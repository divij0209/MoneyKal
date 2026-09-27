package expo.modules.paymentnotifications

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * The JS-facing surface of MoneyKal's payment-notification listener.
 *
 * Android-only by declaration (expo-module.config.json lists only "android"),
 * so on iOS and web the native module is simply absent and the TypeScript
 * wrapper degrades to "unsupported" rather than throwing. That is also what
 * keeps Expo Go working: Expo Go has no idea this module exists, and the
 * wrapper reports it unavailable instead of crashing the app.
 */
class PaymentNotificationsModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.AppContextLost()

  private val listenerComponent: ComponentName
    get() = ComponentName(context, PaymentNotificationListenerService::class.java)

  /**
   * Whether the user has granted notification access to MoneyKal.
   *
   * Read from Settings.Secure rather than through NotificationManagerCompat so
   * the module carries no extra dependency. The value is a colon-separated
   * list of flattened ComponentNames; we match on package, because the entry
   * is written with the component the OS bound, which is ours.
   */
  private fun isGranted(): Boolean =
    try {
      val flat = Settings.Secure.getString(
        context.contentResolver,
        "enabled_notification_listeners",
      )
      !flat.isNullOrBlank() && flat.split(":").any { entry ->
        ComponentName.unflattenFromString(entry)?.packageName == context.packageName
      }
    } catch (t: Throwable) {
      Log.e(TAG, "Could not read notification listener settings", t)
      false
    }

  override fun definition() = ModuleDefinition {
    Name("PaymentNotifications")

    Events(EVENT_NAME)

    OnCreate {
      // Wire the service's hand-off to this module. Anything the service
      // captures while the app is running reaches JS immediately; anything it
      // captures while the app is closed waits in the store instead.
      PaymentNotificationBus.onEvent = { event ->
        try {
          sendEvent(EVENT_NAME, event.toMap())
        } catch (t: Throwable) {
          Log.e(TAG, "Failed to forward notification event to JS", t)
        }
      }
    }

    OnDestroy {
      PaymentNotificationBus.onEvent = null
      // The process may outlive the React context. Leaving this true would make
      // the service believe the app is on screen and silently swallow
      // detections that should have become notifications.
      PaymentNotificationBus.isAppForeground = false
    }

    /**
     * Tells the listener whether MoneyKal is actually on screen.
     *
     * Drives the one-detection-one-surface rule: foreground gets the in-app
     * sheet, anything else gets MoneyKal's own Android notification. Reported
     * from JS on every AppState change.
     */
    Function("setAppForeground") { foreground: Boolean ->
      PaymentNotificationBus.isAppForeground = foreground
    }

    /**
     * Whether MoneyKal may post notifications at all.
     *
     * Separate from notification *access* (reading other apps' notifications).
     * They are two unrelated permissions and the feature needs both: access to
     * detect the payment, POST_NOTIFICATIONS to tell the user about it.
     */
    Function("canPostNotifications") {
      try {
        NotificationManagerCompat.from(context).areNotificationsEnabled()
      } catch (t: Throwable) {
        Log.w(TAG, "Could not read notification permission", t)
        false
      }
    }

    /**
     * Asks for POST_NOTIFICATIONS on Android 13+.
     *
     * Below 13 the permission does not exist and notifications are allowed
     * unless the user turned them off in settings, so this resolves as granted
     * and the caller does not have to branch on version.
     */
    AsyncFunction("requestPostNotificationsPermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(
          mapOf("granted" to true, "canAskAgain" to false, "status" to "granted"),
        )
        return@AsyncFunction
      }
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    /**
     * Everything Settings needs in one call: whether access is granted,
     * whether the system currently has the service bound, and how many
     * captures are waiting.
     */
    Function("getStatus") {
      val granted = isGranted()

      // Re-binding matters after the user toggles access back on. Android does
      // not always rebind a listener whose permission was restored, and
      // requestRebind is the documented nudge. Harmless when already bound.
      if (granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        runCatching { NotificationListenerService.requestRebind(listenerComponent) }
      }

      val canPost = try {
        NotificationManagerCompat.from(context).areNotificationsEnabled()
      } catch (t: Throwable) {
        false
      }

      mapOf(
        "granted" to granted,
        "connected" to PaymentNotificationBus.isConnected,
        "pendingCount" to PaymentNotificationStore.pending(context).length(),
        "canPostNotifications" to canPost,
      )
    }

    /**
     * Opens Android's notification-access screen. There is no API to grant
     * this permission programmatically and MoneyKal does not attempt one —
     * the user toggles it themselves, which is the only way it can work.
     */
    Function("openSettings") {
      val activity = appContext.currentActivity

      // API 30+ can deep-link straight to MoneyKal's own row instead of
      // dropping the user in a list to hunt through.
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
          Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
          listenerComponent.flattenToString(),
        )
      } else {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      }

      try {
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      } catch (t: Throwable) {
        // Some OEM builds do not ship the detail screen. Fall back to the list.
        Log.w(TAG, "Detail settings unavailable, falling back to the listener list", t)
        val fallback = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(fallback) }
      }
    }

    /** Everything captured since the last consume, oldest first. */
    Function("getPendingEvents") {
      val pending = PaymentNotificationStore.pending(context)
      (0 until pending.length()).mapNotNull { pending.optJSONObject(it)?.toMap() }
    }

    /** Marks captures resolved — added or ignored — so they do not come back. */
    Function("consumeEvents") { ids: List<String> ->
      PaymentNotificationStore.consume(context, ids.toSet())
    }

    Function("clearPendingEvents") {
      PaymentNotificationStore.clear(context)
    }

    /**
     * The last few money-related notifications the listener examined, newest
     * first, each with what was decided about it.
     *
     * Answers the one question that otherwise needs a USB cable: when a payment
     * is not detected, was its notification rejected, or did the payment app
     * never post one? An empty list after a real payment means nothing arrived,
     * which is a problem in the payment app's notification settings rather than
     * in MoneyKal.
     */
    Function("getRecentSightings") {
      val arr = PaymentNotificationStore.sightings(context)
      (0 until arr.length())
        .mapNotNull { arr.optJSONObject(it) }
        .map {
          mapOf(
            "packageName" to it.optString("packageName"),
            "appLabel" to it.optString("appLabel"),
            "title" to it.optString("title"),
            "text" to it.optString("text"),
            "verdict" to it.optString("verdict"),
            "at" to it.optLong("at").toDouble(),
          )
        }
        .reversed()
    }

    Function("clearSightings") {
      PaymentNotificationStore.clearSightings(context)
    }

    /**
     * Injects a notification as though a payment app had posted it.
     *
     * This exists so the whole chain — gate, store, dedupe, event, parser,
     * confirmation sheet — can be exercised without spending real money. It
     * runs the identical code path a real notification takes, including the
     * keyword gate, so a string that would be ignored in the wild is ignored
     * here too. Returns whether the event was actually captured.
     */
    Function("emitTestNotification") { title: String, text: String, appLabel: String?, packageName: String? ->
      val pkg = packageName ?: "com.moneykal.test"
      if (!PaymentNotificationListenerService.looksLikePayment("$title $text")) {
        return@Function false
      }

      // Same parser, same store, same dedupe, same surface decision as a real
      // notification — so a green simulation genuinely means the pipeline works
      // rather than only the UI.
      val parsed = PaymentNotificationParser.parse(title, text) ?: return@Function false

      val now = System.currentTimeMillis()
      val contentKey = PaymentNotificationStore.sha256("$pkg|$title|$text")
      val id = PaymentNotificationStore.sha256("$pkg|$title|$text|$now")
      val event = JSONObject().apply {
        put("id", id)
        put("packageName", pkg)
        put("appLabel", appLabel ?: "Test")
        put("title", title)
        put("text", text)
        put("postedAt", now)
        put("capturedAt", now)
        put("amount", parsed.amount)
        put("direction", parsed.direction)
        put("merchant", parsed.merchant)
        put("ruleId", parsed.ruleId)
        put("approved", false)
      }

      val added = PaymentNotificationStore.enqueue(context, event, contentKey, now)
      if (added) PaymentNotificationListenerService.surface(context, event, id, parsed)
      added
    }

    /**
     * Posts the system notification for an already-stored event.
     *
     * Used by the simulator to exercise the shade path while MoneyKal is open,
     * which is otherwise unreachable: with the app in the foreground a
     * detection deliberately goes to the in-app sheet instead.
     */
    Function("debugShowNotificationFor") { eventId: String ->
      val pending = PaymentNotificationStore.pending(context)
      for (i in 0 until pending.length()) {
        val item = pending.optJSONObject(i) ?: continue
        if (item.optString("id") != eventId) continue
        val parsed = PaymentNotificationParser.parse(
          item.optString("title"),
          item.optString("text"),
        ) ?: return@Function false
        PaymentNotificationPresenter.show(context, eventId, parsed)
        return@Function true
      }
      false
    }
  }

  companion object {
    private const val TAG = "MoneyKalNotifications"
    private const val EVENT_NAME = "onPaymentNotification"
  }
}

/** JSONObject -> the Map shape Expo serialises to JS. Timestamps are emitted
 *  as Double because JS has no Long; a millisecond epoch is exact in a double. */
private fun JSONObject.toMap(): Map<String, Any?> = mapOf(
  "id" to optString("id"),
  "packageName" to optString("packageName"),
  "appLabel" to optString("appLabel"),
  "title" to optString("title"),
  "text" to optString("text"),
  "postedAt" to optLong("postedAt").toDouble(),
  "capturedAt" to optLong("capturedAt").toDouble(),
  // The native parse, so JS renders what the notification already said rather
  // than re-deriving it and risking a different answer.
  "amount" to if (has("amount")) optDouble("amount") else null,
  "direction" to optString("direction").ifEmpty { null },
  // optString turns JSON null into "null"; isNull is the only reliable check.
  "merchant" to if (isNull("merchant")) null else optString("merchant").ifEmpty { null },
  "ruleId" to optString("ruleId").ifEmpty { null },
  "approved" to optBoolean("approved", false),
)
