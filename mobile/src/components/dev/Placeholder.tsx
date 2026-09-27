import React from 'react';
import { View } from 'react-native';

import { Card, Chip, Screen, Text } from '../index';
import { useTheme } from '../../theme';

export interface PlaceholderProps {
  /** The web view this screen will reproduce. */
  title: string;
  subtitle: string;
  /** The endpoint(s) it will read, so the wiring is documented in place. */
  endpoints?: string[];
  /** What the finished screen contains, from the feature inventory. */
  contents?: string[];
}

/**
 * A screen that is routed but not yet built.
 *
 * Deliberately explicit rather than a blank view or fake data: during the
 * foundation phase every tab must be reachable so the navigation can be tested
 * end to end, and anyone opening the app should be able to tell at a glance
 * that this is scaffolding, not a broken feature.
 */
export function Placeholder({ title, subtitle, endpoints, contents }: PlaceholderProps) {
  const theme = useTheme();

  return (
    <Screen scroll>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.lg }}>
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="title">{title}</Text>
          <Text variant="bodySmall" color="muted">{subtitle}</Text>
        </View>

        <Chip label="Not built yet" tone="accent" />

        {contents?.length ? (
          <Card label="This screen will contain">
            <View style={{ gap: theme.spacing.sm }}>
              {contents.map((item) => (
                <View key={item} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                  <Text variant="bodySmall" color="faint">—</Text>
                  <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>{item}</Text>
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        {endpoints?.length ? (
          <Card label="Reads from">
            <View style={{ gap: theme.spacing.xs }}>
              {endpoints.map((ep) => (
                <Text key={ep} variant="mono" color="muted">{ep}</Text>
              ))}
            </View>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}
