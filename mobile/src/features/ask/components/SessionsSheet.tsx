import React, { useState } from 'react';
import { View } from 'react-native';

import type { ChatSessionSummary } from '../../../api/types';
import {
  Button,
  Divider,
  Glyph,
  Input,
  ListRow,
  Sheet,
  Skeleton,
  Text,
  confirmDestructive,
} from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  visible: boolean;
  sessions: ChatSessionSummary[];
  loading: boolean;
  activeId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/**
 * Saved conversations.
 *
 * The web keeps these in a permanent left sidebar (`.chat-history-sidebar`).
 * A phone has no room for a second column beside a conversation, so the list
 * becomes a sheet reached from the header — the conversation keeps the screen.
 *
 * These are the profile's server-side sessions, so a conversation started on
 * the website appears here for the same account, and vice versa.
 */
export function SessionsSheet({
  visible,
  sessions,
  loading,
  activeId,
  onClose,
  onOpen,
  onNew,
  onRename,
  onDelete,
}: Props) {
  const theme = useTheme();
  const [renaming, setRenaming] = useState<ChatSessionSummary | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!visible) {
      setRenaming(null);
      setTitle('');
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  async function saveRename() {
    if (!renaming || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(renaming.id, title.trim());
      setRenaming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename that conversation.');
    } finally {
      setBusy(false);
    }
  }

  function askDelete(session: ChatSessionSummary) {
    confirmDestructive({
      title: 'Delete this conversation?',
      message: `"${session.title}" and its messages will be removed for every device. This cannot be undone.`,
      onConfirm: async () => {
        try {
          await onDelete(session.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not delete that conversation.');
        }
      },
    });
  }

  /** "12 Aug, 14:30" — the same shape the web's session list shows. */
  function when(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  if (renaming) {
    return (
      <Sheet
        visible={visible}
        onClose={() => setRenaming(null)}
        title="Rename conversation"
        error={error}
        footer={
          <>
            <Button label="Save" onPress={saveRename} loading={busy} disabled={busy || !title.trim()} />
            <Button label="Cancel" variant="ghost" onPress={() => setRenaming(null)} disabled={busy} />
          </>
        }
      >
        <Input
          label="Title"
          value={title}
          onChangeText={setTitle}
          autoFocus
          editable={!busy}
          maxLength={120}
        />
      </Sheet>
    );
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Conversations"
      subtitle="Saved to your MoneyKal account — the same list you see on the web."
      error={error}
      footer={
        <Button
          label="New conversation"
          onPress={() => {
            onNew();
            onClose();
          }}
        />
      }
    >
      {loading ? (
        <View style={{ gap: theme.spacing.md }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ gap: 6 }}>
              <Skeleton width="70%" height={14} />
              <Skeleton width="40%" height={11} />
            </View>
          ))}
        </View>
      ) : !sessions.length ? (
        <View style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.xxl }}>
          <Glyph name="spark" color={theme.colors.inkFaint} size={24} />
          <Text variant="bodySmall" color="muted" center>
            No saved conversations yet. Ask TATHYA something and it will appear here — on this
            phone and on the web.
          </Text>
        </View>
      ) : (
        <View>
          {sessions.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                label={s.title}
                detail={when(s.created_at)}
                leading={
                  <Glyph
                    name="spark"
                    color={s.id === activeId ? theme.colors.accent : theme.colors.inkFaint}
                    size={16}
                  />
                }
                onPress={() => {
                  onOpen(s.id);
                  onClose();
                }}
                trailing={
                  <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
                    <Text
                      variant="bodySmall"
                      color="accent"
                      onPress={() => {
                        setTitle(s.title);
                        setRenaming(s);
                      }}
                      suppressHighlighting
                    >
                      Rename
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.warn }}
                      onPress={() => askDelete(s)}
                      suppressHighlighting
                    >
                      Delete
                    </Text>
                  </View>
                }
              />
            </React.Fragment>
          ))}
        </View>
      )}
    </Sheet>
  );
}
