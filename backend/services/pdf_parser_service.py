"""
PDF statement parser — extracts transactions from a bank statement PDF.

The flow:
  1. FastAPI receives a multipart PDF upload.
  2. PyMuPDF extracts all text from every page.
  3. The text is sent to Gemini with a structured extraction prompt.
  4. Gemini returns a JSON list of transactions.
  5. Each transaction is deduplicated (by date+amount+description) and saved.
  6. A summary is returned: { parsed, added, skipped_duplicates }.
"""
import io
import logging
import json
import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.services.gemini_service import gemini_service

logger = logging.getLogger(__name__)

PARSE_STATEMENT_PROMPT = """You are a bank statement parser. I will give you raw text extracted from a bank statement PDF.
Your task is to identify every individual transaction and return them as a JSON array.

For each transaction, extract:
- date: the transaction date in "YYYY-MM-DD" format (use today's year if only day/month is shown)
- description: merchant name or transaction description (clean, concise, max 80 chars)
- amount: the transaction amount as a positive number (no currency symbols)
- type: "out" for debits/withdrawals/purchases, "in" for credits/deposits/refunds
- category: one of [Food & Dining, Transport, Shopping, Entertainment, Utilities, Healthcare, Education, Travel, Subscriptions, Other]

Rules:
- Skip balance rows, opening/closing balance, and summary rows.
- If a row is ambiguous, skip it.
- Return ONLY a valid JSON array. No explanation. No markdown.

Example output:
[
  {"date": "2026-09-01", "description": "Swiggy Order", "amount": 350.0, "type": "out", "category": "Food & Dining"},
  {"date": "2026-09-03", "description": "Salary Credit", "amount": 55000.0, "type": "in", "category": "Other"}
]

Bank statement text:
"""


class PdfExtractionUnavailable(RuntimeError):
    """No PDF text extractor is installed.

    Distinct from "this PDF could not be read" because the two need opposite
    responses: a broken file is the user's problem and a missing library is
    ours, and reporting the second as the first is what let a completely
    non-functional import return `{"status": "ok"}`.
    """


def pdf_extraction_available() -> bool:
    """Whether this deployment can read a PDF at all.

    Called by the upload route so the API can advertise the capability instead
    of discovering it is missing halfway through a request.
    """
    try:
        import fitz  # noqa: F401  PyMuPDF
        return True
    except ImportError:
        pass
    try:
        import PyPDF2  # noqa: F401
        return True
    except ImportError:
        return False


def parse_pdf_bytes(pdf_bytes: bytes) -> str:
    """Extract all text from a PDF.

    PyMuPDF first because it is markedly better on the multi-column layouts
    Indian bank statements use. PyPDF2 is the fallback: it is already a declared
    dependency, so a machine without PyMuPDF degrades to a worse extraction
    rather than to no feature at all. Both missing raises, and the caller turns
    that into a real error rather than a success with zero rows.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        fitz = None

    if fitz is not None:
        text_parts = []
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            for page in doc:
                text_parts.append(page.get_text())
        return "\n".join(text_parts)

    try:
        import PyPDF2
    except ImportError:
        raise PdfExtractionUnavailable(
            "No PDF reader is installed on the server. Install pymupdf "
            "(pip install pymupdf) to enable statement import."
        )

    reader = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def parse_transactions_from_pdf(pdf_bytes: bytes, profile_id: int, db: Session) -> Dict[str, Any]:
    """Parse a bank statement PDF and save all found transactions.

    Returns a summary dict: { parsed, added, skipped_duplicates, errors }
    """
    from backend.models.domain import StartupTransaction

    # Step 1: Extract text
    try:
        raw_text = parse_pdf_bytes(pdf_bytes)
    except Exception as e:
        logger.error(f"PDF text extraction failed: {e}")
        return {"parsed": 0, "added": 0, "skipped_duplicates": 0, "errors": [str(e)]}

    if not raw_text.strip():
        return {"parsed": 0, "added": 0, "skipped_duplicates": 0, "errors": ["PDF appears to be empty or image-only"]}

    # Limit text to avoid token overflow (~10,000 chars is plenty for most statements)
    truncated = raw_text[:10000]

    # Step 2: Send to Gemini
    try:
        prompt = PARSE_STATEMENT_PROMPT + truncated
        raw_json = gemini_service.generate(
            prompt,
            json_mode=True,
            temperature=0.1,
            max_output_tokens=4096,
        )
        transactions = json.loads(raw_json)
        if not isinstance(transactions, list):
            transactions = []
    except Exception as e:
        logger.error(f"Gemini PDF parsing failed: {e}")
        return {"parsed": 0, "added": 0, "skipped_duplicates": 0, "errors": [f"AI parsing failed: {e}"]}

    # Step 3: Deduplicate and save
    added = 0
    skipped = 0
    errors = []

    for txn_data in transactions:
        try:
            txn_date_str = txn_data.get("date", "")
            txn_date = date.fromisoformat(txn_date_str[:10])
            amount = float(txn_data.get("amount", 0))
            description = str(txn_data.get("description", ""))[:120]
            txn_type = txn_data.get("type", "out")
            category = txn_data.get("category", "Other")

            if amount <= 0 or not description:
                skipped += 1
                continue

            # Dedup: skip if a transaction with same date+amount+description already exists
            existing = db.query(StartupTransaction).filter(
                StartupTransaction.profile_id == profile_id,
                StartupTransaction.txn_date == txn_date,
                StartupTransaction.amount == amount,
                StartupTransaction.description == description,
            ).first()

            if existing:
                skipped += 1
                continue

            txn = StartupTransaction(
                profile_id=profile_id,
                txn_date=txn_date,
                type=txn_type if txn_type in ("in", "out") else "out",
                amount=amount,
                category=category,
                description=description,
                source="pdf_import",
            )
            db.add(txn)
            added += 1

        except Exception as e:
            logger.warning(f"Skipping malformed transaction row: {e} — data: {txn_data}")
            errors.append(str(e))

    if added > 0:
        db.commit()

    return {
        "parsed": len(transactions),
        "added": added,
        "skipped_duplicates": skipped,
        "errors": errors[:5],  # cap error list
    }
