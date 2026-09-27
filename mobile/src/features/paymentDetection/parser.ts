import type { RawNotificationEvent } from '../../../modules/payment-notifications';

/**
 * Turns a payment notification into a transaction candidate.
 *
 * DETERMINISTIC BY DESIGN. No model, no network, no inference — regex and
 * ordered rules only. A notification either matches something this file knows
 * how to read, or it is dropped. That matters more than coverage: a wrong
 * amount silently added to someone's ledger is worse than a payment MoneyKal
 * simply did not notice, and the user confirms every result anyway.
 *
 * TO ADD A NEW FORMAT: add an entry to MERCHANT_RULES (who the money moved to
 * or from) or extend DEBIT_WORDS / CREDIT_WORDS (which direction it moved).
 * Both are plain values, and neither requires touching the native module or
 * rebuilding the app — this is why parsing lives in TypeScript rather than in
 * the listener service.
 */

export interface ParsedPayment {
  /** Rupees. Always > 0. */
  amount: number;
  /** 'out' = money left the account, 'in' = money arrived. */
  direction: 'in' | 'out';
  /** Merchant, payee or payer. null when the notification did not say —
   *  which is common and is NOT a reason to reject the payment. */
  merchant: string | null;
  /** Which merchant rule matched, or 'none'. Surfaced in the debug card so a
   *  mis-read can be traced to the rule responsible. */
  ruleId: string;
}

/* ------------------------------------------------------------------ text -- */

/** Collapses whitespace so the rules can assume single spaces. */
function normalize(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/* ---------------------------------------------------------------- reject -- */

/**
 * Notifications that mention money but are not a completed payment.
 *
 * Checked before anything else. "Payment request", "payment failed" and
 * "your bill is due" all contain an amount and a payment word, and every one
 * of them would otherwise become a transaction the user never made.
 */
const REJECT_PATTERNS: RegExp[] = [
  /\brequest(?:ed|ing|s)?\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bdeclined\b/i,
  /\bcancell?ed\b/i,
  /\breversed\b/i,
  /\bpending\b/i,
  /\bdue\b/i,
  /\breminder\b/i,
  /\bwill be\b/i,
  /\bexpir(?:es|ing|ed)\b/i,
  /\boffer\b/i,
  /\bcoupon\b/i,
  // "Win up to ₹10,000 cashback", "Save up to ₹500", "Earn up to ₹200".
  // Marketing quotes a ceiling; a real transaction states an exact figure, so
  // "up to" anywhere in the text disqualifies it.
  /\bup to\b/i,
  /\bflat \d+% off\b/i,
  /\bmandate\b/i,
];

function isRejected(text: string): boolean {
  return REJECT_PATTERNS.some((re) => re.test(text));
}

/* ---------------------------------------------------------------- amount -- */

/** "₹500", "₹ 1,200.50", "INR 700", "Rs. 500", "Rs 1,00,000". */
const AMOUNT_PREFIXED = /(?:₹|INR|Rs\.?)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;
/** "500 INR" — the same amount written the other way round. */
const AMOUNT_SUFFIXED = /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|INR|Rs\.?)\b/gi;

/**
 * Words that make a nearby number a balance rather than the payment.
 *
 * "Rs 500 debited. Avl bal Rs 12,340" contains two amounts and the second is
 * not the transaction. Any amount preceded by one of these inside the
 * preceding window is skipped.
 */
const BALANCE_CONTEXT =
  /\b(?:bal|balance|available|avl|limit|outstanding|remaining)\b[^.]{0,24}$/i;

const BALANCE_LOOKBEHIND = 32;

function toNumber(raw: string): number | null {
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The first amount in the string that is not describing a balance. */
export function extractAmount(text: string): number | null {
  const candidates: { value: number; index: number }[] = [];

  for (const re of [AMOUNT_PREFIXED, AMOUNT_SUFFIXED]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = toNumber(match[1]);
      if (value === null) continue;
      const before = text.slice(Math.max(0, match.index - BALANCE_LOOKBEHIND), match.index);
      if (BALANCE_CONTEXT.test(before)) continue;
      candidates.push({ value, index: match.index });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0].value;
}

/* ------------------------------------------------------------- direction -- */

/**
 * Money arriving, described from the *other* person's side.
 *
 * "Divij paid you ₹1" and "divij sent ₹1.00 to You" both carry a debit verb —
 * paid, sent — but the payer is not the user. Read by the generic vocabulary
 * below, these come out as money leaving, which turns every payment received
 * into a recorded expense. Checked first because the verb alone is genuinely
 * ambiguous; only the "you" settles it. `\byou\b` will not match "your" or
 * "Younis".
 */
const INCOMING_TO_ME =
  /\b(?:paid|sent|transferred)\s+(?:to\s+)?you\b|\bto\s+you\b|\bcredited\s+to\s+your\b|\byou\s+(?:have\s+)?(?:got|received)\b/i;

/**
 * Money leaving, stated as a debit from the user's own account.
 *
 * Decisive even when the sentence continues "and credited to <payee>" — a
 * common bank phrasing, e.g. "Rs.1.00 debited from A/c XX9797 and credited to
 * divij@okaxis". That trailing "credited" is the payee's side of our debit.
 */
const OUTGOING_FROM_ME = /\bdebited\s+from\b/i;

/** Money arriving. Checked after the two above: these are the specific words,
 *  where the debit vocabulary contains generic ones like "payment". */
const CREDIT_WORDS =
  /\b(?:credited|received|refund(?:ed)?|deposit(?:ed)?|cashback|added to your)\b/i;

/** Money leaving. */
const DEBIT_WORDS =
  /\b(?:debited|paid|sent|spent|withdrawn|deducted|charged|payment|purchase|transferred|transfer)\b/i;

export function extractDirection(text: string): 'in' | 'out' | null {
  if (INCOMING_TO_ME.test(text)) return 'in';
  if (OUTGOING_FROM_ME.test(text)) return 'out';
  if (CREDIT_WORDS.test(text)) return 'in';
  if (DEBIT_WORDS.test(text)) return 'out';
  return null;
}

/* -------------------------------------------------------------- merchant -- */

export interface MerchantRule {
  id: string;
  /** Which direction this rule is meaningful for, or 'any'. */
  direction: 'in' | 'out' | 'any';
  pattern: RegExp;
}

/**
 * Ordered — the first match wins, so the most specific phrasings come first.
 *
 * THIS IS THE EXTENSION POINT. A new bank's wording is one more entry here.
 */
export const MERCHANT_RULES: MerchantRule[] = [
  // "₹700 paid to Rahul", "You paid ₹500 to Swiggy"
  { id: 'paid-to', direction: 'out', pattern: /\bpaid to\s+(.+)$/i },
  // "Money sent to Rahul", "₹500 transferred to Kirana Store"
  { id: 'sent-to', direction: 'out', pattern: /\b(?:sent|transferred)\s+to\s+(.+)$/i },
  // "₹500 spent at Big Bazaar", "Payment detected: ₹500 at Swiggy"
  { id: 'spent-at', direction: 'out', pattern: /\b(?:at|towards)\s+(.+)$/i },
  // "₹500 received from Rahul", "INR 500 credited from ..."
  { id: 'received-from', direction: 'in', pattern: /\b(?:received|credited)\s+from\s+(.+)$/i },
  { id: 'from', direction: 'in', pattern: /\bfrom\s+(.+)$/i },
  // Generic trailing "to X", last because "to" appears in many other roles.
  { id: 'to', direction: 'out', pattern: /\bto\s+(.+)$/i },
];

/** Phrases that are grammatically a merchant but semantically noise. */
const MERCHANT_STOPWORDS = new Set([
  'you',
  'your account',
  'your bank account',
  'account',
  'your wallet',
  'wallet',
  'a/c',
  'bank',
  'your upi',
  'upi',
  'merchant',
  'the merchant',
  'your card',
]);

/** Trailing clauses that are not part of the name. */
const MERCHANT_TAIL = /\s+(?:on|via|using|through|for|with|by|ref|txn|utr|upi|at)\b.*$/i;

function cleanMerchant(candidate: string): string | null {
  let name = candidate.trim();

  // Cut at the first sentence boundary — the name never spans one.
  name = name.split(/[.!;\n]/)[0] ?? name;
  name = name.replace(MERCHANT_TAIL, '');
  name = name.replace(/[\s,:-]+$/, '').trim();

  if (!name) return null;
  if (name.length > 48) return null;
  if (MERCHANT_STOPWORDS.has(name.toLowerCase())) return null;
  // A bare reference number or masked account is not a merchant.
  if (/^[\d*Xx\s-]+$/.test(name)) return null;
  // Needs at least one letter to be a name at all.
  if (!/[A-Za-z]/.test(name)) return null;

  return name;
}

export function extractMerchant(
  text: string,
  direction: 'in' | 'out',
): { merchant: string; ruleId: string } | null {
  for (const rule of MERCHANT_RULES) {
    if (rule.direction !== 'any' && rule.direction !== direction) continue;
    const match = rule.pattern.exec(text);
    if (!match?.[1]) continue;
    const merchant = cleanMerchant(match[1]);
    if (merchant) return { merchant, ruleId: rule.id };
  }
  return null;
}

/* ------------------------------------------------------------------ main -- */

/**
 * Reads one captured notification.
 *
 * Returns null when the notification is not a completed payment or when the
 * amount cannot be read — never a guess. A missing merchant is fine and does
 * NOT reject the payment: the user can still confirm "₹700, from PhonePe",
 * which is exactly the "amount without merchant" case the feature has to
 * support.
 */
export function parsePaymentNotification(raw: RawNotificationEvent): ParsedPayment | null {
  return parsePaymentText(`${raw.title} ${raw.text}`);
}

/** The same reading, over bare text. Split out so it can be exercised
 *  directly from the debug card without fabricating a full event. */
export function parsePaymentText(input: string): ParsedPayment | null {
  const text = normalize(input);
  if (!text) return null;
  if (isRejected(text)) return null;

  const amount = extractAmount(text);
  if (amount === null) return null;

  const direction = extractDirection(text);
  if (direction === null) return null;

  const merchant = extractMerchant(text, direction);

  return {
    amount,
    direction,
    merchant: merchant?.merchant ?? null,
    ruleId: merchant?.ruleId ?? 'none',
  };
}
