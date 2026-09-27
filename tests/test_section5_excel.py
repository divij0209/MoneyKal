import openpyxl
import io
import os
import sys
import requests
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests._live_server import require_live_server_optin  # noqa: E402

BASE_URL = os.getenv("E2E_BASE_URL", "http://127.0.0.1:8000")

def test_excel_features():
    if not require_live_server_optin(BASE_URL):
        return
    print("--- 1. Testing Dynamic Excel Template Downloads ---")
    for persona in ["individual", "enterprise", "startup"]:
        res = requests.get(f"{BASE_URL}/onboard/excel/template?persona={persona}")
        assert res.status_code == 200, f"Template download failed for {persona}"
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        sheet = wb.active
        headers = [cell.value for cell in sheet[1]]
        print(f"[{persona.upper()}] Excel headers ({len(headers)} fields):", headers[:5], "...")

    print("\n--- 2. Registering & Logging In a Test User ---")
    uname = f"excel_test_{uuid.uuid4().hex[:6]}@zenith.com"
    pwd = "Password123!"
    reg_res = requests.post(f"{BASE_URL}/auth/register", json={
        "username": uname,
        "password": pwd
    })
    assert reg_res.status_code == 200, f"Registration failed: {reg_res.text}"

    token = reg_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    print(f"Registered user {uname}, token obtained.")

    # Enterprise onboarding is retired (backend/routers/onboarding.py). The route
    # is kept as an explicit 410 Gone so a stale client learns the endpoint no
    # longer exists, rather than getting a 404 or silently creating a profile
    # that auth.py would then refuse to sign in.
    init_res = requests.post(f"{BASE_URL}/onboard/enterprise", headers=headers, json={
        "org_name": "Test Excel Corp",
        "gst_number": "27AAAAA0000A1Z5",
        "treasury_balance": 100.0,
        "annual_turnover": 500.0,
        "quarterly_cash_flow": 50.0,
        "fx_exposure_pct": 10.0
    })
    assert init_res.status_code == 410, (
        f"Expected 410 Gone for retired Enterprise onboarding, got {init_res.status_code}: {init_res.text}")
    assert "retired" in init_res.json().get("detail", "").lower(), init_res.text
    print("Retired Enterprise onboarding correctly answers 410 Gone.")

    # The Excel upload and /profile/me sync checks that used to follow ran
    # against the Enterprise profile created above, which can no longer exist.
    # Excel upload for a live persona is covered by test_clean_migration_e2e.py.

    print("\nALL EXCEL TESTS PASSED SUCCESSFULLY! 🎉")

if __name__ == "__main__":
    test_excel_features()
