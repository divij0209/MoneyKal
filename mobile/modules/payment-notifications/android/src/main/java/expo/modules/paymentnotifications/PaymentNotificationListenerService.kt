package expo.modules.paymentnotifications

import android.app.Notification
import android.content.Context
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject

/**
 * Reads notifications posted by other apps and keeps the ones that look like
 * payments.
 *
 * SCOPE: this service sees notifications. It does not read SMS, does not send
 * SMS, and holds no SMS permission — none is declared anywhere in this module.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not decide what a transaction is.
 * The gate below is coarse on purpose — "is there an amount and a
 * payment-shaped word" — and everything past that is the TypeScript parser's
 * job (src/features/paymentDetection/parser.ts). Keeping the real rules in JS
 * is what makes new notification formats a one-file change that can be unit
 * tested, instead of a Kotlin edit and a full native rebuild.
 *
 * It also never shows UI. A background service that popped a dialog over
 * whatever the user was doing would be exactly the intrusive behaviour the
 * feature is supposed to avoid.
 */
class PaymentNotificationListenerService : NotificationListenerService() {

  override fun onListenerConnected() {
    super.onListenerConnected()
    PaymentNotificationBus.isConnected = true
    Log.i(TAG, "Listener connected — MoneyKal is receiving notifications.")
    scanActiveNotifications()
  }

  /**
   * Reads the notifications that were already on screen when we bound.
   *
   * onNotificationPosted only fires for notifications posted *while* the
   * listener is bound. Everything already in the shade at bind time is
   * otherwise invisible, and that covers the cases that matter most in
   * practice: the app was just installed or updated, the phone rebooted, the
   * user force-stopped MoneyKal, or Android rebound the service. Pay first and
   * grant access (or reinstall) second, and without this the payment is lost
   * even though its notification is still sitting right there.
   *
   * Re-scanning on every bind is safe because the store keeps a permanent
   * per-notification id, so anything already handled is skipped rather than
   * offered again.
   */
  private fun scanActiveNotifications() {
    val active = try {
      activeNotifications
    } catch (t: Throwable) {
      // Throws if the binding is not fully established yet. Not fatal — new
      // notifications still arrive through onNotificationPosted.
      Log.w(TAG, "Could not read notifications already on screen", t)
      null
    } ?: return

    Log.i(TAG, "Scanning ${active.size} notification(s) already on screen.")
    for (sbn in active) {
      try {
        handle(sbn)
      } catch (t: Throwable) {
        Log.e(TAG, "Failed to handle an existing notification", t)
      }
    }
  }

  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    PaymentNotificationBus.isConnected = false
    Log.i(TAG, "Listener disconnected — notification access was revoked or the service was rebound.")
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    // Every path in here is wrapped: an exception thrown out of a listener
    // callback takes down the app process, and this runs on notifications we
    // do not control the shape of.
    try {
      handle(sbn ?: return)
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to handle notification", t)
    }
  }

  private fun handle(sbn: StatusBarNotification) {
    if (sbn.packageName == packageName) return

    val notification = sbn.notification ?: return
    val flags = notification.flags

    // Ongoing notifications are persistent status ("Sync in progress"), not
    // events. Group summaries restate children we will also receive.
    if (flags and Notification.FLAG_ONGOING_EVENT != 0) return
    if (flags and Notification.FLAG_GROUP_SUMMARY != 0) return

    val extras = notification.extras ?: return
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()

    // bigText carries the full sentence when the collapsed line is truncated,
    // which is where the merchant usually lives. Prefer whichever is longer.
    val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
    val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim().orEmpty()
    val body = if (bigText.length > text.length) bigText else text

    val now0 = System.currentTimeMillis()

    /** Writes the verdict to the on-device diagnostics list, for the money
     *  related notifications only. See PaymentNotificationStore.recordSighting. */
    fun record(verdict: String) {
      if (!worthRecording(sbn.packageName, "$title $body")) return
      PaymentNotificationStore.recordSighting(
        applicationContext, sbn.packageName, appLabel(sbn.packageName),
        title, body, verdict, now0,
      )
    }

    if (title.isEmpty() && body.isEmpty()) {
      // Some apps draw their notification with a custom RemoteViews layout and
      // leave EXTRA_TITLE/EXTRA_TEXT empty. Nothing can be read from those, and
      // it is worth being able to tell that case apart from a failed gate.
      Log.d(TAG, "Ignored (no readable text) ${sbn.packageName}")
      record("No readable text — the app draws its own notification layout")
      return
    }

    // Logged at DEBUG for everything that reaches here, so "why did MoneyKal
    // not see my payment?" is answerable from Logcat instead of guesswork.
    // Filter with: adb logcat -s MoneyKalNotifications:V
    if (!looksLikePayment("$title $body")) {
      Log.d(TAG, "Ignored (no payment signal) ${sbn.packageName}: ${forLog(title)} / ${forLog(body)}")
      record("No amount or payment wording found")
      return
    }

    val now = System.currentTimeMillis()
    val postedAt = if (sbn.postTime > 0L) sbn.postTime else now

    // Two different hashes, doing two different jobs. `contentKey` ignores the
    // timestamp so a notification the app re-posts with the same words is
    // recognised as the same one. `id` includes it, so it is a stable handle
    // JS can use to mark this specific capture resolved.
    val contentKey = PaymentNotificationStore.sha256(
      "${sbn.packageName}|$title|$body",
    )
    val id = PaymentNotificationStore.sha256(
      "${sbn.packageName}|$title|$body|$postedAt",
    )

    // Parsed here, natively, because the notification MoneyKal is about to post
    // has to say "₹700 paid to Rahul" and there is no JavaScript running when
    // Android starts this process cold. A capture the parser cannot read
    // confidently is dropped outright rather than stored: it would never become
    // a notification, and keeping it would only fill the queue with noise.
    val parsed = PaymentNotificationParser.parse(title, body)
    if (parsed == null) {
      Log.d(TAG, "Ignored (not a confident payment) ${sbn.packageName}: ${forLog(title)} / ${forLog(body)}")
      record("Looked like money, but not a completed payment")
      return
    }

    val event = JSONObject().apply {
      put("id", id)
      put("packageName", sbn.packageName)
      put("appLabel", appLabel(sbn.packageName))
      put("title", title)
      put("text", body)
      put("postedAt", postedAt)
      put("capturedAt", now)
      // The parse travels with the event so JS does not have to redo it.
      put("amount", parsed.amount)
      put("direction", parsed.direction)
      put("merchant", parsed.merchant)
      put("ruleId", parsed.ruleId)
      put("approved", false)
    }

    val added = PaymentNotificationStore.enqueue(applicationContext, event, contentKey, now)
    if (!added) {
      Log.d(TAG, "Duplicate within the dedupe window, ignored: ${sbn.packageName}")
      record("Already handled — duplicate")
      return
    }

    Log.i(TAG, "Captured candidate from ${sbn.packageName}: ${forLog(title)} / ${forLog(body)}")

    record("Detected: " + PaymentNotificationPresenter.bodyFor(parsed))
    surface(applicationContext, event, id, parsed)
  }

  /** The user-visible name of the posting app, so the sheet can say "PhonePe"
   *  rather than "com.phonepe.app". Falls back to the package name. */
  private fun appLabel(pkg: String): String =
    try {
      val pm: PackageManager = applicationContext.packageManager
      pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Throwable) {
      pkg
    }

  companion object {
    private const val TAG = "MoneyKalNotifications"

    /**
     * One detection, one surface.
     *
     * With MoneyKal open the in-app sheet is the right place — the user is
     * already here, and a shade notification on top of the sheet would be the
     * same question asked twice. With MoneyKal anywhere else, its own Android
     * notification is the whole point of the feature: the payment is actionable
     * from the shade without opening the app first.
     *
     * On the companion so the simulator in Settings goes through exactly this,
     * rather than a second code path that could drift from the real one.
     */
    fun surface(
      context: Context,
      event: JSONObject,
      eventId: String,
      parsed: PaymentNotificationParser.Parsed,
    ) {
      if (PaymentNotificationBus.isAppForeground) {
        val deliver = PaymentNotificationBus.onEvent
        if (deliver != null) {
          deliver.invoke(event)
          return
        }
        // Marked foreground but the module has gone — post rather than let the
        // detection disappear.
        Log.w(TAG, "Foreground flag set but no JS listener; posting a notification instead.")
      }

      PaymentNotificationPresenter.show(context, eventId, parsed)
    }

    /** An Indian-currency amount, in either order: "₹500" or "500 INR". */
    private val AMOUNT_PREFIX = Regex("""(?:₹|rs\.?|inr)\s*\d""", RegexOption.IGNORE_CASE)
    private val AMOUNT_SUFFIX = Regex("""\d\s*(?:₹|rs\.?|inr)\b""", RegexOption.IGNORE_CASE)

    /**
     * The coarse vocabulary gate. Extend this list freely — a false positive
     * here costs nothing, because the TypeScript parser rejects anything it
     * cannot read confidently and the user still has to confirm.
     */
    private val KEYWORDS = listOf(
      "paid", "payment", "debited", "credited", "sent", "received",
      "spent", "withdrawn", "transferred", "transaction", "txn",
      "upi", "purchase", "refund", "deducted", "charged",
    )

    /**
     * One line, bounded, for logging.
     *
     * A notification's bigText can be an entire marketing email, and Logcat
     * splits on newlines — so an unsanitised Log call turns one notification
     * into forty log entries and buries everything else.
     */
    fun forLog(text: String, max: Int = 120): String {
      val flat = text.replace(Regex("\\s+"), " ").trim()
      return if (flat.length <= max) flat else flat.take(max) + "…"
    }

    /**
     * Whether a notification is worth writing to the diagnostics list.
     *
     * Money related, or from an app that handles money. Everything else — the
     * chat, the games, the delivery updates — is examined and forgotten, and
     * never touches disk. Without this the diagnostics would quietly become a
     * log of the user's private messages.
     */
    private val MONEY_PACKAGES = listOf(
      "paisa", "phonepe", "paytm", "bhim", "upi", "bank", "sbi", "hdfc", "icici",
      "axis", "kotak", "bob", "cred", "mobikwik", "freecharge", "amazonpay",
      "messaging", "messages", "mms", "sms",
    )

    fun worthRecording(packageName: String, raw: String): Boolean {
      if (AMOUNT_PREFIX.containsMatchIn(raw) || AMOUNT_SUFFIX.containsMatchIn(raw)) return true
      val pkg = packageName.lowercase()
      return MONEY_PACKAGES.any { pkg.contains(it) }
    }

    fun looksLikePayment(raw: String): Boolean {
      val hasAmount = AMOUNT_PREFIX.containsMatchIn(raw) || AMOUNT_SUFFIX.containsMatchIn(raw)
      if (!hasAmount) return false
      val lower = raw.lowercase()
      return KEYWORDS.any { lower.contains(it) }
    }
  }
}
