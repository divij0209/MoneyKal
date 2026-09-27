"""
Request and response models for the Startup GST Calculator.

Mirrors the shape of `schemas/tax_models.py`: a permissive input model that the
UI can post on every keystroke, and a fully-typed output model so the response
contract is explicit rather than a bare dict.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from backend.core.config import gst_config as cfg


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

class GSTLineInput(BaseModel):
    """One line of an invoice.

    `amount` is a unit value; `quantity` extends it. A line is reverse-charge
    when the recipient bears the tax — the supplier raises the line at value
    only and collects nothing.
    """
    description: Optional[str] = None
    amount: float = 0.0
    quantity: float = 1.0
    rate: float = cfg.DEFAULT_RATE
    cess_rate: float = 0.0
    discount: float = 0.0
    reverse_charge: bool = False
    hsn_sac: Optional[str] = None


class GSTCalculateRequest(BaseModel):
    mode: str = "exclusive"                 # exclusive (add) | inclusive (reverse)
    supply_type: str = "intra_state"        # intra_state | inter_state
    rate_structure: Optional[str] = None    # gst_2_0 | pre_gst_2_0

    #: Invoice date, YYYY-MM-DD. When given, it decides which rate structure was
    #: in force; an explicit `rate_structure` that contradicts it is kept but
    #: flagged, so the caller's choice is never silently overridden.
    invoice_date: Optional[str] = None
    lines: List[GSTLineInput] = Field(default_factory=list)

    #: Input tax credit available for the period. Netted off output tax to give
    #: the figure the founder actually pays.
    input_tax_credit: float = 0.0

    #: Optional composition comparison. When a category key is supplied the
    #: response carries a side-by-side of regular versus composition.
    composition_category: Optional[str] = None

    #: Annual turnover, used for the composition eligibility check and the
    #: registration-threshold check. Falls back to the invoice value.
    annual_turnover: Optional[float] = None
    business_type: str = "services"         # services | goods
    special_category_state: bool = False

    #: Optional GSTIN to decode and check alongside the calculation.
    gstin: Optional[str] = None


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

class GSTLineResult(BaseModel):
    description: Optional[str] = None
    hsn_sac: Optional[str] = None
    quantity: float
    rate: float
    cess_rate: float
    gross: float
    discount: float
    taxable_value: float
    cgst: float
    sgst: float
    igst: float
    cess: float
    total_tax: float
    total: float
    reverse_charge: bool
    note: Optional[str] = None


class GSTRateSlabSummary(BaseModel):
    """Rate-wise totals, the block that appears at the foot of a tax invoice."""
    rate: float
    taxable_value: float
    cgst: float
    sgst: float
    igst: float
    cess: float
    total_tax: float


class GSTTotals(BaseModel):
    gross: float
    discount: float
    taxable_value: float
    cgst: float
    sgst: float
    igst: float
    cess: float
    total_tax: float
    total: float
    rounded_total: float
    rounding_adjustment: float
    reverse_charge_taxable: float
    reverse_charge_tax: float
    #: "recipient" when the RCM lines are on your outward invoice (your customer
    #: pays), "you" for an inward supply such as import of services.
    reverse_charge_payable_by: str = "recipient"
    reverse_charge_label: str = ""


class GSTNetPosition(BaseModel):
    output_tax: float
    input_tax_credit: float
    reverse_charge_payable: float
    net_payable: float
    credit_carried_forward: float
    note: str


class CompositionComparison(BaseModel):
    eligible: bool
    category: str
    label: str
    rate: float
    split: str
    turnover_limit: float
    turnover_used: float
    composition_tax: float
    regular_tax: float
    difference: float
    cheaper: str
    restrictions: List[str]
    note: str
    #: How the two figures were made comparable — states the scaling, if any.
    basis: str


class RegistrationCheck(BaseModel):
    business_type: str
    turnover: float
    threshold: float
    required: bool
    message: str


class SupplyTypeDetail(BaseModel):
    """What the chosen supply type means, surfaced so the choice explains itself."""
    key: str
    label: str
    group: str
    description: str
    taxable: bool
    zero_rated: bool
    credit_allowed: bool
    note: str = ""


class ApplicabilityRule(BaseModel):
    id: str
    label: str
    applies: bool
    threshold: float
    sticky: bool
    message: str
    detail: str


class ApplicabilityResult(BaseModel):
    turnover: Optional[float] = None
    status: str
    rules: List[ApplicabilityRule] = Field(default_factory=list)
    eway_bill: Dict[str, Any] = Field(default_factory=dict)
    note: str


class GSTINCheck(BaseModel):
    input: Optional[str] = None
    valid: bool
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    state_code: Optional[str] = None
    state: Optional[str] = None
    pan: Optional[str] = None
    entity_type: Optional[str] = None
    registration_number: Optional[str] = None
    default_char: Optional[str] = None
    check_digit: Optional[str] = None
    expected_check_digit: Optional[str] = None
    special_category_state: bool = False
    note: str = ""


class GSTProfileSave(BaseModel):
    """Persisted working set for one financial year."""
    fy: Optional[str] = None
    request: GSTCalculateRequest


class GSTCalculateResponse(BaseModel):
    mode: str
    mode_label: str
    supply_type: str
    supply_type_label: str
    rate_structure: str
    rate_structure_label: str
    #: Why this structure was used: "explicit", "invoice_date" or "default".
    rate_structure_basis: str = "default"
    invoice_date: Optional[str] = None
    currency: str
    lines: List[GSTLineResult]
    rate_summary: List[GSTRateSlabSummary]
    totals: GSTTotals
    net_position: GSTNetPosition
    composition: Optional[CompositionComparison] = None
    registration: Optional[RegistrationCheck] = None
    supply_detail: Optional[SupplyTypeDetail] = None
    applicability: Optional[ApplicabilityResult] = None
    gstin_check: Optional[GSTINCheck] = None
    formula: str
    rounding_note: str
    warnings: List[str]
    disclaimer: str
