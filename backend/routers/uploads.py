"""
Uploads router — handles file uploads for bank statement parsing.

POST /upload/statement — accepts a PDF bank statement, parses it with Gemini,
                          and logs all found transactions to Hisaab.
"""
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from backend.database import SessionLocal
from backend.models.domain import Profile
from backend.core.auth import get_current_user
from backend.services.pdf_parser_service import (
    parse_transactions_from_pdf, pdf_extraction_available,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/upload", tags=["Uploads"])

MAX_PDF_BYTES = 10 * 1024 * 1024  # 10 MB


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/statement")
async def upload_statement(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Upload a PDF bank statement. All transactions found are automatically
    parsed by AI and added to Hisaab. Duplicates are skipped safely."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content = await file.read()
    if len(content) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 10 MB.")
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")

    # Checked before the work starts. Without this the missing-library case fell
    # through into the generic `errors` list and still returned status "ok" with
    # a cheerful "Found 0 transactions" — a button that reports success and
    # imports nothing is worse than a button that is not there.
    if not pdf_extraction_available():
        raise HTTPException(
            status_code=503,
            detail=(
                "Statement import is unavailable on this server: no PDF reader is "
                "installed. Ask an administrator to install pymupdf."
            ),
        )

    result = parse_transactions_from_pdf(content, profile.id, db)

    # An import that read the file but produced nothing is not a success.
    # "ok" now means rows were added; "empty" and "failed" are distinguishable
    # by the client so it can say something true.
    errors = result.get("errors") or []
    if result.get("added"):
        status_value = "ok"
        message = (
            f"Found {result['parsed']} transactions — "
            f"added {result['added']} new, skipped {result['skipped_duplicates']} duplicates."
        )
    elif result.get("parsed") and result.get("skipped_duplicates"):
        status_value = "duplicate"
        message = (
            f"Found {result['parsed']} transactions, but all of them were already "
            "in your ledger. Nothing new was added."
        )
    elif errors:
        status_value = "failed"
        message = (
            "Could not read any transactions from that statement. "
            + str(errors[0])
        )
    else:
        status_value = "empty"
        message = (
            "No transactions could be read from that PDF. It may be a scanned "
            "image rather than a text statement, or password protected."
        )

    return {
        "status": status_value,
        "filename": file.filename,
        **result,
        "message": message,
    }
