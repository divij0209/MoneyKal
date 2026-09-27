import React from 'react';
import { Pressable, View } from 'react-native';

import { DateField, Divider, Glyph, Input, Text } from '../../../components';
import { useTheme } from '../../../theme';
import type { IndividualDraft } from '../draft';
import type { FieldErrors } from './useIndividualOnboarding';

interface StepProps {
  values: IndividualDraft;
  errors: FieldErrors;
  setField: (field: keyof IndividualDraft, value: string | null) => void;
  disabled?: boolean;
}

/** A currency field. The ₹ prefix is a label, not formatting — the server owns
 *  every formatted figure the app displays. */
function MoneyInput({
  label,
  field,
  values,
  errors,
  setField,
  disabled,
  required,
  hint,
  placeholder,
}: StepProps & {
  label: string;
  field: keyof IndividualDraft;
  required?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <Input
      label={`${label} (₹)`}
      required={required}
      placeholder={placeholder ?? '0'}
      value={(values[field] ?? '') as string}
      onChangeText={(t) => setField(field, t)}
      keyboardType="numeric"
      editable={!disabled}
      error={errors[field]}
      hint={hint}
    />
  );
}

/* ------------------------------------------------------- 1. About you */

export function StepAboutYou({
  values,
  errors,
  setField,
  disabled,
  onOpenAssist,
}: StepProps & { onOpenAssist: () => void }) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="title">Personal Financial Details</Text>
        <Text variant="bodySmall" color="muted">
          A couple of details about you. Both are optional — skip ahead if you would rather
          get to the numbers.
        </Text>
      </View>

      {/* The faster routes in. Offered first because they fill the next step
          for you, which is where the real typing is. */}
      <Pressable
        onPress={onOpenAssist}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Fill this in faster with AI or a bank statement"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          padding: theme.spacing.lg,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.accentBorder,
          backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
        })}
      >
        <Glyph name="spark" color={theme.colors.accent} size={20} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading" color="accent">
            Fill this in faster
          </Text>
          <Text variant="bodySmall" color="faint">
            Answer a few questions, or upload a bank statement
          </Text>
        </View>
        <Glyph name="arrowRight" color={theme.colors.accent} size={16} />
      </Pressable>

      <Divider />

      <Input
        label="Occupation / Role"
        placeholder="e.g. Software Engineer"
        value={values.occupation}
        onChangeText={(t) => setField('occupation', t)}
        autoCapitalize="words"
        editable={!disabled}
        error={errors.occupation}
      />

      <Input
        label="Mobile Number"
        placeholder="Enter Mobile Number"
        value={values.mobile}
        onChangeText={(t) => setField('mobile', t)}
        keyboardType="phone-pad"
        autoComplete="tel"
        editable={!disabled}
        error={errors.mobile}
      />
    </View>
  );
}

/* ------------------------------------------------------ 2. Your money */

export function StepYourMoney({ values, errors, setField, disabled }: StepProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="title">Your money today</Text>
        <Text variant="bodySmall" color="muted">
          These four figures are what MoneyKal reads everything else from. The rest are
          optional.
        </Text>
      </View>

      <MoneyInput
        label="Monthly Salary / Income"
        field="monthlyIncome"
        required
        placeholder="e.g. 85000"
        {...{ values, errors, setField, disabled }}
      />
      <MoneyInput
        label="Total Savings"
        field="totalSavings"
        required
        placeholder="e.g. 320000"
        hint="Your current balance across accounts."
        {...{ values, errors, setField, disabled }}
      />
      <MoneyInput
        label="Monthly Fixed Expenses"
        field="monthlyExpenses"
        required
        placeholder="e.g. 52000"
        {...{ values, errors, setField, disabled }}
      />
      <MoneyInput
        label="Outstanding Loans"
        field="outstandingLoans"
        required
        hint="Enter 0 if you have none."
        {...{ values, errors, setField, disabled }}
      />

      <Divider />

      <Text variant="label" color="faint">
        Optional
      </Text>

      <MoneyInput
        label="Existing Investments"
        field="existingInvestments"
        {...{ values, errors, setField, disabled }}
      />
      <MoneyInput
        label="Insurance Coverage"
        field="insuranceCoverage"
        {...{ values, errors, setField, disabled }}
      />

      <Input
        label="Dependents"
        placeholder="0"
        value={values.dependents}
        onChangeText={(t) => setField('dependents', t)}
        keyboardType="number-pad"
        editable={!disabled}
        error={errors.dependents}
        hint="People who rely on your income."
      />
    </View>
  );
}

/* ------------------------------------------------------- 3. Your goal */

export function StepYourGoal({ values, errors, setField, disabled }: StepProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="title">What are you saving towards?</Text>
        <Text variant="bodySmall" color="muted">
          Optional, and you can change it later. A goal is what gives every other number on
          your dashboard something to point at.
        </Text>
      </View>

      <Input
        label="Financial Goal"
        placeholder="e.g. House Purchase"
        value={values.goalTitle}
        onChangeText={(t) => setField('goalTitle', t)}
        autoCapitalize="sentences"
        editable={!disabled}
        error={errors.goalTitle}
        hint="Left blank, this becomes “Financial Independence”."
      />

      <MoneyInput
        label="Goal Target Amount"
        field="goalTargetAmount"
        placeholder="e.g. 5000000"
        {...{ values, errors, setField, disabled }}
      />

      <DateField
        label="Goal Target Date"
        value={values.goalTargetDate}
        onChange={(iso) => setField('goalTargetDate', iso)}
        placeholder="Optional"
        clearable
        minimumDate={new Date()}
      />
    </View>
  );
}
