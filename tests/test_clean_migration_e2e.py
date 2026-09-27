import openpyxl
import io
import os
import sys
import requests
import uuid

BASE_URL = os.getenv("E2E_BASE_URL", "http://127.0.0.1:8000")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests._live_server import require_live_server_optin  # noqa: E402


def test_clean_migration_e2e():
    if not require_live_server_optin(BASE_URL):
        return

    print("=== STARTING CLEAN MIGRATED DATABASE E2E TEST ===")

    # 1. Register as Individual User
    uname = f"clean_test_{uuid.uuid4().hex[:6]}@zenith.com"
    pwd = "Password123!"
    print(f"\n1. Registering user {uname}...")
    reg_res = requests.post(f"{BASE_URL}/auth/register", json={
        "username": uname,
        "password": pwd
    })
    assert reg_res.status_code == 200, f"Registration failed: {reg_res.text}"
    token = reg_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    print("Registration successful, token obtained.")

    # 2. Complete Individual Onboarding with expanded fields
    print("\n2. Submitting Individual Onboarding...")
    onboard_payload = {
        "full_name": "Jane Doe",
        "email": uname,
        "mobile": "+91 98765 43210",
        "occupation": "Financial Analyst",
        "monthly_income": 120000.0,
        "total_savings": 500000.0,
        "monthly_expenses": 45000.0,
        "outstanding_loans": 150000.0,
        "existing_investments": 200000.0,
        "insurance_coverage": 1000000.0,
        "dependents": 2,
        "goal_title": "Buy a House in 5 Years",
        "goal_target_amount": 5000000.0
    }
    onboard_res = requests.post(f"{BASE_URL}/onboard/confirm", headers=headers, json=onboard_payload)
    assert onboard_res.status_code == 200, f"Onboarding failed: {onboard_res.text}"
    print("Individual onboarding confirmed.")

    # 3. Verify GET /profile/me returns individual raw_inputs & metrics
    print("\n3. Fetching /profile/me...")
    prof_res = requests.get(f"{BASE_URL}/profile/me", headers=headers)
    assert prof_res.status_code == 200, f"Get profile failed: {prof_res.text}"
    prof_data = prof_res.json()
    assert prof_data["key"] == "individual"
    assert prof_data["details"]["full_name"] == "Jane Doe"
    assert prof_data["details"]["monthly_income"] == 120000.0
    print("Profile data verified:", prof_data["details"])

    # 4. Test Live Dashboard Edit via PUT /onboard/individual/update
    print("\n4. Editing Individual Profile via PUT endpoint...")
    edit_payload = {
        "full_name": "Jane Smith Doe",
        "email": uname,
        "mobile": "+91 98765 43210",
        "occupation": "Senior Financial Analyst",
        "monthly_income": 135000.0,
        "total_savings": 550000.0,
        "monthly_expenses": 48000.0,
        "outstanding_loans": 140000.0,
        "existing_investments": 250000.0,
        "insurance_coverage": 1200000.0,
        "dependents": 2,
        "goal_title": "Buy a House in 5 Years",
        "goal_target_amount": 5000000.0
    }
    edit_res = requests.put(f"{BASE_URL}/onboard/individual/update", headers=headers, json=edit_payload)
    assert edit_res.status_code == 200, f"Edit failed: {edit_res.text}"
    print("Profile edited successfully.")

    # 5. Download Dynamic Excel Template
    print("\n5. Downloading Individual Excel Template...")
    template_res = requests.get(f"{BASE_URL}/onboard/excel/template?persona=individual")
    assert template_res.status_code == 200, f"Template download failed: {template_res.text}"
    wb = openpyxl.load_workbook(io.BytesIO(template_res.content))
    sheet = wb.active
    headers_list = [cell.value for cell in sheet[1]]
    print(f"Downloaded Excel headers ({len(headers_list)} fields):", headers_list)

    # 6. Upload Excel File with updated values
    print("\n6. Uploading Excel with Updated Financial Values...")
    wb_up = openpyxl.Workbook()
    ws_up = wb_up.active
    ws_up.append(["monthly_income", "total_savings", "occupation"])
    ws_up.append([150000.0, 600000.0, "Lead Analyst"])

    buf = io.BytesIO()
    wb_up.save(buf)
    buf.seek(0)

    upload_res = requests.post(
        f"{BASE_URL}/onboard/excel/upload",
        headers=headers,
        files={"file": ("individual_update.xlsx", buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    )
    assert upload_res.status_code == 200, f"Upload failed: {upload_res.text}"
    upload_data = upload_res.json()
    print("Upload response:", upload_data)
    assert upload_data["updated_count"] == 3

    # 7. Final Verification via GET /profile/me
    print("\n7. Final Verification of Updated Profile...")
    final_res = requests.get(f"{BASE_URL}/profile/me", headers=headers)
    assert final_res.status_code == 200
    final_details = final_res.json()["details"]
    print("Final Details:", final_details)
    assert final_details["monthly_income"] == 150000.0
    assert final_details["total_savings"] == 600000.0
    assert final_details["occupation"] == "Lead Analyst"
    assert final_details["full_name"] == "Jane Smith Doe" # Preserved from previous edit!

    print("\n==================================================")
    print("🎉 ALL CLEAN DATABASE E2E TESTS PASSED PERFECTLY!")
    print("==================================================")

if __name__ == "__main__":
    test_clean_migration_e2e()
