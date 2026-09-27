/**
 * The shape the native listener captures and stores.
 *
 * The raw title/text are kept alongside the parse so a mis-read stays
 * debuggable — you can see exactly what MoneyKal was looking at.
 *
 * The parsed fields are filled in natively. That is not a duplicate of
 * src/features/paymentDetection/parser.ts for its own sake: MoneyKal now posts
 * its own Android notification the moment a payment is detected, and that has
 * to work with the app closed, where no JavaScript is running. The rules are
 * mirrored in PaymentNotificationParser.kt and the two must change together.
 */
export interface RawNotificationEvent {
  /** Stable handle for this capture: sha256(package|title|text|postedAt). */
  id: string;
  /** e.g. "com.phonepe.app". */
  packageName: string;
  /** The user-visible app name, e.g. "PhonePe". Falls back to the package. */
  appLabel: string;
  title: string;
  text: string;
  /** Epoch ms, from the notification itself. */
  postedAt: number;
  /** Epoch ms, when the listener saw it. */
  capturedAt: number;

  /* ---- the native parse. Present on everything the listener stores. ---- */

  /** Rupees. Always > 0 when present. */
  amount?: number | null;
  direction?: 'in' | 'out' | null;
  /** null when the notification named no payee — still confirmable. */
  merchant?: string | null;
  /** Which merchant rule matched, or 'none'. */
  ruleId?: string | null;
  /**
   * The user pressed "ADD TO MONEYKAL" on the system notification.
   *
   * Set natively when the action fires; the transaction itself is written by
   * the app, through the existing mutation, once there is a session.
   */
  approved?: boolean;
}

export interface NotificationAccessStatus {
  /** Notification *access* — MoneyKal may read other apps' notifications. */
  granted: boolean;
  /** The system currently has the listener service bound. */
  connected: boolean;
  /** Captures waiting to be reviewed. */
  pendingCount: number;
  /** POST_NOTIFICATIONS — MoneyKal may show its own notifications. A separate
   *  permission from `granted`, and the feature needs both. */
  canPostNotifications: boolean;
}

/** What the runtime permission request resolves to. */
export interface PermissionResult {
  granted: boolean;
  canAskAgain?: boolean;
  status?: string;
}

export type PaymentNotificationsEvents = {
  onPaymentNotification: (event: RawNotificationEvent) => void;
};

/**
 * One notification the listener examined, and what it decided.
 *
 * Only money-related notifications are recorded — anything carrying a currency
 * amount, or coming from a payment or messaging app. Ordinary chat is examined
 * and forgotten and never reaches disk. Local to the device, capped, and
 * clearable from Settings.
 */
export interface NotificationSighting {
  packageName: string;
  appLabel: string;
  title: string;
  text: string;
  /** Plain-language outcome, e.g. "Detected: ₹700 paid to Rahul". */
  verdict: string;
  /** Epoch ms. */
  at: number;
}
