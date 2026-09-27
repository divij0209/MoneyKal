import React, { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';

import { dictionaries, en, type Lang, type StringKey } from './strings';

export type { Lang, StringKey } from './strings';

/**
 * Language state.
 *
 * The web stores its choice under `moneykal_lang` (twin-app/js/i18n.js) and
 * offers the same two languages behind an `EN | हिं` toggle. This is the same
 * contract on the phone, kept in SecureStore because that is the only
 * key-value store already wired into this app.
 *
 * Resolution order for a string:
 *   1. the active language's dictionary
 *   2. English
 *   3. the key itself
 *
 * Step 2 is the important one. Hindi covers the app's own chrome; anything
 * the backend authored arrives in English and has no Hindi key, so a missing
 * entry must degrade to readable English rather than to `tax.surcharge`.
 */

const STORAGE_KEY = 'moneykal_lang';

export interface Interpolations {
  [token: string]: string | number;
}

export type TFunction = (key: StringKey, vars?: Interpolations) => string;

interface I18nContextValue {
  lang: Lang;
  setLang: (next: Lang) => void;
  toggle: () => void;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** `{name}` in a string is replaced by `vars.name`. */
function interpolate(template: string, vars?: Interpolations): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, token: string) =>
    Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : whole,
  );
}

export function makeT(lang: Lang): TFunction {
  const dict = dictionaries[lang] ?? en;
  return (key, vars) => {
    const value = dict[key] ?? en[key] ?? key;
    return interpolate(value, vars);
  };
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (stored === 'en' || stored === 'hi') setLangState(stored);
      })
      .catch(() => {
        /* Storage unavailable — English is a fine answer. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {
      /* Non-fatal: the choice just won't survive a restart. */
    });
  }, []);

  const toggle = useCallback(() => {
    setLangState((current) => {
      const next: Lang = current === 'en' ? 'hi' : 'en';
      SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, toggle, t: makeT(lang) }),
    [lang, setLang, toggle],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** The translate function. `const t = useT();  t('common.save')` */
export function useT(): TFunction {
  return useI18n().t;
}

/** Language state and controls, for the Settings toggle. */
export function useLanguage() {
  const { lang, setLang, toggle } = useI18n();
  return { lang, setLang, toggle };
}
