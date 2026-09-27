import React, { useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { ApiError, hisaabApi } from '../../../api';
import type { ReceiptScan } from '../../../api/types';
import { Button, Divider, Glyph, ListRow, Sheet, Text } from '../../../components';
import { useTheme } from '../../../theme';
import { HISAAB_CATEGORIES, formatAmount, receiptAmount } from '../constants';
import type { TransactionDraft } from './TransactionSheet';

interface Props {
  visible: boolean;
  currency: string;
  onClose: () => void;
  /** Hands the reviewed figures to the add-transaction sheet. Nothing is
   *  written to the ledger from here. */
  onUseResult: (draft: Partial<TransactionDraft>) => void;
}

type Stage = 'choose' | 'scanning' | 'review';

/**
 * Receipt scanning.
 *
 * The image goes to POST /hisaab/scan-receipt, which runs Gemini vision
 * server-side — no AI credential exists on the device, and the route requires
 * the app's bearer token.
 *
 * The extracted figures are shown for review and then prefill the add sheet.
 * A scan never creates a transaction on its own: an OCR reading is a
 * suggestion, and the user confirms it in the same form they would have typed.
 * That mirrors the web, where a scan fills the Hisaab form and the user still
 * presses Add.
 */
export function ReceiptScanner({ visible, currency, onClose, onUseResult }: Props) {
  const theme = useTheme();
  const [stage, setStage] = useState<Stage>('choose');
  const [scan, setScan] = useState<ReceiptScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissionBlocked, setPermissionBlocked] = useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setStage('choose');
    setScan(null);
    setError(null);
    setPermissionBlocked(false);
  }, [visible]);

  async function run(source: 'camera' | 'library') {
    setError(null);
    setPermissionBlocked(false);

    try {
      // Permission is requested at the moment of use, so the prompt arrives
      // with the reason on screen rather than at app start.
      const perm =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!perm.granted) {
        setPermissionBlocked(!perm.canAskAgain);
        setError(
          source === 'camera'
            ? 'MoneyKal needs camera access to scan a receipt.'
            : 'MoneyKal needs photo access to read a receipt.',
        );
        return;
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: 'images',
        allowsEditing: true,
        // Enough detail for the model to read a receipt, small enough to
        // upload on a phone connection.
        quality: 0.7,
      };

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync(options)
          : await ImagePicker.launchImageLibraryAsync(options);

      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      setStage('scanning');

      const data = await hisaabApi.scanReceipt({
        uri: asset.uri,
        name: asset.fileName || 'receipt.jpg',
        mimeType: asset.mimeType,
      });

      setScan(data);
      setStage('review');
    } catch (err) {
      setStage('choose');
      setError(
        err instanceof ApiError
          ? err.detail
          : 'Could not read that receipt. Try a clearer photo.',
      );
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Receipt scan failed for a non-API reason:', err);
      }
    }
  }

  function useResult() {
    if (!scan) return;
    const amount = receiptAmount(scan);

    // The scan prompt constrains `category` to the same list the form offers,
    // so which side of the ledger it belongs on follows from that rather than
    // from any judgement made here — the web decides it the same way.
    const isOut = !!scan.category && HISAAB_CATEGORIES.out.includes(scan.category as never);

    let description = scan.merchant || '';
    const names = (scan.items ?? []).map((i) => i.name).filter(Boolean);
    if (names.length) description += (description ? ' - ' : '') + names.join(', ');

    onUseResult({
      type: isOut ? 'out' : 'in',
      category: scan.category || undefined,
      amount: amount != null ? String(Number(amount.toFixed(2))) : '',
      description,
      txn_date: scan.date || undefined,
    });
    onClose();
  }

  const amount = scan ? receiptAmount(scan) : null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Scan a receipt"
      subtitle={
        stage === 'review'
          ? 'Check these before adding — nothing is saved yet.'
          : 'MoneyKal reads the merchant, date, items and total.'
      }
      error={error}
      footer={
        stage === 'review' ? (
          <>
            <Button label="Review and add" onPress={useResult} />
            <Button label="Scan another" variant="outline" onPress={() => setStage('choose')} />
          </>
        ) : permissionBlocked ? (
          <Button
            label="Open Settings"
            variant="outline"
            onPress={() => Linking.openSettings().catch(() => undefined)}
          />
        ) : undefined
      }
    >
      {stage === 'scanning' ? (
        <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.xxxl }}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text variant="bodySmall" color="muted">
            Reading your receipt…
          </Text>
          <Text variant="bodySmall" color="faint" center>
            This takes a few seconds.
          </Text>
        </View>
      ) : stage === 'review' && scan ? (
        <View style={{ gap: theme.spacing.md }}>
          <Field label="Merchant" value={scan.merchant || '—'} />
          <Divider />
          <Field label="Date" value={scan.date || 'Not found'} />
          <Divider />
          <Field
            label="Total"
            value={amount != null ? formatAmount(amount, currency) : 'Not found'}
            emphasis
          />
          {scan.tax_amount ? (
            <>
              <Divider />
              <Field label="Tax" value={formatAmount(scan.tax_amount, currency)} />
            </>
          ) : null}
          <Divider />
          <Field label="Category" value={scan.category || 'Not detected'} />

          {scan.items?.length ? (
            <>
              <Divider />
              <Text variant="label" color="faint">
                {scan.items.length} item{scan.items.length === 1 ? '' : 's'}
              </Text>
              {scan.items.map((item, i) => (
                <View
                  key={i}
                  style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}
                >
                  <Text variant="bodySmall" color="muted" style={{ flex: 1 }} numberOfLines={1}>
                    {item.name || 'Item'}
                  </Text>
                  <Text variant="bodySmall" tabular>
                    {formatAmount(item.amount, currency)}
                  </Text>
                </View>
              ))}
            </>
          ) : null}

          {amount == null ? (
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              No total could be read — you can enter it yourself on the next screen.
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          <ListRow
            label="Take a photo"
            detail="Point the camera at the receipt."
            leading={<Glyph name="spark" color={theme.colors.accent} size={20} />}
            onPress={() => run('camera')}
          />
          <Divider />
          <ListRow
            label="Choose from photos"
            detail="Pick a receipt you have already saved."
            leading={<Glyph name="wallet" color={theme.colors.accent} size={20} />}
            onPress={() => run('library')}
          />

          <Text variant="bodySmall" color="faint" style={{ paddingTop: theme.spacing.md }}>
            The photo is sent to MoneyKal only to read the figures from it. You review
            everything before it becomes a transaction.
          </Text>
        </View>
      )}
    </Sheet>
  );
}

function Field({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing.lg,
      }}
    >
      <Text variant="bodySmall" color="faint">
        {label}
      </Text>
      <Text variant={emphasis ? 'heading' : 'body'} tabular style={{ flex: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}
