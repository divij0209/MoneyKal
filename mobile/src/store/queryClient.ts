import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api';

/**
 * Server-state defaults.
 *
 * Tuned for a phone rather than a browser tab: a mobile connection drops and
 * recovers constantly, so a couple of retries are worth it — but never on a
 * 401 or a 4xx, where retrying just repeats a request the server has already
 * answered definitively.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
