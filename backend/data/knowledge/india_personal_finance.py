"""
Indian Personal Finance & Tax Knowledge Base for MoneyKal RAG Pipeline.

This file contains curated, authoritative information about Indian personal
finance, income tax rules, and investment strategies. It is chunked and
ingested into ChromaDB by backend/scripts/ingest_knowledge.py.

Sources: Income Tax Act 1961, SEBI guidelines, AMFI guidelines, RBI circulars.
Last updated: September 2026.
"""

KNOWLEDGE_CHUNKS = [
    # -----------------------------------------------------------------------
    # Income Tax
    # -----------------------------------------------------------------------
    (
        "chunk_tax_slabs_new_regime",
        """Indian Income Tax Slabs (New Tax Regime, FY 2024-25):
        - Income up to Rs. 3,00,000: NIL tax
        - Rs. 3,00,001 to Rs. 7,00,000: 5% tax (rebate under Section 87A means zero tax if total income <= 7L)
        - Rs. 7,00,001 to Rs. 10,00,000: 10% tax
        - Rs. 10,00,001 to Rs. 12,00,000: 15% tax
        - Rs. 12,00,001 to Rs. 15,00,000: 20% tax
        - Above Rs. 15,00,000: 30% tax
        The new tax regime is the default. It does not allow most deductions (80C, HRA, etc.)
        but has lower rates. It is better for salaried individuals who cannot claim many deductions.""",
        {"source": "Income Tax Act", "category": "tax_slabs"}
    ),
    (
        "chunk_tax_slabs_old_regime",
        """Indian Income Tax Slabs (Old Tax Regime, FY 2024-25):
        - Income up to Rs. 2,50,000: NIL tax
        - Rs. 2,50,001 to Rs. 5,00,000: 5% tax (rebate under 87A means zero tax if total income <= 5L)
        - Rs. 5,00,001 to Rs. 10,00,000: 20% tax
        - Above Rs. 10,00,000: 30% tax
        The old regime allows deductions like 80C (up to 1.5L), 80D (medical insurance), HRA, LTA, etc.
        It is better for individuals with significant deductions totaling more than Rs. 3-3.5 lakhs.""",
        {"source": "Income Tax Act", "category": "tax_slabs"}
    ),
    (
        "chunk_section_80c",
        """Section 80C - Tax Deductions (Old Tax Regime only):
        Maximum deduction: Rs. 1,50,000 per financial year.
        Eligible investments: PPF (Public Provident Fund), ELSS Mutual Funds (3-year lock-in),
        EPF contributions, NSC, 5-year bank FD, Sukanya Samriddhi Yojana, life insurance premium,
        tuition fees for children (max 2 children), principal repayment of home loan.
        ELSS is the most popular 80C option because it has the shortest lock-in (3 years)
        and offers potentially higher market-linked returns.""",
        {"source": "Income Tax Act Section 80C", "category": "tax_deductions"}
    ),
    (
        "chunk_capital_gains",
        """Capital Gains Tax in India (applicable from FY 2024-25 after Union Budget 2024):
        Equity Mutual Funds & Stocks:
        - Short-Term Capital Gains (STCG) - held < 1 year: 20% tax (revised up from 15%)
        - Long-Term Capital Gains (LTCG) - held > 1 year: 12.5% tax on gains above Rs. 1,25,000 per year (exemption limit raised from 1L to 1.25L)
        Debt Mutual Funds (purchased after April 1, 2023):
        - All gains taxed at slab rate (same as income), no LTCG benefit.
        Real Estate:
        - STCG (< 2 years): Taxed at slab rate.
        - LTCG (> 2 years): 12.5% without indexation (indexation benefit removed in Budget 2024).""",
        {"source": "Income Tax Act / Budget 2024", "category": "capital_gains"}
    ),
    (
        "chunk_tds",
        """TDS (Tax Deducted at Source) Key Rates in India:
        - Bank FD interest: 10% TDS if interest exceeds Rs. 40,000/year (Rs. 50,000 for senior citizens). No TDS if Form 15G/15H submitted.
        - Salary: TDS deducted by employer as per applicable slab.
        - Rent > Rs. 50,000/month: 5% TDS by tenant.
        - Professional fees / freelance payments > Rs. 30,000: 10% TDS.
        - Dividend income > Rs. 5,000: 10% TDS.
        TDS can be claimed as a tax credit when filing ITR (Income Tax Return).""",
        {"source": "Income Tax Act", "category": "tds"}
    ),

    # -----------------------------------------------------------------------
    # Mutual Funds & Investments
    # -----------------------------------------------------------------------
    (
        "chunk_sip_basics",
        """SIP (Systematic Investment Plan) in India:
        SIP allows you to invest a fixed amount in a mutual fund every month.
        Key benefits: Rupee Cost Averaging (you buy more units when prices are low, fewer when high),
        Power of Compounding, and financial discipline.
        Minimum SIP: As low as Rs. 100-500/month in most funds.
        Expected returns (historical, not guaranteed): Large-cap funds: 10-12% p.a. CAGR,
        Mid-cap: 12-15% p.a., Small-cap: 15-18% p.a. (with higher risk).
        Rule of thumb: For long-term wealth creation (7+ years), a mix of large and mid-cap index funds
        via SIP is one of the most effective strategies for an Indian investor.""",
        {"source": "AMFI Guidelines", "category": "mutual_funds"}
    ),
    (
        "chunk_nifty50_index_funds",
        """Nifty50 Index Funds in India:
        These funds passively track the Nifty50 index (50 largest companies by market cap on NSE).
        They are ideal for beginners because they are low-cost (expense ratio 0.1-0.2%), diversified,
        and historically have returned ~12% CAGR over 10+ year periods.
        Popular options: UTI Nifty50 Index Fund, HDFC Index Fund Nifty 50 Plan, Nippon India Index Fund.
        Compare with actively managed large-cap funds, which charge 1-2% expense ratio but
        often fail to beat the index over long periods. John Bogle (founder of Vanguard) showed
        that passive index investing beats 80% of actively managed funds over 20 years.""",
        {"source": "NSE/AMFI", "category": "mutual_funds"}
    ),
    (
        "chunk_ppf",
        """PPF (Public Provident Fund) in India:
        One of the safest investment options with sovereign guarantee.
        Interest rate: 7.1% p.a. (revised quarterly by government, tax-free interest).
        Lock-in period: 15 years (partial withdrawals allowed from year 7).
        Maximum investment: Rs. 1.5 lakh per year (qualifies for 80C deduction).
        EEE (Exempt-Exempt-Exempt) status: Investment, interest, and maturity are all tax-free.
        Best for: Risk-averse individuals, debt portion of portfolio, guaranteed returns,
        and retirement planning. Not ideal for short-term goals.""",
        {"source": "NSSF/Ministry of Finance", "category": "investments"}
    ),
    (
        "chunk_emergency_fund",
        """Emergency Fund - Personal Finance Rule:
        An emergency fund is 3-6 months of monthly expenses kept in a highly liquid, safe account.
        Why: Protects from sudden job loss, medical emergency, or urgent car/home repair without
        having to break long-term investments or take high-interest personal loans.
        Where to keep it: High-yield savings account, liquid mutual funds, or short-term FDs.
        Rule: Build the emergency fund BEFORE starting aggressive investing. It is the foundation
        of any sound financial plan. Without it, one market downturn or emergency can derail years of investing.""",
        {"source": "Personal Finance Best Practices", "category": "financial_planning"}
    ),
    (
        "chunk_50_30_20_rule",
        """The 50-30-20 Budgeting Rule for Indian Households:
        - 50% of take-home income: Needs (rent, groceries, EMIs, utilities, school fees)
        - 30% of take-home income: Wants (dining out, OTT subscriptions, travel, entertainment)
        - 20% of take-home income: Savings and Investments (SIP, PPF, FD, emergency fund)
        In high cost-of-living Indian metros (Mumbai, Bangalore), the 50% for needs may need to
        be increased to 60%, reducing wants to 20%. The key insight: pay yourself first by
        automating your 20% investment on salary day, before spending on wants.""",
        {"source": "Personal Finance Best Practices", "category": "budgeting"}
    ),
    (
        "chunk_health_insurance",
        """Health Insurance in India - Key Rules:
        Section 80D Tax Deduction:
        - Rs. 25,000/year deduction for self, spouse, and children's medical insurance premium.
        - Additional Rs. 25,000 for parents' premium (Rs. 50,000 if parents are senior citizens).
        - Maximum total 80D deduction: Rs. 75,000/year.
        Recommendation: A family floater plan of Rs. 5-10 lakh sum insured is the minimum for
        an Indian family. With rising medical inflation (14% p.a.), a top-up or super top-up policy
        is recommended for coverage above Rs. 10 lakh at a low cost.""",
        {"source": "Income Tax Act Section 80D / IRDAI", "category": "insurance"}
    ),
    (
        "chunk_home_loan",
        """Home Loan Tax Benefits in India (Old Tax Regime):
        - Section 80C: Principal repayment up to Rs. 1.5 lakh/year (within the overall 80C limit).
        - Section 24(b): Interest paid on home loan up to Rs. 2 lakh/year for self-occupied property.
        - First-time buyers: Section 80EEA provides additional Rs. 1.5 lakh interest deduction
          for affordable housing (stamp duty value <= Rs. 45 lakh).
        FOIR (Fixed Obligation to Income Ratio): Banks typically limit total EMI obligations
        (all loans) to 40-50% of gross monthly income. A home loan EMI above this threshold
        will likely be rejected.""",
        {"source": "Income Tax Act / RBI guidelines", "category": "home_loan"}
    ),
    (
        "chunk_credit_score",
        """Credit Score (CIBIL Score) in India:
        Range: 300 to 900. Score above 750 is considered good, above 800 is excellent.
        Factors that affect score: Payment history (35%), credit utilization ratio (30%),
        credit history length (15%), credit mix (10%), new credit inquiries (10%).
        Key tips: Pay all credit card bills in full and on time (never just the minimum due).
        Keep credit utilization below 30% (if limit is 1 lakh, spend max 30,000/month).
        Do not apply for multiple loans/cards simultaneously — each hard inquiry reduces score by 5-10 points.
        Check your free CIBIL score once a year on CIBIL website or credit apps.""",
        {"source": "TransUnion CIBIL / RBI", "category": "credit"}
    ),
]
