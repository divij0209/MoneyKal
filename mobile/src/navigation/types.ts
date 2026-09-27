import type { NavigatorScreenParams } from '@react-navigation/native';

import type { DecisionContext } from '../api/types';
import type { StringKey } from '../i18n';

/**
 * Route types.
 *
 * Screen names and their header copy are taken from the web's `titles` and
 * `STARTUP_TITLES` maps in twin-app/js/app.js and js/startup.js, so the two
 * clients name the same things the same way.
 */

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

export type OnboardingStackParamList = {
  /** Step 1 of the web wizard: Individual or Startup. */
  AccountType: undefined;
  IndividualProfile: undefined;
  StartupProfile: undefined;
  StartupFinancialSetup: undefined;
  StartupManualEntry: undefined;
};

export type IndividualTabParamList = {
  /** Daily Home + Overview, in one scroll. */
  Home: undefined;
  /** `date` opens the ledger filtered to one day — the same deep link the web
   *  supports as dashboard.html?date=YYYY-MM-DD, used when a calendar event
   *  that came from the Hisaab ledger is opened. */
  Hisaab: { date?: string } | undefined;
  /** `sessionId` opens one saved conversation. Set when returning from VARTA,
   *  so the turns just spoken are on screen instead of a stale transcript —
   *  they are read back from the backend, which stored them. */
  Ask: { sessionId?: string } | undefined;
  /** `scenario` prefills the scenario box, mirroring `pendingScenarioPrefill`
   *  in twin-app/js/app.js.
   *
   *  `decisionContext` is the structured hand-off behind Ask Twin's contextual
   *  Simulation CTA: everything the conversation established (amount, purpose,
   *  horizon, stated risk constraints, the computed risk position), so the run
   *  starts from discovered facts instead of re-parsing the sentence. Absent
   *  when the user opens Simulate directly and types their own scenario, which
   *  still works exactly as it always has.
   *
   *  `ctaLabel` is the wording the user tapped, echoed back on screen so the
   *  hand-off is legible rather than a silent jump between tabs. */
  Simulate:
    | { scenario?: string; decisionContext?: DecisionContext | null; ctaLabel?: string }
    | undefined;
  More: undefined;
};

export type StartupTabParamList = {
  Overview: undefined;
  Ask: { sessionId?: string } | undefined;
  Simulate: undefined;
  Alerts: undefined;
  Reports: undefined;
};

export type AppStackParamList = {
  Tabs: NavigatorScreenParams<IndividualTabParamList | StartupTabParamList> | undefined;
  /** Full-screen modals — deliberately not tabs, matching the web, where the
   *  live.life.fully portal is explicitly not a `.navitem`. */
  LiveLife: undefined;
  /** `sessionId` continues an existing conversation, so a question asked out
   *  loud lands in the same thread as the typed ones — the web does this via
   *  the shared localStorage['twin_chat_session'] key. Optional: opening VARTA
   *  cold starts a new conversation, exactly as the web does with no key set. */
  Voice: { sessionId?: string; returnTo?: 'ask' } | undefined;
  Settings: undefined;
  Profile: undefined;
  /** The Individual Tax Calculator. A pushed screen rather than a sixth tab:
   *  the web gates it to Individual profiles (see `navTax` in dashboard.html
   *  and the profile-key check in tax.js), a tab that disappears for half the
   *  personas reads as a bug, and six Devanagari tab labels do not fit. It is
   *  surfaced prominently from both Home and More instead. */
  Tax: undefined;
  MarketPulse: undefined;
  Reports: undefined;
};

export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  Onboarding: NavigatorScreenParams<OnboardingStackParamList>;
  /** Creating the MoneyKal passcode — rendered alone, so it cannot be skipped. */
  SetPasscode: undefined;
  /** The app lock. While this is the stack, no persona screen is mounted. */
  Lock: undefined;
  App: NavigatorScreenParams<AppStackParamList>;
};

/**
 * Header and tab copy, as i18n keys rather than literals.
 *
 * The web hardcodes these in its `titles` / `STARTUP_TITLES` maps
 * (twin-app/js/app.js, js/startup.js). Here they are keys so the topbar and
 * the tab bar translate with the rest of the app; `src/i18n/strings.ts` holds
 * the English, which is byte-identical in meaning to the web's copy.
 */

export interface TabMeta {
  title: StringKey;
  subtitle: StringKey;
  tabLabel: StringKey;
}

export const INDIVIDUAL_TAB_META: Record<keyof IndividualTabParamList, TabMeta> = {
  Home: {
    title: 'nav.home',
    subtitle: 'nav.sub.home',
    tabLabel: 'nav.home',
  },
  Hisaab: {
    title: 'nav.hisaab',
    subtitle: 'nav.sub.hisaab',
    tabLabel: 'nav.hisaab',
  },
  Ask: {
    title: 'nav.ask',
    subtitle: 'nav.sub.ask',
    tabLabel: 'nav.ask',
  },
  Simulate: {
    title: 'nav.simulate',
    subtitle: 'nav.sub.simulate',
    tabLabel: 'nav.simulate',
  },
  More: {
    title: 'nav.more',
    subtitle: 'nav.sub.more',
    tabLabel: 'nav.more',
  },
};

export const STARTUP_TAB_META: Record<keyof StartupTabParamList, TabMeta> = {
  Overview: {
    title: 'nav.overview',
    subtitle: 'nav.sub.overview',
    tabLabel: 'nav.overview',
  },
  Ask: {
    title: 'nav.ask',
    subtitle: 'nav.sub.ask',
    tabLabel: 'nav.ask',
  },
  Simulate: {
    title: 'nav.simulate',
    subtitle: 'nav.sub.simulate',
    tabLabel: 'nav.simulate',
  },
  Alerts: {
    title: 'nav.alerts',
    subtitle: 'nav.sub.alerts',
    tabLabel: 'nav.alerts',
  },
  Reports: {
    title: 'nav.reports',
    subtitle: 'nav.sub.reports',
    tabLabel: 'nav.reports',
  },
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
