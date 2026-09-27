import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export interface StatTileProps {
  label: string;
  /** Already formatted by the server wherever the API provides a *_display
   *  field — this component never formats currency itself. */
  value: string;
  caption?: string;
  delta?: string;
  deltaTone?: 'pos' | 'neg' | 'muted';
  style?: ViewStyle;
}

/** A labelled figure — the web's `.ov-hero__*` and `.dh-stat` blocks. */
export function StatTile({ label, value, caption, delta, deltaTone = 'muted', style }: StatTileProps) {
  const theme = useTheme();

  return (
    <View style={[{ gap: theme.spacing.xxs }, style]}>
      <Text variant="label" color="faint">{label}</Text>
      <Text variant="metric" tabular numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
        {value}
      </Text>
      {delta || caption ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          {delta ? (
            <Text
              variant="bodySmall"
              color={deltaTone === 'muted' ? 'muted' : deltaTone}
              tabular
            >
              {delta}
            </Text>
          ) : null}
          {caption ? <Text variant="bodySmall" color="faint">{caption}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
