/**
 * MoneyKal — Terms & Conditions (content).
 *
 * The document shown by TermsSheet on both auth screens, so what a person
 * accepts at sign-up is what they accept at sign-in.
 *
 * VERSIONING. `TERMS_VERSION` is sent to the backend as `terms_version` and
 * stored against the user row by /auth/register and /auth/login. Bump it
 * whenever the text below changes in a way a user would need to re-accept,
 * and move `TERMS_UPDATED` with it. Editing the text and leaving the version
 * alone would leave every acceptance record pointing at a document that no
 * longer exists.
 *
 * THE WEB CARRIES THE SAME DOCUMENT at twin-app/js/legal-terms.js. They are
 * separate packages with separate bundlers and neither can import the other,
 * so the text is duplicated deliberately. Edit both, and keep the version in
 * step across the two files and CURRENT_TERMS_VERSION in
 * backend/routers/auth.py.
 *
 * MARKUP. Body strings support `**bold**` and nothing else — TermsSheet
 * renders it as a nested <Text>. No links: the document is read in place,
 * never in a browser.
 */

import type { TermsAcceptance } from '../../api/types';

export const TERMS_VERSION = '1.0';
export const TERMS_UPDATED = '10 September 2026';

/**
 * The record sent to /auth/register and /auth/login when the box was ticked.
 *
 * The timestamp is a convenience for the client's own logs — the backend
 * stamps its own time, because a device clock can be anything.
 */
export function termsAcceptance(): TermsAcceptance {
  return {
    terms_accepted: true,
    terms_version: TERMS_VERSION,
    terms_accepted_at: new Date().toISOString(),
  };
}

export interface TermsSection {
  id: string;
  title: string;
  /** A paragraph, or a bulleted list. */
  body: (string | { list: string[] })[];
}

export const TERMS_SUBTITLE =
  'Please read these Terms before you create an account or sign in. They set out what MoneyKal does, what it deliberately does not do, and what each of us is responsible for.';

export const TERMS_CALLOUT =
  'MoneyKal is a financial modelling and planning tool. It is **not** a bank, **not** a payment service, and **not** a registered investment adviser. Nothing it shows you is personalised financial, investment, tax, legal or accounting advice. Decisions about your money remain yours.';

export const TERMS_SECTIONS: TermsSection[] = [
  {
    id: 'acceptance',
    title: 'Acceptance of these Terms',
    body: [
      'These Terms are an agreement between you and the operator of MoneyKal (**[legal entity name — configure before launch]**, referred to here as MoneyKal, we, us or our). They govern your use of the MoneyKal web application, mobile application and any related features.',
      'You accept these Terms by ticking the acceptance box, and by creating an account or signing in. If you do not agree with any part of them, please do not use MoneyKal.',
      'We record which version of these Terms you accepted and when. This document is version 1.0, last updated 10 September 2026.',
      'These Terms should be read together with the **Security & Privacy statement**, which describes what information MoneyKal holds and who else ever sees it.',
    ],
  },
  {
    id: 'eligibility',
    title: 'Eligibility',
    body: [
      'To use MoneyKal you must be at least 18 years old and legally capable of entering into a binding contract under the laws of India.',
      'You must not use MoneyKal if you are barred from doing so under any applicable law, sanctions regime or regulation.',
      'If you create an account on behalf of a business, you confirm that you are authorised to accept these Terms for that business, and references to you include that business.',
      'Accounts are personal. Please do not create an account for someone else, or let someone else use yours.',
    ],
  },
  {
    id: 'account',
    title: 'Account registration and security',
    body: [
      'You need an account to use MoneyKal. Register with details that are accurate and keep them up to date — your email address is how we identify you and how we would reach you.',
      'Keep your password confidential. You are responsible for activity that takes place under your account, so choose a password you do not use anywhere else, and sign out on devices you share.',
      'On a phone, set a device screen lock and the MoneyKal passcode. Tell us promptly if you believe someone else has gained access to your account, so that we can help you secure it.',
      'MoneyKal will never ask you for your net-banking password, your card PIN, your CVV or a one-time password. If anything claiming to be MoneyKal asks for these, it is not us — please report it to us.',
    ],
  },
  {
    id: 'responsibilities',
    title: 'Your responsibilities',
    body: [
      'When you use MoneyKal, you agree to:',
      {
        list: [
          'use the service only for lawful purposes and in line with these Terms;',
          'provide only information you own or are authorised to share;',
          'keep the devices you sign in from reasonably secure, including a screen lock on your phone;',
          'review what MoneyKal produces before acting on it, rather than treating any figure as final;',
          'meet your own tax, regulatory, contractual and reporting obligations, which remain entirely yours; and',
          'respect the rights of anyone else whose information appears in the service, for example a person you add to a shared expense.',
        ],
      },
    ],
  },
  {
    id: 'accuracy',
    title: 'Accuracy of the information you provide',
    body: [
      'Everything MoneyKal shows you is calculated from what you tell it. Income, expenses, savings, debt, goals and business figures all feed directly into the projections, so incomplete or out-of-date inputs produce answers that look confident and are wrong.',
      'You are responsible for the accuracy of the information you enter and for keeping it current. We do not independently verify it.',
      'Where information is imported rather than typed — a statement or receipt you upload, or a connected account — it is read automatically and may be incomplete, mis-categorised or misread. Please review imported entries before relying on them.',
    ],
  },
  {
    id: 'nature',
    title: 'What MoneyKal insights are, and are not',
    body: [
      'MoneyKal is an informational and educational planning tool. It models scenarios in your own numbers, explains trade-offs, and helps you think a decision through before you make it.',
      'It is **not** personalised financial, investment, tax, legal or accounting advice, and no output should be read as a recommendation to buy, sell or hold any specific security, product or policy.',
      'MoneyKal is not a bank, an NBFC or a payment system, and is not regulated by the Reserve Bank of India. It is not a registered investment adviser with the Securities and Exchange Board of India. It never holds, moves or has access to your money, and there is no facility within the service to make a payment.',
      'Tax figures, deadlines and compliance prompts are general estimates based on the information you enter and on rules as we understand them. They are not a tax filing, a tax opinion, or a substitute for one.',
      'For advice about your particular circumstances, please consult a qualified and appropriately registered professional.',
    ],
  },
  {
    id: 'outcomes',
    title: 'No guarantee of financial outcomes',
    body: [
      'Projections, simulations and scenarios are estimates. They rest on assumptions — about returns, inflation, prices, your future income and your future spending — and assumptions are frequently wrong.',
      'Markets move, interest rates change, tax rules are amended and personal circumstances shift. Past performance is not a reliable indicator of future results, and nothing in MoneyKal is a promise, guarantee or forecast of any particular financial outcome.',
      'Parts of the service are produced by automated systems, including AI models. These can be inaccurate, incomplete or out of date. Please verify anything material before you act on it.',
      'MoneyKal is provided on an as-is and as-available basis. We do not warrant that it will be uninterrupted or error-free, or that any figure it produces is accurate or complete.',
    ],
  },
  {
    id: 'decisions',
    title: 'Your financial decisions remain yours',
    body: [
      'You alone decide what to do with your money. MoneyKal informs a decision; it does not make one, and it is not a party to any transaction you enter into with a bank, broker, lender, insurer or anyone else.',
      'To the extent permitted by law, we are not responsible for losses arising from decisions you take in reliance on the service — investments made, loans taken, purchases deferred, or opportunities not pursued.',
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy and your data',
    body: [
      'Your financial information stays tied to your account and is used to run the features you asked for. We have never sold, rented or leased your information, and we will not.',
      'We do not build or train AI models on your financial data. Some processing is carried out by hosted providers acting on our instruction, and some of those providers operate outside India.',
      'You can review and correct what you have entered at any time, disconnect any connected account, and ask us to delete your account and the data held with it.',
      'What we collect, why, who it reaches and where it is processed is set out in full in the **Security & Privacy statement**, which forms part of these Terms.',
    ],
  },
  {
    id: 'third-parties',
    title: 'Third-party services and connected accounts',
    body: [
      'MoneyKal relies on third-party services to work — among them hosted AI and speech providers, a messaging service for the reminders you opt into, and market data sources.',
      'You may choose to connect an external account, such as an email inbox or accounting software, so that transactions appear without manual entry. Where we do this we ask only for read access, and you can withdraw that permission at any time from MoneyKal or directly in the provider own account settings.',
      'Those services are operated by their own providers under their own terms and privacy policies. We are not responsible for their availability, accuracy or content, and a change on their side may affect features that depend on them.',
    ],
  },
  {
    id: 'ip',
    title: 'Intellectual property',
    body: [
      'MoneyKal, including its software, design, interface, models, text and branding, belongs to us or to our licensors and is protected by intellectual property law.',
      'We grant you a limited, personal, non-exclusive, non-transferable and revocable licence to use MoneyKal for your own financial planning, or your business planning, for as long as your account is in good standing.',
      'You keep ownership of the information you put into MoneyKal. You grant us only the permission needed to store and process it in order to provide the service to you.',
      'You may not copy, modify, translate, reverse engineer, decompile, resell, sub-licence or create derivative works from any part of the service, or use it to build a competing product.',
    ],
  },
  {
    id: 'prohibited',
    title: 'Prohibited and misuse activities',
    body: [
      'You must not:',
      {
        list: [
          'access, or try to access, another person account or data;',
          'probe, scan, disrupt or test the security of the service, other than through a good-faith report to us;',
          'use bots, scrapers or automated means to extract data from the service;',
          'put unlawful, infringing, abusive, misleading or malicious content into the service;',
          'use MoneyKal for money laundering, tax evasion, fraud or any other unlawful activity;',
          'attempt to manipulate the assistant into revealing information belonging to another account;',
          'resell, redistribute or publish MoneyKal outputs as your own product or as professional advice; or',
          'place an unreasonable load on the service, or interfere with anyone else use of it.',
        ],
      },
      'If you believe you have found a security problem, please tell us before you tell anyone else. We will not pursue you for a good-faith report made in line with the guidance in our **Security & Privacy statement**.',
    ],
  },
  {
    id: 'termination',
    title: 'Suspension and termination',
    body: [
      'You can stop using MoneyKal at any time, and ask us to delete your account and the data held with it.',
      'We may suspend or terminate an account if these Terms are breached, if the account is being used unlawfully, if it poses a security risk to other users or to the service, or where we are required to do so by law. Where it is reasonable and lawful to do so, we will tell you why.',
      'On termination your right to use the service ends. Provisions meant to survive — intellectual property, limitation of liability, and governing law — continue to apply. Deletion of your data follows the process described in the Security & Privacy statement.',
    ],
  },
  {
    id: 'availability',
    title: 'Service availability and changes',
    body: [
      'MoneyKal is under active development. Features may be added, changed, restricted or withdrawn, and interfaces may change as the product evolves.',
      'We do not guarantee that the service will be available without interruption. Planned maintenance, third-party outages, network faults and events outside our reasonable control can all make it unavailable for a period.',
      'Where a change is material and we can reasonably give notice, we will.',
    ],
  },
  {
    id: 'fees',
    title: 'Fees and paid plans',
    body: [
      'Some parts of MoneyKal may be offered free of charge and others on a paid plan. Where a plan carries a fee, the price, billing cycle, applicable taxes and any refund terms are those shown to you at the point of purchase, and they form part of these Terms for that plan.',
      'We will give you notice before a change to fees takes effect on an existing plan. If you do not accept the change, you may cancel before it applies.',
      'Full pricing and billing terms: **[pricing and refund policy — add before launch]**.',
    ],
  },
  {
    id: 'liability',
    title: 'Limitation of liability',
    body: [
      'To the maximum extent permitted by law, MoneyKal is not liable for indirect, incidental, special, punitive or consequential losses, nor for loss of profit, loss of investment value, loss of business, loss of opportunity or loss of data arising from your use of, or inability to use, the service.',
      'To the maximum extent permitted by law, our total aggregate liability arising out of or in connection with these Terms is limited to the amount you paid us for the service in the twelve months before the event giving rise to the claim, or **[nominal cap — confirm with counsel before launch]** where you have paid us nothing.',
      'Nothing in these Terms limits or excludes liability that cannot lawfully be limited or excluded, including liability for fraud or fraudulent misrepresentation, or for death or personal injury caused by negligence.',
      'You agree to be responsible for claims brought against us that arise from your unlawful use of the service or from your breach of these Terms.',
    ],
  },
  {
    id: 'changes',
    title: 'Changes to these Terms',
    body: [
      'We may update these Terms as the product and the law change. The version number and date at the top of this document always tell you which version is current.',
      'Where a change is material, we will ask you to accept the new version the next time you sign in, rather than treating silence as agreement. Continued use after a minor update means you accept it.',
      'We will not quietly reword a limitation once it stops being convenient for us.',
    ],
  },
  {
    id: 'law',
    title: 'Governing law and jurisdiction',
    body: [
      'These Terms, and any dispute arising out of them, are governed by the laws of India, without regard to conflict-of-law rules.',
      'The courts at **[city of jurisdiction — configure before launch]**, India, have exclusive jurisdiction, subject to any right you have as a consumer to bring proceedings where you live.',
      'Before starting proceedings, please contact us so we have a chance to resolve the matter directly. We would rather have the conversation than the dispute.',
    ],
  },
  {
    id: 'contact',
    title: 'Contact and support',
    body: [
      'Questions about these Terms, your account, or anything here you think is wrong: **[support contact address — add before publishing]**.',
      'Data protection and grievance requests, including correction, export and deletion: **[grievance officer name and contact — add before publishing]**, as required under the Digital Personal Data Protection Act, 2023.',
      'Security reports: please use the address given in the Security & Privacy statement.',
    ],
  },
];
