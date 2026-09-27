import { getApiBaseUrl, AI_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../config/env';

/**
 * The single HTTP client for the existing FastAPI backend.
 *
 * Everything the app knows about the network lives here: the base URL, the
 * bearer header, timeouts, error normalisation, and the one-shot token refresh
 * on a 401. No feature module builds a request by hand.
 *
 * It calls back into the session layer through the two hooks registered by
 * AuthContext rather than importing it, so this module has no dependency on
 * React and the two can't form a cycle.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  /** True when the server said "you are not who you say you are", as opposed
   *  to any other failure. Screens use this to decide between "sign in again"
   *  and "something went wrong". */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** No HTTP response at all — offline, wrong host, server down. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

type TokenProvider = () => string | null;
type TokenRefresher = () => Promise<string | null>;
type UnauthorizedHandler = () => void;

let getToken: TokenProvider = () => null;
let refreshToken: TokenRefresher = async () => null;
let onUnauthorized: UnauthorizedHandler = () => {};

/** Wired once, by AuthContext, at app start. */
export function configureApiClient(opts: {
  getToken: TokenProvider;
  refreshToken: TokenRefresher;
  onUnauthorized: UnauthorizedHandler;
}) {
  getToken = opts.getToken;
  refreshToken = opts.refreshToken;
  onUnauthorized = opts.onUnauthorized;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  /** Multipart payload. When set, `body` is ignored and Content-Type is left
   *  unset so the runtime can add the multipart boundary itself. */
  formData?: FormData;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Skip the Authorization header. Only login/register/health need this. */
  anonymous?: boolean;
  /** Use the longer AI budget — the agent pipeline is genuinely slow. */
  slow?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  // Read at call time, not at import: the base URL can be re-pointed from
  // Settings while the app is running.
  const url = `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Pull a human-usable message out of whatever the server returned. FastAPI
 *  uses `detail`, which may itself be a validation-error array. */
async function extractDetail(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      const detail = parsed?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length > 0) {
        const first = detail[0] as { msg?: string };
        if (first?.msg) return first.msg;
      }
    } catch {
      return text.slice(0, 300);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function rawRequest(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const { method = 'GET', body, formData, query, slow, signal } = options;

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  // Content-Type is set only for JSON. For multipart the runtime must add it
  // together with the boundary, so setting it here would corrupt the upload —
  // the same reason twin-app/js/api.js builds its own headers for uploads.
  if (!formData && body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    slow ? AI_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  );

  // Honour a caller's own cancellation as well as the timeout.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(buildUrl(path, query), {
      method,
      headers,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;

  try {
    res = await rawRequest(path, options, options.anonymous ? null : getToken());
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ApiError(
      0,
      aborted
        ? 'The server took too long to respond.'
        : `Can't reach MoneyKal at ${getApiBaseUrl()}. Check your connection and the API address in Settings.`,
    );
  }

  // One retry after refreshing. A second 401 means the refresh token is gone
  // or rejected too, so the session is genuinely over.
  if (res.status === 401 && !options.anonymous) {
    const fresh = await refreshToken();
    if (fresh) {
      try {
        res = await rawRequest(path, options, fresh);
      } catch {
        throw new ApiError(0, 'Lost connection while signing you back in.');
      }
    }
    if (res.status === 401) {
      onUnauthorized();
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, await extractDetail(res, `Request failed (${res.status})`));
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'The server returned a response the app could not read.');
  }
}

/** Fetch a binary body — the TTS MP3 stream. Returns the raw Response so the
 *  caller decides how to consume it. */
export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await rawRequest(path, options, options.anonymous ? null : getToken());
  } catch {
    throw new ApiError(0, `Can't reach MoneyKal at ${getApiBaseUrl()}.`);
  }
  if (res.status === 401 && !options.anonymous) {
    const fresh = await refreshToken();
    if (fresh) res = await rawRequest(path, options, fresh);
    if (res.status === 401) {
      onUnauthorized();
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
  }
  if (!res.ok) throw new ApiError(res.status, await extractDetail(res, 'Request failed'));
  return res;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

export { getApiBaseUrl };
