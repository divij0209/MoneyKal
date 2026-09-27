/* ==========================================================================
   TWIN — "What does this feature do?" (the i beside each page heading)

   Every sidebar feature gets an i next to its heading. Clicking it opens a
   short panel saying what the feature is for and what can be done there.

   Where the buttons live:
     · the shared topbar heading, as data-feature-info="current", which follows
       whichever view is active (most features);
     · the Overview greeting, data-feature-info="overview" (Overview hides the
       topbar);
     · the Money Splits hero title, data-feature-info="split" (Money Splits
       hides the topbar heading too).

   Copy is keyed by view and then by persona, because the same sidebar item
   does different things for a Startup and an Individual (Overview, Tathya,
   Simulate, Reports). Every string is English source text; js/i18n.js
   translates it through js/i18n-strings.js like the rest of the page.
   ========================================================================== */

(function () {
  'use strict';

  const TYPE_OR_SPEAK = 'Type or speak your question';
  const KEEPS_HISTORY = 'Earlier conversations are kept so you can pick them up again';
  const PAST_SIMULATIONS = 'Look back at earlier simulations';

  const FEATURES = {
    overview: {
      individual: {
        title: 'Overview',
        summary: 'Your money today at a glance.',
        points: [
          'Your financial snapshot, monthly budgets and upcoming payments',
          'A calendar of your money activity and your goals',
          'Daily AI insights and notifications'
        ]
      },
      startup: {
        title: 'Startup Overview',
        summary: "Your company's live financial snapshot, built from your startup profile and the metric history recorded every day.",
        points: [
          'Net burn, runway, cash and revenue, each showing how it was calculated',
          'A financial health score out of 100 and a cash projection',
          'Hiring capacity, goal progress and your daily brief'
        ]
      }
    },
    hisaab: {
      individual: {
        title: 'Hisaab',
        summary: 'Your ledger of money in and money out, sorted into categories.',
        points: [
          'Add transactions by hand, or scan a receipt with your camera or an image',
          'Import bank and merchant emails automatically from Gmail',
          'See totals by category, and edit or delete any entry'
        ]
      }
    },
    split: {
      individual: {
        title: 'Money Splits',
        summary: 'Share expenses with friends and groups, and keep track of who owes whom.',
        points: [
          'Create groups, add friends and log shared expenses',
          'Live balances show who owes what',
          'Record settlements and follow group activity'
        ]
      }
    },
    tax: {
      individual: {
        title: 'Tax Calculator',
        summary: 'Works out your income tax for the year and compares the old and new regimes.',
        points: [
          'Enter every head of income, your deductions and HRA',
          'See which regime costs less and your likely return form',
          'Follow a step-by-step filing guide'
        ]
      }
    },
    ask: {
      individual: {
        title: 'Tathya',
        summary: 'Ask about your finances in plain language and get answers grounded in your own data.',
        points: ['Answers use your own figures, not generic advice', TYPE_OR_SPEAK, KEEPS_HISTORY]
      },
      startup: {
        title: 'Tathya',
        summary: "Ask about your company's finances in plain language and get answers grounded in your own figures.",
        points: ['Questions on runway, burn and hiring answered from your numbers', TYPE_OR_SPEAK, KEEPS_HISTORY]
      }
    },
    simulate: {
      individual: {
        title: 'Simulate a decision',
        summary: 'Try a financial decision on your digital twin before you act on it.',
        points: [
          'Describe a scenario such as a monthly investment, an EMI or a gap in income',
          'See how it affects your savings and goals',
          PAST_SIMULATIONS
        ]
      },
      startup: {
        title: 'Simulate a decision',
        summary: 'Test a decision on a copy of your company before you commit to it.',
        points: [
          'Describe a scenario such as hiring, raising money or cutting costs',
          'See its effect on burn, runway and cash',
          PAST_SIMULATIONS
        ]
      }
    },
    alerts: {
      startup: {
        title: 'Risk alerts',
        summary: 'Warnings raised when one of your numbers crosses a risk threshold.',
        points: [
          'Runway, burn, revenue, hiring and goal alerts',
          'Each alert shows how serious it is',
          'Recomputed from your latest figures every time you open it'
        ]
      }
    },
    reports: {
      individual: {
        title: 'Weekly Spend Report',
        summary: 'An automated weekly look at where your money went.',
        points: [
          "This week's spending by category compared with last week",
          'Suggestions on categories that jumped or are new',
          'Past reports saved and downloadable as PDF'
        ]
      },
      startup: {
        title: 'Reports',
        summary: "Your daily brief and weekly reports on the company's financial health.",
        points: [
          'A daily brief of what changed',
          'A weekly health report covering runway and burn trends',
          'A weekly spend report with suggestions, saved and downloadable as PDF'
        ]
      }
    },
    fundraise: {
      startup: {
        title: 'Fundraise readiness',
        summary: 'Scores how ready your company is to raise, against the benchmarks investors use at your stage.',
        points: [
          'Runway, burn multiple, growth, margin, Rule of 40 and capital efficiency against stage benchmarks',
          'How much you would need to raise to reach the target runway',
          'The diligence questions your data cannot answer yet'
        ]
      }
    },
    gst: {
      startup: {
        title: 'GST calculator',
        summary: 'Calculates the GST on an invoice and what you owe for the period.',
        points: [
          'Add or remove GST and split it into CGST, SGST or IGST',
          'Net off input tax credit and handle reverse charge',
          'Compare the composition scheme, check a GSTIN and look up HSN/SAC codes'
        ]
      }
    },
    compliance: {
      startup: {
        title: 'Compliance center',
        summary: 'Your statutory calendar: what you must file, by when, and what missing it costs.',
        points: [
          'GST, TDS, payroll, income tax and ROC deadlines for the year',
          'Mark filings as done so only unfiled ones count as overdue',
          'Penalty exposure and estimated GST and TDS liabilities'
        ]
      }
    },
    billing: {
      individual: {
        title: 'Plans & Billing',
        summary: 'Your MoneyKal plan, what you have used this month, and your payments.',
        points: [
          'See your plan, when it ends and your free allowances',
          'Upgrade to ACT, or unlock the Tax Calculator for a tax year',
          'Kal Coins and your payment history'
        ]
      },
      startup: {
        title: 'Plans & Billing',
        summary: 'Your MoneyKal plan, what you have used this month, and your payments.',
        points: [
          'See your plan, when it ends and your free allowances',
          'Upgrade to ACT',
          'Kal Coins and your payment history'
        ]
      }
    }
  };

  let panel = null;
  let openButton = null;

  function persona() {
    return (typeof isStartup === 'function' && isStartup()) ? 'startup' : 'individual';
  }

  function activeView() {
    const v = document.querySelector('.view.is-active');
    return v ? v.id.replace(/^view-/, '') : 'overview';
  }

  function infoFor(view) {
    const byPersona = FEATURES[view];
    return byPersona ? (byPersona[persona()] || null) : null;
  }

  function viewFor(button) {
    const target = button.dataset.featureInfo;
    return target === 'current' ? activeView() : target;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function position() {
    if (!panel || !openButton) return;
    const r = openButton.getBoundingClientRect();
    const width = panel.offsetWidth;
    const left = Math.max(16, Math.min(r.left - 12, window.innerWidth - width - 16));
    panel.style.left = left + 'px';
    panel.style.top = (r.bottom + 10) + 'px';
  }

  function close() {
    if (openButton) openButton.setAttribute('aria-expanded', 'false');
    if (panel) panel.remove();
    panel = null;
    openButton = null;
  }

  function open(button) {
    const info = infoFor(viewFor(button));
    if (!info) return;
    close();

    panel = el('div', 'feature-info');
    panel.id = 'featureInfoPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', info.title);

    const head = el('div', 'feature-info__head');
    const titles = el('div');
    titles.append(el('p', 'feature-info__eyebrow', 'About this feature'), el('h2', 'feature-info__title', info.title));
    const closeBtn = el('button', 'feature-info__close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => { const b = openButton; close(); if (b) b.focus(); });
    head.append(titles, closeBtn);

    const list = el('ul', 'feature-info__points');
    info.points.forEach(p => list.appendChild(el('li', null, p)));

    panel.append(head, el('p', 'feature-info__summary', info.summary),
      el('p', 'feature-info__label', 'What you can do here'), list);
    document.body.appendChild(panel);

    openButton = button;
    button.setAttribute('aria-expanded', 'true');
    position();
  }

  /** Hide the topbar i on any view that has no description for this persona. */
  function sync() {
    const hasInfo = !!infoFor(activeView());
    document.querySelectorAll('[data-feature-info="current"]').forEach(b => { b.hidden = !hasInfo; });
  }

  document.addEventListener('click', e => {
    const button = e.target.closest('[data-feature-info]');
    if (button) {
      e.preventDefault();
      e.stopPropagation();
      if (openButton === button) close();
      else open(button);
      return;
    }
    if (panel && !panel.contains(e.target)) close();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel) {
      const b = openButton;
      close();
      if (b) b.focus();
    }
  });

  window.addEventListener('resize', position);
  // The panel is fixed to the viewport, so a scroll would leave it floating
  // away from its heading; close it instead.
  window.addEventListener('scroll', () => { if (panel) close(); }, true);

  window.featureInfo = { close, sync, infoFor };
})();
