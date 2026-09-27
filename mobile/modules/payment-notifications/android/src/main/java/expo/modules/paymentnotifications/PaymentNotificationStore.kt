package expo.modules.paymentnotifications

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The on-device queue of captured payment notifications.
 *
 * WHY A QUEUE AT ALL: a NotificationListenerService is bound by the system and
 * runs whether or not MoneyKal is open — Android will even start the process
 * just to deliver a notification. In that state there is no React context, no
 * JavaScript, and nothing to render, so the event cannot simply be handed to
 * JS. It is written here instead and drained the next time the app is
 * foregrounded. That is also what keeps the feature honest about the "do not
 * launch intrusive UI from the background" rule: capture is silent, and the
 * user only ever sees a confirmation inside MoneyKal.
 *
 * Nothing here is transmitted anywhere. This is SharedPreferences on the
 * device, read only by MoneyKal's own process.
 */
object PaymentNotificationStore {
  private const val PREFS = "moneykal_payment_notifications"
  private const val KEY_PENDING = "pending"
  private const val KEY_SEEN = "seen"
  private const val KEY_PROCESSED = "processed"

  /**
   * Ids of notifications already taken in, kept even after the user answers.
   *
   * The 5-minute content window below is about one notification being *updated*.
   * This is about the same notification being *seen again* — which happens every
   * time the listener rebinds and re-scans what is already on screen. Without a
   * permanent record, a payment the user reviewed this morning would be offered
   * again after the next reinstall, because the shade still holds it.
   */
  private const val MAX_PROCESSED = 500

  /** A phone left unopened for a week must not grow this without bound. Oldest
   *  entries are dropped first — a stale payment is less useful than a fresh one. */
  private const val MAX_PENDING = 200

  /**
   * Identical content inside this window is the same notification being
   * updated ("Payment successful" re-posted with a progress change), not a
   * second payment. Outside it, a genuine repeat — paying the same person the
   * same amount twice — is allowed through rather than silently swallowed.
   */
  private const val DEDUPE_WINDOW_MS = 5 * 60 * 1000L

  /** Bound on the dedupe ledger itself. */
  private const val MAX_SEEN = 400

  private const val KEY_SIGHTINGS = "sightings"

  /** A short rolling window — enough to cover one test payment, not a history. */
  private const val MAX_SIGHTINGS = 40

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /**
   * Records that a notification was examined, and what was decided about it.
   *
   * This exists to answer one question that is otherwise unanswerable without a
   * USB cable: when a payment is not detected, was the notification rejected —
   * or did the payment app never post one? Those need opposite fixes, and
   * guessing between them wastes everybody's time.
   *
   * DELIBERATELY NARROW. The caller only offers notifications that are money
   * related (they carry a currency amount) or come from a payment or messaging
   * app, so ordinary chat never lands on disk. It is capped, it is local to the
   * device, it is never uploaded, and "Clear" empties it.
   */
  @Synchronized
  fun recordSighting(
    context: Context,
    packageName: String,
    appLabel: String,
    title: String,
    text: String,
    verdict: String,
    now: Long,
  ) {
    val existing = readArray(prefs(context).getString(KEY_SIGHTINGS, null))

    // Drop any earlier record of the same notification before appending.
    //
    // The listener re-scans everything on screen on every rebind, and rebinds
    // happen often — app update, reboot, OEM process management. Without this
    // the list fills with the same few notifications repeated four and five
    // times, and the cap then evicts the genuinely new ones. That is not a
    // cosmetic problem: it is the diagnostics quietly deleting the evidence
    // they exist to preserve.
    val arr = JSONArray()
    for (i in 0 until existing.length()) {
      val item = existing.optJSONObject(i) ?: continue
      val same = item.optString("packageName") == packageName &&
        item.optString("title") == title &&
        item.optString("text") == text
      if (!same) arr.put(item)
    }

    arr.put(
      JSONObject().apply {
        put("packageName", packageName)
        put("appLabel", appLabel)
        put("title", title)
        put("text", text)
        put("verdict", verdict)
        put("at", now)
      },
    )
    prefs(context).edit()
      .putString(KEY_SIGHTINGS, trimToLast(arr, MAX_SIGHTINGS).toString())
      .apply()
  }

  @Synchronized
  fun sightings(context: Context): JSONArray =
    readArray(prefs(context).getString(KEY_SIGHTINGS, null))

  @Synchronized
  fun clearSightings(context: Context) {
    prefs(context).edit().remove(KEY_SIGHTINGS).apply()
  }

  fun sha256(input: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }

  /**
   * Records an event unless its content was already seen inside the dedupe
   * window. Returns true when the event was actually added, so the caller
   * knows whether to emit a live event to JS.
   */
  @Synchronized
  fun enqueue(context: Context, event: JSONObject, contentKey: String, now: Long): Boolean {
    val store = prefs(context)
    val id = event.optString("id")

    // Permanent guard, checked first. Survives consume(), so a notification the
    // user has already answered is never offered a second time — including when
    // it is still in the shade and gets re-scanned on the next listener bind.
    val processed = readArray(store.getString(KEY_PROCESSED, null))
    for (i in 0 until processed.length()) {
      if (processed.optString(i) == id) return false
    }

    val seen = readObject(store.getString(KEY_SEEN, null))
    val last = seen.optLong(contentKey, 0L)
    if (last > 0L && now - last < DEDUPE_WINDOW_MS) return false

    val pending = readArray(store.getString(KEY_PENDING, null))

    // Belt and braces alongside the `processed` guard above. Entries queued by
    // an earlier build predate `processed`, and a rebind re-scan would
    // otherwise queue them a second time once the content window has expired.
    for (i in 0 until pending.length()) {
      if (pending.optJSONObject(i)?.optString("id") == id) return false
    }

    seen.put(contentKey, now)
    pruneSeen(seen, now)

    pending.put(event)
    processed.put(id)

    store.edit()
      .putString(KEY_PENDING, trimToLast(pending, MAX_PENDING).toString())
      .putString(KEY_SEEN, seen.toString())
      .putString(KEY_PROCESSED, trimToLast(processed, MAX_PROCESSED).toString())
      .apply()

    return true
  }

  @Synchronized
  fun pending(context: Context): JSONArray =
    readArray(prefs(context).getString(KEY_PENDING, null))

  /** One stored event by id, or null. Used by the notification actions, which
   *  need the event itself to hand to a running app. */
  @Synchronized
  fun find(context: Context, id: String): JSONObject? {
    val pending = readArray(prefs(context).getString(KEY_PENDING, null))
    for (i in 0 until pending.length()) {
      val item = pending.optJSONObject(i) ?: continue
      if (item.optString("id") == id) return item
    }
    return null
  }

  /**
   * Records that the user pressed "ADD TO MONEYKAL" on the system notification.
   *
   * The flag rides on the stored event rather than triggering a write here: the
   * transaction has to go through the app's own mutation, with its session and
   * its app lock, and none of that exists in the notification's process. So the
   * answer is recorded and the app acts on it the next time it drains.
   */
  @Synchronized
  fun approve(context: Context, id: String) {
    val pending = readArray(prefs(context).getString(KEY_PENDING, null))
    var changed = false
    for (i in 0 until pending.length()) {
      val item = pending.optJSONObject(i) ?: continue
      if (item.optString("id") == id) {
        item.put("approved", true)
        changed = true
      }
    }
    if (changed) {
      prefs(context).edit().putString(KEY_PENDING, pending.toString()).apply()
    }
  }

  /**
   * Drops events the user has resolved — added or ignored. Called from JS once
   * the confirmation has been answered, so a handled payment cannot reappear
   * on the next launch.
   */
  @Synchronized
  fun consume(context: Context, ids: Set<String>) {
    if (ids.isEmpty()) return
    val pending = readArray(prefs(context).getString(KEY_PENDING, null))
    val kept = JSONArray()
    for (i in 0 until pending.length()) {
      val item = pending.optJSONObject(i) ?: continue
      if (item.optString("id") !in ids) kept.put(item)
    }
    prefs(context).edit().putString(KEY_PENDING, kept.toString()).apply()
  }

  /** Clears the queue. The dedupe ledger is kept: forgetting it would let
   *  every already-handled notification be captured again. */
  @Synchronized
  fun clear(context: Context) {
    prefs(context).edit().putString(KEY_PENDING, JSONArray().toString()).apply()
  }

  private fun readArray(raw: String?): JSONArray =
    try {
      if (raw.isNullOrBlank()) JSONArray() else JSONArray(raw)
    } catch (_: Throwable) {
      // Corrupt stored JSON must not take the listener down with it.
      JSONArray()
    }

  private fun readObject(raw: String?): JSONObject =
    try {
      if (raw.isNullOrBlank()) JSONObject() else JSONObject(raw)
    } catch (_: Throwable) {
      JSONObject()
    }

  private fun trimToLast(array: JSONArray, max: Int): JSONArray {
    if (array.length() <= max) return array
    val out = JSONArray()
    for (i in (array.length() - max) until array.length()) out.put(array.get(i))
    return out
  }

  /** Drops window-expired entries, then the oldest if still over the cap. */
  private fun pruneSeen(seen: JSONObject, now: Long) {
    val expired = seen.keys().asSequence()
      .filter { now - seen.optLong(it, 0L) > DEDUPE_WINDOW_MS }
      .toList()
    expired.forEach { seen.remove(it) }

    if (seen.length() <= MAX_SEEN) return
    seen.keys().asSequence()
      .sortedBy { seen.optLong(it, 0L) }
      .take(seen.length() - MAX_SEEN)
      .toList()
      .forEach { seen.remove(it) }
  }
}
