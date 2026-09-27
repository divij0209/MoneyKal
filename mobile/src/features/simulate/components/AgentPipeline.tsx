import React from 'react';
import { View } from 'react-native';

import { Text } from '../../../components';
import { useTheme } from '../../../theme';
import { AGENTS } from '../constants';
import type { PipelineState, StageState } from '../hooks';

/**
 * The six-agent pipeline, mirroring `.pipeline` / `.pipe-step` on the web.
 *
 * Worth being precise about what this shows, because it would be easy to
 * mistake for decoration: the rows are driven by the `stages` array the
 * backend returned, so a row reaching "Done" means that agent genuinely ran
 * server-side. "Skipped" means it did not — an informational answer runs a
 * shorter pipeline because there is no hypothetical to project.
 */

interface Props {
  pipeline: PipelineState;
  /** `stages[].summary`, keyed by agent, shown once a row is done. */
  summaries: Record<string, string>;
}

const STATE_LABEL: Record<StageState, string> = {
  queued: 'Queued',
  running: 'Running…',
  done: 'Done',
  skipped: 'Skipped',
};

export function AgentPipeline({ pipeline, summaries }: Props) {
  const theme = useTheme();

  const dotColor = (s: StageState) =>
    s === 'done' ? theme.colors.accent
    : s === 'running' ? theme.colors.accent
    : theme.colors.line;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      {AGENTS.map((a) => {
        const state = pipeline[a.agent] ?? 'queued';
        const summary = state === 'done' ? summaries[a.agent] : undefined;

        return (
          <View
            key={a.agent}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              opacity: state === 'queued' ? 0.45 : state === 'skipped' ? 0.55 : 1,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                marginTop: 6,
                backgroundColor: dotColor(state),
                borderWidth: state === 'running' ? 0 : 1,
                borderColor: theme.colors.line,
              }}
            />

            <View style={{ flex: 1, gap: 2 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.spacing.sm,
                }}
              >
                <Text variant="bodySmall" color={state === 'done' ? 'ink' : 'muted'}>
                  {a.name}
                </Text>
                <Text
                  variant="label"
                  color={state === 'done' ? 'accent' : 'faint'}
                >
                  {STATE_LABEL[state]}
                </Text>
              </View>

              {/* The web puts the stage summary in a `title` tooltip, which a
                  phone has no equivalent for. Shown inline instead — it is the
                  most substantive thing the pipeline has to say. */}
              {summary ? (
                <Text variant="bodySmall" color="faint">
                  {summary}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
