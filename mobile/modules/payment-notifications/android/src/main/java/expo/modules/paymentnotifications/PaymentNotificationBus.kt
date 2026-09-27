package expo.modules.paymentnotifications

import org.json.JSONObject

/**
 * The one-way hand-off from the listener service to the Expo module.
 *
 * The service and the React Native app share a process but not a lifetime: the
 * service can be running with no React context at all (Android started the
 * process purely to deliver a notification). So the service never reaches for
 * JS directly. It writes to the store, then offers the event here. If a module
 * instance happens to be alive it forwards to JS; if not, the callback is null
 * and the event simply waits in the store until the app opens.
 */
object PaymentNotificationBus {
  /** Set by PaymentNotificationsModule while it is alive; null otherwise. */
  @Volatile
  var onEvent: ((JSONObject) -> Unit)? = null

  /** Whether the system currently has the listener bound. Written by the
   *  service's connect/disconnect callbacks and read for diagnostics. */
  @Volatile
  var isConnected: Boolean = false

  /**
   * Whether MoneyKal is actually on screen right now.
   *
   * This decides which of the two ways a detection surfaces. Foreground: the
   * in-app confirmation sheet, because the user is already looking at the app
   * and a shade notification on top of it would be noise. Anything else — the
   * app backgrounded, closed, or the phone on the home screen — gets MoneyKal's
   * own Android notification instead. Exactly one of the two happens, never
   * both, which is why this cannot be inferred from `onEvent != null`: the
   * module stays alive for as long as the process does, long after the user has
   * swiped the app away.
   *
   * Reported from JS on every AppState change, and forced back to false when
   * the module is destroyed.
   */
  @Volatile
  var isAppForeground: Boolean = false
}
