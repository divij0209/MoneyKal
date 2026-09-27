import { api, request } from '../client';
import type { AuthResponse, HealthResponse, TermsAcceptance } from '../types';

/**
 * Auth endpoints. Mirrors backend/routers/auth.py exactly — same paths, same
 * request bodies, same field names as the web client sends.
 *
 * `terms` is optional and spread into the body only when it is given, so a
 * call without it is byte-for-byte the request this file made before.
 */

export function login(username: string, password: string, terms?: TermsAcceptance) {
  return api.post<AuthResponse>(
    '/auth/login',
    { username, password, ...(terms ?? {}) },
    { anonymous: true },
  );
}

export function register(username: string, password: string, terms?: TermsAcceptance) {
  return api.post<AuthResponse>(
    '/auth/register',
    { username, password, ...(terms ?? {}) },
    { anonymous: true },
  );
}

/** Additive backend route: trades a refresh token for a new access token.
 *  Called by AuthContext on a 401, never by a screen. */
export function refresh(refreshToken: string) {
  return request<AuthResponse>('/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
    anonymous: true,
  });
}

/** Unauthenticated reachability probe, used by Settings to tell "offline"
 *  apart from "wrong API address". */
export function health() {
  return api.get<HealthResponse>('/health', { anonymous: true });
}
