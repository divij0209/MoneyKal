import React, { useMemo } from 'react';
import { View } from 'react-native';

import { Text } from '../../components';
import { useTheme } from '../../theme';

/**
 * Markdown rendering for TATHYA's answers.
 *
 * The web passes the answer through `marked.parse()` (twin-app/js/app.js
 * addBubble), so answers can and do contain markdown — the Explainer agent is
 * asked to "format the response as a 10-point response", which reliably
 * produces numbered lists, and often bold labels.
 *
 * This is a deliberately small renderer rather than a markdown library. Two
 * reasons: a library brings its own type scale and would fight MoneyKal's
 * tokens on every heading and list item, and the answer format here is narrow.
 * It handles what the backend actually emits — headings, bold, italic, inline
 * code, bullet and numbered lists, block quotes, rules and paragraphs — and
 * anything it doesn't recognise falls through as plain text rather than
 * showing raw syntax.
 *
 * It formats nothing financial. Every figure inside the string was computed by
 * the backend; this only decides what is bold and what is a bullet.
 */

interface Props {
  content: string;
  /** Rendered on an accent ground, where muted greys lose contrast. */
  onAccent?: boolean;
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string; level: number }
  | { kind: 'li'; text: string; marker: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' };

/** Splits into block-level pieces. Line-based: the source is chat prose, not a
 *  document, so nested structures do not occur. */
function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'p', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };

  for (const rawLine of (src || '').split('\n')) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', text: heading[2].trim(), level: heading[1].length });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      blocks.push({ kind: 'quote', text: quote[1].trim() });
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      flush();
      blocks.push({ kind: 'li', marker: `${numbered[1]}.`, text: numbered[2].trim() });
      continue;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      flush();
      blocks.push({ kind: 'li', marker: '•', text: bullet[1].trim() });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

/**
 * Inline emphasis. Ordered so `**bold**` is matched before `*italic*`, and
 * `` `code` `` before either, which is what stops `**` being read as two
 * italic markers.
 */
function parseInline(src: string): Span[] {
  const spans: Span[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(src)) !== null) {
    if (match.index > last) spans.push({ text: src.slice(last, match.index) });
    const token = match[0];

    if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('**') || token.startsWith('__')) {
      spans.push({ text: token.slice(2, -2), bold: true });
    } else spans.push({ text: token.slice(1, -1), italic: true });

    last = match.index + token.length;
  }

  if (last < src.length) spans.push({ text: src.slice(last) });
  return spans.length ? spans : [{ text: src }];
}

function Inline({ src, onAccent }: { src: string; onAccent?: boolean }) {
  const theme = useTheme();
  const spans = useMemo(() => parseInline(src), [src]);

  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          variant="body"
          color="inherit"
          style={{
            ...(s.bold ? { fontFamily: theme.fonts.bodySemiBold } : null),
            ...(s.italic ? { fontStyle: 'italic' as const } : null),
            ...(s.code
              ? {
                  fontFamily: theme.fonts.mono,
                  fontSize: 13,
                  color: onAccent ? theme.colors.onAccent : theme.colors.accent,
                }
              : null),
          }}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}

export function Markdown({ content, onAccent }: Props) {
  const theme = useTheme();
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const baseColor = onAccent ? theme.colors.onAccent : theme.colors.ink;
  const softColor = onAccent ? theme.colors.onAccent : theme.colors.inkMuted;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {blocks.map((block, i) => {
        if (block.kind === 'rule') {
          return (
            <View
              key={i}
              style={{
                height: 1,
                backgroundColor: onAccent ? theme.colors.onAccent : theme.colors.line,
                opacity: onAccent ? 0.25 : 1,
                marginVertical: theme.spacing.xs,
              }}
            />
          );
        }

        if (block.kind === 'h') {
          return (
            <Text
              key={i}
              variant={block.level <= 2 ? 'title' : 'heading'}
              style={{ color: baseColor, marginTop: i === 0 ? 0 : theme.spacing.xs }}
            >
              {block.text}
            </Text>
          );
        }

        if (block.kind === 'quote') {
          return (
            <View
              key={i}
              style={{
                borderLeftWidth: 2,
                borderLeftColor: onAccent ? theme.colors.onAccent : theme.colors.accentBorder,
                paddingLeft: theme.spacing.md,
              }}
            >
              <Text variant="body" style={{ color: softColor }}>
                <Inline src={block.text} onAccent={onAccent} />
              </Text>
            </View>
          );
        }

        if (block.kind === 'li') {
          return (
            <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Text
                variant="body"
                tabular
                style={{ color: onAccent ? theme.colors.onAccent : theme.colors.accent, minWidth: 16 }}
              >
                {block.marker}
              </Text>
              <Text variant="body" style={{ flex: 1, color: baseColor }}>
                <Inline src={block.text} onAccent={onAccent} />
              </Text>
            </View>
          );
        }

        return (
          <Text key={i} variant="body" style={{ color: baseColor }}>
            <Inline src={block.text} onAccent={onAccent} />
          </Text>
        );
      })}
    </View>
  );
}
