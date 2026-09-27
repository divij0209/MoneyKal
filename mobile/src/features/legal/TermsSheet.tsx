import React, { useCallback, useRef, useState } from 'react';
import { View, type ScrollView } from 'react-native';

import { Button, Sheet, Text } from '../../components';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import {
  TERMS_CALLOUT,
  TERMS_SECTIONS,
  TERMS_SUBTITLE,
  TERMS_UPDATED,
  TERMS_VERSION,
} from './termsContent';

/**
 * The Terms & Conditions, read in place.
 *
 * A bottom sheet rather than a screen push, for the same reason the web uses a
 * dialog: reading the Terms must not cost the user the half-filled form
 * underneath. Nothing here navigates, and nothing opens a browser.
 *
 * It rides on the app's existing `Sheet` primitive, so the grabber, scrim,
 * close control and motion are the ones used everywhere else. The only thing
 * it needs of its own is a handle on the scroll area, so that opening on the
 * Privacy Policy link lands on the privacy clause instead of at the top of a
 * long document.
 */

/** `**bold**` is the only inline form the content file uses. */
function Rich({ text, color }: { text: string; color?: 'muted' | 'faint' }) {
  const theme = useTheme();
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);

  return (
    <Text variant="body" color={color ?? 'muted'}>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <Text
            key={i}
            variant="body"
            style={{ fontFamily: theme.fonts.bodySemiBold, color: theme.colors.ink }}
          >
            {part.slice(2, -2)}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

export interface TermsSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Open scrolled to this section id, e.g. 'privacy'. */
  initialSection?: string | null;
}

export function TermsSheet({ visible, onClose, initialSection }: TermsSheetProps) {
  const theme = useTheme();
  const t = useT();
  const scrollRef = useRef<ScrollView>(null);
  // Section offsets, measured as they lay out. A section the reader has not
  // scrolled past yet still reports its offset, because the whole document is
  // mounted rather than virtualised.
  const offsets = useRef<Record<string, number>>({});
  const [ready, setReady] = useState(false);

  const jump = useCallback(() => {
    if (!initialSection) return;
    const y = offsets.current[initialSection];
    if (y == null) return;
    scrollRef.current?.scrollTo({ y: Math.max(y - 8, 0), animated: false });
  }, [initialSection]);

  // Runs once the document has laid out, which is the first moment an offset
  // exists to scroll to.
  const onDocumentLayout = useCallback(() => {
    if (ready) return;
    setReady(true);
    requestAnimationFrame(jump);
  }, [jump, ready]);

  // A fresh open re-measures: the sheet unmounts its content between openings.
  const handleClose = useCallback(() => {
    setReady(false);
    offsets.current = {};
    onClose();
  }, [onClose]);

  if (!visible) return null;

  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      title={t('terms.title')}
      subtitle={t('terms.meta', { version: TERMS_VERSION, date: TERMS_UPDATED })}
      scrollRef={scrollRef}
      footer={<Button label={t('common.close')} variant="ghost" onPress={handleClose} />}
    >
      <View onLayout={onDocumentLayout} style={{ gap: theme.spacing.lg }}>
        <Rich text={TERMS_SUBTITLE} color="faint" />

        {/* The disclaimer, given the one accented surface in the document. */}
        <View
          style={{
            padding: theme.spacing.lg,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.accentBorder,
            backgroundColor: theme.colors.accentTint,
          }}
        >
          <Rich text={TERMS_CALLOUT} />
        </View>

        {TERMS_SECTIONS.map((section, i) => (
          <View
            key={section.id}
            onLayout={(e) => {
              offsets.current[section.id] = e.nativeEvent.layout.y;
            }}
            style={{
              paddingTop: theme.spacing.lg,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
              gap: theme.spacing.sm,
            }}
          >
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Text variant="label" color="accent" style={{ marginTop: 3 }}>
                {String(i + 1).padStart(2, '0')}
              </Text>
              <Text variant="heading" style={{ flex: 1 }}>
                {section.title}
              </Text>
            </View>

            {section.body.map((block, j) =>
              typeof block === 'string' ? (
                <Rich key={j} text={block} />
              ) : (
                <View key={j} style={{ gap: theme.spacing.xs, paddingLeft: theme.spacing.xs }}>
                  {block.list.map((item, k) => (
                    <View key={k} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                      <Text variant="body" color="accent">
                        ·
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Rich text={item} />
                      </View>
                    </View>
                  ))}
                </View>
              ),
            )}
          </View>
        ))}

        <View style={{ height: theme.spacing.lg }} />
      </View>
    </Sheet>
  );
}
