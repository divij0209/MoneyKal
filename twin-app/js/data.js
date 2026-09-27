/* ==========================================================================
   TWIN — mock data layer
   Stands in for the real Data Layer (banks / accounting software / ERP)
   until the backend is connected. Every number below feeds the UI live —
   nothing on screen is hardcoded text; it's all computed from this file.
   ========================================================================== */

const TWIN_DATA = {

  individual: {
    key: 'individual',
    label: 'Individual',
    persona: 'Aarav Sharma · Salaried, Bengaluru',
    currency: '₹',
    metrics: [
      { id: 'income',   label: 'Monthly income',   value: 85000,  unit: '/mo', trend: [78000,79500,81000,82000,83500,85000] },
      { id: 'expenses', label: 'Monthly expenses', value: 52000,  unit: '/mo', trend: [49000,50000,53000,51000,54000,52000] },
      { id: 'savings',  label: 'Total savings',    value: 320000, unit: '',    trend: [210000,240000,258000,281000,302000,320000] },
      { id: 'goal',     label: 'Goal progress',    value: 40,     unit: '%',   trend: [18,22,27,31,36,40], isPercent: true }
    ],
    goal: { title: 'Car fund: ₹8,00,000 by Dec 2027', progress: 40, target: 800000 },
    alerts: [
      { level: 'warn', text: 'Credit utilisation is above 40%, which is over the recommended threshold.' },
      { level: 'info', text: 'Emergency buffer covers 4.2 months of expenses, below the 6-month target.' }
    ],
    history: [
      { title: 'Increased SIP by ₹5,000/mo', date: '18 May 2026', outcome: 'Goal timeline improved by 3 months', tag: 'good' },
      { title: 'Used credit card for travel booking', date: '02 May 2026', outcome: 'Utilisation crossed 40% threshold', tag: 'warn' },
      { title: 'Moved ₹40,000 to fixed deposit', date: '14 Apr 2026', outcome: 'Buffer stability improved', tag: 'good' }
    ],
    decisionTypes: [
      {
        id: 'prepay_loan', label: 'Prepay personal loan',
        primaryLabel: 'Emergency buffer', primaryUnit: ' mo', primaryStart: 4.2,
        impactRate: -0.021, goodDirection: 'up',
        secondaryLabel: 'Interest saved (est.)', secondaryUnit: '', secondaryStart: 0, secondaryImpactRate: 380,
        inactionNote: 'Buffer stays thin; interest keeps accruing on the outstanding balance.'
      },
      {
        id: 'increase_sip', label: 'Increase monthly SIP',
        primaryLabel: 'Goal completion', primaryUnit: '%', primaryStart: 40,
        impactRate: 0.18, goodDirection: 'up',
        secondaryLabel: 'Free cash flow left', secondaryUnit: '', secondaryStart: 33000, secondaryImpactRate: -180,
        inactionNote: 'Goal stays on the current 17-month timeline.'
      },
      {
        id: 'car_lease', label: 'Buy vs. lease a car',
        primaryLabel: 'Monthly cash flow', primaryUnit: '', primaryStart: 33000,
        impactRate: -145, goodDirection: 'up',
        secondaryLabel: 'Buffer months', secondaryUnit: ' mo', secondaryStart: 4.2, secondaryImpactRate: -0.012,
        inactionNote: 'Cash flow position is preserved; the car purchase is deferred.'
      }
    ],
    chat: [
      { keys: ['runway','buffer','emergency'], reply: p => `Your emergency buffer currently covers ${p.metricByIdVal('income') ? '4.2' : ''} months of expenses. That's below the 6-month target. The Watch agent flagged this on ${new Date().toLocaleDateString()}.` },
      { keys: ['save','savings','saving'], reply: p => `Total savings stand at ₹${p.fmt(p.metricByIdVal('savings'))}, up from ₹2,10,000 six months ago, a steady upward trend.` },
      { keys: ['goal','car'], reply: p => `You're 40% of the way to the ₹8,00,000 car fund, targeted for Dec 2027. Increasing your SIP would pull that timeline in. Try the Simulate tab.` },
      { keys: ['spend','expense','expenses'], reply: p => `Monthly expenses are ₹${p.fmt(p.metricByIdVal('expenses'))}, against income of ₹${p.fmt(p.metricByIdVal('income'))}, a savings rate of about ${Math.round((1-p.metricByIdVal('expenses')/p.metricByIdVal('income'))*100)}%.` }
    ]
  },

  startup: {
    key: 'startup',
    label: 'Startup',
    persona: 'Loopwise Analytics · Seed stage, 34 employees',
    currency: '₹',
    metrics: [
      { id: 'revenue', label: 'Monthly revenue',   value: 1800000,  unit: '/mo', trend: [1100000,1250000,1400000,1550000,1680000,1800000] },
      { id: 'burn',    label: 'Monthly burn',      value: 2200000,  unit: '/mo', trend: [1900000,2000000,2050000,2100000,2150000,2200000] },
      { id: 'runway',  label: 'Runway',            value: 9.4,      unit: ' mo', trend: [13.1,12.0,11.0,10.3,9.8,9.4] },
      { id: 'headcount', label: 'Headcount',       value: 34,       unit: '',    trend: [26,28,29,31,32,34] }
    ],
    goal: { title: 'Reach ₹25L MRR before Series A conversations', progress: 62, target: 2500000 },
    alerts: [
      { level: 'warn', text: 'Runway falls under 6 months if the planned hiring round proceeds at full pace.' },
      { level: 'info', text: 'Burn multiple (burn ÷ net new revenue) is trending up for the second straight month.' }
    ],
    history: [
      { title: 'Renegotiated AWS committed-use contract', date: '22 May 2026', outcome: 'Burn reduced by ₹1.4L/mo', tag: 'good' },
      { title: 'Extended two contractor offers', date: '09 May 2026', outcome: 'Runway shortened by 0.6 months', tag: 'warn' },
      { title: 'Closed ₹40L bridge note', date: '30 Apr 2026', outcome: 'Runway extended by 2.1 months', tag: 'good' }
    ],
    decisionTypes: [
      {
        id: 'prepay_loan', label: 'Prepay term loan',
        primaryLabel: 'Runway', primaryUnit: ' mo', primaryStart: 9.4,
        impactRate: -0.038, goodDirection: 'up',
        secondaryLabel: 'Interest saved (annualised)', secondaryUnit: '', secondaryStart: 0, secondaryImpactRate: 4200,
        inactionNote: 'Loan interest keeps accruing; runway unaffected.'
      },
      {
        id: 'hire_engineers', label: 'Hire 5 engineers',
        primaryLabel: 'Runway', primaryUnit: ' mo', primaryStart: 9.4,
        impactRate: -0.046, goodDirection: 'up',
        secondaryLabel: 'Shipping velocity (est.)', secondaryUnit: '%', secondaryStart: 100, secondaryImpactRate: 0.55,
        inactionNote: 'Velocity stays flat; runway is preserved at 9.4 months.'
      },
      {
        id: 'bridge_vs_extend', label: 'Raise bridge vs. extend runway',
        primaryLabel: 'Runway', primaryUnit: ' mo', primaryStart: 9.4,
        impactRate: 0.062, goodDirection: 'up',
        secondaryLabel: 'Dilution (est.)', secondaryUnit: '%', secondaryStart: 0, secondaryImpactRate: 0.09,
        inactionNote: 'No new capital raised; current runway trajectory continues unchanged.'
      }
    ],
    chat: [
      { keys: ['runway'], reply: p => `Runway is currently 9.4 months, down from 13.1 six months ago as burn has climbed with headcount. The Watch agent flags a risk if hiring continues at the current pace.` },
      { keys: ['burn'], reply: p => `Monthly burn is ₹${p.fmt(p.metricByIdVal('burn'))} against ₹${p.fmt(p.metricByIdVal('revenue'))} in revenue. The gap has been narrowing for three straight months.` },
      { keys: ['hire','hiring','headcount'], reply: p => `Headcount is at 34, up from 26 six months ago. Run the "Hire 5 engineers" scenario in Simulate to see the runway trade-off before committing.` },
      { keys: ['revenue','mrr'], reply: p => `Monthly revenue is ₹${p.fmt(p.metricByIdVal('revenue'))}, tracking toward the ₹25L MRR goal, currently 62% of the way there.` }
    ]
  }
};

const AGENTS = [
  { id: 'understand', name: 'Understand', desc: 'Pulls in and cleans up the user\u2019s financial data.' },
  { id: 'watch',      name: 'Watch',      desc: 'Constantly checks for risk: low cash, bad debt, fraud, FX exposure.' },
  { id: 'simulate',   name: 'Simulate',   desc: 'Runs \u201cwhat-if\u201d tests against your real figures.' },
  { id: 'recommend',  name: 'Recommend',  desc: 'Picks the best option based on the simulation results.' },
  { id: 'teach',      name: 'Teach',      desc: 'Explains the recommendation in plain language.' },
  { id: 'check',      name: 'Check',      desc: 'Confirms it\u2019s compliant, and explains why the call was made.' }
];
