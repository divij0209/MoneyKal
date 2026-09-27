package expo.modules.paymentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.roundToLong

/**
 * MoneyKal's own Android notification for a detected payment.
 *
 * This is what lets the feature work without the app being open. The listener
 * service posts this the moment it reads a payment, so the user acts on it from
 * the notification shade instead of having to remember to open MoneyKal.
 *
 * It is a plain system notification — no overlay, no activity launched from the
 * background, nothing drawn over whatever the user is doing.
 */
object PaymentNotificationPresenter {

  const val CHANNEL_ID = "moneykal_payment_detection"

  const val ACTION_ADD = "expo.modules.paymentnotifications.action.ADD"
  const val ACTION_IGNORE = "expo.modules.paymentnotifications.action.IGNORE"
  const val ACTION_OPEN = "expo.modules.paymentnotifications.action.OPEN"
  const val EXTRA_EVENT_ID = "expo.modules.paymentnotifications.extra.EVENT_ID"

  private const val TAG = "MoneyKalNotifications"

  /** MoneyKal's accent, matching --ov-accent in the web theme and
   *  theme/tokens.ts. Tints the small icon and the action text. */
  private val ACCENT = Color.parseColor("#00E5FF")

  /**
   * The channel. Created on every post because creating an existing channel is
   * a no-op, which is cheaper than tracking whether we have done it — and the
   * service can be started cold by Android at any time.
   */
  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      ?: return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Payment detection",
      // DEFAULT, not HIGH: this should appear in the shade, not shove a
      // heads-up banner over whatever the user is doing. The payment already
      // happened — nothing here is urgent.
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Payments MoneyKal noticed from your UPI and banking apps."
      enableVibration(false)
      setShowBadge(true)
    }
    manager.createNotificationChannel(channel)
  }

  /** Whole rupees with Indian digit grouping, matching formatAmount() in
   *  src/features/hisaab/constants.ts so the notification and the ledger agree. */
  fun formatAmount(value: Double): String {
    val nf = NumberFormat.getIntegerInstance(Locale("en", "IN"))
    return "₹" + nf.format(value.roundToLong())
  }

  /**
   * The one line the user reads.
   *
   * "₹700 paid to Rahul" when the payee is known, "₹700 payment detected" when
   * it is not. The amount is never invented — this is only ever called with a
   * parse that produced one.
   */
  fun bodyFor(parsed: PaymentNotificationParser.Parsed): String {
    val amount = formatAmount(parsed.amount)
    val payee = parsed.merchant
    return when {
      payee != null && parsed.direction == "out" -> "$amount paid to $payee"
      payee != null -> "$amount received from $payee"
      parsed.direction == "out" -> "$amount payment detected"
      else -> "$amount received"
    }
  }

  /** A stable per-event notification id, so the right one can be cancelled. */
  fun notificationId(eventId: String): Int = eventId.hashCode()

  fun show(context: Context, eventId: String, parsed: PaymentNotificationParser.Parsed) {
    try {
      ensureChannel(context)

      val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        // The MoneyKal chevron, as a white silhouette. Android tints the small
        // icon itself and ignores colour, so the drawable is alpha-only.
        .setSmallIcon(R.drawable.ic_moneykal_notification)
        .setColor(ACCENT)
        .setContentTitle("Payment detected")
        .setContentText(bodyFor(parsed))
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openIntent(context, eventId))
        .addAction(0, "ADD TO MONEYKAL", addIntent(context, eventId))
        .addAction(0, "IGNORE", ignoreIntent(context, eventId))
        .build()

      // Posting without POST_NOTIFICATIONS on Android 13+ is a silent no-op
      // rather than a throw, but check anyway so the reason is in the log.
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        Log.w(TAG, "Notifications are disabled for MoneyKal — nothing will be shown.")
      }

      NotificationManagerCompat.from(context).notify(notificationId(eventId), notification)
      Log.i(TAG, "Posted MoneyKal notification: ${bodyFor(parsed)}")
    } catch (se: SecurityException) {
      // Missing POST_NOTIFICATIONS. Not fatal: the capture is already stored and
      // will be offered in-app the next time MoneyKal is opened.
      Log.w(TAG, "Not allowed to post notifications", se)
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to post MoneyKal notification", t)
    }
  }

  fun cancel(context: Context, eventId: String) {
    try {
      NotificationManagerCompat.from(context).cancel(notificationId(eventId))
    } catch (t: Throwable) {
      Log.w(TAG, "Failed to cancel notification", t)
    }
  }

  /* ------------------------------------------------------------- intents -- */

  /**
   * IMMUTABLE is required from Android 12. These intents are fully specified
   * here and nothing downstream needs to add to them, so immutability costs
   * nothing.
   */
  private fun flags(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }

  /**
   * ADD is a broadcast, so pressing it does not open MoneyKal.
   *
   * The whole point of the button is to record a payment without interrupting
   * whatever the user is doing. An activity PendingIntent would drag them out
   * of WhatsApp and into MoneyKal to confirm something they just confirmed,
   * which defeats it. A receiver starts nothing, so the user stays exactly
   * where they were — and because it never calls startActivity, Android 12's
   * notification-trampoline ban does not apply to it.
   *
   * The receiver records the approval and hands off to the app for the actual
   * write; see PaymentActionReceiver.
   */
  private fun addIntent(context: Context, eventId: String): PendingIntent {
    val intent = Intent(context, PaymentActionReceiver::class.java).apply {
      action = ACTION_ADD
      putExtra(EXTRA_EVENT_ID, eventId)
    }
    return PendingIntent.getBroadcast(context, ("add:$eventId").hashCode(), intent, flags())
  }

  private fun openIntent(context: Context, eventId: String): PendingIntent {
    val intent = Intent(context, PaymentActionActivity::class.java).apply {
      action = ACTION_OPEN
      putExtra(EXTRA_EVENT_ID, eventId)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    return PendingIntent.getActivity(context, ("open:$eventId").hashCode(), intent, flags())
  }

  /** IGNORE is a broadcast for the same reason ADD is: dismissing a
   *  suggestion must not open an app. */
  private fun ignoreIntent(context: Context, eventId: String): PendingIntent {
    val intent = Intent(context, PaymentActionReceiver::class.java).apply {
      action = ACTION_IGNORE
      putExtra(EXTRA_EVENT_ID, eventId)
    }
    return PendingIntent.getBroadcast(context, ("ignore:$eventId").hashCode(), intent, flags())
  }
}
