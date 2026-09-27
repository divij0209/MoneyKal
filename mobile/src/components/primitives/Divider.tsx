import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../../theme';

/** A hairline rule in `--line`. */
export function Divider({ spacing = 0, strong = false }: { spacing?: number; strong?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: 1,
        backgroundColor: strong ? theme.colors.lineStrong : theme.colors.line,
        marginVertical: spacing,
      }}
    />
  );
}
