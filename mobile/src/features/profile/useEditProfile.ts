import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError, onboardingApi } from '../../api';
import type { IndividualOnboardingPayload } from '../../api/endpoints/onboarding';
import type { StartupUpdatePayload } from '../../api/endpoints/onboarding';
import { profileQueryKey, useProfile } from '../../store';
import { fieldsFor, toFormValue, toPayloadValue, type FieldDef } from './constants';

/**
 * Edit Profile's state.
 *
 * Two rules shape this hook.
 *
 * The first is that the *server* owns the values: the form is seeded from
 * `GET /profile/me`'s `details` block and nothing is computed here. The second
 * is that only changed fields are sent. Both update endpoints apply
 * `req.dict(exclude_unset=True)`, so an omitted key is left alone — which makes
 * a partial payload the correct payload, and a full one a way to overwrite
 * fields the form does not even show. `details` carries 29 keys for a founder
 * and the form edits 16 of them; resending everything would be wrong.
 */

export type FieldValues = Record<string, string>;

export function useEditProfile() {
  const qc = useQueryClient();
  const { profile, persona } = useProfile();

  const fields: FieldDef[] = useMemo(() => fieldsFor(persona), [persona]);

  /** What the server had when the form opened — the diff baseline. */
  const initial: FieldValues = useMemo(() => {
    const details = (profile?.details ?? {}) as Record<string, unknown>;
    const out: FieldValues = {};
    for (const f of fields) out[f.key] = toFormValue(details[f.key], f.kind);
    return out;
  }, [profile, fields]);

  const [values, setValues] = useState<FieldValues>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seed when the profile arrives or is refetched, but never on top of edits
  // in flight — the dependency is the baseline itself, so a refetch that
  // changes nothing leaves the form alone.
  useEffect(() => {
    setValues(initial);
  }, [initial]);

  const setField = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setError(null);
  }, []);

  /** The keys whose on-screen value differs from what the server sent. */
  const changedKeys = useMemo(
    () => fields.filter((f) => (values[f.key] ?? '') !== (initial[f.key] ?? '')).map((f) => f.key),
    [fields, values, initial],
  );

  const isDirty = changedKeys.length > 0;

  const buildPayload = useCallback(() => {
    const payload: Record<string, string | number | null> = {};
    for (const f of fields) {
      if (!changedKeys.includes(f.key)) continue;
      payload[f.key] = toPayloadValue(values[f.key] ?? '', f.kind);
    }
    return payload;
  }, [fields, changedKeys, values]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload = buildPayload();
      if (persona === 'startup') {
        await onboardingApi.updateStartup(payload as StartupUpdatePayload);
      } else {
        await onboardingApi.updateIndividual(payload as Partial<IndividualOnboardingPayload>);
      }

      // The persona strip, the header greeting and Home's snapshot all read the
      // same profile query, and the backend mirrors company/full name onto
      // `profile.persona` — so a refetch is what makes a rename appear
      // everywhere at once rather than only on this screen.
      await qc.invalidateQueries({ queryKey: profileQueryKey });
      setSaved(true);
      return true;
    } catch (err) {
      // The backend's own wording, verbatim: it distinguishes a malformed
      // GSTIN from a wrong-persona profile, and both need different fixes.
      setError(
        err instanceof ApiError ? err.detail : 'Could not save your profile. Please try again.',
      );
      return false;
    } finally {
      setSaving(false);
    }
  }, [isDirty, buildPayload, persona, qc]);

  const reset = useCallback(() => {
    setValues(initial);
    setError(null);
    setSaved(false);
  }, [initial]);

  return {
    persona,
    fields,
    values,
    setField,
    changedKeys,
    isDirty,
    saving,
    error,
    saved,
    save,
    reset,
    /** Null until GET /profile/me resolves. */
    loaded: !!profile,
  };
}
