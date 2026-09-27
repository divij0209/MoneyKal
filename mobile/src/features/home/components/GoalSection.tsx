import React from 'react';
import { Pressable, View } from 'react-native';

import type { GoalResponse } from '../../../api/types';
import {
  Button,
  Divider,
  ProgressBar,
  SectionHeader,
  Text,
  formatIsoDate,
} from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  primary: GoalResponse | null;
  goals: GoalResponse[];
  onAdd: () => void;
  onOpenGoal: (goal: GoalResponse) => void;
}

/**
 * The primary goal's progress.
 *
 * Which goal is "primary" is resolved by the backend (`resolve_primary_goal`),
 * not chosen here. Every figure — current, target, percentage, remaining, the
 * monthly pace needed — arrives pre-computed and pre-formatted.
 */
export function GoalSection({ primary, goals, onAdd, onOpenGoal }: Props) {
  const theme = useTheme();
  const others = goals.filter((g) => !primary || g.id !== primary.id);

  if (!primary) {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <SectionHeader title="Goal progress" icon="target" />
        <Text variant="bodySmall" color="muted">
          Set your first financial goal — an emergency fund, a trip, a purchase — and every
          number on this page starts pointing somewhere.
        </Text>
        <Button
          label="Set your first goal"
          variant="outline"
          size="sm"
          fullWidth={false}
          onPress={onAdd}
        />
      </View>
    );
  }

  /* Only the note the data actually supports — the same precedence the web
     applies: a deadline gets the monthly pace, a passed deadline gets a nudge,
     otherwise the remaining amount. */
  let note: string | null = null;
  if (primary.monthly_required_display && primary.days_left != null && primary.days_left > 0) {
    note = `${primary.monthly_required_display} a month gets you there by ${formatIsoDate(
      primary.target_date,
    )}.`;
  } else if (primary.days_left != null && primary.days_left <= 0) {
    note = `The ${formatIsoDate(
      primary.target_date,
    )} deadline has passed — worth resetting the target.`;
  } else if (primary.remaining_display && (primary.remaining ?? 0) > 0) {
    note = `${primary.remaining_display} to go.`;
  } else if (primary.remaining === 0) {
    note = 'Goal reached — nice work.';
  }

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader
        title="Goal progress"
        icon="target"
        actionLabel="Add"
        actionIcon="plus"
        onAction={onAdd}
      />

      <Pressable
        onPress={() => onOpenGoal(primary)}
        accessibilityRole="button"
        accessibilityLabel={`${primary.name}, ${primary.percentage}% complete. Edit goal.`}
        style={({ pressed }) => ({ gap: theme.spacing.sm, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="body" style={{ fontSize: 20 }}>
            {primary.icon}
          </Text>
          <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
            {primary.name}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.xs }}>
          <Text variant="metric" tabular>
            {primary.current_display}
          </Text>
          <Text variant="body" color="faint" tabular>
            / {primary.target_display}
          </Text>
        </View>

        <ProgressBar percent={primary.percentage ?? 0} height={6} />

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text variant="bodySmall" color="muted" tabular>
            {primary.percentage}% complete
          </Text>
          {others.length ? (
            <Text variant="bodySmall" color="faint">
              +{others.length} other goal{others.length === 1 ? '' : 's'}
            </Text>
          ) : null}
        </View>

        {note ? (
          <Text variant="bodySmall" color="faint">
            {note}
          </Text>
        ) : null}
      </Pressable>

      {others.length ? (
        <>
          <Divider />
          <View>
            {others.map((g, i) => (
              <React.Fragment key={g.id}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  onPress={() => onOpenGoal(g)}
                  accessibilityRole="button"
                  accessibilityLabel={`${g.name}, ${g.percentage ?? 0}% complete. Edit goal.`}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingVertical: theme.spacing.md,
                    backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
                  })}
                >
                  <Text variant="body" style={{ fontSize: 17 }}>
                    {g.icon}
                  </Text>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text variant="body" numberOfLines={1}>
                      {g.name}
                    </Text>
                    <ProgressBar percent={g.percentage ?? 0} height={3} />
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text variant="bodySmall" tabular>
                      {g.current_display}
                    </Text>
                    <Text variant="bodySmall" color="faint" tabular>
                      of {g.target_display}
                    </Text>
                  </View>
                </Pressable>
              </React.Fragment>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}
