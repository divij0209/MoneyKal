import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { ApiError } from '../../api';
import type { PersonaKey } from '../../api/types';
import { Button, Input, Text } from '../../components';
import { useT } from '../../i18n';
import { useAuth } from '../../store';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { saveDraft } from '../onboarding/draft';
import type { AuthStackParamList } from '../../navigation/types';
import { TermsConsent, termsAcceptance } from '../legal';
import { AuthShell } from './AuthShell';

type Props = NativeStackScreenProps<AuthStackParamList, 'Register'>;

/**
 * Create an account.
 *
 * Reproduces steps 1 and 2 of the web wizard (twin-app/register.html) on one
 * screen: the account type, then Full Name / Email / Password. They are merged
 * because on a phone a two-option choice and three fields fit together
 * comfortably, and the web's step 1 is a single tap.
 *
 * The order is preserved: the type is chosen *before* the account exists, and
 * it goes into the onboarding draft because the persona profile step needs it.
 * As on the web, the account is created with `username = email`, and — as on
 * Login — the email is passed through untouched apart from the `.trim()`
 * AuthContext already applied before this redesign. Nothing here normalises
 * case.
 *
 * Validation is client-side only where the server would otherwise reject with
 * a message that does not name the field. Anything the server has an opinion
 * about (a taken User ID) is still left to the server.
 */
export function RegisterScreen({ navigation }: Props) {
  const theme = useTheme();
  const t = useT();
  const { signUp } = useAuth();

  const [accountType, setAccountType] = useState<PersonaKey>('individual');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

  function acceptTerms(next: boolean) {
    setTerms(next);
    if (next) setTermsError(null);
  }

  const nameError = touched && !fullName.trim() ? t('auth.nameRequired') : undefined;
  const emailError = touched && !email.trim() ? t('auth.emailRequired') : undefined;
  const passwordError =
    touched && password.length > 0 && password.length < 8
      ? t('auth.passwordTooShort')
      : undefined;

  const canSubmit =
    fullName.trim().length > 0 && email.trim().length > 0 && password.length > 0 && !busy;

  async function onSubmit() {
    setTouched(true);
    if (!canSubmit) return;

    // No account is created until the Terms have been accepted. Checked before
    // the draft is written as well as before the request, so a blocked submit
    // leaves nothing behind.
    if (!terms) {
      setTermsError(t('terms.required'));
      return;
    }

    setError(null);
    setBusy(true);
    try {
      // Saved first: if account creation succeeds but the app is killed before
      // the profile step, the draft is what lets onboarding resume.
      await saveDraft({ accountType, fullName: fullName.trim() });
      await signUp(email, password, termsAcceptance());
      // profile_key comes back null, so RootNavigator moves to Onboarding.
    } catch (err) {
      // A non-ApiError here is a client-side fault, not something the server
      // rejected, and the generic message below actively points at the wrong
      // thing. Logging it in development keeps the real cause visible instead
      // of hidden behind "Registration failed".
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Registration failed for a non-API reason:', err);
      }
      setError(err instanceof ApiError ? err.detail : t('common.somethingWrong'));
      setBusy(false);
    }
  }

  const options: { key: PersonaKey; title: string; desc: string }[] = [
    { key: 'individual', title: t('auth.individual'), desc: t('auth.individualDesc') },
    { key: 'startup', title: t('auth.startup'), desc: t('auth.startupDesc') },
  ];

  return (
    <AuthShell
      footer={
        <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
          <Text variant="bodySmall" color="muted">
            {t('auth.haveAccount')}
          </Text>
          <Button
            label={t('auth.signIn')}
            variant="ghost"
            size="sm"
            fullWidth={false}
            onPress={() => navigation.goBack()}
            disabled={busy}
          />
        </View>
      }
    >
      <View style={{ height: theme.spacing.xxxl }} />

      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="display">{t('auth.createTitle')}</Text>
        <Text variant="body" color="muted">
          {t('auth.createSubtitle')}
        </Text>
      </View>

      <View style={{ height: theme.spacing.xxl }} />

      {/* Account type. Two rows rather than two cards — the selected state is
          carried by the accent rule and the mark, not by a filled box. */}
      <Text variant="label" color="faint">
        {t('auth.accountType')}
      </Text>
      <View style={{ marginTop: theme.spacing.sm }}>
        {options.map((opt, i) => {
          const selected = accountType === opt.key;
          return (
            <Pressable
              key={opt.key}
              onPress={() => setAccountType(opt.key)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${opt.title}. ${opt.desc}`}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: theme.spacing.md,
                minHeight: MIN_TOUCH_SIZE,
                paddingVertical: theme.spacing.lg,
                borderTopWidth: i === 0 ? 1 : 0,
                borderTopColor: theme.colors.line,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.line,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  marginTop: 1,
                  borderWidth: selected ? 6 : 1.5,
                  borderColor: selected ? theme.colors.accent : theme.colors.lineStrong,
                }}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  variant="heading"
                  style={{ color: selected ? theme.colors.ink : theme.colors.inkMuted }}
                >
                  {opt.title}
                </Text>
                <Text variant="bodySmall" color="faint">
                  {opt.desc}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={{ height: theme.spacing.xxl }} />

      <View style={{ gap: theme.spacing.lg }}>
        <Input
          label={t('auth.fullName')}
          required
          placeholder={t('auth.fullNamePlaceholder')}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          autoComplete="name"
          editable={!busy}
          error={nameError}
        />
        <Input
          label={t('auth.email')}
          required
          placeholder={t('auth.emailPlaceholder')}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          hint={t('auth.userId')}
          editable={!busy}
          error={emailError}
        />
        <Input
          label={t('auth.choosePassword')}
          required
          placeholder={t('auth.passwordPlaceholder')}
          value={password}
          onChangeText={setPassword}
          secureToggle
          autoCapitalize="none"
          autoComplete="new-password"
          onSubmitEditing={onSubmit}
          editable={!busy}
          hint={t('auth.passwordHint')}
          error={passwordError ?? error ?? undefined}
        />
      </View>

      <View style={{ height: theme.spacing.xl }} />

      <TermsConsent value={terms} onChange={acceptTerms} error={termsError} disabled={busy} />

      <View style={{ height: theme.spacing.xl }} />

      <Button
        label={t('auth.createAndContinue')}
        onPress={onSubmit}
        loading={busy}
        disabled={!canSubmit}
        size="lg"
      />
    </AuthShell>
  );
}
