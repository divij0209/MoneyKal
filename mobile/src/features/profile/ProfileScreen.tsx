import React from 'react';
import { View } from 'react-native';

import { Button, DateField, Divider, Input, Screen, Select, Text } from '../../components';
import { useTheme } from '../../theme';
import { UPPERCASE_FIELDS, sectionsOf, type FieldDef } from './constants';
import { useEditProfile } from './useEditProfile';

/**
 * Edit profile — the mobile counterpart of `#editProfileModal`.
 *
 * Loads from `GET /profile/me`, edits the fields that persona's update endpoint
 * accepts, and PUTs **only what changed**. Nothing on this screen is computed:
 * the values come from the server and go back to it, and every rejection is
 * shown in the backend's own words.
 *
 * The web builds three variants of this form. Enterprise is excluded here
 * because no account can reach that persona — register.html offers Individual
 * and Startup only — so its branch is dead code rather than a journey.
 */
export function ProfileScreen() {
  const theme = useTheme();
  const form = useEditProfile();

  if (!form.loaded) {
    return (
      <Screen scroll>
        <Text variant="bodySmall" color="faint">
          Loading your profile…
        </Text>
      </Screen>
    );
  }

  const sections = sectionsOf(form.fields);

  function renderField(f: FieldDef) {
    const value = form.values[f.key] ?? '';
    const changed = form.changedKeys.includes(f.key);

    if (f.kind === 'select') {
      return (
        <View key={f.key} style={{ gap: 4 }}>
          <Select
            label={f.label}
            value={value}
            options={f.options ?? []}
            onChange={(v) => form.setField(f.key, v)}
            placeholder={`Select ${f.label.toLowerCase()}`}
            disabled={form.saving}
          />
          {f.hint ? (
            <Text variant="label" color="faint">
              {f.hint}
            </Text>
          ) : null}
          {changed ? (
            <Text variant="label" color="accent">
              Changed
            </Text>
          ) : null}
        </View>
      );
    }

    if (f.kind === 'date') {
      return (
        <View key={f.key} style={{ gap: 4 }}>
          <DateField
            label={f.label}
            value={value ? value : null}
            onChange={(iso) => form.setField(f.key, iso ?? '')}
            clearable
          />
          {changed ? (
            <Text variant="label" color="accent">
              Changed
            </Text>
          ) : null}
        </View>
      );
    }

    return (
      <View key={f.key} style={{ gap: 4 }}>
        <Input
          label={f.label}
          value={value}
          onChangeText={(t) => form.setField(f.key, t)}
          editable={!form.saving}
          hint={f.hint}
          placeholder={f.placeholder}
          keyboardType={
            f.kind === 'number'
              ? 'number-pad'
              : f.kind === 'email'
                ? 'email-address'
                : f.kind === 'phone'
                  ? 'phone-pad'
                  : 'default'
          }
          autoCapitalize={
            UPPERCASE_FIELDS.has(f.key)
              ? 'characters'
              : f.kind === 'email'
                ? 'none'
                : f.kind === 'text'
                  ? 'words'
                  : 'none'
          }
          autoCorrect={f.kind === 'text' ? undefined : false}
        />
        {changed ? (
          <Text variant="label" color="accent">
            Changed
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <Screen scroll contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}>
      <View style={{ gap: theme.spacing.xxl, paddingTop: theme.spacing.md }}>
        <Text variant="bodySmall" color="muted">
          {form.persona === 'startup'
            ? 'Your Startup Financial Twin is rebuilt from these figures every time they change.'
            : 'Your financial twin is rebuilt from these figures every time they change.'}
        </Text>

        {sections.map((section) => (
          <View key={section} style={{ gap: theme.spacing.lg }}>
            <Text variant="label" color="muted">
              {section}
            </Text>
            {form.fields.filter((f) => f.section === section).map(renderField)}
            <Divider />
          </View>
        ))}

        {form.error ? (
          <View
            style={{
              padding: theme.spacing.md,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.warnTint,
              borderWidth: 1,
              borderColor: theme.colors.warn,
            }}
          >
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              {form.error}
            </Text>
          </View>
        ) : null}

        {form.saved && !form.isDirty ? (
          <Text variant="bodySmall" color="accent">
            Saved. Your twin has been updated.
          </Text>
        ) : null}

        <View style={{ gap: theme.spacing.md }}>
          <Button
            label={
              form.saving
                ? 'Saving…'
                : form.isDirty
                  ? `Save ${form.changedKeys.length} change${form.changedKeys.length === 1 ? '' : 's'}`
                  : 'Save changes'
            }
            loading={form.saving}
            disabled={form.saving || !form.isDirty}
            onPress={() => void form.save()}
          />
          {form.isDirty ? (
            <Button
              label="Discard changes"
              variant="outline"
              disabled={form.saving}
              onPress={form.reset}
            />
          ) : null}
        </View>
      </View>
    </Screen>
  );
}
