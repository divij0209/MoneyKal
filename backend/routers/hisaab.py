import os
import json
import logging
from io import BytesIO
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from PIL import Image, ExifTags
from dotenv import load_dotenv

from backend.core.auth import get_current_user
from backend.models.domain import User

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'), override=True)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hisaab", tags=["hisaab"])

def process_image(file_bytes: bytes) -> bytes:
    try:
        img = Image.open(BytesIO(file_bytes))
        
        # fix orientation
        try:
            for orientation in ExifTags.TAGS.keys():
                if ExifTags.TAGS[orientation] == 'Orientation':
                    break
            exif = dict(img._getexif().items())
            if exif[orientation] == 3:
                img = img.rotate(180, expand=True)
            elif exif[orientation] == 6:
                img = img.rotate(270, expand=True)
            elif exif[orientation] == 8:
                img = img.rotate(90, expand=True)
        except Exception:
            pass

        # convert to RGB
        if img.mode != "RGB":
            img = img.convert("RGB")

        # downscale longest side to <=1024px
        max_size = 1024
        if max(img.size) > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        
        out_io = BytesIO()
        img.save(out_io, format="JPEG")
        return out_io.getvalue()
    except Exception as e:
        logger.error(f"Image processing failed: {e}")
        raise ValueError("Invalid or unreadable image.")

@router.post("/scan-receipt")
async def scan_receipt(
    file: UploadFile = File(...),
    # This route was open to anyone who could reach the host, which meant an
    # unauthenticated caller could spend the project's Gemini vision quota.
    # The web client has always sent the Authorization header here (see
    # twin-app/js/api.js scanReceipt), so requiring it changes nothing for it.
    current_user: User = Depends(get_current_user),
):
    if not file:
        raise HTTPException(status_code=400, detail="No file uploaded.")
    
    file_bytes = await file.read()
    try:
        processed_bytes = process_image(file_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
        
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Gemini API key not configured.")
        
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=api_key)
    except Exception as e:
        logger.error(f"Failed to initialize Gemini client: {e}")
        raise HTTPException(status_code=500, detail="Failed to initialize AI client.")
        
    prompt = """Analyze this receipt. Return strict JSON only, no markdown, no prose.
Shape: {"merchant": string, "date": string (YYYY-MM-DD), "items": [{"name": string, "amount": number}], "tax_amount": number, "total": number, "category": string}
Category MUST be exactly one of: Salary, Freelance / Business, Investment Return, Revenue, Funding, Refund, Gift, Interest income, Other income, Rent / Housing, Groceries, Food & Dining, Utilities & Bills, Shopping, Entertainment, Travel & Transport, Health & Medical, Subscriptions, Payroll, Software/Tools, Marketing, Supplies, Professional fees, Taxes, Other expense.
If a field is missing, omit it or return null.
CRITICAL RULES FOR TOTAL:
- If the receipt has an explicit final total, use that for 'total'.
- If the receipt lacks a final total but lists items and a tax rate (e.g. VAT 12.5%), you MUST compute the tax amount, compute the sum of items, and provide the computed sum + tax as the 'total'. Also provide the computed or explicitly stated tax in 'tax_amount'.
"""
    try:
        response = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-1.5-flash"),
            contents=[
                types.Content(role="user", parts=[
                    types.Part.from_bytes(data=processed_bytes, mime_type="image/jpeg"),
                    types.Part.from_text(text=prompt)
                ])
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.1
            )
        )
        text = response.text
        if not text:
            raise ValueError("Empty response from AI.")
        
        import re
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                data = json.loads(match.group(0))
            else:
                raise ValueError("Failed to parse AI response as JSON.")
                
        return data
        
    except Exception as e:
        logger.error(f"Gemini processing failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to analyze receipt.")
