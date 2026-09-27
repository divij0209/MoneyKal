import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import { Button, Card, Chip, Text } from '../../components';
import { ListRow } from '../../components/primitives/ListRow';
import {
  clearSightings,
  emitTestNotification,
  getRecentSightings,
  openSettings,
  requestPostNotificationsPermission,
  type NotificationSighting,
} from '../../../modules/payment-notifications';
import { BUILD_PROFILE } from '../../config/env';
import { useTheme } from '../../theme';
import { useNotificationAccess } from './useNotificationAccess';

/** Sample notifications covering the formats the parser is built for. Cycled
 *  through by the debug button so repeated taps exercise different rules. */
const SAMPLES: { title: string; text: string; app: string; pkg: string }[] = [
  {
    title: 'Payment successful',
    text: '₹700 paid to Rahul',
    app: 'PhonePe',
    pkg: 'com.phonepe.app',
  },
  {
    title: 'Google Pay',
    text: 'You paid ₹500 to Swiggy',
    app: 'Google Pay',
    pkg: 'com.google.android.apps.nbu.paisa.user',
  },
  {
    title: 'Transaction alert',
    text: 'Your account has been debited by INR 700',
    app: 'Bank',
    pkg: 'com.moneykal.test.bank',
  },
  {
    title: 'UPI',
    text: 'UPI payment of ₹1,250 successful',
    app: 'Paytm',
    pkg: 'net.one97.paytm',
  },
  {
    title: 'Credit alert',
    text: '₹2,500 received from Rahul Sharma',
    app: 'PhonePe',
    pkg: 'com.phonepe.app',
  },
];

/** How long the deferred simulation waits, so there is time to leave the app. */
const DEFERRED_MS = 6000;

/**
 * Payment Notification Access — the permission surface in Settings.
 *
 * Two separate permissions live here and they are easy to confuse, so the card
 * names both. Notification *access* lets MoneyKal read other apps'
 * notifications and is granted on Android's own screen. POST_NOTIFICATIONS lets
 * MoneyKal show its own notification about what it found, and on Android 13+ is
 * a runtime request. Detection works with only the first; the payment just
 * waits in the app instead of reaching the shade.
 */
export function NotificationAccessCard() {
  const theme = useTheme();
  const { status, refresh, isSupported } = useNotificationAccess();
  const [sampleIndex, setSampleIndex] = useState(0);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [sightings, setSightings] = useState<NotificationSighting[] | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [],
  );

  /* Not built for iOS, and absent from Expo Go's runtime. Saying why beats a
     card that silently does nothing. */
  if (!isSupported) {
    return (
      <Card label="Automation" title="Payment Notification Access">
        <Text variant="bodySmall" color="muted">
          {Platform.OS === 'android'
            ? 'Not available in Expo Go — this needs the development build, which includes the native listener.'
            : 'Android only. Notification access has no iOS equivalent.'}
        </Text>
      </Card>
    );
  }

  const showDebug = __DEV__ || BUILD_PROFILE !== 'production';

  function fire(deferred: boolean) {
    const sample = SAMPLES[sampleIndex];
    setSampleIndex((i) => (i + 1) % SAMPLES.length);

    const run = () => {
      const captured = emitTestNotification(sample.title, sample.text, sample.app, sample.pkg);
      setCountdown(null);
      setTestNote(
        captured
          ? deferred
            ? 'Sent. If MoneyKal was in the background it is in your notification shade now.'
            : 'Captured — the confirmation should appear now.'
          : 'Not captured. Either it failed the payment rules, or it is a duplicate within the 5-minute window.',
      );
      refresh();
    };

    if (!deferred) return run();

    // Counts down visibly so it is obvious how long there is to press Home.
    setTestNote(null);
    setCountdown(Math.round(DEFERRED_MS / 1000));
    for (let s = 1; s <= DEFERRED_MS / 1000; s += 1) {
      timers.current.push(
        setTimeout(() => setCountdown(Math.round(DEFERRED_MS / 1000) - s), s * 1000),
      );
    }
    timers.current.push(setTimeout(run, DEFERRED_MS));
  }

  return (
    <Card label="Automation" title="Payment Notification Access">
      <Text variant="bodySmall" color="muted" style={{ marginBottom: theme.spacing.md }}>
        Lets MoneyKal notice payment notifications from UPI and banking apps and offer
        them as transactions. Notifications only — MoneyKal does not read or send SMS,
        and nothing is added without your confirmation.
      </Text>

      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
        <Chip
          label={status.granted ? 'Reading: enabled' : 'Reading: not enabled'}
          tone={status.granted ? 'positive' : 'warn'}
        />
        <Chip
          label={status.canPostNotifications ? 'Alerts: on' : 'Alerts: off'}
          tone={status.canPostNotifications ? 'positive' : 'warn'}
        />
        {status.granted && status.connected ? <Chip label="Listening" tone="accent" /> : null}
        {status.pendingCount > 0 ? <Chip label={`${status.pendingCount} waiting`} /> : null}
      </View>

      {status.granted ? (
        <Text variant="bodySmall" color="faint" style={{ marginTop: theme.spacing.sm }}>
          {status.connected
            ? 'MoneyKal is watching for payments. When one is detected while the app is closed, it appears in your notification shade with Add and Ignore.'
            : 'Access is granted but Android has not bound the listener yet. It usually connects within a few seconds, or after the next app launch.'}
        </Text>
      ) : (
        <Text variant="bodySmall" color="faint" style={{ marginTop: theme.spacing.sm }}>
          Android asks you to turn this on yourself — it cannot be enabled from inside
          the app. Find MoneyKal in the list and switch it on.
        </Text>
      )}

      {!status.canPostNotifications ? (
        <Text variant="bodySmall" color="faint" style={{ marginTop: theme.spacing.sm }}>
          MoneyKal cannot show notifications yet, so detected payments will wait inside
          the app instead of appearing in your shade.
        </Text>
      ) : null}

      <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
        <Button
          label={status.granted ? 'Manage notification access' : 'Enable Notification Access'}
          variant={status.granted ? 'outline' : 'primary'}
          onPress={openSettings}
        />
        {!status.canPostNotifications ? (
          <Button
            label="Allow MoneyKal notifications"
            onPress={() => {
              void requestPostNotificationsPermission().then(refresh);
            }}
          />
        ) : null}
      </View>

      {/* ------------------------------------------------------------ debug --
          Verifying the chain without spending money. Both rows feed a sample
          through the identical native path a real notification takes — gate,
          parser, store, dedupe, then the same foreground/background decision —
          so a pass here means the pipeline works, not just the UI. Kept out of
          production builds. */}
      {showDebug ? (
        <View style={{ marginTop: theme.spacing.lg }}>
          <ListRow
            label="Simulate a payment notification"
            detail={SAMPLES[sampleIndex].text}
            showChevron={false}
            onPress={() => fire(false)}
          />
          <ListRow
            label={
              countdown !== null
                ? `Press Home now — firing in ${countdown}s`
                : 'Simulate after 6s (to test the shade)'
            }
            detail={
              countdown !== null
                ? 'Leave MoneyKal before it fires'
                : 'Fires once you have left the app, so it arrives as a notification'
            }
            showChevron={false}
            onPress={countdown !== null ? undefined : () => fire(true)}
          />
          {testNote ? (
            <Text variant="bodySmall" color="faint" style={{ marginTop: theme.spacing.xs }}>
              {testNote}
            </Text>
          ) : null}

          {/* ------------------------------------------------ diagnostics --
              When a real payment is not detected there are two very different
              causes that look identical from outside: MoneyKal rejected the
              notification, or the payment app never posted one. This says
              which. Money-related notifications only — chat is never recorded. */}
          <ListRow
            label={sightings === null ? 'What has MoneyKal seen?' : 'Refresh'}
            detail={
              sightings === null
                ? 'Recent money notifications and what was decided'
                : `${sightings.length} recorded`
            }
            showChevron={false}
            onPress={() => setSightings(getRecentSightings())}
          />

          {sightings !== null ? (
            <View style={{ marginTop: theme.spacing.sm, gap: theme.spacing.sm }}>
              {sightings.length === 0 ? (
                <Text variant="bodySmall" color="muted">
                  Nothing recorded. If you have just paid and this is still empty, the
                  payment app did not post a notification at all — check that its
                  notifications are switched on in Android Settings.
                </Text>
              ) : (
                sightings.map((s) => (
                  <View
                    key={`${s.at}-${s.packageName}`}
                    style={{
                      padding: theme.spacing.md,
                      borderRadius: theme.radius.md,
                      backgroundColor: theme.colors.surface2,
                      borderWidth: 1,
                      borderColor: theme.colors.line,
                      gap: 2,
                    }}
                  >
                    <Text variant="label" color="faint">
                      {s.appLabel} ·{' '}
                      {new Date(s.at).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                    {s.title ? <Text variant="bodySmall">{s.title}</Text> : null}
                    {s.text ? (
                      <Text variant="bodySmall" color="muted">
                        {s.text}
                      </Text>
                    ) : null}
                    <Text
                      variant="bodySmall"
                      color={s.verdict.startsWith('Detected') ? 'accent' : 'faint'}
                    >
                      {s.verdict}
                    </Text>
                  </View>
                ))
              )}
              {sightings.length > 0 ? (
                <Button
                  label="Clear diagnostics"
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    clearSightings();
                    setSightings([]);
                  }}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
