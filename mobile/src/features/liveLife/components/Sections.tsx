import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '../../../components';
import type {
  ExperienceCategory,
  FreedomBalance,
  LiveLifeMoment,
  LiveLifeMomentLocked,
  StashItem,
  Stash,
  UpcomingAdventure,
} from '../../../api/types';
import { daysToGoUnit, formatStashDate } from '../constants';
import {
  ACCENT,
  HAIRLINE,
  INK,
  INK_FAINT,
  INK_MUTED,
  LlfButton,
  LlfCard,
  LlfChip,
  ProgressArt,
  SectionLabel,
} from './shared';

/**
 * The five read-only sections of live.life.fully, transcribed from the render
 * functions in twin-app/js/live-life.js.
 *
 * Every figure printed here is a `*_display` string the backend produced. The
 * only arithmetic anywhere in this file is `Math.min` when topping a stash up,
 * and that mirrors the web line for line — it exists because the goals API
 * rejects a `current_amount` above the target, so a generous top-up lands on
 * the target rather than being refused.
 */

/* ---------------------------------------------------------------- hero --- */

export function Hero({ freedom, accent }: { freedom: FreedomBalance; accent: string }) {
  const [whyOpen, setWhyOpen] = useState(false);
  const known = freedom.status !== 'insufficient_data';
  const calc = freedom.calculation ?? {};

  const chips: React.ReactNode[] = [];
  if (freedom.status) {
    chips.push(
      <LlfChip
        key="status"
        label={freedom.status === 'estimated' ? 'Estimated' : freedom.status.replace(/_/g, ' ')}
      />,
    );
  }
  if (freedom.period) {
    chips.push(<LlfChip key="period" label={`Over the ${freedom.period}`} />);
  }
  if (freedom.buffer_status === 'healthy') {
    chips.push(
      <LlfChip
        key="buffer"
        tone="accent"
        accent={accent}
        label={`Buffer healthy · ${freedom.buffer_months} months`}
      />,
    );
  } else if (freedom.buffer_status === 'building' || freedom.buffer_status === 'thin') {
    chips.push(
      <LlfChip key="buffer" tone="warn" label={`Buffer ${freedom.buffer_months} months`} />,
    );
  }

  return (
    <View style={{ gap: 14 }}>
      <LlfCard>
        <Text variant="label" style={{ color: INK_FAINT }}>
          {freedom.label}
        </Text>
        <Text
          variant="display"
          style={{ color: known ? INK : INK_FAINT, fontSize: 44, lineHeight: 52 }}
          tabular
        >
          {known ? freedom.display : '—'}
        </Text>
        <Text variant="bodySmall" style={{ color: INK_MUTED }}>
          {freedom.copy}
        </Text>
        {freedom.note ? (
          <Text variant="bodySmall" style={{ color: INK_FAINT }}>
            {freedom.note}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          {chips}
        </View>
      </LlfCard>

      <LlfCard>
        <Text variant="heading" style={{ color: INK }}>
          What it is made of
        </Text>
        <Text variant="bodySmall" style={{ color: INK_FAINT }}>
          Everything below comes out before a rupee is called free.
        </Text>

        {(freedom.breakdown ?? []).length ? (
          <View style={{ gap: 2, marginTop: 6 }}>
            {(freedom.breakdown ?? []).map((b) => (
              <View
                key={b.key}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 10,
                  paddingVertical: 9,
                  borderBottomWidth: 1,
                  borderBottomColor: HAIRLINE,
                }}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    marginTop: 7,
                    backgroundColor: b.kind === 'source' ? accent : INK_FAINT,
                  }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="bodySmall" style={{ color: INK_MUTED }}>
                    {b.label}
                  </Text>
                  {b.note ? (
                    <Text variant="label" style={{ color: INK_FAINT }}>
                      {b.note}
                    </Text>
                  ) : null}
                </View>
                <Text variant="bodySmall" style={{ color: INK }} tabular>
                  {b.display}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text variant="bodySmall" style={{ color: INK_FAINT }}>
            {freedom.note || ''}
          </Text>
        )}

        {/* The two-sided check, worded as the web words it. */}
        {known && freedom.flow && freedom.stock ? (
          <Text variant="bodySmall" style={{ color: INK_FAINT, marginTop: 6 }}>
            Checked two ways, and held to the lower answer: {freedom.flow.display} is what this
            month&apos;s income can carry, {freedom.stock.display} is what your savings can spare
            above your buffer.
          </Text>
        ) : !known ? (
          <Text variant="bodySmall" style={{ color: INK_FAINT, marginTop: 6 }}>
            {freedom.note || ''}
          </Text>
        ) : null}

        {known ? (
          <>
            <Pressable
              onPress={() => setWhyOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: whyOpen }}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, marginTop: 6 })}
            >
              <Text variant="label" style={{ color: accent }}>
                {whyOpen ? 'Hide the working' : 'How is this worked out?'}
              </Text>
            </Pressable>

            {whyOpen ? (
              <View style={{ gap: 8, marginTop: 6 }}>
                {calc.formula ? (
                  <Text variant="mono" style={{ color: INK_MUTED }}>
                    {calc.formula}
                  </Text>
                ) : null}
                {Object.entries(calc.inputs ?? {}).map(([k, v]) => (
                  <Text key={k} variant="mono" style={{ color: INK_FAINT }}>
                    {k.replace(/_/g, ' ')}: {String(v)}
                  </Text>
                ))}
                {calc.data_source ? (
                  <Text variant="label" style={{ color: INK_FAINT }}>
                    Source: {calc.data_source}
                  </Text>
                ) : null}
                {(freedom.assumptions ?? []).length ? (
                  <View style={{ gap: 3 }}>
                    <Text variant="label" style={{ color: INK_FAINT }}>
                      Assumptions
                    </Text>
                    {(freedom.assumptions ?? []).map((a, i) => (
                      <Text key={i} variant="label" style={{ color: INK_FAINT }}>
                        · {a}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
      </LlfCard>
    </View>
  );
}

/* -------------------------------------------------------------- moment --- */

export function MomentSection({
  moment,
  repeat,
  locked,
  accent,
  onAction,
  onCheckFirst,
}: {
  moment: LiveLifeMoment | null;
  repeat: boolean;
  locked?: LiveLifeMomentLocked | null;
  accent: string;
  onAction: (target: string) => void;
  onCheckFirst: () => void;
}) {
  if (moment) {
    return (
      <View style={{ gap: 10 }}>
        <SectionLabel>A moment for you</SectionLabel>
        <LlfCard tint={repeat ? undefined : accent}>
          <Text variant="label" style={{ color: repeat ? INK_FAINT : accent }}>
            {repeat ? 'Still true today' : '✨ You deserve this'}
          </Text>
          <Text variant="title" style={{ color: INK }}>
            {moment.title}
          </Text>
          <Text variant="bodySmall" style={{ color: INK_MUTED }}>
            {moment.message}
          </Text>

          {(moment.evidence ?? []).length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {(moment.evidence ?? []).map((e, i) => (
                <LlfChip key={i} label={e} />
              ))}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            {moment.action ? (
              <LlfButton
                label={`${moment.action.label} →`}
                variant="primary"
                accent={accent}
                onPress={() => onAction(moment.action?.target || '')}
              />
            ) : null}
            <LlfButton label="Check something first" variant="ghost" onPress={onCheckFirst} />
          </View>
        </LlfCard>
      </View>
    );
  }

  if (locked) {
    return (
      <View style={{ gap: 10 }}>
        <SectionLabel>A moment for you</SectionLabel>
        <LlfCard>
          <Text variant="title" style={{ color: INK }}>
            {locked.title}
          </Text>
          <Text variant="bodySmall" style={{ color: INK_MUTED }}>
            {locked.message}
          </Text>
          {(locked.needs ?? []).map((n, i) => (
            <Text key={i} variant="bodySmall" style={{ color: INK_FAINT }}>
              · {n}
            </Text>
          ))}
        </LlfCard>
      </View>
    );
  }

  return null;
}

/* ----------------------------------------------------------- adventure --- */

export function AdventureSection({ adventure }: { adventure: UpcomingAdventure }) {
  // The backend sends a per-category accent (sunset, violet, neon) left over
  // from the old rotating-scene direction. It is ignored: this experience now
  // has one accent, and it is MoneyKal cyan. See constants.ts.
  const tint = ACCENT;
  return (
    <View style={{ gap: 10 }}>
      <SectionLabel>Upcoming adventure</SectionLabel>

      <LlfCard tint={tint}>
        <Text variant="display" style={{ fontSize: 30, lineHeight: 36 }}>
          {adventure.emoji}
        </Text>
        <Text variant="title" style={{ color: INK }}>
          {adventure.name}
        </Text>
        {adventure.date_display ? (
          <Text variant="bodySmall" style={{ color: INK_FAINT }}>
            {adventure.date_display}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
          <Text variant="display" style={{ color: tint, fontSize: 40, lineHeight: 46 }} tabular>
            {adventure.days_to_go ?? '—'}
          </Text>
          <Text variant="bodySmall" style={{ color: INK_MUTED }}>
            {daysToGoUnit(adventure.days_to_go)}
          </Text>
        </View>

        {adventure.readiness ? (
          <Text variant="bodySmall" style={{ color: INK_MUTED }}>
            {adventure.readiness}
          </Text>
        ) : null}
      </LlfCard>

      <LlfCard tint={tint}>
        <Text variant="label" style={{ color: INK_FAINT }}>
          Funding
        </Text>
        <Text variant="bodySmall" style={{ color: INK_MUTED }}>
          {adventure.current_display} of {adventure.target_display}
        </Text>
        <ProgressArt
          art={adventure.progress_art}
          percentage={adventure.percentage}
          accent={tint}
        />
      </LlfCard>
    </View>
  );
}

/* --------------------------------------------------------------- stash --- */

export function StashSection({
  stash,
  onFund,
  onCreate,
  onAsk,
}: {
  stash: Stash;
  onFund: (item: StashItem) => void;
  onCreate: (categoryKey: string) => void;
  onAsk: (amount: number, goalId: number) => void;
}) {
  if (!stash.count) {
    return (
      <View style={{ gap: 10 }}>
        <SectionLabel>Experience stash</SectionLabel>
        <LlfCard>
          <Text variant="heading" style={{ color: INK }}>
            Nothing set aside for an experience yet
          </Text>
          <Text variant="bodySmall" style={{ color: INK_MUTED }}>
            A stash is a savings goal with a better name. Start one and it shows up in your Goals,
            on your Financial Calendar and in the countdown above — MoneyKal keeps one set of
            numbers, not two.
          </Text>
          <View style={{ flexDirection: 'row', marginTop: 6 }}>
            <LlfButton
              label="Start a stash"
              variant="primary"
              onPress={() => onCreate('experience_trips')}
            />
          </View>
        </LlfCard>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <SectionLabel>{`Experience stash · ${stash.total_saved_display} set aside`}</SectionLabel>

      <View style={{ gap: 12 }}>
        {stash.items.map((i) => {
          const tint = ACCENT; // see the note in AdventureSection
          return (
            <LlfCard key={i.id} tint={tint}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text variant="title">{i.emoji}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="heading" style={{ color: INK }}>
                    {i.name}
                  </Text>
                  <Text variant="label" style={{ color: INK_FAINT }}>
                    {i.experience_label}
                    {i.target_date ? ` · ${formatStashDate(i.target_date)}` : ''}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                <Text variant="metric" style={{ color: INK }} tabular>
                  {i.current_display}
                </Text>
                <Text variant="bodySmall" style={{ color: INK_FAINT }}>
                  of {i.target_display}
                </Text>
              </View>

              <Text variant="bodySmall" style={{ color: INK_MUTED }}>
                {i.is_funded
                  ? 'Fully funded. Go and use it.'
                  : `${i.remaining_display} to go${
                      i.monthly_required_display
                        ? ` · about ${i.monthly_required_display} a month to land on time`
                        : ''
                    }`}
              </Text>

              <ProgressArt art={i.progress_art} percentage={i.percentage} accent={tint} />

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                <LlfButton label="Add money" onPress={() => onFund(i)} />
                {i.remaining > 0 ? (
                  <LlfButton
                    label="Can I afford the rest?"
                    variant="ghost"
                    onPress={() => onAsk(i.remaining, i.id)}
                  />
                ) : null}
              </View>
            </LlfCard>
          );
        })}
      </View>
    </View>
  );
}

/* ---------------------------------------------------------- categories --- */

export function CategoriesSection({
  categories,
  onOpen,
  onCreate,
}: {
  categories: ExperienceCategory[];
  /** A category the user already has a stash in scrolls to it… */
  onOpen: () => void;
  /** …an empty one opens the create sheet, pre-typed. */
  onCreate: (categoryKey: string) => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      <SectionLabel>What are you saving to live?</SectionLabel>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {categories.map((c) => {
          const has = c.stash_count > 0;
          const tint = ACCENT; // see the note in AdventureSection
          return (
            <Pressable
              key={c.key}
              onPress={() => (c.lead_stash_id ? onOpen() : onCreate(c.key))}
              accessibilityRole="button"
              accessibilityLabel={`${c.label} — ${has ? 'open it' : 'start one'}`}
              style={({ pressed }) => ({
                flexGrow: 1,
                flexBasis: '46%',
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <LlfCard tint={tint} style={{ minHeight: 168 }}>
                <Text variant="title">{c.emoji}</Text>
                <Text variant="heading" style={{ color: INK }}>
                  {c.label}
                </Text>
                <Text variant="label" style={{ color: INK_FAINT }}>
                  {c.blurb}
                </Text>

                {has ? (
                  <View style={{ gap: 6, marginTop: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
                      <Text variant="bodySmall" style={{ color: INK }} tabular>
                        {c.saved_display}
                      </Text>
                      {c.target_display ? (
                        <Text variant="label" style={{ color: INK_FAINT }}>
                          of {c.target_display}
                        </Text>
                      ) : null}
                    </View>
                    <View
                      style={{
                        height: 5,
                        borderRadius: 3,
                        backgroundColor: 'rgba(244,242,238,0.14)',
                        overflow: 'hidden',
                      }}
                    >
                      <View
                        style={{
                          width: `${Math.max(0, Math.min(c.percentage ?? 0, 100))}%`,
                          height: '100%',
                          backgroundColor: tint,
                        }}
                      />
                    </View>
                    <Text variant="label" style={{ color: tint }}>
                      Open it →
                    </Text>
                  </View>
                ) : (
                  <Text variant="label" style={{ color: tint, marginTop: 4 }}>
                    Start one →
                  </Text>
                )}
              </LlfCard>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
