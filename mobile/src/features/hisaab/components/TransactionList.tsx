import React from 'react';
import { Pressable, View } from 'react-native';

import type { Transaction } from '../../../api/types';
import { Chip, Divider, Text } from '../../../components';
import { useTheme } from '../../../theme';
import { cleanTxnDescription, dayHeading, formatAmount, formatSigned } from '../constants';

interface Props {
  groups: { date: string; items: Transaction[] }[];
  currency: string;
  onOpen: (txn: Transaction) => void;
  busyIds: Set<number>;
}

/**
 * The ledger, grouped by day.
 *
 * The web renders one flat list with the raw `txn_date` on every row. Grouping
 * by day suits a phone better — the date is said once per group instead of
 * repeated on every line, which leaves the row itself to carry category,
 * description and amount without crowding.
 *
 * Each day's heading shows that day's net movement, summed from the rows
 * beneath it. That is the same client-side sum the web's filter bar performs
 * over a selected day; the ledger's headline totals still come from the API.
 */
export function TransactionList({ groups, currency, onOpen, busyIds }: Props) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xl }}>
      {groups.map((group) => {
        let moneyIn = 0;
        let moneyOut = 0;
        for (const t of group.items) {
          if (t.type === 'in') moneyIn += t.amount;
          else moneyOut += t.amount;
        }
        const net = moneyIn - moneyOut;

        return (
          <View key={group.date} style={{ gap: theme.spacing.xs }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.spacing.sm,
              }}
            >
              <Text variant="label" color="faint">
                {dayHeading(group.date)}
              </Text>
              <Text variant="label" color={net >= 0 ? 'pos' : 'faint'} tabular>
                {net >= 0 ? '+' : '−'}
                {formatAmount(Math.abs(net), currency)}
              </Text>
            </View>

            <View>
              {group.items.map((txn, i) => (
                <React.Fragment key={txn.id}>
                  {i > 0 ? <Divider /> : null}
                  <Row
                    txn={txn}
                    currency={currency}
                    busy={busyIds.has(txn.id)}
                    onPress={() => onOpen(txn)}
                  />
                </React.Fragment>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Row({
  txn,
  currency,
  busy,
  onPress,
}: {
  txn: Transaction;
  currency: string;
  busy: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const description = cleanTxnDescription(txn.description);
  // A row the Gmail importer created is attributed rather than passed off as
  // something the user entered — the same `auto` tag the web row carries.
  const isAuto = txn.source === 'auto';

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`${txn.category}${description ? `, ${description}` : ''}, ${formatSigned(txn, currency)}. Tap to edit.`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: busy ? 0.45 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
      })}
    >
      {/* Direction rail — reads before any text does. */}
      <View
        style={{
          width: 3,
          alignSelf: 'stretch',
          borderRadius: 2,
          backgroundColor: txn.type === 'in' ? theme.colors.pos : theme.colors.accentBorder,
        }}
      />

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" numberOfLines={1}>
          {txn.category}
        </Text>
        {description || isAuto ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              flexWrap: 'wrap',
            }}
          >
            {description ? (
              <Text variant="bodySmall" color="faint" numberOfLines={1} style={{ flexShrink: 1 }}>
                {description}
              </Text>
            ) : null}
            {isAuto ? <Chip label="auto" /> : null}
          </View>
        ) : null}
      </View>

      <Text variant="body" tabular color={txn.type === 'in' ? 'pos' : 'ink'}>
        {formatSigned(txn, currency)}
      </Text>
    </Pressable>
  );
}
