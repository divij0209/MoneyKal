import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import {
  getStatus,
  isSupported,
  type NotificationAccessStatus,
} from '../../../modules/payment-notifications';

/**
 * The current state of MoneyKal's notification access.
 *
 * Re-read whenever the app returns to the foreground, because the only way to
 * grant this permission is to leave MoneyKal for Android's settings screen and
 * come back. Without the AppState listener the card would still say "Not
 * enabled" immediately after the user enabled it, which reads as a bug.
 */
export function useNotificationAccess() {
  const [status, setStatus] = useState<NotificationAccessStatus>(() => getStatus());

  const refresh = useCallback(() => {
    setStatus(getStatus());
  }, []);

  useEffect(() => {
    if (!isSupported) return;

    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return { status, refresh, isSupported };
}
