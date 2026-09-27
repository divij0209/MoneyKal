import { api, request } from '../client';
import type { GenericResponse, HisaabSummary, ReceiptScan, Transaction } from '../types';

/**
 * Hisaab endpoints.
 *
 * The ledger lives under /startup/* even for Individuals — StartupTransaction
 * is keyed on profile_id and is shared by both personas, which is why the web
 * calls the same routes from its Individual-only Hisaab view. The paths are
 * kept exactly as the backend defines them rather than aliased, so there is no
 * second name for the same thing.
 */

/** GET /startup/hisaab.
 *
 *  Returns the profile's ENTIRE ledger plus lifetime money_in/money_out/net —
 *  not a month. Any per-month or per-day view is a filter over `transactions`,
 *  which is exactly how the web does it (and why paging months needs no
 *  further requests). */
export function fetchHisaab(): Promise<HisaabSummary> {
  return api.get<HisaabSummary>('/startup/hisaab');
}

export interface TransactionPayload {
  type: 'in' | 'out';
  category: string;
  amount: number;
  description?: string | null;
  /** ISO YYYY-MM-DD. Omitted, the backend uses today. */
  txn_date?: string | null;
  source?: string;
}

export function addTransaction(payload: TransactionPayload): Promise<Transaction> {
  return api.post<Transaction>('/startup/hisaab/transactions', payload);
}

/** Every field optional server-side; the app sends the whole row, as the web does. */
export function updateTransaction(
  id: number,
  payload: Partial<TransactionPayload>,
): Promise<Transaction> {
  return api.put<Transaction>(`/startup/hisaab/transactions/${id}`, payload);
}

export function deleteTransaction(id: number): Promise<GenericResponse> {
  return api.delete<GenericResponse>(`/startup/hisaab/transactions/${id}`);
}

/**
 * POST /hisaab/scan-receipt — a receipt image through Gemini vision.
 *
 * Authenticated: the route gained a get_current_user dependency during the
 * mobile foundation work, so the app's bearer token is required. No AI
 * credential exists on the device — the key stays server-side, which is the
 * whole reason this is a backend route rather than a client-side SDK call.
 */
export function scanReceipt(file: {
  uri: string;
  name: string;
  mimeType?: string | null;
}): Promise<ReceiptScan> {
  const form = new FormData();
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || 'image/jpeg',
  } as unknown as Blob);

  return request<ReceiptScan>('/hisaab/scan-receipt', {
    method: 'POST',
    formData: form,
    // Vision extraction takes well past the default budget.
    slow: true,
  });
}
