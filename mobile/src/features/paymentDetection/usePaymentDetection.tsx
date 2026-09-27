import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import {
  addPaymentNotificationListener,
  consumeEvents,
  getPendingEvents,
  getStatus,
  isSupported,
  setAppForeground,
  type RawNotificationEvent,
} from '../../../modules/payment-notifications';
import { hisaabApi } from '../../api';
import type { Transaction } from '../../api/types';
import { dateKey } from '../hisaab/constants';
import { hisaabQueryKey, useHisaabMutations } from '../hisaab/hooks';
import { parsePaymentNotification, type ParsedPayment } from './parser';
import { DEFAULT_CATEGORY, PaymentDetectedSheet } from './PaymentDetectedSheet';

/** Backoff between retries of an approved save. Short enough that reconnecting
 *  feels immediate, capped so a phone left offline overnight does not spin. */
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 60_000;

/** A capture the parser could read, waiting for the user to confirm it. */
export interface DetectedPayment {
  raw: RawNotificationEvent;
  parsed: ParsedPayment;
}

interface PaymentDetectionValue {
  /** Everything waiting, oldest first. */
  queue: DetectedPayment[];
  /** The one currently being offered, or null. */
  current: DetectedPayment | null;
}

const PaymentDetectionContext = createContext<PaymentDetectionValue>({
  queue: [],
  current: null,
});

export function usePaymentDetection(): PaymentDetectionValue {
  return useContext(PaymentDetectionContext);
}

/**
 * Prefers the parse the native listener already did.
 *
 * The system notification in the shade was built from the native parse, so
 * reusing it is what guarantees the sheet says the same thing the notification
 * said. parser.ts stays as the fallback for any event without a stored parse.
 */
function toDetected(raw: RawNotificationEvent): DetectedPayment | null {
  if (
    typeof raw.amount === 'number' &&
    raw.amount > 0 &&
    (raw.direction === 'in' || raw.direction === 'out')
  ) {
    return {
      raw,
      parsed: {
        amount: raw.amount,
        direction: raw.direction,
        merchant: raw.merchant ?? null,
        ruleId: raw.ruleId ?? 'none',
      },
    };
  }

  const parsed = parsePaymentNotification(raw);
  return parsed ? { raw, parsed } : null;
}

/**
 * Whether the ledger already contains this detection.
 *
 * A save can reach the server and have only its *response* lost — the row
 * exists, the client saw an error. Checking before a retry is what stops one
 * payment on a flaky connection becoming two or three. Matched on the fields
 * this flow controls, all of which are derived from the notification and so are
 * identical on every attempt.
 */
function alreadyRecorded(
  transactions: Transaction[],
  item: DetectedPayment,
  description: string,
): boolean {
  const txnDate = dateKey(new Date(item.raw.postedAt));
  return transactions.some(
    (t) =>
      t.source === 'notification' &&
      t.type === item.parsed.direction &&
      t.txn_date === txnDate &&
      Math.abs(t.amount - item.parsed.amount) < 0.005 &&
      (t.description ?? '') === description,
  );
}

/**
 * Drains captured payment notifications and offers them for confirmation.
 *
 * WHERE THIS SITS: mounted inside the signed-in navigator, so it is alive only
 * when there is a session and the app lock has been passed (see RootNavigator).
 * That is deliberate on two counts — a sheet carrying an amount can never
 * appear over the lock screen, and while the app is locked or signed out this
 * subtree is unmounted, which reports "not foreground" to the listener and
 * sends detections to the notification shade instead. The user still finds out
 * about the payment; they just have to get past the lock to act on it.
 *
 * NOTHING IS SAVED WITHOUT CONFIRMATION. The write happens either when the user
 * presses Add in the sheet, or when they pressed "ADD TO MONEYKAL" on the
 * system notification — both are the user's answer, and both go through the
 * existing Hisaab mutation.
 */
export function PaymentDetectionProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<DetectedPayment[]>([]);
  /** Bumped when a retry becomes due, to re-run the save effect. */
  const [retryTick, setRetryTick] = useState(0);

  const { create } = useHisaabMutations();
  const qc = useQueryClient();

  /** How many save attempts each approved event has had, for backoff and to
   *  know when a duplicate check is warranted. */
  const attempts = useRef<Map<string, number>>(new Map());
  /** Earliest time each event may be tried again. Enforces the backoff no
   *  matter what caused the effect to re-run. */
  const nextAttemptAt = useRef<Map<string, number>>(new Map());
  const retryTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /** Ids already in the queue or already resolved this session. Guards against
   *  the same capture arriving twice — once live, once from a drain. */
  const seen = useRef<Set<string>>(new Set());
  /** Auto-saves in flight, so a re-render cannot start a second write for the
   *  same event and create a duplicate transaction. */
  const saving = useRef<Set<string>>(new Set());

  const ingest = useCallback((events: RawNotificationEvent[]) => {
    if (events.length === 0) return;

    const additions: DetectedPayment[] = [];
    const unreadable: string[] = [];

    for (const raw of events) {
      if (seen.current.has(raw.id)) continue;
      seen.current.add(raw.id);

      const detected = toDetected(raw);
      if (detected) additions.push(detected);
      // The native side already drops anything it could not read confidently,
      // so this is now only a guard for events stored by an older build.
      else unreadable.push(raw.id);
    }

    if (unreadable.length > 0) consumeEvents(unreadable);
    if (additions.length > 0) setQueue((q) => [...q, ...additions]);
  }, []);

  /** Reads whatever the listener stored while MoneyKal was closed. */
  const drain = useCallback(() => {
    if (!isSupported) return;

    // getStatus() asks Android to rebind the listener if access is granted but
    // the service is not currently bound. That matters more than it sounds: a
    // listener is unbound by an app update and by aggressive OEM process
    // management (Samsung, Xiaomi, Oppo), and while unbound it receives
    // nothing. Nudging on every foreground — not only when Settings happens to
    // be open — is what keeps detection alive between reinstalls. The rebind
    // then re-scans notifications already on screen, so a payment made just
    // before the app opened is still caught.
    getStatus();

    ingest(getPendingEvents());
  }, [ingest]);

  useEffect(() => {
    if (!isSupported) return;

    // This subtree only exists when the app is signed in, unlocked and
    // rendering, so mounting is exactly the moment MoneyKal is on screen.
    setAppForeground(true);
    drain();

    const sub = addPaymentNotificationListener((event) => ingest([event]));

    const appState = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setAppForeground(active);
      if (active) drain();
    });

    return () => {
      // Signed out, locked, or unmounting: from here on a detection belongs in
      // the notification shade, not in a sheet nobody is looking at.
      setAppForeground(false);
      sub?.remove();
      appState.remove();
    };
  }, [drain, ingest]);

  /** Marks an event resolved, whichever way it was answered. */
  const resolve = useCallback((id: string) => {
    consumeEvents([id]);
    setQueue((q) => q.filter((item) => item.raw.id !== id));
    saving.current.delete(id);
  }, []);

  /* ------------------------------------------------ ADD from the shade ----
     The user already answered by pressing "ADD TO MONEYKAL" on the
     notification; the native side recorded that on the event. The write itself
     waits until here on purpose — it needs the session and has to go through
     the same mutation as every other transaction, neither of which exists in
     the notification's process.

     APPROVAL IS PERMANENT. A save can fail for reasons that have nothing to do
     with the user's intent — no network yet, or the session still being
     restored moments after the app was launched from the notification. Turning
     that into "here is the question again" asks someone to answer twice and
     makes the Add button feel broken. So a failure only schedules another
     attempt; the event stays approved, stays stored natively, and is retried
     until it lands. */
  useEffect(() => {
    const now = Date.now();
    const approved = queue.filter(
      (d) =>
        d.raw.approved &&
        !saving.current.has(d.raw.id) &&
        (nextAttemptAt.current.get(d.raw.id) ?? 0) <= now,
    );
    if (approved.length === 0) return;

    for (const item of approved) {
      const id = item.raw.id;
      saving.current.add(id);

      void (async () => {
        const attempt = (attempts.current.get(id) ?? 0) + 1;
        attempts.current.set(id, attempt);

        const description = item.parsed.merchant || item.raw.title || 'Detected payment';

        try {
          // Only on a retry: the earlier attempt may have reached the server
          // and lost only its reply. Skipping the write in that case is what
          // keeps a flaky connection from recording the payment twice.
          if (attempt > 1) {
            const ledger = await qc.fetchQuery({
              queryKey: hisaabQueryKey,
              queryFn: hisaabApi.fetchHisaab,
            });
            if (alreadyRecorded(ledger.transactions ?? [], item, description)) {
              attempts.current.delete(id);
              nextAttemptAt.current.delete(id);
              resolve(id);
              return;
            }
          }

          await create.mutateAsync({
            type: item.parsed.direction,
            category: DEFAULT_CATEGORY[item.parsed.direction],
            amount: item.parsed.amount,
            description,
            txn_date: dateKey(new Date(item.raw.postedAt)),
            source: 'notification',
          });

          // Saved. resolve() consumes it natively, so it is gone for good.
          attempts.current.delete(id);
          nextAttemptAt.current.delete(id);
          resolve(id);
        } catch {
          // Never re-offered as a question — only tried again.
          saving.current.delete(id);
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
          nextAttemptAt.current.set(id, Date.now() + delay);
          retryTimers.current.push(setTimeout(() => setRetryTick((t) => t + 1), delay));
        }
      })();
    }
  }, [queue, retryTick, create, resolve, qc]);

  /** Timers must not outlive the provider — signing out unmounts this. */
  useEffect(
    () => () => {
      retryTimers.current.forEach(clearTimeout);
      retryTimers.current = [];
    },
    [],
  );

  /* Approved items are being saved in the background and are never offered as
     a sheet. The user answered on the notification; asking again would be
     asking twice. */
  const visible = useMemo(() => queue.filter((d) => !d.raw.approved), [queue]);

  const current = visible[0] ?? null;

  const value = useMemo<PaymentDetectionValue>(
    () => ({ queue: visible, current }),
    [visible, current],
  );

  return (
    <PaymentDetectionContext.Provider value={value}>
      {children}
      <PaymentDetectedSheet
        detected={current}
        remaining={Math.max(0, visible.length - 1)}
        onResolved={resolve}
      />
    </PaymentDetectionContext.Provider>
  );
}
