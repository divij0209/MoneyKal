import { requireOptionalNativeModule, type NativeModule } from 'expo';
// EventSubscription is exported by expo-modules-core; the `expo` barrel
// re-exports the runtime pieces but not this type.
import type { EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

import type {
  NotificationAccessStatus,
  NotificationSighting,
  PaymentNotificationsEvents,
  PermissionResult,
  RawNotificationEvent,
} from './src/PaymentNotifications.types';

export type {
  NotificationAccessStatus,
  NotificationSighting,
  PaymentNotificationsEvents,
  PermissionResult,
  RawNotificationEvent,
} from './src/PaymentNotifications.types';

declare class PaymentNotificationsNativeModule extends NativeModule<PaymentNotificationsEvents> {
  getStatus(): NotificationAccessStatus;
  openSettings(): void;
  getPendingEvents(): RawNotificationEvent[];
  consumeEvents(ids: string[]): void;
  clearPendingEvents(): void;
  getRecentSightings(): NotificationSighting[];
  clearSightings(): void;
  setAppForeground(foreground: boolean): void;
  canPostNotifications(): boolean;
  requestPostNotificationsPermission(): Promise<PermissionResult>;
  debugShowNotificationFor(eventId: string): boolean;
  emitTestNotification(
    title: string,
    text: string,
    appLabel: string | null,
    packageName: string | null,
  ): boolean;
}

/**
 * requireOptionalNativeModule returns null instead of throwing when the native
 * side is absent. That is the whole reason Expo Go still runs: Expo Go's
 * runtime has never heard of this module, so every call below falls through to
 * a safe default and the rest of MoneyKal behaves exactly as it always did.
 * The same holds on iOS and web, where the module is not built at all.
 */
const native = requireOptionalNativeModule<PaymentNotificationsNativeModule>(
  'PaymentNotifications',
);

/** True only where the native listener actually exists — Android, in a
 *  development or production build. False in Expo Go, on iOS, and on web. */
export const isSupported = Platform.OS === 'android' && native != null;

const UNSUPPORTED: NotificationAccessStatus = {
  granted: false,
  connected: false,
  pendingCount: 0,
  canPostNotifications: false,
};

/** Whether the user has granted notification access, and what is waiting. */
export function getStatus(): NotificationAccessStatus {
  if (!native) return UNSUPPORTED;
  try {
    return native.getStatus();
  } catch {
    return UNSUPPORTED;
  }
}

/** Opens Android's notification-access screen. There is no way to grant this
 *  silently, and MoneyKal does not try — the user toggles it themselves. */
export function openSettings(): void {
  if (!native) return;
  try {
    native.openSettings();
  } catch {
    /* An OEM without the settings screen. Nothing useful to do. */
  }
}

/** Captures waiting since the app was last open, oldest first. */
export function getPendingEvents(): RawNotificationEvent[] {
  if (!native) return [];
  try {
    return native.getPendingEvents();
  } catch {
    return [];
  }
}

/** Marks captures resolved — added or ignored — so they never reappear. */
export function consumeEvents(ids: string[]): void {
  if (!native || ids.length === 0) return;
  try {
    native.consumeEvents(ids);
  } catch {
    /* Worst case the event is offered again on next launch. */
  }
}

export function clearPendingEvents(): void {
  if (!native) return;
  try {
    native.clearPendingEvents();
  } catch {
    /* Nothing to do. */
  }
}

/**
 * Injects a notification as if a payment app had posted it, through the exact
 * code path a real one takes. Returns false when the text does not pass the
 * native gate. For development and manual testing — see the debug card in
 * Settings.
 */
export function emitTestNotification(
  title: string,
  text: string,
  appLabel?: string,
  packageName?: string,
): boolean {
  if (!native) return false;
  try {
    return native.emitTestNotification(title, text, appLabel ?? null, packageName ?? null);
  } catch {
    return false;
  }
}

/**
 * Tells the native listener whether MoneyKal is on screen.
 *
 * Decides where a detection surfaces: foreground gets the in-app confirmation
 * sheet, anything else gets MoneyKal's own Android notification. Exactly one of
 * the two, never both.
 */
export function setAppForeground(foreground: boolean): void {
  if (!native) return;
  try {
    native.setAppForeground(foreground);
  } catch {
    /* Nothing to do. */
  }
}

/** Whether MoneyKal is allowed to post its own notifications. Distinct from
 *  notification *access*; the feature needs both. */
export function canPostNotifications(): boolean {
  if (!native) return false;
  try {
    return native.canPostNotifications();
  } catch {
    return false;
  }
}

/** Asks for POST_NOTIFICATIONS on Android 13+. Resolves granted below 13,
 *  where the permission does not exist. Never throws. */
export async function requestPostNotificationsPermission(): Promise<PermissionResult> {
  if (!native) return { granted: false };
  try {
    return await native.requestPostNotificationsPermission();
  } catch {
    return { granted: false };
  }
}

/** Posts the system notification for a stored event. Debug only — it is the
 *  only way to see the shade path while MoneyKal is open, since a foreground
 *  detection deliberately goes to the in-app sheet instead. */
export function debugShowNotificationFor(eventId: string): boolean {
  if (!native) return false;
  try {
    return native.debugShowNotificationFor(eventId);
  } catch {
    return false;
  }
}

/**
 * The last few money-related notifications the listener examined, newest first.
 *
 * The point of this is to separate two very different failures that look
 * identical from the outside: a notification MoneyKal rejected, versus a
 * notification that was never posted. An empty list right after a real payment
 * means the payment app posted nothing — no amount of parser work would help.
 */
export function getRecentSightings(): NotificationSighting[] {
  if (!native) return [];
  try {
    return native.getRecentSightings();
  } catch {
    return [];
  }
}

export function clearSightings(): void {
  if (!native) return;
  try {
    native.clearSightings();
  } catch {
    /* Nothing to do. */
  }
}

/** Live events, for while MoneyKal is open. Returns null when unsupported so
 *  callers can skip teardown without a branch of their own. */
export function addPaymentNotificationListener(
  handler: (event: RawNotificationEvent) => void,
): EventSubscription | null {
  if (!native) return null;
  try {
    return native.addListener('onPaymentNotification', handler);
  } catch {
    return null;
  }
}
