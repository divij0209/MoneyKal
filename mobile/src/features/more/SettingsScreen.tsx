import React, { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { ApiError, authApi } from '../../api';
import { Button, Chip, Divider, Input, Screen, Surface, Text } from '../../components';
import { ListRow } from '../../components/primitives/ListRow';
import {
  ADB_REVERSE_HINT,
  API_HOST_IS_LOOPBACK,
  API_URL_IS_DERIVED,
  API_URL_OVERRIDE_SUPPORTED,
  DEFAULT_API_BASE_URL,
  getApiBaseUrl,
  getApiBaseUrlOverride,
  getDiscoveredApiBaseUrl,
  normalizeApiUrl,
  setApiBaseUrlOverride,
} from '../../config/env';
import { useLanguage, useT, type Lang } from '../../i18n';
import { NotificationAccessCard } from '../paymentDetection';
import { useAuth, useProfile } from '../../store';
import { hasPasscode, LOCK_SUPPORTED } from '../../store/passcode';
import { MIN_TOUCH_SIZE, useTheme, useThemeControls, type ThemePreference } from '../../theme';
import { SetPasscodeScreen } from '../lock/SetPasscodeScreen';

/**
 * Settings — appearance, language, security, connection, account.
 *
 * Restructured from five stacked cards into labelled groups: a small caps
 * heading, then the rows it governs on one inset surface. Same controls, same
 * behaviour, a third less chrome.
 *
 * The connection block exists because the mobile app resolves its API host at
 * runtime (src/config/env.ts) rather than hardcoding loopback like the web
 * does. When something can't reach the backend, this is the screen that tells
 * you which address it tried and whether the server answered — otherwise the
 * only symptom is every screen failing identically.
 *
 * The backend override stays gated on `API_URL_OVERRIDE_SUPPORTED`, which is
 * false in production builds. That is a security boundary, not a convenience:
 * a switch that redirects every authenticated request — bearer token included
 * — to an arbitrary host is a real attack surface. The redesign does not
 * widen it.
 */

/** A labelled group of rows. The unit this screen is built from. */
function Group({
  label,
  children,
  padded = false,
}: {
  label: string;
  children: React.ReactNode;
  padded?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="label" color="faint" style={{ paddingHorizontal: theme.spacing.xs }}>
        {label}
      </Text>
      <Surface tone="inset" padded={padded ? theme.spacing.lg : 0}>
        {children}
      </Surface>
    </View>
  );
}

/** A row of mutually exclusive choices — theme, language. */
function ChoiceGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (next: T) => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
      {options.map((opt) => {
        const selected = value === opt.key;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.label}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: MIN_TOUCH_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.spacing.xs,
              paddingVertical: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.line,
              backgroundColor: selected ? theme.colors.accentTint : theme.colors.surface2,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              variant="bodySmall"
              center
              numberOfLines={1}
              style={{
                color: selected ? theme.colors.accent : theme.colors.inkMuted,
                fontFamily: selected ? theme.fonts.bodySemiBold : theme.fonts.body,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingsScreen() {
  /* The passcode lives in the keystore, so Settings asks whether one exists
     rather than assuming. */
  const [hasPin, setHasPin] = React.useState(false);
  const [changingPin, setChangingPin] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void hasPasscode().then((v: boolean) => {
      if (alive) setHasPin(v);
    });
    return () => {
      alive = false;
    };
  }, [changingPin]);

  const theme = useTheme();
  const t = useT();
  const { preference, setPreference } = useThemeControls();
  const { lang, setLang } = useLanguage();
  const { signOut, session } = useAuth();
  const { persona } = useProfile();

  const [probe, setProbe] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  const [probeDetail, setProbeDetail] = useState<string | null>(null);

  /* The API address is editable at runtime in dev and preview builds, so it is
     state rather than a constant — saving one has to re-render this group and
     every subsequent request picks it up without a restart. */
  const [apiUrl, setApiUrl] = useState(getApiBaseUrl());
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const isOverridden = getApiBaseUrlOverride() !== null;
  /* Discovery picked this rather than the address the build was compiled
     with. Worth saying out loud: otherwise the screen shows an address that
     appears in no config file and looks like a bug. */
  const isDiscovered = !isOverridden && getDiscoveredApiBaseUrl() !== null;

  async function saveApiUrl() {
    const normalized = normalizeApiUrl(urlDraft);
    if (!normalized) {
      setUrlError('Enter an address like 192.168.43.1:8000 or http://10.0.0.5:8000');
      return;
    }
    setApiUrl(await setApiBaseUrlOverride(normalized));
    setEditingUrl(false);
    setUrlError(null);
    // The old result described a different server; clear it rather than leave
    // a stale "Reachable" next to a new address.
    setProbe('idle');
    setProbeDetail(null);
  }

  async function resetApiUrl() {
    setApiUrl(await setApiBaseUrlOverride(null));
    setEditingUrl(false);
    setUrlError(null);
    setProbe('idle');
    setProbeDetail(null);
  }

  async function checkConnection() {
    setProbe('checking');
    setProbeDetail(null);
    try {
      const res = await authApi.health();
      setProbe('ok');
      setProbeDetail(`${res.service} responded`);
    } catch (err) {
      setProbe('fail');
      setProbeDetail(err instanceof ApiError ? err.detail : 'The server did not respond.');
    }
  }

  function confirmSignOut() {
    Alert.alert(t('settings.signOutConfirm'), '', [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.signOut'), style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  const themeOptions: { key: ThemePreference; label: string }[] = [
    { key: 'light', label: t('settings.themeLight') },
    { key: 'dark', label: t('settings.themeDark') },
    { key: 'system', label: t('settings.themeSystem') },
  ];

  const langOptions: { key: Lang; label: string }[] = [
    { key: 'en', label: t('settings.languageEnglish') },
    { key: 'hi', label: t('settings.languageHindi') },
  ];

  // Change-passcode takes over the screen while it runs: a half-visible
  // Settings behind a passcode pad invites tapping the wrong thing.
  if (changingPin) {
    return (
      <SetPasscodeScreen
        mode="change"
        onDone={() => setChangingPin(false)}
        onCancel={() => setChangingPin(false)}
      />
    );
  }

  return (
    <Screen scroll padded={false}>
      <View
        style={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
          gap: theme.spacing.xxl,
        }}
      >
        {/* ------------------------------------------------------ appearance */}
        <Group label={t('settings.appearance')} padded>
          <View style={{ gap: theme.spacing.md }}>
            <Text variant="bodySmall" color="muted">
              {t('settings.theme')}
            </Text>
            <ChoiceGroup value={preference} options={themeOptions} onChange={setPreference} />
          </View>
        </Group>

        {/* -------------------------------------------------------- language
            The web offers the same two behind an `EN | हिं` toggle
            (twin-app/js/i18n.js); this is the same choice with room for the
            names written out. */}
        <Group label={t('settings.language')} padded>
          <View style={{ gap: theme.spacing.md }}>
            <Text variant="bodySmall" color="muted">
              {t('settings.language')}
            </Text>
            <ChoiceGroup value={lang} options={langOptions} onChange={setLang} />
            <Text variant="bodySmall" color="faint">
              MoneyKal's own screens are translated. Insights, recommendations and
              other text written by the server stay in English.
            </Text>
          </View>
        </Group>

        {/* -------------------------------------------------------- security */}
        {LOCK_SUPPORTED ? (
          <Group label={t('settings.security')}>
            <ListRow
              label={t('settings.changePasscode')}
              detail={hasPin ? '6-digit app lock' : 'Not set'}
              onPress={() => setChangingPin(true)}
            />
          </Group>
        ) : null}

        <NotificationAccessCard />

        {/* ------------------------------------------------------ connection */}
        <Group label={t('settings.connection')} padded>
          <View style={{ gap: theme.spacing.md }}>
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="label" color="faint">
                {t('settings.serverAddress')}
              </Text>
              <Text variant="mono" color="muted" selectable>
                {apiUrl}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              <Chip
                label={
                  isOverridden
                    ? 'Custom'
                    : isDiscovered
                      ? 'Found automatically'
                      : API_URL_IS_DERIVED
                        ? 'Auto-detected'
                        : 'Configured'
                }
                tone={isOverridden || isDiscovered || !API_URL_IS_DERIVED ? 'accent' : 'neutral'}
              />
              {probe === 'ok' ? <Chip label={t('settings.connected')} tone="positive" /> : null}
              {probe === 'fail' ? <Chip label={t('settings.notConnected')} tone="warn" /> : null}
            </View>

            {API_URL_IS_DERIVED && !isOverridden ? (
              <Text variant="bodySmall" color="faint">
                Derived from the Expo dev server address. Set EXPO_PUBLIC_API_URL to point
                somewhere else.
              </Text>
            ) : null}

            {isOverridden ? (
              <Text variant="bodySmall" color="faint">
                Set on this device. This build shipped pointing at {DEFAULT_API_BASE_URL}.
              </Text>
            ) : null}

            {isDiscovered ? (
              <Text variant="bodySmall" color="faint">
                This build shipped pointing at {DEFAULT_API_BASE_URL}, which did not
                answer. MoneyKal found this one instead.
              </Text>
            ) : null}

            {probeDetail ? (
              <Text variant="bodySmall" color={probe === 'fail' ? 'muted' : 'faint'}>
                {probeDetail}
              </Text>
            ) : null}

            {/* The USB-development trap, answered on screen.
                `expo run:android --device` tunnels Metro with a single
                `adb reverse tcp:8081`, so Expo reports its host as 127.0.0.1
                and the API address is derived as loopback. That is right only
                if the API port is tunnelled too — and nothing does that
                automatically, so every request fails against the phone's own
                loopback. Rather than leave the user guessing, print the
                command. See API_HOST_IS_LOOPBACK in src/config/env.ts. */}
            {API_HOST_IS_LOOPBACK && probe === 'fail' && !isOverridden ? (
              <Surface tone="accent" padded={theme.spacing.md}>
                <View style={{ gap: theme.spacing.xs }}>
                  <Text variant="label" color="accent">
                    {t('settings.loopbackTitle')}
                  </Text>
                  <Text variant="bodySmall" color="muted">
                    {t('settings.loopbackBody')}
                  </Text>
                  <Text variant="mono" selectable style={{ color: theme.colors.ink }}>
                    {ADB_REVERSE_HINT}
                  </Text>
                </View>
              </Surface>
            ) : null}

            {/* ----------------------------------------------- change host --
                A LAN address compiled into the APK is only true until the
                laptop joins a different network. Rather than a rebuild for
                each move, the host can be re-pointed here. Not present in
                production builds — see API_URL_OVERRIDE_SUPPORTED. */}
            {editingUrl ? (
              <View style={{ gap: theme.spacing.md }}>
                <Input
                  label={t('settings.serverAddress')}
                  value={urlDraft}
                  onChangeText={(v: string) => {
                    setUrlDraft(v);
                    if (urlError) setUrlError(null);
                  }}
                  placeholder="192.168.43.1:8000"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  error={urlError ?? undefined}
                  hint={t('settings.serverAddressHint')}
                />
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                  <Button
                    label={t('common.save')}
                    size="sm"
                    onPress={() => void saveApiUrl()}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={t('common.cancel')}
                    size="sm"
                    variant="outline"
                    onPress={() => {
                      setEditingUrl(false);
                      setUrlError(null);
                    }}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            ) : null}

            <View style={{ marginHorizontal: -theme.spacing.lg }}>
              <Divider />
              <ListRow
                label={probe === 'checking' ? t('common.loading') : t('settings.testConnection')}
                onPress={probe === 'checking' ? undefined : checkConnection}
                showChevron={false}
              />
              {API_URL_OVERRIDE_SUPPORTED && !editingUrl ? (
                <>
                  <Divider />
                  <ListRow
                    label="Change backend address"
                    onPress={() => {
                      setUrlDraft(getApiBaseUrlOverride() ?? DEFAULT_API_BASE_URL);
                      setUrlError(null);
                      setEditingUrl(true);
                    }}
                    showChevron={false}
                  />
                </>
              ) : null}
              {API_URL_OVERRIDE_SUPPORTED && isOverridden ? (
                <>
                  <Divider />
                  <ListRow
                    label="Reset to build default"
                    onPress={() => void resetApiUrl()}
                    showChevron={false}
                  />
                </>
              ) : null}
            </View>
          </View>
        </Group>

        {/* --------------------------------------------------------- account */}
        <Group label={t('settings.account')}>
          <ListRow label={t('auth.userId')} detail={session?.username ?? '—'} showChevron={false} />
          <Divider />
          <ListRow
            label={t('auth.accountType')}
            detail={persona === 'startup' ? t('auth.startup') : t('auth.individual')}
            showChevron={false}
          />
          <Divider />
          <ListRow
            label={t('common.signOut')}
            destructive
            onPress={confirmSignOut}
            showChevron={false}
          />
        </Group>

        <Text variant="label" color="faint" center style={{ textTransform: 'none' }}>
          MoneyKal Financial Technologies
        </Text>
      </View>
    </Screen>
  );
}
