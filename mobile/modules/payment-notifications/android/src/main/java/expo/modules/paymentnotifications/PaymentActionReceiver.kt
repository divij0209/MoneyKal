package expo.modules.paymentnotifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Handles the notification's two buttons, without opening MoneyKal.
 *
 * Both are receivers on purpose. Pressing a button in the shade should not pull
 * the user out of whatever app they are in — they already answered the
 * question, and launching an activity to "confirm" it again is exactly the
 * interruption the notification exists to avoid. A receiver starts no activity,
 * so Android 12's trampoline restriction does not apply here.
 *
 * ADD records the approval and, if MoneyKal happens to be running, nudges it to
 * write the transaction immediately. The write itself never happens here: it
 * needs the user's session and has to go through the same Hisaab mutation as
 * every other transaction, and neither of those exists in a receiver. When the
 * app is not running — or is signed out, or locked — the approval simply waits
 * in the store and is saved the next time MoneyKal opens. That is what keeps
 * the authentication rules intact while still making the button instant.
 */
class PaymentActionReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context?, intent: Intent?) {
    if (context == null || intent == null) return

    val app = context.applicationContext
    val eventId = intent.getStringExtra(PaymentNotificationPresenter.EXTRA_EVENT_ID)
    if (eventId.isNullOrEmpty()) return

    try {
      when (intent.action) {
        PaymentNotificationPresenter.ACTION_ADD -> {
          PaymentNotificationStore.approve(app, eventId)
          PaymentNotificationPresenter.cancel(app, eventId)
          Log.i(TAG, "User approved payment $eventId from the notification")

          // If a React context is alive — the app is backgrounded but running,
          // signed in and unlocked — hand it the approved event so it saves now
          // instead of at the next launch. Null when MoneyKal is not running,
          // which is fine: the approval is already on disk.
          val deliver = PaymentNotificationBus.onEvent
          if (deliver != null) {
            val event = PaymentNotificationStore.find(app, eventId)
            if (event != null) deliver.invoke(event)
          }
        }

        PaymentNotificationPresenter.ACTION_IGNORE -> {
          // consume() drops it from the queue; the id stays in the store's
          // permanent `processed` ledger, so it is never offered again.
          PaymentNotificationStore.consume(app, setOf(eventId))
          PaymentNotificationPresenter.cancel(app, eventId)
          Log.i(TAG, "User ignored payment $eventId from the notification")
        }
      }
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to handle notification action ${intent.action}", t)
    }
  }

  private companion object {
    const val TAG = "MoneyKalNotifications"
  }
}
