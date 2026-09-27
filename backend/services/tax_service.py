"""
Income head collection and aggregation for the Individual Tax Calculator.

STEP 1 SCOPE — this module turns raw user input into a per-head summary of
gross income, exempt portions and TDS. It deliberately does NOT compute tax:
slab application, surcharge, cess, marginal relief and the regime comparison
belong to the computation engine (Step 4).

Salary structuring follows the reference CTC workbook. Where that workbook
applies an allowance limit more generous than statute, this module uses the
STATUTORY limit from tax_config and records a warning explaining the
difference, so the number on screen is defensible and the divergence is
visible rather than silent.

Every rate, threshold and limit is read from backend.core.config.tax_config.
Nothing statutory is hardcoded here.
"""

from typing import Dict, List, Optional, Tuple

from backend.core.config import tax_config as cfg
from backend.schemas.tax_models import (
    CapitalGainsIncome,
    DeductionResult,
    DeductionsInput,
    DeductionsSummary,
    HeadSummary,
    HRAExemptionDetail,
    HRALimb,
    HousePropertyIncome,
    ITRFormRecommendation,
    ITRRuledOut,
    Recommendation,
    TDSEntry,
    TDSSummary,
    HousePropertyIncome,
    IncomeCollectionResponse,
    LineItem,
    MotorCarPerquisite,
    OtherSourcesIncome,
    PGBPIncome,
    RegimeComparison,
    RegimeComputation,
    SalaryComponent,
    SalaryIncome,
    SlabBand,
    SpecialRateItem,
    TaxProfileInput,
    TaxpayerProfile,
)

DISCLAIMER = (
    "This calculator provides an estimate for planning purposes only. It is not "
    "tax advice and should not be relied upon for filing. Figures reflect the "
    "rates in force for the selected year; verify with a qualified tax "
    "professional before acting on any result."
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rupees(value: float) -> float:
    """Round to 2dp and clamp tiny float noise to zero."""
    try:
        v = round(float(value or 0.0), 2)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if abs(v) < 0.005 else v


def _component_amount(component: SalaryComponent, basic_da: float, per_unit: float = 0.0) -> float:
    """
    Resolve a SalaryComponent to an annual rupee amount.

    'fixed'   -> the amount as given
    'percent' -> a percentage of (Basic + DA)
    'count'   -> a unit count priced at `per_unit` (children, meals, ...)
    """
    if not component or not component.enabled:
        return 0.0
    if component.mode == "percent":
        return _rupees(basic_da * (component.percent_of_basic_da or 0.0) / 100.0)
    if component.mode == "count":
        return _rupees((component.count or 0) * per_unit)
    return _rupees(component.amount)


def _capped(actual: float, limit, label: str, warnings: List[str]) -> float:
    """Apply a statutory ceiling, noting it when it actually bites."""
    if limit is None:
        return _rupees(actual)
    if actual > limit:
        warnings.append(
            f"{label}: claimed {_rupees(actual):,.0f} exceeds the statutory limit "
            f"of {limit:,.0f}; restricted to the limit."
        )
        return _rupees(limit)
    return _rupees(actual)


# ---------------------------------------------------------------------------
# HRA exemption
# ---------------------------------------------------------------------------

def resolve_metro(taxpayer: TaxpayerProfile) -> Tuple[bool, List[str]]:
    """
    Decide whether the taxpayer's city counts as a metro for HRA, and say so.

    The statute recognises only Delhi, Mumbai, Kolkata and Chennai for the 50%
    limb. The reference workbook also treats Hyderabad, Pune, Ahmedabad and
    Bengaluru as metros — a more generous position. The user's own selection is
    respected either way; where it relies on the wider list, a note explains
    that the statutory rate is 40%.
    """
    notes: List[str] = []
    rules = cfg.HRA_RULES
    city = (taxpayer.city or "").strip().lower()

    strict = {c.lower() for c in rules["metro_cities_strict"]}
    wide = {c.lower() for c in rules["metro_cities"]}

    if taxpayer.is_metro and city and city not in strict and city in wide:
        notes.append(
            f"{taxpayer.city.title()} is treated as a metro by the reference CTC tool, "
            f"but for HRA the statute recognises only "
            f"{', '.join(rules['metro_cities_strict'])} — where the 50% limb binds, "
            f"40% is the defensible position."
        )
    elif taxpayer.is_metro and city and city not in wide:
        notes.append(
            f"{taxpayer.city.title()} is not a recognised metro for HRA. The 50% limb "
            f"has been applied as selected; confirm this is intended."
        )

    return bool(taxpayer.is_metro), notes


def compute_hra_exemption(
    hra_received: float,
    basic_da: float,
    rent_paid: float,
    taxpayer: TaxpayerProfile,
) -> "HRAExemptionDetail":
    """
    HRA exemption — the lowest of three limbs.

        (a) actual HRA received
        (b) rent paid  minus  10% of (Basic + DA)
        (c) 50% of (Basic + DA) in a metro, else 40%

    Replicates the workbook's "HRA Calculation" sheet, including its treatment
    of limb (b) as nil when no rent is paid, and floors it at zero so rent
    below 10% of salary cannot produce a negative exemption.

    Available under the old regime only; the amount is reported, never netted
    off here.
    """
    rules = cfg.HRA_RULES
    detail = HRAExemptionDetail(
        basic_da=_rupees(basic_da),
        rent_paid=_rupees(rent_paid),
        allowed_in_new_regime=rules["allowed_in_new_regime"],
    )

    hra_received = _rupees(hra_received)
    if hra_received <= 0:
        detail.applicable = False
        if rent_paid > 0:
            detail.notes.append(
                "No HRA is received, so no HRA exemption arises. Rent paid may instead "
                f"qualify for a deduction under {cfg.section_label('80GG', taxpayer.tax_year)}, "
                f"capped at {cfg.DEDUCTIONS['80GG']['limit']:,.0f} a year."
            )
        return detail

    is_metro, metro_notes = resolve_metro(taxpayer)
    detail.notes.extend(metro_notes)
    detail.is_metro = is_metro

    pct = rules["metro_percent"] if is_metro else rules["non_metro_percent"]
    detail.metro_percent_applied = pct

    # (b) is nil when no rent is paid, and never negative.
    limb_rent = _rupees(max(0.0, rent_paid - rules["rent_less_percent_of_salary"] * basic_da)) \
        if rent_paid > 0 else 0.0

    limbs = [
        HRALimb(
            key="actual_hra",
            label="Actual HRA received",
            amount=hra_received,
            formula="HRA component of salary",
        ),
        HRALimb(
            key="rent_less_10pct",
            label="Rent paid less 10% of Basic + DA",
            amount=limb_rent,
            formula=(
                f"{_rupees(rent_paid):,.0f} − 10% × {_rupees(basic_da):,.0f}"
                if rent_paid > 0 else "No rent paid → nil"
            ),
        ),
        HRALimb(
            key="percent_of_salary",
            label=f"{int(pct * 100)}% of Basic + DA ({'metro' if is_metro else 'non-metro'})",
            amount=_rupees(pct * basic_da),
            formula=f"{int(pct * 100)}% × {_rupees(basic_da):,.0f}",
        ),
    ]

    lowest = min(limbs, key=lambda l: l.amount)
    for l in limbs:
        l.is_binding = (l.key == lowest.key)

    detail.applicable = True
    detail.limbs = limbs
    detail.binding_limb = lowest.key
    detail.exempt_amount = _rupees(max(0.0, lowest.amount))
    detail.taxable_hra = _rupees(max(0.0, hra_received - detail.exempt_amount))

    if rent_paid <= 0:
        detail.notes.append(
            "No rent paid, so the exemption is nil — HRA received is fully taxable."
        )
    elif rent_paid > rules["landlord_pan_required_above"]:
        detail.notes.append(
            f"Rent exceeds {rules['landlord_pan_required_above']:,.0f} a year, so the "
            f"landlord's name, address and PAN must be reported to your employer."
        )

    if detail.exempt_amount and not rules["allowed_in_new_regime"]:
        detail.notes.append(
            "This exemption applies under the old regime only. Under the new regime "
            "the full HRA remains taxable."
        )

    return detail


# ---------------------------------------------------------------------------
# Motor car perquisite — Rule 15, Table II
# ---------------------------------------------------------------------------

def compute_motor_car_perquisite(car: MotorCarPerquisite) -> Tuple[float, List[str]]:
    """
    Taxable value of a motor car perquisite.

    Returns (annual_value, warnings). Mirrors the decision tree in the
    workbook's hidden "Motor Car Perquisite" sheet, priced at the statutory
    Rule 15 rates held in config.
    """
    warnings: List[str] = []
    if not car or not car.enabled:
        return 0.0, warnings

    rules = cfg.MOTOR_CAR_PERQUISITE
    band = rules["small_engine"] if car.engine_type == "small" else rules["large_engine"]
    months = max(0, min(12, car.months_available or 0))

    # Official use only -> nil, subject to logbook and employer certificate.
    if car.usage == "official":
        warnings.append(
            "Motor car treated as official use only (nil perquisite). This requires "
            "prescribed journey records and an employer certificate."
        )
        value = 0.0

    elif car.usage == "mixed":
        if car.car_owner == "employer":
            per_month = (
                band["employer_bears_expenses"]
                if car.expense_bearer == "employer"
                else band["employee_bears_expenses"]
            )
            if car.chauffeur_provided:
                per_month += rules["chauffeur_per_month"]
            value = _rupees(per_month * months)
        else:
            # Employee-owned, employer reimburses: taxable = reimbursement less
            # the value attributable to official use.
            per_month = band["employer_bears_expenses"]
            if car.chauffeur_provided:
                per_month += rules["chauffeur_per_month"]
            official_portion = per_month * months
            value = _rupees(max(0.0, (car.actual_reimbursement or 0.0) - official_portion))

    else:  # wholly personal use
        value = _rupees(
            max(
                0.0,
                (car.annual_running_expenses or 0.0)
                + (car.driver_salary_annual or 0.0)
                + 0.10 * (car.actual_cost_of_car or 0.0)
                - (car.employee_recovery or 0.0),
            )
        )

    # Transfer of a used car to the employee: WDV after 20% per completed year,
    # less whatever the employee paid.
    if car.transferred_to_employee and car.actual_cost_of_car:
        dep = rules["transfer_depreciation_per_year"]
        wdv = (car.actual_cost_of_car or 0.0) * ((1 - dep) ** max(0, car.completed_years or 0))
        transfer_perq = max(0.0, wdv - (car.amount_paid_on_transfer or 0.0))
        value = _rupees(value + transfer_perq)

    return value, warnings


# ---------------------------------------------------------------------------
# Salary
# ---------------------------------------------------------------------------

def build_salary_head(salary: SalaryIncome, taxpayer: TaxpayerProfile) -> HeadSummary:
    """
    Structure the CTC and aggregate salary income.

    Produces gross salary, the exempt portion, and a line-item breakdown. The
    HRA *exemption* is not computed here — that is Step 2; this records the HRA
    component amount and the inputs the exemption will need.
    """
    head = HeadSummary(head="salary", label="Income from Salary")
    if not salary or not salary.enabled:
        return head

    warnings: List[str] = []
    items: List[LineItem] = []

    # ---- Simple mode: user supplies gross salary directly -------------------
    if salary.use_simple_mode:
        gross = _rupees(salary.gross_salary_simple)
        items.append(LineItem(label="Gross salary (as entered)", amount=gross))
        head.gross = gross
        head.net = gross
        head.tds = _rupees(salary.tds_deducted)
        head.line_items = items
        head.warnings = warnings
        return head

    ctc = _rupees(salary.annual_ctc)
    if ctc <= 0:
        head.warnings = ["Annual CTC not provided — salary income treated as nil."]
        return head

    # ---- Basic + DA ---------------------------------------------------------
    basic = _rupees(ctc * (salary.basic_percent_of_ctc or 0.0) / 100.0)
    da = _rupees(ctc * (salary.da_percent_of_ctc or 0.0) / 100.0)
    basic_da = _rupees(basic + da)

    items.append(LineItem(label="Basic Pay", amount=basic))
    items.append(LineItem(label="Dearness Allowance", amount=da))

    if (salary.basic_percent_of_ctc + salary.da_percent_of_ctc) < 50:
        warnings.append(
            "Basic + DA is below 50% of CTC. The Labour Codes require wages "
            "(Basic + DA) to be at least 50% of total remuneration."
        )

    emp_rules = cfg.EMPLOYER_CONTRIBUTION_RULES

    # ---- Employer contributions --------------------------------------------
    gratuity = 0.0
    if salary.gratuity_applicable:
        gratuity = _rupees(basic_da * emp_rules["gratuity"]["accrual_percent"])
        items.append(LineItem(
            label="Gratuity (accrual)", amount=gratuity,
            note="Excluded from taxable salary in the year of accrual.",
        ))

    employer_nps = 0.0
    if salary.employer_nps:
        # Old-regime and new-regime percentages differ (10% vs 14%); the higher
        # is used for structuring and the regime engine applies the correct
        # deduction ceiling in Step 4.
        pct = max(
            emp_rules["nps"]["old_regime_percent"],
            emp_rules["nps"]["new_regime_percent"],
        )
        employer_nps = _rupees(min(emp_rules["nps"]["combined_cap"], basic_da * pct))
        items.append(LineItem(
            label="Employer contribution to NPS", amount=employer_nps,
            section=cfg.section_label("80CCD_2", taxpayer.tax_year),
        ))

    employer_pf = 0.0
    if salary.employer_pf:
        cap_headroom = max(0.0, emp_rules["provident_fund"]["combined_cap"] - employer_nps)
        employer_pf = _rupees(min(basic_da * emp_rules["provident_fund"]["exempt_percent"], cap_headroom))
        items.append(LineItem(
            label="Employer contribution to Recognised PF", amount=employer_pf,
            note="Exempt up to 12% of Basic + DA.",
        ))

    # ---- Allowances and reimbursements -------------------------------------
    ex = cfg.SALARY_EXEMPTIONS

    hra_amount = _component_amount(salary.hra, basic_da)
    hra_detail = compute_hra_exemption(
        hra_received=hra_amount,
        basic_da=basic_da,
        rent_paid=_rupees(salary.rent_paid_annual),
        taxpayer=taxpayer,
    )
    if hra_amount:
        binding = next((l for l in hra_detail.limbs if l.is_binding), None)
        items.append(LineItem(
            label="House Rent Allowance", amount=hra_amount,
            section=cfg.HRA_RULES["section_1961"],
            note=(
                f"Exempt {hra_detail.exempt_amount:,.0f} (lowest limb: {binding.label}), "
                f"taxable {hra_detail.taxable_hra:,.0f} — old regime only."
                if binding else
                "Exemption computed from rent paid, Basic + DA and city."
            ),
        ))

    conveyance = _component_amount(salary.conveyance_allowance, basic_da)
    conveyance_exempt = _capped(
        conveyance, ex["conveyance_allowance"]["annual_limit"],
        ex["conveyance_allowance"]["label"], warnings,
    )

    # Meal coupons: statutory ₹50/meal (the workbook uses ₹200 — see config).
    food_cfg = ex["food_coupons"]
    meals_per_year = food_cfg["meals_per_day"] * food_cfg["working_days"]
    food_claimed = _component_amount(salary.food_coupons, basic_da, per_unit=food_cfg["_SPREADSHEET_OVERRIDE_PER_MEAL"])
    food_statutory = _rupees((salary.food_coupons.count or 0) * food_cfg["working_days"] * food_cfg["per_meal"]) \
        if salary.food_coupons.enabled and salary.food_coupons.mode == "count" else 0.0
    if salary.food_coupons.enabled and food_claimed > food_statutory:
        warnings.append(
            f"Meal coupons: statutory exemption is {food_cfg['per_meal']:,.0f} per meal "
            f"({food_statutory:,.0f} exempt). The reference workbook assumes "
            f"{food_cfg['_SPREADSHEET_OVERRIDE_PER_MEAL']:,.0f} per meal; the excess is taxable."
        )
    food_exempt = food_statutory

    # Children education / hostel: statutory ₹100 and ₹300 per month per child.
    cea_cfg = ex["children_education_allowance"]
    hostel_cfg = ex["children_hostel_allowance"]

    cea_children = min(salary.children_education_allowance.count or 0, cea_cfg["max_children"])
    cea_claimed = _component_amount(
        salary.children_education_allowance, basic_da,
        per_unit=cea_cfg["_SPREADSHEET_OVERRIDE"] * 12,
    )
    cea_exempt = _rupees(cea_children * cea_cfg["per_month_per_child"] * 12)
    if salary.children_education_allowance.enabled and cea_claimed > cea_exempt:
        warnings.append(
            f"Children Education Allowance: statutory exemption is "
            f"{cea_cfg['per_month_per_child']}/month/child (max {cea_cfg['max_children']}), "
            f"i.e. {cea_exempt:,.0f}. Any excess paid is taxable salary."
        )

    hostel_children = min(salary.children_hostel_allowance.count or 0, hostel_cfg["max_children"])
    hostel_claimed = _component_amount(
        salary.children_hostel_allowance, basic_da,
        per_unit=hostel_cfg["_SPREADSHEET_OVERRIDE"] * 12,
    )
    hostel_exempt = _rupees(hostel_children * hostel_cfg["per_month_per_child"] * 12)
    if salary.children_hostel_allowance.enabled and hostel_claimed > hostel_exempt:
        warnings.append(
            f"Children Hostel Allowance: statutory exemption is "
            f"{hostel_cfg['per_month_per_child']}/month/child (max {hostel_cfg['max_children']}), "
            f"i.e. {hostel_exempt:,.0f}. Any excess paid is taxable salary."
        )

    uniform = _component_amount(salary.uniform_allowance, basic_da)
    telephone = _component_amount(salary.telephone_internet, basic_da)
    medical_premium = _component_amount(salary.employer_medical_premium, basic_da)
    professional_course = _component_amount(salary.professional_course, basic_da)
    health_club = _component_amount(salary.health_club, basic_da)

    gift_claimed = _component_amount(salary.gift_vouchers, basic_da)
    gift_exempt = _capped(
        gift_claimed, ex["gift_vouchers"]["annual_limit"],
        ex["gift_vouchers"]["label"], warnings,
    )

    ltc = _component_amount(salary.leave_travel_concession, basic_da)

    for label, amount in [
        ("Conveyance Allowance", conveyance),
        ("Meal Coupons", food_claimed),
        ("Children Education Allowance", cea_claimed),
        ("Children Hostel Allowance", hostel_claimed),
        ("Uniform Allowance", uniform),
        ("Telephone / Internet Reimbursement", telephone),
        ("Employer-paid Medical Premium", medical_premium),
        ("Professional Course Reimbursement", professional_course),
        ("Health Club / Sports Reimbursement", health_club),
        ("Gift Vouchers", gift_claimed),
        ("Leave Travel Concession", ltc),
    ]:
        if amount:
            items.append(LineItem(label=label, amount=amount))

    # ---- Balancing figure ---------------------------------------------------
    allocated = sum([
        basic, da, gratuity, employer_nps, employer_pf, hra_amount, conveyance,
        food_claimed, cea_claimed, hostel_claimed, uniform, telephone,
        medical_premium, professional_course, health_club, gift_claimed, ltc,
    ])
    special_allowance = _rupees(ctc - allocated)
    if special_allowance < 0:
        warnings.append(
            f"Structured components exceed the Annual CTC by "
            f"{abs(special_allowance):,.0f}. Reduce optional allowances "
            f"(HRA / meal coupons / children allowances) to rebalance."
        )
        special_allowance = 0.0
    items.append(LineItem(
        label="Balance — Special Allowance / Incentives", amount=special_allowance,
        note="Residual CTC after all structured components. Fully taxable.",
    ))

    # ---- Taxable perquisites ------------------------------------------------
    motor_car_value, car_warnings = compute_motor_car_perquisite(salary.motor_car)
    warnings.extend(car_warnings)
    if motor_car_value:
        items.append(LineItem(
            label="Motor car perquisite", amount=motor_car_value,
            section="Rule 15 (Table II)",
        ))

    # ---- Totals -------------------------------------------------------------
    # Exempt / excluded from taxable salary. HRA is NOT included here — its
    # exemption is regime-dependent and computed in Step 2.
    # Exemptions split by regime. Retirement benefits and reimbursements of
    # actual official expenditure survive into the new regime; the allowances
    # marked allowed_in_new_regime=False in config do not, so the engine can
    # add them back when computing under the new regime.
    exempt_both = _rupees(
        gratuity + employer_pf + telephone
        + medical_premium + professional_course + health_club
    )
    exempt_old_only = _rupees(
        conveyance_exempt + food_exempt + cea_exempt
        + hostel_exempt + uniform + gift_exempt + ltc
    )
    exempt_total = _rupees(exempt_both + exempt_old_only)

    gross_salary = _rupees(ctc + motor_car_value)

    head.gross = gross_salary
    head.exempt = exempt_total
    head.exempt_both_regimes = exempt_both
    head.exempt_old_regime_only = exempt_old_only
    head.net = _rupees(gross_salary - exempt_total)
    head.tds = _rupees(salary.tds_deducted)
    head.line_items = items
    head.warnings = warnings
    head.hra_exemption = hra_detail
    return head


# ---------------------------------------------------------------------------
# House property
# ---------------------------------------------------------------------------

def build_house_property_head(hp: HousePropertyIncome, taxpayer: TaxpayerProfile) -> HeadSummary:
    """
    Net income (or loss) from house property.

    Self-occupied: NAV is nil; only housing loan interest is claimable, capped.
    Let-out: NAV less municipal taxes, less the 30% standard deduction, less
    the full interest (uncapped).
    """
    head = HeadSummary(head="house_property", label="Income from House Property")
    if not hp or not hp.enabled or not hp.properties:
        return head

    rules = cfg.HOUSE_PROPERTY_RULES
    warnings: List[str] = []
    items: List[LineItem] = []

    total_net = 0.0
    total_tds = 0.0
    self_occupied_count = 0

    for prop in hp.properties:
        label = prop.label or "Property"
        total_tds += _rupees(prop.tds_deducted)

        if prop.property_type == "self_occupied":
            self_occupied_count += 1
            cap = rules["self_occupied_interest_cap"]["cap"]
            interest = _capped(
                prop.housing_loan_interest, cap,
                f"{label} — housing loan interest", warnings,
            )
            net = _rupees(-interest)
            items.append(LineItem(
                label=f"{label} (self-occupied) — housing loan interest",
                amount=net,
                section=cfg.HOUSE_PROPERTY_RULES["self_occupied_interest_cap"]["section_1961"],
                note="Old regime only; not available under the new regime.",
            ))
        else:
            gav = _rupees(prop.annual_rent_received)
            municipal = _rupees(prop.municipal_taxes_paid)
            nav = _rupees(gav - municipal)
            std_ded = _rupees(nav * rules["standard_deduction_percent"])
            interest = _rupees(prop.housing_loan_interest)
            net = _rupees(nav - std_ded - interest)
            items.append(LineItem(label=f"{label} — Gross Annual Value", amount=gav))
            if municipal:
                items.append(LineItem(label=f"{label} — less municipal taxes", amount=-municipal))
            items.append(LineItem(
                label=f"{label} — standard deduction @30%", amount=-std_ded,
                section="24(a)",
            ))
            if interest:
                items.append(LineItem(
                    label=f"{label} — housing loan interest", amount=-interest,
                    section="24(b)",
                ))

        total_net = _rupees(total_net + net)

    if self_occupied_count > rules["max_self_occupied_properties"]:
        warnings.append(
            f"{self_occupied_count} properties marked self-occupied; only "
            f"{rules['max_self_occupied_properties']} may be treated as such. "
            f"The remainder are deemed let out."
        )

    # Loss set-off against other heads is capped.
    if total_net < 0:
        cap = rules["set_off_cap_against_other_heads"]
        if abs(total_net) > cap:
            warnings.append(
                f"Loss from house property is {abs(total_net):,.0f}. Set-off against "
                f"other heads is limited to {cap:,.0f} per year; the balance carries "
                f"forward for up to 8 years."
            )

    head.gross = _rupees(sum(_rupees(p.annual_rent_received) for p in hp.properties))
    head.net = total_net
    head.tds = _rupees(total_tds)
    head.line_items = items
    head.warnings = warnings
    return head


# ---------------------------------------------------------------------------
# PGBP
# ---------------------------------------------------------------------------

def build_pgbp_head(pgbp: PGBPIncome, taxpayer: TaxpayerProfile) -> HeadSummary:
    """Business / professional income, presumptive or under normal provisions."""
    head = HeadSummary(head="pgbp", label="Profits & Gains from Business / Profession")
    if not pgbp or not pgbp.enabled:
        return head

    warnings: List[str] = []
    items: List[LineItem] = []
    total = 0.0

    # ---- Presumptive --------------------------------------------------------
    if pgbp.presumptive.enabled:
        p = pgbp.presumptive
        scheme = cfg.PRESUMPTIVE_TAXATION.get(p.scheme)
        turnover = _rupees(p.gross_turnover)

        if scheme:
            cash = _rupees(p.cash_receipts)
            cash_ratio = (cash / turnover) if turnover else 0.0
            limit = (
                scheme["turnover_limit"]
                if cash_ratio <= scheme["cash_receipts_threshold"]
                else scheme["turnover_limit_standard"]
            )
            if turnover > limit:
                warnings.append(
                    f"{p.scheme}: turnover of {turnover:,.0f} exceeds the "
                    f"{limit:,.0f} ceiling for this scheme. Presumptive taxation "
                    f"is not available; normal provisions and audit apply."
                )

            if p.declared_profit_override is not None:
                deemed = _rupees(p.declared_profit_override)
                items.append(LineItem(
                    label=f"{scheme['label']} — profit declared", amount=deemed,
                    section=scheme["section_1961"],
                ))
            elif p.scheme == "44AD":
                digital = _rupees(p.digital_receipts) or _rupees(turnover - cash)
                deemed = _rupees(
                    cash * scheme["deemed_profit_percent_cash"]
                    + digital * scheme["deemed_profit_percent_digital"]
                )
                items.append(LineItem(
                    label="Deemed profit — cash receipts @8%",
                    amount=_rupees(cash * scheme["deemed_profit_percent_cash"]),
                    section="44AD",
                ))
                items.append(LineItem(
                    label="Deemed profit — digital receipts @6%",
                    amount=_rupees(digital * scheme["deemed_profit_percent_digital"]),
                    section="44AD",
                ))
            else:  # 44ADA
                deemed = _rupees(turnover * scheme["deemed_profit_percent"])
                items.append(LineItem(
                    label="Deemed profit @50% of gross receipts", amount=deemed,
                    section="44ADA",
                ))

            total = _rupees(total + deemed)

    # ---- Normal provisions --------------------------------------------------
    if pgbp.regular.enabled:
        r = pgbp.regular
        if r.net_profit_override is not None:
            net_profit = _rupees(r.net_profit_override)
            items.append(LineItem(label="Net profit (as entered)", amount=net_profit))
        else:
            net_profit = _rupees(r.gross_receipts - r.total_expenses - r.depreciation)
            items.append(LineItem(label="Gross receipts", amount=_rupees(r.gross_receipts)))
            items.append(LineItem(label="Less: expenses", amount=-_rupees(r.total_expenses)))
            if r.depreciation:
                items.append(LineItem(label="Less: depreciation", amount=-_rupees(r.depreciation)))
        total = _rupees(total + net_profit)

    head.gross = total
    head.net = total
    head.tds = _rupees(pgbp.tds_deducted)
    head.line_items = items
    head.warnings = warnings
    return head


# ---------------------------------------------------------------------------
# Capital gains
# ---------------------------------------------------------------------------

def build_capital_gains_head(cg: CapitalGainsIncome, taxpayer: TaxpayerProfile) -> HeadSummary:
    """
    Capital gains, keeping the special-rate buckets separate.

    111A and 112A are tracked apart from other gains because they carry their
    own rates, their own exemption, and are excluded from both the rebate and
    Chapter VI-A deductions when tax is computed in Step 4.
    """
    head = HeadSummary(head="capital_gains", label="Capital Gains")
    if not cg or not cg.enabled:
        return head

    rules = cfg.CAPITAL_GAINS_RULES
    warnings: List[str] = []
    items: List[LineItem] = []

    stcg_111a = _rupees(cg.stcg_111a)
    ltcg_112a = _rupees(cg.ltcg_112a)
    stcg_other = _rupees(cg.stcg_other)
    ltcg_other = _rupees(cg.ltcg_other)

    # Brought-forward losses: STCL sets off against either; LTCL only against LTCG.
    bf_stcl = _rupees(cg.brought_forward_stcl)
    bf_ltcl = _rupees(cg.brought_forward_ltcl)

    if bf_ltcl:
        absorb_112a = min(bf_ltcl, ltcg_112a)
        ltcg_112a = _rupees(ltcg_112a - absorb_112a)
        remaining = _rupees(bf_ltcl - absorb_112a)
        absorb_other = min(remaining, ltcg_other)
        ltcg_other = _rupees(ltcg_other - absorb_other)
        items.append(LineItem(
            label="Less: brought-forward long-term capital loss",
            amount=-_rupees(absorb_112a + absorb_other),
            note="Long-term losses set off only against long-term gains.",
        ))

    if bf_stcl:
        pool = [("stcg_111a", stcg_111a), ("stcg_other", stcg_other),
                ("ltcg_112a", ltcg_112a), ("ltcg_other", ltcg_other)]
        remaining = bf_stcl
        absorbed = 0.0
        adjusted = {}
        for key, value in pool:
            take = min(remaining, value)
            adjusted[key] = _rupees(value - take)
            remaining = _rupees(remaining - take)
            absorbed = _rupees(absorbed + take)
        stcg_111a = adjusted["stcg_111a"]
        stcg_other = adjusted["stcg_other"]
        ltcg_112a = adjusted["ltcg_112a"]
        ltcg_other = adjusted["ltcg_other"]
        if absorbed:
            items.append(LineItem(
                label="Less: brought-forward short-term capital loss",
                amount=-absorbed,
                note="Short-term losses set off against any capital gain.",
            ))

    if stcg_111a:
        items.append(LineItem(
            label=rules["stcg_111a"]["label"], amount=stcg_111a,
            section=rules["stcg_111a"]["section_1961"],
            note=f"Taxed at {rules['stcg_111a']['rate'] * 100:.0f}%; no basic exemption applies.",
        ))
    if ltcg_112a:
        exemption = rules["ltcg_112a"]["annual_exemption"]
        taxable_112a = _rupees(max(0.0, ltcg_112a - exemption))
        items.append(LineItem(
            label=rules["ltcg_112a"]["label"], amount=ltcg_112a,
            section=rules["ltcg_112a"]["section_1961"],
            note=(
                f"First {exemption:,.0f} exempt each year; balance "
                f"{taxable_112a:,.0f} taxed at {rules['ltcg_112a']['rate'] * 100:.1f}%."
            ),
        ))
    if stcg_other:
        items.append(LineItem(
            label=rules["stcg_other"]["label"], amount=stcg_other,
            note="Added to total income and taxed at slab rates.",
        ))
    if ltcg_other:
        items.append(LineItem(
            label=rules["ltcg_other"]["label"], amount=ltcg_other,
            section=rules["ltcg_other"].get("section_1961"),
            note=f"Taxed at {rules['ltcg_other']['rate'] * 100:.1f}% without indexation.",
        ))

    if stcg_111a or ltcg_112a:
        warnings.append(
            "Gains under S.111A / S.112A are taxed at special rates. The S.87A "
            "rebate and Chapter VI-A deductions are not available against them."
        )

    total = _rupees(stcg_111a + ltcg_112a + stcg_other + ltcg_other)
    head.gross = total
    head.net = total
    head.tds = _rupees(cg.tds_deducted)
    head.line_items = items
    head.warnings = warnings
    return head


# ---------------------------------------------------------------------------
# Other sources
# ---------------------------------------------------------------------------

def build_other_sources_head(os_income: OtherSourcesIncome, taxpayer: TaxpayerProfile) -> HeadSummary:
    """Interest, dividends, winnings and residual income."""
    head = HeadSummary(head="other_sources", label="Income from Other Sources")
    if not os_income or not os_income.enabled:
        return head

    warnings: List[str] = []
    items: List[LineItem] = []

    parts = [
        ("Savings bank interest", _rupees(os_income.savings_interest),
         "Eligible for a deduction under 80TTA / 80TTB in the old regime."),
        ("Fixed deposit interest", _rupees(os_income.fd_interest), None),
        ("Other interest income", _rupees(os_income.other_interest), None),
        ("Dividend income", _rupees(os_income.dividend_income),
         "Taxable at slab rates in the hands of the recipient."),
        ("Family pension", _rupees(os_income.family_pension),
         "A standard deduction is available against family pension."),
        ("Other income", _rupees(os_income.other_income), None),
    ]
    total = 0.0
    for label, amount, note in parts:
        if amount:
            items.append(LineItem(label=label, amount=amount, note=note))
            total = _rupees(total + amount)

    winnings = _rupees(os_income.winnings)
    if winnings:
        items.append(LineItem(
            label="Winnings (lottery, betting, online games)", amount=winnings,
            section="115BB",
            note="Taxed at a flat special rate; no deduction or exemption is allowed.",
        ))
        warnings.append(
            "Winnings are taxed at a flat special rate with no deductions or "
            "basic exemption available."
        )
        total = _rupees(total + winnings)

    head.gross = total
    head.net = total
    head.tds = _rupees(os_income.tds_deducted)
    head.line_items = items
    head.warnings = warnings
    return head


# ---------------------------------------------------------------------------
# Chapter VI-A deductions  (Part C / Schedule XV under ITA 2025)
# ---------------------------------------------------------------------------

def _deduction_limit(key: str, entry, taxpayer: TaxpayerProfile) -> Tuple[float, str]:
    """
    Resolve the ceiling for one deduction, accounting for the senior-citizen
    and severe-disability variants. Returns (limit, reason); limit None means
    uncapped.
    """
    d = cfg.DEDUCTIONS[key]
    age_band = cfg.age_band_for(taxpayer.age or 0)
    self_is_senior = age_band in ("senior", "super_senior")

    # Severe disability raises the ceiling for 80DD / 80U.
    if entry and getattr(entry, "is_severe_disability", False) and d.get("limit_severe"):
        return d["limit_severe"], "severe disability"

    # 80D parents uses the flag on the entry (the parents' age, not the
    # taxpayer's); 80DDB and 80D self key off the taxpayer's own age.
    if d.get("limit_senior"):
        if key == "80D_parents":
            if entry and getattr(entry, "is_senior_citizen_claim", False):
                return d["limit_senior"], "senior citizen parents"
        elif self_is_senior:
            return d["limit_senior"], "senior citizen"

    return d.get("limit"), ""


def compute_deductions(
    payload: TaxProfileInput,
    gross_total_income: float,
    salary_head: HeadSummary,
) -> "DeductionsSummary":
    """
    Work every Chapter VI-A deduction the user has claimed.

    Two things this deliberately does NOT do silently:
      * it never lets deductions exceed Gross Total Income (they cannot create
        or increase a loss), and says so when it restricts them;
      * it never mixes regimes — the old-regime and new-regime totals are
        reported separately, because almost everything here is old-regime only.

    `headroom` on each entry is the unused allowance, which is what Step 5
    turns into "you can still invest X" advice.
    """
    taxpayer = payload.taxpayer or TaxpayerProfile()
    d_in = payload.deductions or DeductionsInput()
    summary = DeductionsSummary()
    warnings: List[str] = []

    age_band = cfg.age_band_for(taxpayer.age or 0)
    self_is_senior = age_band in ("senior", "super_senior")

    # Claimed amounts, keyed by deduction. Start from the explicit entries.
    claimed: Dict[str, float] = {}
    entry_by_key: Dict[str, object] = {}
    for e in (d_in.entries or []):
        if e.key not in cfg.DEDUCTIONS:
            warnings.append(f"Ignored unknown deduction {e.key!r}.")
            continue
        claimed[e.key] = _rupees(claimed.get(e.key, 0.0) + _rupees(e.amount))
        entry_by_key[e.key] = e

    # 80C is an aggregate pool: explicit investments plus the employee's own PF
    # contribution and any home loan principal repaid.
    pool_80c = _rupees(
        claimed.get("80C", 0.0)
        + _rupees(d_in.employee_pf_contribution)
        + _rupees(d_in.home_loan_principal)
    )
    if pool_80c:
        claimed["80C"] = pool_80c

    # Employer NPS is not user-entered — it comes from the salary structure and
    # is the one deduction that survives into the new regime. Its ceiling is a
    # percentage of Basic + DA that DIFFERS by regime (10% old, 14% new), so the
    # Basic + DA base is captured here and the two limits applied separately below.
    employer_nps = 0.0
    basic_da_for_nps = 0.0
    for li in (salary_head.line_items or []):
        if li.label == "Employer contribution to NPS":
            employer_nps = _rupees(li.amount)
        elif li.label in ("Basic Pay", "Dearness Allowance"):
            basic_da_for_nps = _rupees(basic_da_for_nps + li.amount)
    if employer_nps:
        claimed["80CCD_2"] = employer_nps

    # 80TTA and 80TTB are mutually exclusive, and both are capped by the actual
    # savings interest earned.
    savings_interest = _rupees((payload.other_sources or OtherSourcesIncome()).savings_interest)
    if self_is_senior:
        if claimed.pop("80TTA", None):
            warnings.append(
                "80TTA is not available to senior citizens; the claim has been moved "
                "to 80TTB, which carries a higher limit."
            )
        if savings_interest and "80TTB" not in claimed:
            claimed["80TTB"] = savings_interest
    else:
        if claimed.pop("80TTB", None):
            warnings.append(
                "80TTB applies only to senior citizens; the claim has been moved to 80TTA."
            )
        if savings_interest and "80TTA" not in claimed:
            claimed["80TTA"] = savings_interest

    for key in ("80TTA", "80TTB"):
        if key in claimed and claimed[key] > savings_interest:
            claimed[key] = savings_interest

    # ---- Apply ceilings -----------------------------------------------------
    total_old = 0.0
    total_new = 0.0
    total_claimed = 0.0

    for key in cfg.DEDUCTIONS:
        amount = _rupees(claimed.get(key, 0.0))
        if amount <= 0:
            continue

        d = cfg.DEDUCTIONS[key]
        entry = entry_by_key.get(key)
        limit, reason = _deduction_limit(key, entry, taxpayer)

        qualifying = amount if limit is None else min(amount, limit)
        # Same figure for both regimes unless a rule says otherwise (80CCD(2) below).
        qualifying_old = qualifying
        qualifying_new = qualifying
        notes: List[str] = []

        if key == "80CCD_2":
            rules = cfg.EMPLOYER_CONTRIBUTION_RULES["nps"]
            cap_old = min(
                rules["combined_cap"],
                basic_da_for_nps * rules["old_regime_percent"],
            )
            cap_new = min(
                rules["combined_cap"],
                basic_da_for_nps * rules["new_regime_percent"],
            )
            qualifying_old = _rupees(min(amount, cap_old))
            qualifying_new = _rupees(min(amount, cap_new))
            # `qualifying` is the headline figure; show the more favourable one
            # and let the per-regime fields carry the detail.
            qualifying = max(qualifying_old, qualifying_new)
            notes.append(
                f"Deductible under both regimes, but at different rates: "
                f"{int(rules['old_regime_percent'] * 100)}% of Basic + DA under the old "
                f"regime ({qualifying_old:,.0f}), "
                f"{int(rules['new_regime_percent'] * 100)}% under the new "
                f"({qualifying_new:,.0f})."
            )
        if key in ("80D_self", "80D_parents"):
            notes.append("Includes preventive health check-up up to 5,000 within this limit.")
        if key == "80E":
            notes.append(f"No monetary cap; available for up to {d['max_years']} assessment years.")
        if key == "80G":
            notes.append(
                "Donations qualify at 50% or 100%, some subject to a further "
                "qualifying limit. Enter the deductible amount, not the gross donation."
            )

        result = DeductionResult(
            key=key,
            section=cfg.section_label(key, taxpayer.tax_year),
            label=d["label"],
            short_label=d.get("short_label", d["label"]),
            claimed=amount,
            qualifying=_rupees(qualifying),
            qualifying_old=_rupees(qualifying_old),
            qualifying_new=_rupees(qualifying_new),
            limit=limit,
            limit_reason=reason or None,
            regimes=d["regimes"],
            is_capped=(limit is not None and amount > limit),
            headroom=_rupees(max(0.0, limit - amount)) if limit is not None else 0.0,
            notes=notes,
        )
        summary.entries.append(result)

        total_claimed = _rupees(total_claimed + amount)
        if "old" in d["regimes"]:
            total_old = _rupees(total_old + result.qualifying_old)
        if "new" in d["regimes"]:
            total_new = _rupees(total_new + result.qualifying_new)

        if result.is_capped:
            warnings.append(
                f"{result.section}: claimed {amount:,.0f} against a limit of "
                f"{limit:,.0f}{f' ({reason})' if reason else ''} — restricted."
            )

    # Deductions cannot exceed Gross Total Income.
    gti = _rupees(gross_total_income)
    if total_old > gti > 0:
        warnings.append(
            f"Deductions of {total_old:,.0f} exceed Gross Total Income of {gti:,.0f}. "
            f"Chapter VI-A deductions cannot create a loss, so they are restricted "
            f"to {gti:,.0f}."
        )
        total_old = gti
        summary.restricted_to_gti = True
    if total_new > gti > 0:
        total_new = gti
        summary.restricted_to_gti = True

    summary.total_old_regime = total_old
    summary.total_new_regime = total_new
    summary.total_claimed = total_claimed
    summary.warnings = warnings
    return summary


# ---------------------------------------------------------------------------
# TDS and taxes already paid
# ---------------------------------------------------------------------------

def compute_tds_summary(payload: TaxProfileInput, heads: List[HeadSummary]) -> "TDSSummary":
    """
    Consolidate tax already paid, as a taxpayer would from Form 26AS / AIS.

    Netted against the computed liability in Step 4; a surplus here is a
    refund rather than a payable.
    """
    summary = TDSSummary()
    for h in heads:
        if h.tds:
            summary.by_head.append(TDSEntry(head=h.head, label=h.label, amount=_rupees(h.tds)))

    summary.total_tds = _rupees(sum(e.amount for e in summary.by_head))
    summary.advance_tax = _rupees(payload.advance_tax_paid)
    summary.self_assessment_tax = _rupees(payload.self_assessment_tax_paid)
    summary.total_prepaid = _rupees(
        summary.total_tds + summary.advance_tax + summary.self_assessment_tax
    )

    if summary.total_prepaid:
        summary.notes.append(
            "Reconcile these figures against Form 26AS / AIS before filing — "
            "credit is allowed only for tax actually reflected there."
        )
    return summary


# ---------------------------------------------------------------------------
# Tax computation engine
# ---------------------------------------------------------------------------

def tax_from_slabs(income: float, slabs) -> Tuple[float, List["SlabBand"]]:
    """Apply a slab table, returning total tax and the per-band breakdown."""
    income = max(0.0, _rupees(income))
    total = 0.0
    bands: List[SlabBand] = []
    lower = 0.0

    for s in slabs:
        upper = s["upto"] if s["upto"] is not None else float("inf")
        taxable = max(0.0, min(income, upper) - lower)
        tax = _rupees(taxable * s["rate"])
        if taxable > 0:
            bands.append(SlabBand(
                from_amount=_rupees(lower),
                to_amount=None if s["upto"] is None else _rupees(upper),
                rate=s["rate"],
                taxable_in_band=_rupees(taxable),
                tax=tax,
            ))
            total = _rupees(total + tax)
        if income <= upper:
            break
        lower = upper

    return total, bands


def _surcharge_rate_for(total_income: float, bands) -> Tuple[float, float]:
    """Highest surcharge band the income crosses. Returns (rate, threshold)."""
    rate, threshold = 0.0, 0.0
    for b in bands:
        if total_income > b["above"]:
            rate, threshold = b["rate"], float(b["above"])
    return rate, threshold


def _basic_exemption_limit(slabs) -> float:
    """The top of the nil-rate band."""
    for s in slabs:
        if s["rate"] == 0 and s["upto"] is not None:
            return float(s["upto"])
    return 0.0


def compute_regime(
    regime: str,
    payload: TaxProfileInput,
    heads: List[HeadSummary],
    deductions: "DeductionsSummary",
    tds: "TDSSummary",
    extra_deductions: float = 0.0,
) -> "RegimeComputation":
    """
    Full computation under one regime.

    Order follows the Act: build total income, split it between slab-rate and
    special-rate income, tax each, apply the rebate, then surcharge (with
    marginal relief), then cess, then credit tax already paid.

    `extra_deductions` is used by the break-even search and is not part of a
    normal computation.
    """
    taxpayer = payload.taxpayer or TaxpayerProfile()
    year = cfg.get_year_config(taxpayer.tax_year)
    rcfg = cfg.get_regime_config(regime, taxpayer.tax_year)
    is_old = regime == "old"
    age_band = cfg.age_band_for(taxpayer.age or 0)
    slabs = cfg.get_slabs(regime, age_band, taxpayer.tax_year)

    comp = RegimeComputation(regime=regime, label=rcfg["label"])
    notes: List[str] = []

    def head(name: str) -> HeadSummary:
        return next((h for h in heads if h.head == name), HeadSummary(head=name, label=name))

    salary_head = head("salary")

    # ---- Salary ------------------------------------------------------------
    # Step 1's `net` already nets off every exemption, i.e. the OLD-regime
    # position. Under the new regime the old-only allowances come back.
    salary_net = salary_head.net
    if not is_old:
        salary_net = _rupees(salary_net + salary_head.exempt_old_regime_only)
        if salary_head.exempt_old_regime_only:
            comp.allowances_exempt = 0.0
            notes.append(
                f"Allowance exemptions of {salary_head.exempt_old_regime_only:,.0f} "
                f"(conveyance, meal coupons, children's allowances, uniform, gift "
                f"vouchers, LTC) are withdrawn under the new regime."
            )
    else:
        comp.allowances_exempt = salary_head.exempt_old_regime_only

    # HRA — old regime only.
    hra = salary_head.hra_exemption
    if is_old and hra and hra.applicable and rcfg["allows_hra"]:
        comp.hra_exemption = hra.exempt_amount
        salary_net = _rupees(salary_net - hra.exempt_amount)

    # Standard deduction and professional tax, both under S.19.
    if salary_net > 0 or salary_head.gross:
        comp.standard_deduction = _rupees(min(rcfg["standard_deduction"], max(0.0, salary_net)))
        salary_net = _rupees(salary_net - comp.standard_deduction)
        if rcfg["professional_tax"]:
            comp.professional_tax = _rupees(min(rcfg["professional_tax"], max(0.0, salary_net)))
            salary_net = _rupees(salary_net - comp.professional_tax)

    comp.salary_net = _rupees(max(0.0, salary_net))

    # ---- Other heads -------------------------------------------------------
    hp = head("house_property")
    hp_net = hp.net
    if not is_old and hp_net < 0:
        # Self-occupied housing loan interest is not deductible under the new
        # regime, so a self-occupied loss does not arise there.
        self_occupied_loss = 0.0
        for p in (payload.house_property.properties if payload.house_property else []):
            if p.property_type == "self_occupied":
                self_occupied_loss += min(
                    _rupees(p.housing_loan_interest),
                    cfg.HOUSE_PROPERTY_RULES["self_occupied_interest_cap"]["cap"],
                )
        if self_occupied_loss:
            hp_net = _rupees(hp_net + self_occupied_loss)
            notes.append(
                f"Self-occupied housing loan interest of {self_occupied_loss:,.0f} is "
                f"not deductible under the new regime."
            )
    # A house property loss can only be set off against other heads up to a cap.
    if hp_net < 0:
        cap = cfg.HOUSE_PROPERTY_RULES["set_off_cap_against_other_heads"]
        if abs(hp_net) > cap:
            notes.append(
                f"House property loss restricted to {cap:,.0f} for set-off; the balance "
                f"carries forward."
            )
            hp_net = _rupees(-cap)
    comp.house_property_net = _rupees(hp_net)
    comp.pgbp_net = _rupees(head("pgbp").net)
    comp.other_sources_net = _rupees(head("other_sources").net)

    # ---- Capital gains, split by rate --------------------------------------
    cg_in = payload.capital_gains or CapitalGainsIncome()
    cg_rules = cfg.CAPITAL_GAINS_RULES
    cg_head = head("capital_gains")

    # STCG on assets other than listed equity is taxed at slab rates, so it is
    # deliberately absent here — it stays inside normal income via the head net.
    stcg_111a = _rupees(cg_in.stcg_111a) if cg_in.enabled else 0.0
    ltcg_112a = _rupees(cg_in.ltcg_112a) if cg_in.enabled else 0.0
    ltcg_other = _rupees(cg_in.ltcg_other) if cg_in.enabled else 0.0

    comp.capital_gains_net = _rupees(cg_head.net)

    # ---- Gross Total Income ------------------------------------------------
    comp.gross_total_income = _rupees(
        comp.salary_net + comp.house_property_net + comp.pgbp_net
        + comp.other_sources_net + comp.capital_gains_net
    )

    # ---- Chapter VI-A ------------------------------------------------------
    ded = deductions.total_old_regime if is_old else deductions.total_new_regime
    ded = _rupees(ded + (extra_deductions if is_old else 0.0))
    # Deductions cannot be set against special-rate 111A/112A income, so they
    # are limited to income that is not taxed at a special rate.
    deductible_base = _rupees(max(0.0, comp.gross_total_income - stcg_111a - ltcg_112a - ltcg_other))
    if ded > deductible_base:
        if deductible_base < ded and (stcg_111a or ltcg_112a or ltcg_other):
            notes.append(
                "Chapter VI-A deductions cannot be set against income taxed at the "
                "special S.111A / S.112A rates, so they are restricted."
            )
        ded = deductible_base
    comp.chapter_via_deductions = ded

    comp.total_income = _rupees(max(0.0, comp.gross_total_income - ded))

    # ---- Split between slab-rate and special-rate income -------------------
    special_total = _rupees(stcg_111a + ltcg_112a + ltcg_other)
    normal_income = _rupees(max(0.0, comp.total_income - special_total))

    # An unexhausted basic exemption may be set off against special-rate gains.
    basic_exemption = _basic_exemption_limit(slabs)
    shortfall = _rupees(max(0.0, basic_exemption - normal_income))

    specials: List[SpecialRateItem] = []

    def add_special(key, gross, rate, section, label, annual_exemption=0.0):
        nonlocal shortfall
        if gross <= 0:
            return
        after_exemption = _rupees(max(0.0, gross - annual_exemption))
        setoff = _rupees(min(shortfall, after_exemption))
        shortfall = _rupees(shortfall - setoff)
        taxable = _rupees(after_exemption - setoff)
        specials.append(SpecialRateItem(
            key=key, label=label, section=section, gross=gross,
            exemption_applied=_rupees(min(annual_exemption, gross)),
            basic_exemption_setoff=setoff,
            taxable=taxable, rate=rate, tax=_rupees(taxable * rate),
        ))

    # Highest rate first, so the basic-exemption shortfall shelters the most
    # expensive income.
    add_special("stcg_111a", stcg_111a, cg_rules["stcg_111a"]["rate"],
                cg_rules["stcg_111a"]["section_1961"], cg_rules["stcg_111a"]["label"],
                cg_rules["stcg_111a"]["annual_exemption"])
    add_special("ltcg_112a", ltcg_112a, cg_rules["ltcg_112a"]["rate"],
                cg_rules["ltcg_112a"]["section_1961"], cg_rules["ltcg_112a"]["label"],
                cg_rules["ltcg_112a"]["annual_exemption"])
    add_special("ltcg_other", ltcg_other, cg_rules["ltcg_other"]["rate"],
                cg_rules["ltcg_other"].get("section_1961"), cg_rules["ltcg_other"]["label"],
                cg_rules["ltcg_other"]["annual_exemption"])

    if any(s.basic_exemption_setoff for s in specials):
        notes.append(
            "Part of the unused basic exemption has been set off against gains taxed "
            "at special rates."
        )

    comp.special_rate_items = specials
    comp.normal_income = normal_income

    # ---- Tax ---------------------------------------------------------------
    tax_normal, bands = tax_from_slabs(normal_income, slabs)
    comp.slab_bands = bands
    comp.tax_on_normal_income = tax_normal
    comp.tax_on_special_income = _rupees(sum(s.tax for s in specials))
    comp.tax_before_rebate = _rupees(tax_normal + comp.tax_on_special_income)

    # ---- Rebate  (S.156 / 87A) ---------------------------------------------
    # Not available against special-rate income, so it bites only on the slab tax.
    reb = rcfg["rebate"]
    comp.rebate_section = (
        reb["section_2025"] if year["labels"]["section_scheme"] == "2025"
        else reb["section_1961"]
    )
    rebate = 0.0
    if comp.total_income <= reb["income_threshold"]:
        rebate = _rupees(min(tax_normal, reb["max_rebate"]))
    elif reb["marginal_relief"]:
        # Income just past the threshold: cap the tax at the excess over it, so
        # crossing the line by a rupee cannot cost the whole rebate.
        excess = _rupees(comp.total_income - reb["income_threshold"])
        if tax_normal > excess:
            rebate = _rupees(tax_normal - excess)
            comp.rebate_marginal_relief = rebate
            notes.append(
                f"Marginal relief on the rebate: income exceeds "
                f"{reb['income_threshold']:,.0f} by {excess:,.0f}, so slab tax is "
                f"limited to that excess."
            )
    comp.rebate = rebate
    comp.tax_after_rebate = _rupees(comp.tax_before_rebate - rebate)

    # ---- Surcharge ---------------------------------------------------------
    rate, threshold = _surcharge_rate_for(comp.total_income, rcfg["surcharge"])
    comp.surcharge_rate = rate

    if rate > 0:
        # Surcharge on tax attributable to 111A / 112A gains is capped.
        cg_cap = cfg.SURCHARGE_CAPITAL_GAINS_CAP
        capped_rate = min(rate, cg_cap)
        tax_on_capped = _rupees(sum(
            s.tax for s in specials if s.key in ("stcg_111a", "ltcg_112a")
        ))
        tax_at_full_rate = _rupees(comp.tax_after_rebate - tax_on_capped)
        sc = _rupees(max(0.0, tax_at_full_rate) * rate + tax_on_capped * capped_rate)
        if tax_on_capped and capped_rate < rate:
            notes.append(
                f"Surcharge on tax from S.111A / S.112A gains is capped at "
                f"{cg_cap * 100:.0f}% rather than {rate * 100:.0f}%."
            )
        comp.surcharge_before_relief = sc

        # Marginal relief: crossing a surcharge threshold cannot cost more in
        # extra tax than the extra income itself.
        tax_at_threshold, _ = tax_from_slabs(
            max(0.0, threshold - special_total), slabs
        )
        tax_at_threshold = _rupees(tax_at_threshold + comp.tax_on_special_income)
        excess_income = _rupees(comp.total_income - threshold)
        relief = _rupees(max(0.0, (comp.tax_after_rebate + sc) - (tax_at_threshold + excess_income)))
        if relief > 0:
            comp.surcharge_marginal_relief = relief
            sc = _rupees(max(0.0, sc - relief))
            notes.append(
                f"Marginal relief on surcharge: {relief:,.0f}. Income exceeds the "
                f"{threshold:,.0f} threshold by {excess_income:,.0f}, and the extra "
                f"tax cannot exceed that."
            )
        comp.surcharge = sc

    # ---- Cess --------------------------------------------------------------
    comp.cess_rate = year["cess_rate"]
    comp.cess = _rupees((comp.tax_after_rebate + comp.surcharge) * comp.cess_rate)

    comp.total_tax_liability = _rupees(comp.tax_after_rebate + comp.surcharge + comp.cess)

    # ---- Credit tax already paid -------------------------------------------
    comp.prepaid_tax = _rupees(tds.total_prepaid)
    net = _rupees(comp.total_tax_liability - comp.prepaid_tax)
    comp.net_payable = net
    comp.is_refund = net < 0

    if comp.gross_total_income > 0:
        comp.effective_rate = round(comp.total_tax_liability / comp.gross_total_income, 4)

    comp.notes = notes
    return comp


def _breakeven_extra_deductions(
    payload: TaxProfileInput,
    heads: List[HeadSummary],
    deductions: "DeductionsSummary",
    tds: "TDSSummary",
    gap: float,
) -> Optional[float]:
    """
    How much MORE old-regime deduction would be needed to match the new regime.

    Solved by bisection rather than algebraically: the liability is piecewise
    linear with slab, surcharge and rebate discontinuities, so searching the
    actual function is both simpler and correct across those breaks.
    """
    if gap <= 0:
        return None

    lo, hi = 0.0, 5000000.0
    new_liability = compute_regime("new", payload, heads, deductions, tds).total_tax_liability

    # If even a very large deduction cannot close the gap, say so.
    best = compute_regime("old", payload, heads, deductions, tds, extra_deductions=hi)
    if best.total_tax_liability > new_liability:
        return None

    for _ in range(40):
        mid = (lo + hi) / 2
        liability = compute_regime(
            "old", payload, heads, deductions, tds, extra_deductions=mid
        ).total_tax_liability
        if liability > new_liability:
            lo = mid
        else:
            hi = mid
    return _rupees(hi)


def compare_regimes(
    payload: TaxProfileInput,
    heads: List[HeadSummary],
    deductions: "DeductionsSummary",
    tds: "TDSSummary",
) -> "RegimeComparison":
    """Compute both regimes and say which wins, and by how much."""
    taxpayer = payload.taxpayer or TaxpayerProfile()
    year = cfg.get_year_config(taxpayer.tax_year)

    old = compute_regime("old", payload, heads, deductions, tds)
    new = compute_regime("new", payload, heads, deductions, tds)

    default_regime = next(
        (k for k, r in year["regimes"].items() if r.get("is_default_regime")), "new"
    )

    old_wins = old.total_tax_liability < new.total_tax_liability
    recommended = "old" if old_wins else "new"
    saving = _rupees(abs(old.total_tax_liability - new.total_tax_liability))

    breakeven = None
    if not old_wins and saving > 0:
        breakeven = _breakeven_extra_deductions(
            payload, heads, deductions, tds,
            gap=_rupees(old.total_tax_liability - new.total_tax_liability),
        )

    if saving == 0:
        summary = "Both regimes produce the same liability."
    elif old_wins:
        summary = (
            f"The old regime is cheaper by ₹{saving:,.0f}, on deductions of "
            f"₹{old.chapter_via_deductions:,.0f}."
        )
    elif breakeven:
        summary = (
            f"The new regime is cheaper by ₹{saving:,.0f}. About "
            f"₹{breakeven:,.0f} of further old-regime deductions would draw level."
        )
    else:
        summary = (
            f"The new regime is cheaper by ₹{saving:,.0f}, and no realistic amount "
            f"of additional deduction would close the gap."
        )

    return RegimeComparison(
        old=old, new=new,
        recommended_regime=recommended,
        saving=saving,
        breakeven_extra_deductions=breakeven,
        default_regime=default_regime,
        summary=summary,
    )


# ---------------------------------------------------------------------------
# Recommendations  (rule-based — no model involved)
# ---------------------------------------------------------------------------

def _marginal_rate(total_income: float, slabs) -> float:
    """The slab rate the next rupee of income would attract."""
    for s in slabs:
        upper = s["upto"] if s["upto"] is not None else float("inf")
        if total_income <= upper:
            return s["rate"]
    return slabs[-1]["rate"] if slabs else 0.0


def build_recommendations(
    payload: TaxProfileInput,
    heads: List[HeadSummary],
    deductions: "DeductionsSummary",
    tds: "TDSSummary",
    comparison: "RegimeComparison",
) -> List["Recommendation"]:
    """
    Turn the computed figures into ranked, actionable suggestions.

    The important subtlety: extra Chapter VI-A investment only saves tax if the
    OLD regime is, or could become, the better choice. Where the new regime
    wins by more than any realistic deduction could bridge, this says so
    plainly rather than recommending an 80C top-up that would save nothing —
    which is the usual failure mode of tools like this.
    """
    taxpayer = payload.taxpayer or TaxpayerProfile()
    recs: List[Recommendation] = []

    old, new = comparison.old, comparison.new
    old_wins = comparison.recommended_regime == "old"
    breakeven = comparison.breakeven_extra_deductions

    age_band = cfg.age_band_for(taxpayer.age or 0)
    old_slabs = cfg.get_slabs("old", age_band, taxpayer.tax_year)
    marginal = _marginal_rate(old.total_income, old_slabs)
    # Each rupee of old-regime deduction saves the marginal rate, grossed up
    # for surcharge and cess.
    relief_factor = marginal * (1 + old.surcharge_rate) * (1 + old.cess_rate)

    # ---- 1. Regime -------------------------------------------------------
    winner = old if old_wins else new
    recs.append(Recommendation(
        key="regime",
        category="regime",
        priority="high",
        title=f"Choose the {winner.label}",
        detail=comparison.summary,
        estimated_saving=comparison.saving,
        action=(
            "This is the default regime — no election is needed."
            if comparison.recommended_regime == comparison.default_regime
            else "You must opt in to this regime when filing your return."
        ),
    ))

    # ---- 2. Deduction headroom -------------------------------------------
    # Only meaningful if the old regime is in play.
    headroom_entries = [e for e in deductions.entries if e.headroom > 0 and "old" in e.regimes]
    claimed_keys = {e.key for e in deductions.entries}

    # Deductions never claimed at all still represent headroom.
    for key, d in cfg.DEDUCTIONS.items():
        if key in claimed_keys or "old" not in d["regimes"]:
            continue
        if key in ("80CCD_2", "80TTA", "80TTB", "80G", "80E", "80GG", "80DD", "80DDB", "80U", "80EEA"):
            continue  # circumstantial, not general headroom
        limit = d.get("limit")
        if limit:
            headroom_entries.append(DeductionResult(
                key=key, section=cfg.section_label(key, taxpayer.tax_year),
                label=d["label"], short_label=d.get("short_label", d["label"]),
                claimed=0.0, qualifying=0.0, limit=limit,
                regimes=d["regimes"], headroom=float(limit),
            ))

    total_headroom = _rupees(sum(e.headroom for e in headroom_entries))

    # A break-even figure is only useful if the taxpayer could actually reach it
    # with the allowances still open to them. A "you need 15,00,000 more of
    # deductions" answer is arithmetically true and practically useless, so it
    # is treated the same as unreachable.
    breakeven_reachable = breakeven is not None and breakeven <= total_headroom

    if old_wins and total_headroom > 0:
        for e in sorted(headroom_entries, key=lambda x: -x.headroom)[:4]:
            recs.append(Recommendation(
                key=f"headroom_{e.key}",
                category="deduction",
                priority="high" if e.headroom >= 50000 else "medium",
                title=f"₹{_rupees(e.headroom):,.0f} of unused {e.section} allowance",
                detail=(
                    f"You have claimed {e.claimed:,.0f} of a {e.limit:,.0f} limit. "
                    f"At your marginal rate of {marginal * 100:.0f}%, using the full "
                    f"allowance would reduce tax by about "
                    f"{_rupees(e.headroom * relief_factor):,.0f}."
                ),
                estimated_saving=_rupees(e.headroom * relief_factor),
                action=f"Consider investing up to {_rupees(e.headroom):,.0f} more before 31 March.",
                section=e.section,
            ))

    elif not old_wins and breakeven_reachable:
        # New regime wins, but the gap is genuinely bridgeable.
        recs.append(Recommendation(
            key="breakeven",
            category="deduction",
            priority="medium",
            title=f"About ₹{breakeven:,.0f} more in deductions would make the old regime competitive",
            detail=(
                f"You currently claim {old.chapter_via_deductions:,.0f}, and have "
                f"{total_headroom:,.0f} of unused allowance still open to you — enough "
                f"to close the {comparison.saving:,.0f} gap."
            ),
            action="Worth modelling if you were going to make these investments anyway.",
        ))

    elif not old_wins:
        # The case most calculators get wrong: recommending an 80C top-up that
        # would save nothing because the new regime wins regardless.
        reach = (
            f"You would need about {breakeven:,.0f} of further deductions to draw "
            f"level, against {total_headroom:,.0f} of allowance still available."
            if breakeven is not None
            else "No realistic amount of additional deduction would close that gap."
        )
        recs.append(Recommendation(
            key="no_deduction_benefit",
            category="deduction",
            priority="high",
            title="Further tax-saving investments will not reduce your tax",
            detail=(
                f"The new regime is cheaper by {comparison.saving:,.0f}. {reach} "
                f"Money put into 80C-type products now would be locked up without any "
                f"tax benefit."
            ),
            action="Choose investments on their own merits rather than for tax relief.",
        ))

    # ---- 3. HRA ----------------------------------------------------------
    salary_head = next((h for h in heads if h.head == "salary"), None)
    hra = salary_head.hra_exemption if salary_head else None

    # How much further the HRA exemption could rise on the current salary
    # structure. This is not a Chapter VI-A deduction — it reduces salary income
    # directly — so it counts toward closing an old-vs-new gap.
    hra_room = 0.0
    hra_binding = None
    if hra and hra.applicable:
        hra_binding = next((l for l in hra.limbs if l.is_binding), None)
        if hra_binding:
            others = [l.amount for l in hra.limbs if l.key != hra_binding.key]
            hra_room = _rupees(max(0.0, min(others) - hra_binding.amount)) if others else 0.0

    # Surface HRA advice when the old regime already wins, or when the combined
    # headroom (Chapter VI-A plus a larger HRA exemption) could tip it there.
    old_regime_relevant = old_wins or (
        breakeven is not None and breakeven <= _rupees(total_headroom + hra_room)
    )

    if hra and hra.applicable and old_regime_relevant:
        binding = hra_binding
        if binding and binding.key == "rent_less_10pct":
            ceiling = next((l.amount for l in hra.limbs if l.key == "percent_of_salary"), 0)
            actual = next((l.amount for l in hra.limbs if l.key == "actual_hra"), 0)
            room = _rupees(max(0.0, min(ceiling, actual) - binding.amount))
            if room > 0:
                recs.append(Recommendation(
                    key="hra_rent",
                    category="hra",
                    priority="medium",
                    title=f"Your HRA exemption is limited by rent paid — ₹{room:,.0f} of headroom",
                    detail=(
                        f"The rent limb ({binding.amount:,.0f}) is the lowest of the three. "
                        f"Each additional rupee of documented rent raises the exemption "
                        f"until it reaches {min(ceiling, actual):,.0f}."
                    ),
                    estimated_saving=_rupees(room * relief_factor),
                    action="Ensure all rent actually paid is claimed and documented.",
                    section=cfg.HRA_RULES["section_1961"],
                ))
        elif binding and binding.key == "percent_of_salary":
            recs.append(Recommendation(
                key="hra_capped",
                category="hra",
                priority="low",
                title="Your HRA exemption is already at the salary-linked ceiling",
                detail=(
                    f"The {int(hra.metro_percent_applied * 100)}% of Basic + DA limb is "
                    f"binding, so paying more rent will not increase the exemption. "
                    f"Only a higher Basic + DA would."
                ),
            ))
        elif binding and binding.key == "actual_hra":
            recs.append(Recommendation(
                key="hra_component",
                category="hra",
                priority="medium",
                title="Your HRA component is the constraint",
                detail=(
                    f"You pay enough rent to justify a larger exemption, but the HRA in "
                    f"your salary ({binding.amount:,.0f}) caps it. Restructuring pay "
                    f"toward HRA would raise the exempt amount."
                ),
                action="Raise this with your employer at the next salary structuring cycle.",
                section=cfg.HRA_RULES["section_1961"],
            ))

    if hra and not hra.applicable and hra.rent_paid > 0 and old_regime_relevant:
        limit = cfg.DEDUCTIONS["80GG"]["limit"]
        recs.append(Recommendation(
            key="80gg",
            category="hra",
            priority="medium",
            title=f"You pay rent but receive no HRA — {cfg.section_label('80GG', taxpayer.tax_year)} may apply",
            detail=(
                f"Where no HRA is received, rent paid can qualify for a deduction of up "
                f"to {limit:,.0f} a year, subject to the statutory formula."
            ),
            estimated_saving=_rupees(min(limit, hra.rent_paid) * relief_factor),
            action="Check eligibility — it is not available if you own a home in the same city.",
            section=cfg.section_label("80GG", taxpayer.tax_year),
        ))

    # ---- 4. Employer NPS --------------------------------------------------
    if payload.salary and payload.salary.enabled and not payload.salary.employer_nps:
        rules = cfg.EMPLOYER_CONTRIBUTION_RULES["nps"]
        recs.append(Recommendation(
            key="employer_nps",
            category="structure",
            priority="medium",
            title="Employer NPS is deductible under BOTH regimes",
            detail=(
                f"An employer contribution to NPS is deductible up to "
                f"{int(rules['old_regime_percent'] * 100)}% of Basic + DA under the old "
                f"regime and {int(rules['new_regime_percent'] * 100)}% under the new — "
                f"one of the very few reliefs the new regime retains."
            ),
            action="Ask your employer whether an NPS contribution can be added to your CTC.",
            section=cfg.section_label("80CCD_2", taxpayer.tax_year),
        ))

    # ---- 5. Capital gains -------------------------------------------------
    cg = payload.capital_gains or CapitalGainsIncome()
    if cg.enabled:
        exemption = cfg.CAPITAL_GAINS_RULES["ltcg_112a"]["annual_exemption"]
        used = _rupees(min(cg.ltcg_112a, exemption))
        if used < exemption:
            unused = _rupees(exemption - used)
            recs.append(Recommendation(
                key="ltcg_exemption",
                category="capital_gains",
                priority="low",
                title=f"₹{unused:,.0f} of the annual LTCG exemption is unused",
                detail=(
                    f"The first {exemption:,.0f} of long-term gains on listed equity is "
                    f"exempt each year, and the allowance does not carry forward."
                ),
                estimated_saving=_rupees(unused * cfg.CAPITAL_GAINS_RULES["ltcg_112a"]["rate"]),
                action="Realising gains up to the limit before year end uses an allowance that otherwise lapses.",
                section=cfg.CAPITAL_GAINS_RULES["ltcg_112a"]["section_1961"],
            ))

    # ---- 6. Compliance ----------------------------------------------------
    payable = winner.net_payable
    if payable > 10000:
        recs.append(Recommendation(
            key="advance_tax",
            category="compliance",
            priority="high",
            title=f"₹{payable:,.0f} still payable — advance tax may be due",
            detail=(
                "Where the balance after TDS exceeds 10,000, advance tax is payable in "
                "instalments through the year. Paying late attracts interest under "
                "S.234B and S.234C."
            ),
            action="Pay the outstanding amount before the next instalment date.",
        ))
    elif winner.is_refund and abs(payable) > 0:
        recs.append(Recommendation(
            key="refund",
            category="compliance",
            priority="medium",
            title=f"₹{abs(payable):,.0f} refund due",
            detail=(
                "Tax already deducted exceeds the computed liability. The excess is "
                "refundable once the return is filed and processed."
            ),
            action="File your return to claim it.",
        ))

    if tds.total_prepaid > 0:
        recs.append(Recommendation(
            key="reconcile_26as",
            category="compliance",
            priority="medium",
            title="Reconcile TDS against Form 26AS / AIS",
            detail=(
                f"You have recorded {tds.total_prepaid:,.0f} of tax already paid. Credit "
                f"is allowed only for amounts actually reflected in the department's "
                f"records."
            ),
            action="Download Form 26AS and the AIS before filing and match each entry.",
        ))

    # ---- 7. Salary structure ---------------------------------------------
    if payload.salary and payload.salary.enabled and not payload.salary.use_simple_mode:
        pct_basic_da = (payload.salary.basic_percent_of_ctc or 0) + (payload.salary.da_percent_of_ctc or 0)
        if 0 < pct_basic_da < 50:
            recs.append(Recommendation(
                key="basic_da_floor",
                category="structure",
                priority="low",
                title=f"Basic + DA is {pct_basic_da:.0f}% of CTC",
                detail=(
                    "The Labour Codes expect wages (Basic + DA) to be at least 50% of "
                    "total remuneration. A higher Basic also raises the HRA and employer "
                    "NPS ceilings, both of which are computed on it."
                ),
                action="Worth reviewing with your employer.",
            ))

    # Rank: priority first, then rupee impact.
    order = {"high": 0, "medium": 1, "low": 2}
    recs.sort(key=lambda r: (order.get(r.priority, 3), -(r.estimated_saving or 0)))
    return recs


# ---------------------------------------------------------------------------
# ITR form selection
# ---------------------------------------------------------------------------

def select_itr_form(
    payload: TaxProfileInput,
    heads: List[HeadSummary],
    comparison: Optional["RegimeComparison"],
) -> "ITRFormRecommendation":
    """
    Suggest the applicable return form from the heads of income present.

    Forms are evaluated in the configured order (simplest first); the first one
    whose disqualifiers are all absent wins. The forms that were ruled out are
    reported with the reason, since knowing why ITR-1 is unavailable is usually
    more useful than the answer itself.
    """
    taxpayer = payload.taxpayer or TaxpayerProfile()
    cg = payload.capital_gains or CapitalGainsIncome()
    hp = payload.house_property or HousePropertyIncome()
    pgbp = payload.pgbp or PGBPIncome()

    total_income = comparison.old.total_income if comparison else 0.0
    if comparison:
        total_income = max(comparison.old.total_income, comparison.new.total_income)

    property_count = len([p for p in (hp.properties or [])]) if hp.enabled else 0
    ltcg_112a = _rupees(cg.ltcg_112a) if cg.enabled else 0.0
    other_gains = _rupees(cg.stcg_111a + cg.stcg_other + cg.ltcg_other) if cg.enabled else 0.0
    small_112a_cap = cfg.CAPITAL_GAINS_RULES["ltcg_112a"]["annual_exemption"]

    presumptive_only = bool(
        pgbp.enabled and pgbp.presumptive.enabled and not pgbp.regular.enabled
    )
    has_business = bool(pgbp.enabled and (pgbp.presumptive.enabled or pgbp.regular.enabled))

    # Facts each disqualifier tests against.
    facts = {
        "business_income": has_business,
        "capital_gains_other_than_small_112a": bool(
            other_gains > 0 or ltcg_112a > small_112a_cap
        ),
        "more_than_one_house_property": property_count > 1,
        "foreign_income": bool(taxpayer.has_foreign_income),
        "foreign_assets": bool(taxpayer.has_foreign_assets),
        "is_director": bool(taxpayer.is_director),
        "unlisted_shares": bool(taxpayer.holds_unlisted_shares),
        "agricultural_income_above_5000": _rupees(taxpayer.agricultural_income) > 5000,
    }
    reason_text = {
        "business_income": "you have income from business or profession",
        "capital_gains_other_than_small_112a": (
            f"you have capital gains beyond long-term equity gains of {small_112a_cap:,.0f}"
        ),
        "more_than_one_house_property": f"you have {property_count} house properties",
        "foreign_income": "you have foreign income",
        "foreign_assets": "you hold foreign assets",
        "is_director": "you are a company director",
        "unlisted_shares": "you hold unlisted shares",
        "agricultural_income_above_5000": "your agricultural income exceeds 5,000",
    }

    ruled_out: List[ITRRuledOut] = []
    warnings: List[str] = []

    for key in cfg.ITR_EVALUATION_ORDER:
        form = cfg.ITR_FORMS[key]
        blockers = [d for d in form.get("disqualifiers", []) if facts.get(d)]

        cap = form.get("eligible_when", {}).get("total_income_upto")
        if cap and total_income > cap:
            blockers.append(f"total income exceeds {cap:,.0f}")

        if form.get("eligible_when", {}).get("presumptive_only") and not presumptive_only:
            blockers.append(
                "your business income is not declared wholly under a presumptive scheme"
            )

        if blockers:
            readable = [reason_text.get(b, b) for b in blockers]
            ruled_out.append(ITRRuledOut(
                form=form["name"],
                reason="; ".join(readable),
            ))
            continue

        # First form that survives wins.
        reasons: List[str] = []
        active = [h.head for h in heads if h.gross or h.net]
        label = {
            "salary": "salary income",
            "house_property": "house property income",
            "pgbp": "business or professional income",
            "capital_gains": "capital gains",
            "other_sources": "income from other sources",
        }
        for h in active:
            reasons.append(f"You have {label.get(h, h)}.")
        if key == "ITR-4" and presumptive_only:
            scheme = pgbp.presumptive.scheme
            reasons.append(f"Business income is declared under the presumptive scheme {scheme}.")
        if key == "ITR-1" and ltcg_112a:
            reasons.append(
                f"Long-term equity gains of {ltcg_112a:,.0f} are within the "
                f"{small_112a_cap:,.0f} that ITR-1 now permits."
            )

        if not active:
            warnings.append("No income has been entered yet, so this is provisional.")

        warnings.append(
            "Form applicability depends on facts beyond the figures entered here. "
            "Confirm before filing."
        )

        return ITRFormRecommendation(
            form=key,
            name=form["name"],
            description=form["description"],
            reasons=reasons,
            ruled_out=ruled_out,
            warnings=warnings,
        )

    # Nothing matched — ITR-3 is the broadest form for an individual.
    fallback = cfg.ITR_FORMS["ITR-3"]
    return ITRFormRecommendation(
        form="ITR-3",
        name=fallback["name"],
        description=fallback["description"],
        reasons=["Selected as the broadest form available to an individual."],
        ruled_out=ruled_out,
        warnings=["Confirm applicability with a tax professional before filing."],
    )


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def collect_income(payload: TaxProfileInput) -> IncomeCollectionResponse:
    """
    STEP 1 entry point — aggregate every head into a single summary.

    Returns gross total income before Chapter VI-A deductions and before any
    tax computation, plus the set of active heads that Step 6 will use to
    recommend an ITR form.
    """
    taxpayer = payload.taxpayer or TaxpayerProfile()
    year_cfg = cfg.get_year_config(taxpayer.tax_year)
    labels = year_cfg["labels"]

    heads = [
        build_salary_head(payload.salary, taxpayer),
        build_house_property_head(payload.house_property, taxpayer),
        build_pgbp_head(payload.pgbp, taxpayer),
        build_capital_gains_head(payload.capital_gains, taxpayer),
        build_other_sources_head(payload.other_sources, taxpayer),
    ]

    active = [h.head for h in heads if h.gross or h.net or h.line_items]

    gross_total = _rupees(sum(h.net for h in heads))
    total_tds = _rupees(sum(h.tds for h in heads))

    warnings: List[str] = []
    for h in heads:
        warnings.extend(h.warnings)

    if taxpayer.agricultural_income and taxpayer.agricultural_income > 5000:
        warnings.append(
            "Agricultural income above 5,000 is exempt but is aggregated for "
            "rate purposes and rules out ITR-1 / ITR-4."
        )

    # Step 3: deductions and taxes already paid. Deductions are reported, not
    # netted off — the regime engine applies the right total in Step 4.
    salary_head = next((h for h in heads if h.head == "salary"), HeadSummary(head="salary", label="Salary"))
    deductions = compute_deductions(payload, gross_total, salary_head)
    tds = compute_tds_summary(payload, heads)
    warnings.extend(deductions.warnings)

    # Step 4: compute both regimes and compare. Skipped when there is no income
    # to tax, so an empty form doesn't render a page of zeros.
    comparison = None
    recommendations: List[Recommendation] = []
    if gross_total > 0:
        comparison = compare_regimes(payload, heads, deductions, tds)
        # Step 5: rule-based suggestions off the computed figures.
        recommendations = build_recommendations(payload, heads, deductions, tds, comparison)

    # Step 6: which return form the entered heads point to.
    itr_form = select_itr_form(payload, heads, comparison) if active else None

    return IncomeCollectionResponse(
        tax_year=taxpayer.tax_year or cfg.DEFAULT_TAX_YEAR,
        tax_year_label=f"{labels['fy']} ({labels['ay']})",
        governing_act=labels["act"],
        heads=heads,
        gross_total_income=gross_total,
        total_tds=total_tds,
        active_heads=active,
        warnings=warnings,
        disclaimer=DISCLAIMER,
        deductions=deductions,
        tds=tds,
        comparison=comparison,
        recommendations=recommendations,
        itr_form=itr_form,
    )
