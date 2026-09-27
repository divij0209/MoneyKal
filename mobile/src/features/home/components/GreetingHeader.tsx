import React from 'react';
import { View } from 'react-native';

import { Text } from '../../../components';
import type { HomeUser } from '../../../api/types';
import { useLanguage } from '../../../i18n';
import { useTheme } from '../../../theme';

/**
 * "Good morning, Divij" plus the date.
 *
 * The greeting comes from GET /home, computed server-side from the local hour
 * the app reports — so any other consumer (WhatsApp, a voice call) gets the
 * same wording from the same source. It therefore arrives in English and
 * stays in English; translating a server-authored string on the client is how
 * two clients start disagreeing about what the product said.
 *
 * The date is the one part formatted here, because it is purely
 * presentational — the API sends the ISO date it used, and `Intl` renders it
 * in the active language. Hindi gets हिन्दी weekday and month names for free.
 */
export function GreetingHeader({ user }: { user: HomeUser }) {
  const theme = useTheme();
  const { lang } = useLanguage();

  const dateLabel = React.useMemo(() => {
    const [y, m, d] = (user.local_date || '').split('-').map(Number);
    if (!y) return '';
    const locale = lang === 'hi' ? 'hi-IN' : 'en-IN';
    try {
      return new Date(y, m - 1, d).toLocaleDateString(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
    } catch {
      // Hermes ships a trimmed ICU on some Android builds; an unsupported
      // locale throws rather than falling back, and a missing date line is
      // better than a crashed screen.
      return '';
    }
  }, [user.local_date, lang]);

  return (
    <View style={{ gap: theme.spacing.xs, paddingTop: theme.spacing.md }}>
      {dateLabel ? (
        <Text
          variant="label"
          color="faint"
          numberOfLines={1}
          // Devanagari weekday names are long and the uppercase transform is
          // meaningless for them.
          style={lang === 'hi' ? { textTransform: 'none', letterSpacing: 0.2 } : undefined}
        >
          {dateLabel}
        </Text>
      ) : null}
      <Text variant="display" numberOfLines={2}>
        {user.greeting}, {user.name}
      </Text>
    </View>
  );
}
