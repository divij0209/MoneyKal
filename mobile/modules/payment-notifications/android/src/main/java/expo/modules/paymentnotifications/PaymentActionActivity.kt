package expo.modules.paymentnotifications

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * Handles "ADD TO MONEYKAL" and a tap on the notification body.
 *
 * It draws nothing and finishes immediately — it exists only because Android 12
 * forbids notification trampolines, so anything that brings MoneyKal to the
 * front has to be an activity PendingIntent rather than a receiver that then
 * calls startActivity.
 *
 * It does not add the transaction itself. It records the user's answer on the
 * stored event and opens the app; the write happens in JS through the existing
 * Hisaab mutation, behind the existing auth and app-lock rules. That is what
 * keeps "no transaction without confirmation" and "no bypassing authentication"
 * true even though the entry point is now outside the app.
 */
class PaymentActionActivity : Activity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    try {
      val eventId = intent?.getStringExtra(PaymentNotificationPresenter.EXTRA_EVENT_ID)
      val action = intent?.action

      if (eventId.isNullOrEmpty()) {
        Log.w(TAG, "Action activity started with no event id")
        openMoneyKal()
      } else if (action == PaymentNotificationPresenter.ACTION_ADD) {
        // ADD is a broadcast now and no longer routes here. This branch only
        // catches a PendingIntent from a notification posted by an older build
        // that is still sitting in the shade — and it must behave like the new
        // one: record the approval, take the notification down, open nothing.
        PaymentNotificationStore.approve(applicationContext, eventId)
        PaymentNotificationPresenter.cancel(applicationContext, eventId)
        Log.i(TAG, "User approved payment $eventId (legacy action intent)")
      } else {
        // Body tap. This is the one path that is *meant* to open MoneyKal, so
        // the existing confirmation flow can run.
        PaymentNotificationPresenter.cancel(applicationContext, eventId)
        Log.i(TAG, "User opened payment $eventId from the notification")
        openMoneyKal()
      }
    } catch (t: Throwable) {
      Log.e(TAG, "Failed to handle notification action", t)
    } finally {
      // Never leave this on the back stack; it has no UI to return to.
      finish()
      overridePendingTransition(0, 0)
    }
  }

  /** Brings the app's own task forward, or starts it if it is not running. */
  private fun openMoneyKal() {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch == null) {
      Log.w(TAG, "No launcher intent for ${packageName}")
      return
    }
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    startActivity(launch)
  }

  private companion object {
    const val TAG = "MoneyKalNotifications"
  }
}
