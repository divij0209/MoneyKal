import React, { useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { ApiError, onboardingApi } from '../../../api';
import type { ExtractedFinancials } from '../../../api/endpoints/onboarding';
import { Divider, Glyph, ListRow, Sheet, Text } from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  onOpenChat: () => void;
  /** Called with whatever the statement parser extracted. */
  onExtracted: (data: ExtractedFinancials) => void;
}

/**
 * The alternative ways in, offered alongside typing.
 *
 * Two of the three fill the form for you and are then reviewed before
 * submitting — nothing is saved on your behalf. The third is the Excel
 * template, which is a download rather than an import; see the note below.
 */
export function AssistSheet({ visible, onClose, onOpenChat, onExtracted }: Props) {
  const theme = useTheme();
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickStatement() {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // The backend's extractor handles PDF, CSV and Excel, and falls back to
        // reading anything else as plain text.
        type: ['application/pdf', 'text/csv', 'text/plain', 'application/vnd.ms-excel'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      setParsing(true);
      const data = await onboardingApi.parseStatement({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
      });
      setParsing(false);
      onExtracted(data);
      onClose();
    } catch (err) {
      setParsing(false);
      setError(
        err instanceof ApiError
          ? err.detail
          : 'Could not read that file. Try a different statement.',
      );
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Statement parse failed for a non-API reason:', err);
      }
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Fill this in faster"
      subtitle="However you start, you review every figure before anything is saved."
      error={error}
    >
      <View style={{ gap: theme.spacing.sm }}>
        <ListRow
          label="Answer a few questions"
          detail="MoneyKal asks 3–4 short questions and fills the form from your answers."
          leading={<Glyph name="spark" color={theme.colors.accent} size={20} />}
          onPress={() => {
            setError(null);
            onOpenChat();
          }}
        />

        <Divider />

        <ListRow
          label={parsing ? 'Reading your statement…' : 'Upload a bank statement'}
          detail="A PDF or CSV. MoneyKal extracts income, savings and expenses from it."
          leading={
            parsing ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : (
              <Glyph name="wallet" color={theme.colors.accent} size={20} />
            )
          }
          onPress={parsing ? undefined : pickStatement}
        />

        <Divider />

        <ListRow
          label="Download the Excel template"
          detail="A spreadsheet of every field, to gather your figures offline."
          leading={<Glyph name="external" color={theme.colors.inkMuted} size={20} />}
          onPress={() =>
            Linking.openURL(onboardingApi.excelTemplateUrl('individual')).catch(() =>
              setError('Could not open the template link.'),
            )
          }
        />
      </View>

      {/* Said plainly rather than offering a button that would fail: the
          upload route resolves the caller's profile first and returns 404
          until one exists, so it is an update path, not a setup path. */}
      <Text variant="bodySmall" color="faint" style={{ paddingTop: theme.spacing.lg }}>
        Importing a filled-in spreadsheet becomes available once your profile exists — the
        import updates a profile rather than creating one.
      </Text>
    </Sheet>
  );
}
