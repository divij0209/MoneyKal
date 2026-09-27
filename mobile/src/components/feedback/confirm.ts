import { Alert, Platform } from 'react-native';

/**
 * Ask before doing something destructive.
 *
 * `Alert.alert` is the right control on a phone, but react-native-web ships it
 * as `static alert() {}` — an empty function. On Expo Web a destructive action
 * guarded by it therefore does nothing at all, silently: no dialog, no action,
 * no error. That is worse than having no confirmation, because the button
 * appears broken.
 *
 * So: the native dialog on iOS and Android, `window.confirm` on web. Same
 * decision either way, and the action actually runs when the answer is yes.
 */
export function confirmDestructive(options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
}): void {
  const {
    title,
    message,
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    onConfirm,
  } = options;

  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(message ? `${title}\n\n${message}` : title)
      : true;
    if (ok) onConfirm();
    return;
  }

  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
