package expo.modules.paymentnotifications

/**
 * The payment-reading rules, in Kotlin.
 *
 * WHY THIS EXISTS AT ALL — and read this before editing either copy.
 *
 * The canonical rules live in src/features/paymentDetection/parser.ts and that
 * file is still the reference. They had to be mirrored here because the feature
 * changed shape: MoneyKal now posts its own Android notification the moment a
 * payment is detected, and that has to work while the app is closed. When
 * Android starts this process purely to deliver a notification there is no
 * React context and no JavaScript, so parser.ts cannot run and cannot supply
 * the "₹700 paid to Rahul" line the notification has to show.
 *
 * These two implementations must be changed together. The rule ids, the reject
 * list, the direction vocabularies and the merchant patterns are deliberately
 * transcribed one-for-one so a diff between the files is readable.
 *
 * At runtime this copy is the one that decides: the parse is stored on the
 * event, and the JS side prefers the stored result over re-parsing. parser.ts
 * remains as the reference and as the fallback for any event that reaches JS
 * without a stored parse.
 */
object PaymentNotificationParser {

  data class Parsed(
    /** Rupees. Always > 0. */
    val amount: Double,
    /** "out" = money left the account, "in" = money arrived. */
    val direction: String,
    /** Merchant, payee or payer; null when the notification did not say. */
    val merchant: String?,
    /** Which merchant rule matched, or "none". */
    val ruleId: String,
  )

  private val IC = setOf(RegexOption.IGNORE_CASE)

  /* ---------------------------------------------------------------- reject -- */

  /** Mentions money but is not a completed payment. Checked before anything
   *  else — a payment request, a failure and a bill reminder all carry an
   *  amount and a payment word. */
  private val REJECT = listOf(
    Regex("\\brequest(?:ed|ing|s)?\\b", IC),
    Regex("\\bfail(?:ed|ure)?\\b", IC),
    Regex("\\bdeclined\\b", IC),
    Regex("\\bcancell?ed\\b", IC),
    Regex("\\breversed\\b", IC),
    Regex("\\bpending\\b", IC),
    Regex("\\bdue\\b", IC),
    Regex("\\breminder\\b", IC),
    Regex("\\bwill be\\b", IC),
    Regex("\\bexpir(?:es|ing|ed)\\b", IC),
    Regex("\\boffer\\b", IC),
    Regex("\\bcoupon\\b", IC),
    Regex("\\bup to\\b", IC),
    Regex("\\bflat \\d+% off\\b", IC),
    Regex("\\bmandate\\b", IC),
  )

  /* ---------------------------------------------------------------- amount -- */

  private val AMOUNT_PREFIXED = Regex("(?:₹|INR|Rs\\.?)\\s*(\\d[\\d,]*(?:\\.\\d{1,2})?)", IC)
  private val AMOUNT_SUFFIXED = Regex("(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*(?:₹|INR|Rs\\.?)\\b", IC)

  /** An amount preceded by one of these is a balance, not the transaction. */
  private val BALANCE_CONTEXT =
    Regex("\\b(?:bal|balance|available|avl|limit|outstanding|remaining)\\b[^.]{0,24}\$", IC)

  private const val BALANCE_LOOKBEHIND = 32

  /* ------------------------------------------------------------- direction -- */

  /**
   * Money arriving, described from the *other* person's side.
   *
   * "Divij paid you ₹1" and "divij sent ₹1.00 to You" both carry a debit verb
   * — paid, sent — but the person doing the paying is not the user. Read by the
   * generic vocabulary below these come out as money leaving, which turns
   * every payment received into a recorded expense. Checked before everything
   * else because the verb alone is genuinely ambiguous; only the "you" settles
   * it. `\byou\b` will not match "your" or "Younis".
   */
  private val INCOMING_TO_ME = Regex(
    "\\b(?:paid|sent|transferred)\\s+(?:to\\s+)?you\\b" +
      "|\\bto\\s+you\\b" +
      "|\\bcredited\\s+to\\s+your\\b" +
      "|\\byou\\s+(?:have\\s+)?(?:got|received)\\b",
    IC,
  )

  /**
   * Money leaving, stated as a debit from the user's own account.
   *
   * Decisive even when the same sentence goes on to say "and credited to
   * <payee>" — a very common bank phrasing, e.g. "Rs.1.00 debited from A/c
   * XX9797 and credited to divij@okaxis". That trailing "credited" is the
   * payee's side of *our* debit, and letting the generic credit vocabulary see
   * it first reports the user's own payment as income.
   */
  private val OUTGOING_FROM_ME = Regex("\\bdebited\\s+from\\b", IC)

  /** Checked after the two above: these are the specific words, where the debit
   *  vocabulary contains generic ones like "payment". */
  private val CREDIT_WORDS =
    Regex("\\b(?:credited|received|refund(?:ed)?|deposit(?:ed)?|cashback|added to your)\\b", IC)

  private val DEBIT_WORDS = Regex(
    "\\b(?:debited|paid|sent|spent|withdrawn|deducted|charged|payment|purchase|transferred|transfer)\\b",
    IC,
  )

  /* -------------------------------------------------------------- merchant -- */

  private data class MerchantRule(val id: String, val direction: String, val pattern: Regex)

  /** Ordered — first match wins, most specific phrasings first. */
  private val MERCHANT_RULES = listOf(
    MerchantRule("paid-to", "out", Regex("\\bpaid to\\s+(.+)\$", IC)),
    MerchantRule("sent-to", "out", Regex("\\b(?:sent|transferred)\\s+to\\s+(.+)\$", IC)),
    MerchantRule("spent-at", "out", Regex("\\b(?:at|towards)\\s+(.+)\$", IC)),
    MerchantRule("received-from", "in", Regex("\\b(?:received|credited)\\s+from\\s+(.+)\$", IC)),
    MerchantRule("from", "in", Regex("\\bfrom\\s+(.+)\$", IC)),
    MerchantRule("to", "out", Regex("\\bto\\s+(.+)\$", IC)),
  )

  private val MERCHANT_STOPWORDS = setOf(
    "you", "your account", "your bank account", "account", "your wallet",
    "wallet", "a/c", "bank", "your upi", "upi", "merchant", "the merchant",
    "your card",
  )

  private val MERCHANT_TAIL =
    Regex("\\s+(?:on|via|using|through|for|with|by|ref|txn|utr|upi|at)\\b.*\$", IC)

  private val ONLY_DIGITS_OR_MASK = Regex("^[\\d*Xx\\s-]+\$")
  private val HAS_LETTER = Regex("[A-Za-z]")
  private val TRAILING_PUNCT = Regex("[\\s,:-]+\$")
  private val WHITESPACE = Regex("\\s+")

  /* ------------------------------------------------------------------ main -- */

  /**
   * Reads a notification's title and body together.
   *
   * Returns null when it is not a completed payment or the amount cannot be
   * read — never a guess. A missing merchant is fine and does not reject the
   * payment: "₹700, from PhonePe" is still worth confirming.
   */
  fun parse(title: String, body: String): Parsed? = parseText("$title $body")

  fun parseText(input: String): Parsed? {
    val text = WHITESPACE.replace(input, " ").trim()
    if (text.isEmpty()) return null
    if (REJECT.any { it.containsMatchIn(text) }) return null

    val amount = extractAmount(text) ?: return null
    val direction = extractDirection(text) ?: return null
    val merchant = extractMerchant(text, direction)

    return Parsed(
      amount = amount,
      direction = direction,
      merchant = merchant?.first,
      ruleId = merchant?.second ?: "none",
    )
  }

  /** The first amount that is not describing a balance. */
  fun extractAmount(text: String): Double? {
    val hits = ArrayList<Pair<Double, Int>>()

    for (re in listOf(AMOUNT_PREFIXED, AMOUNT_SUFFIXED)) {
      for (m in re.findAll(text)) {
        val raw = m.groupValues[1].replace(",", "")
        val value = raw.toDoubleOrNull() ?: continue
        if (value <= 0.0) continue
        val start = m.range.first
        val before = text.substring(maxOf(0, start - BALANCE_LOOKBEHIND), start)
        if (BALANCE_CONTEXT.containsMatchIn(before)) continue
        hits.add(value to start)
      }
    }

    return hits.minByOrNull { it.second }?.first
  }

  fun extractDirection(text: String): String? = when {
    INCOMING_TO_ME.containsMatchIn(text) -> "in"
    OUTGOING_FROM_ME.containsMatchIn(text) -> "out"
    CREDIT_WORDS.containsMatchIn(text) -> "in"
    DEBIT_WORDS.containsMatchIn(text) -> "out"
    else -> null
  }

  /** Returns merchant to ruleId, or null. */
  private fun extractMerchant(text: String, direction: String): Pair<String, String>? {
    for (rule in MERCHANT_RULES) {
      if (rule.direction != direction) continue
      val candidate = rule.pattern.find(text)?.groupValues?.getOrNull(1) ?: continue
      val cleaned = cleanMerchant(candidate) ?: continue
      return cleaned to rule.id
    }
    return null
  }

  private fun cleanMerchant(candidate: String): String? {
    // The name never spans a sentence boundary.
    var name = candidate.trim().split('.', '!', ';', '\n')[0]
    name = MERCHANT_TAIL.replace(name, "")
    name = TRAILING_PUNCT.replace(name, "").trim()

    if (name.isEmpty()) return null
    if (name.length > 48) return null
    if (name.lowercase() in MERCHANT_STOPWORDS) return null
    // A bare reference number or masked account is not a merchant.
    if (ONLY_DIGITS_OR_MASK.matches(name)) return null
    if (!HAS_LETTER.containsMatchIn(name)) return null

    return name
  }
}
