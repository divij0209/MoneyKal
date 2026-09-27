import React, { useState } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { ApiError } from '../../api';
import { Button, Input, Text } from '../../components';
import { useT } from '../../i18n';
import { useAuth } from '../../store';
import { useTheme } from '../../theme';
import type { AuthStackParamList } from '../../navigation/types';
import { TermsConsent, termsAcceptance } from '../legal';
import { AuthShell, TrustRow } from './AuthShell';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

/**
 * Log in.
 *
 * IMPORTANT — the credential path is deliberately untouched by the redesign.
 * `signIn(username, password)` is called with exactly what the user typed;
 * AuthContext applies `username.trim()` and nothing else, which is the
 * behaviour that was there before. No lower-casing, no normalisation, no
 * client-side transformation of any kind is introduced here: the server
 * decides what matches, and a client that "helpfully" reshapes a username is
 * how a working login stops working.
 *
 * Copy follows twin-app/login.html — "Welcome back", "Log in with your User
 * ID to continue", the field labels and the three trust marks — now routed
 * through i18n so the same page reads in Hindi.
 */
export function LoginScreen({ navigation }: Props) {
  const theme = useTheme();
  const t = useT();
  const { signIn } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  function acceptTerms(next: boolean) {
    setTerms(next);
    if (next) setTermsError(null);
  }

  async function onSubmit() {
    if (!canSubmit) return;

    // The Terms gate. Deliberately not folded into `canSubmit`: a disabled
    // button would block the submit without ever saying why, and the point of
    // the check is that the reason is legible.
    if (!terms) {
      setTermsError(t('terms.required'));
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await signIn(username, password, termsAcceptance());
      // No navigation here: RootNavigator swaps stacks off auth status, the
      // same way the web redirects on profile_key after a successful login.
    } catch (err) {
      // As on the Register screen: a non-ApiError is a client-side fault, and
      // "Invalid credentials" would be a misleading thing to show for one.
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Login failed for a non-API reason:', err);
      }
      setError(
        err instanceof ApiError
          ? err.isNetworkError
            ? err.detail
            : t('auth.invalidCredentials')
          : t('common.somethingWrong'),
      );
      setBusy(false);
    }
  }

  return (
    <AuthShell
      footer={
        <View style={{ gap: theme.spacing.lg }}>
          <TrustRow
            items={[t('auth.encrypted'), t('auth.instantAccess'), t('auth.bankGrade')]}
          />
          <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="bodySmall" color="muted">
              {t('auth.newUser')}
            </Text>
            <Button
              label={t('auth.createAccount')}
              variant="ghost"
              size="sm"
              fullWidth={false}
              onPress={() => navigation.navigate('Register')}
              disabled={busy}
            />
          </View>
        </View>
      }
    >
      <View style={{ height: theme.spacing.huge }} />

      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="label" color="accent">
          {t('auth.secureAccess')}
        </Text>
        <Text variant="display">{t('auth.welcomeBack')}</Text>
        <Text variant="body" color="muted">
          {t('auth.loginSubtitle')}
        </Text>
      </View>

      <View style={{ height: theme.spacing.xxxl }} />

      <View style={{ gap: theme.spacing.lg }}>
        <Input
          label={t('auth.userId')}
          required
          placeholder={t('auth.userIdPlaceholder')}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          returnKeyType="next"
          editable={!busy}
        />
        <Input
          label={t('auth.password')}
          required
          placeholder={t('auth.passwordPlaceholder')}
          value={password}
          onChangeText={setPassword}
          secureToggle
          autoCapitalize="none"
          autoComplete="password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          editable={!busy}
          error={error ?? undefined}
        />
      </View>

      <View style={{ height: theme.spacing.xl }} />

      <TermsConsent value={terms} onChange={acceptTerms} error={termsError} disabled={busy} />

      <View style={{ height: theme.spacing.xl }} />

      <Button
        label={busy ? t('auth.loggingIn') : t('auth.logIn')}
        onPress={onSubmit}
        loading={busy}
        disabled={!canSubmit}
        size="lg"
      />

      <Text
        variant="label"
        color="faint"
        center
        style={{ marginTop: theme.spacing.lg, textTransform: 'none', letterSpacing: 0.3 }}
      >
        {t('auth.securedBy')}
      </Text>
    </AuthShell>
  );
}
