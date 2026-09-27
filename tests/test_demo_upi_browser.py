"""
The demo UPI checkout — browser test.

Drives the real Plans & Billing page in headless Chrome, from "Extend ACT" to
the success screen, and then reads the account back through the API to check
the database really moved. The point of this suite is that the ten seconds of
payment theatre sit on top of a real purchase: the QR the user is shown carries
the amount the order charges, the success screen appears only after the server
has confirmed, and the plan afterwards is a plan the backend agrees with.

Also checks what the checkout no longer offers: card and net banking are gone,
and the only method on screen is UPI QR.

This suite registers accounts and buys plans, so it writes to whatever database
the server it talks to was started with — see tests/_live_server.py. It refuses
to run until you say that server is disposable.

Start both against a throwaway database, then run it:

  DATABASE_URL=sqlite:///./demo_upi_e2e.db python -m uvicorn backend.main:app --port 8001
  python -m http.server 8081 --directory twin-app
  E2E_ALLOW_LIVE_SERVER=true MK_API=http://127.0.0.1:8001 \\
    MK_SITE=http://127.0.0.1:8081 python tests/test_demo_upi_browser.py

MK_API is handed to the page as window.__API_BASE before any of its own
scripts run, so the real dashboard.html is driven unmodified even when the
backend is not on its default port.

Registration is rate limited to 10 accounts an hour per IP, and one run uses
two. Restart the API to clear that window if you are iterating on this file.
"""
import json
import os
import sys
import time
import uuid

import requests
from selenium import webdriver
from selenium.common.exceptions import (
    ElementClickInterceptedException, NoSuchElementException, StaleElementReferenceException)
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests._live_server import require_live_server_optin  # noqa: E402

API = os.getenv("MK_API", "http://127.0.0.1:8000").rstrip("/")
SITE = os.getenv("MK_SITE", "http://127.0.0.1:8080").rstrip("/")
PASSWORD = "Password123!"

PASSED = 0
FAILED = []


def check(label, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}" + (f"   -> {detail}" if detail else ""))


def section(name):
    print(f"\n{'=' * 70}\n{name}\n{'=' * 70}")


def console_errors(driver):
    out = []
    for entry in driver.get_log("browser"):
        if entry["level"] != "SEVERE":
            continue
        # favicon 404s are noise from python -m http.server. A 402 is the
        # billing gate answering a free account as designed — the page handles
        # it and shows an upgrade prompt; Chrome logs every non-2xx fetch.
        if "favicon" in entry["message"] or "402 (Payment Required)" in entry["message"]:
            continue
        out.append(entry["message"])
    return out


def register():
    """A signed-in Individual account with onboarding done, as the app expects."""
    email = f"upi_{uuid.uuid4().hex[:10]}@moneykal.test"
    res = requests.post(f"{API}/auth/register", json={"username": email, "password": PASSWORD}, timeout=30)
    res.raise_for_status()
    body = res.json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    res = requests.post(f"{API}/onboard/confirm", headers=headers, timeout=60, json={
        "full_name": "Demo Tester",
        "email": email,
        "occupation": "Engineer",
        "city": "Mumbai",
        "monthly_income": 120000,
        "total_savings": 400000,
        "monthly_expenses": 60000,
        "outstanding_loans": 0,
    })
    res.raise_for_status()
    return body, headers


def sign_in(driver, body):
    """Put the session the app expects into localStorage and open Billing."""
    driver.get(f"{SITE}/dashboard.html")
    driver.execute_script(
        "localStorage.clear();"
        "localStorage.setItem('twin_session', arguments[0]);"
        "localStorage.setItem('twin_pin_device', '1');",
        json.dumps({"token": body["access_token"], "user_id": body["user_id"],
                    "username": body.get("username", "")}),
    )
    driver.get(f"{SITE}/dashboard.html")
    WebDriverWait(driver, 40).until(
        lambda d: d.execute_script("return typeof window.billingView !== 'undefined';"),
        message=f"the dashboard never finished loading (at {driver.current_url})")


def open_checkout(driver, sku):
    """Open checkout for one SKU the way any screen in the app does."""
    driver.execute_script("window.billingView.buy(arguments[0], null, {stay: true});", sku)
    WebDriverWait(driver, 20).until(
        lambda d: d.execute_script(
            "return window.__blStage && window.__blStage() === 'review';"))


def text_of(driver, selector):
    """The element's text, retried once: the dialog re-renders under us."""
    for _ in range(6):
        try:
            els = driver.find_elements(By.CSS_SELECTOR, selector)
            return els[0].text if els else ""
        except StaleElementReferenceException:
            time.sleep(0.1)
    return ""


def rupees(minor):
    """Paise formatted the way the page formats them."""
    return "₹" + f"{minor // 100:,}"


def click(driver, selector):
    """Click, retrying past a re-render that invalidated the element."""
    last = None
    for _ in range(12):
        try:
            driver.find_element(By.CSS_SELECTOR, selector).click()
            return
        except (StaleElementReferenceException, ElementClickInterceptedException,
                NoSuchElementException) as exc:
            last = exc
            time.sleep(0.15)
    raise AssertionError(f"could not click {selector}: {last}")


def main():
    if not require_live_server_optin(API):
        return 0
    try:
        requests.get(f"{API}/openapi.json", timeout=30)
        requests.get(f"{SITE}/dashboard.html", timeout=30)
    except Exception as exc:
        print(f"Skipped: the API on {API} and the site on {SITE} must both be running ({exc}).")
        return 0

    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1280,1000")
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    driver = webdriver.Chrome(options=opts)
    # Told to the page before its own scripts run, so js/config.js resolves the
    # backend to wherever this run put it (see the module docstring).
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument",
                           {"source": f"window.__API_BASE = {json.dumps(API)};"})

    try:
        # A tiny probe so the test can read the module's own state rather than
        # guessing it from the DOM.
        probe = (
            "window.__blStage = function(){"
            "  var card = document.getElementById('blCheckoutCard');"
            "  if (!card) return null;"
            "  var t = (document.getElementById('blCheckoutTitle')||{}).textContent || '';"
            "  if (document.querySelector('.bl-qr')) return 'qr';"
            "  if (document.querySelector('.bl-success')) return 'success';"
            "  if (document.querySelector('.bl-failed')) return 'failed';"
            "  if (document.querySelector('.bl-summary')) return 'review';"
            "  return t;"
            "};"
        )

        # ===============================================================
        section("1. The checkout offers UPI QR, and nothing else")
        # ===============================================================
        body, headers = register()
        sign_in(driver, body)
        driver.execute_script(probe)
        open_checkout(driver, "act_monthly")

        # Scoped to the method list: the Kal Coins toggle above it borrows the
        # same label and hint classes.
        labels = [e.text for e in driver.find_elements(By.CSS_SELECTOR, ".bl-methods .bl-method__label")]
        check("One payment method is shown", labels == ["UPI QR"], labels)
        check("Card is not offered", "Card" not in labels)
        check("Net banking is not offered", "Net banking" not in labels)
        check("It explains how to pay",
              text_of(driver, ".bl-methods .bl-method__hint") == "Scan using any UPI app",
              text_of(driver, ".bl-methods .bl-method__hint"))
        check("The method is selected for the user",
              driver.find_element(By.CSS_SELECTOR, ".bl-methods .bl-method input").is_selected())

        summary = text_of(driver, ".bl-summary")
        check("The plan is named", "ACT Monthly" in summary, summary)
        check("With its duration", "30" in summary and "days" in summary, summary)
        check("The list price is shown", "₹199" in summary, summary)
        check("And the total to pay", "Total to pay" in summary, summary)
        # Onboarding earns the profile-completed reward, so this account has
        # coins and the total is below the list price. That the discount
        # reaches the QR is the point of following it through below.
        check("Kal Coins come off the price", "Kal Coins" in summary, summary)
        total = text_of(driver, ".bl-summary__total").split()[-1]
        check("The total is less than the list price", total != "₹199", total)
        check("The demo is declared",
              "No real money will be charged" in text_of(driver, ".bl-demo-note"),
              text_of(driver, ".bl-demo-note"))
        pay_btn = driver.find_element(By.CSS_SELECTOR, '[data-bl="pay"]')
        check("The Pay button names the total, not the list price",
              total in pay_btn.text and "₹199" not in pay_btn.text, pay_btn.text)

        # ===============================================================
        section("2. Pay shows a QR for that exact amount")
        # ===============================================================
        pay_started = time.time()
        click(driver, '[data-bl="pay"]')
        WebDriverWait(driver, 20).until(
            lambda d: d.execute_script("return window.__blStage() === 'qr';"))
        check("Pressing Pay opens the QR screen", True)
        check("The Pay button is gone, so it cannot be pressed twice",
              not driver.find_elements(By.CSS_SELECTOR, '[data-bl="pay"]'))

        check("The QR screen asks for that same discounted total",
              text_of(driver, ".bl-qr__amount") == total,
              f"{text_of(driver, '.bl-qr__amount')} vs {total}")
        check("With the plan and its length",
              "ACT Monthly" in text_of(driver, ".bl-qr__plan") and "30" in text_of(driver, ".bl-qr__plan"),
              text_of(driver, ".bl-qr__plan"))
        check("A QR is drawn", bool(driver.find_elements(By.CSS_SELECTOR, ".bl-qr__svg path")))
        modules = driver.execute_script(
            "return (document.querySelector('.bl-qr__svg path').getAttribute('d')||'').split('M').length - 1;")
        check("It is a real code, not a placeholder", modules > 50, modules)
        check("It says how to use it", text_of(driver, ".bl-qr__hint") == "Scan using any UPI app")
        check("A reference is shown", "MK-DEMO-" in text_of(driver, ".bl-qr__ref"),
              text_of(driver, ".bl-qr__ref"))
        check("The demo is declared here too",
              "No real money will be charged" in text_of(driver, ".bl-demo-note"))

        # ===============================================================
        section("3. The simulated payment runs for about ten seconds")
        # ===============================================================
        started = pay_started
        seen = []

        def note_phase():
            # Read in one go: the dialog repaints under us, so an element
            # handle taken here can be stale by the time its text is asked for.
            label = driver.execute_script(
                "var e = document.querySelector('.bl-step.is-active .bl-step__label');"
                "return e ? e.textContent.trim() : null;")
            if label and (not seen or seen[-1][0] != label):
                seen.append((label, round(time.time() - started, 1)))

        while time.time() - started < 20:
            if driver.execute_script("return window.__blStage() === 'success';"):
                break
            note_phase()
            time.sleep(0.15)
        elapsed = time.time() - started

        phases = [p for p, _ in seen]
        check("It waits for payment first", phases and phases[0] == "Waiting for payment…", seen)
        check("Then reports the payment received", "Payment received" in phases, seen)
        check("Then verifies it", "Verifying payment…" in phases, seen)
        check("The stages run in order",
              phases == sorted(set(phases), key=lambda p: ["Waiting for payment…", "Payment received",
                                                           "Verifying payment…"].index(p)), seen)
        check("There is no countdown anywhere",
              not any(ch.isdigit() for ch in " ".join(phases)), phases)
        check("It takes about ten seconds, not none", 9 <= elapsed <= 16, round(elapsed, 1))

        # ===============================================================
        section("4. Success, and a plan the backend agrees with")
        # ===============================================================
        WebDriverWait(driver, 15).until(
            lambda d: d.execute_script("return window.__blStage() === 'success';"))
        success = text_of(driver, ".bl-modal__card")
        check("The success screen says so", "Payment successful" in success, success)
        check("It shows the amount that was paid", total in success, success)
        check("It confirms ACT is on", "ACT activated successfully" in success, success)
        check("And for how long", "30" in success and "days" in success, success)
        check("It names the reference", "MK-DEMO-" in success, success)
        check("It still says nothing was charged",
              "No real money will be charged" in success, success)
        check("The button moves the user on",
              driver.find_element(By.CSS_SELECTOR, '[data-bl="done"]').text == "Continue")

        me = requests.get(f"{API}/billing/me", headers=headers, timeout=20).json()
        check("The backend has the user on ACT", me["tier"] == "act", me["tier"])
        check("On the monthly pass", me["plan"]["sku"] == "act_monthly", me["plan"])
        check("With 30 days", me["plan"]["days_left"] == 30, me["plan"])
        orders = requests.get(f"{API}/billing/orders", headers=headers, timeout=20).json()
        check("One paid order was recorded", len(orders) == 1, orders)
        check("Paid by UPI QR", orders[0]["payment_method"] == "upi_qr", orders[0])
        check("Marked as a demo transaction", orders[0]["is_demo"] is True, orders[0])
        check("With its reference", (orders[0]["transaction_reference"] or "").startswith("MK-DEMO-"))
        check("Charged the discounted total the QR showed",
              rupees(orders[0]["payable_minor"]) == total,
              f"{orders[0]['payable_minor']} vs {total}")
        check("At the full list price before coins", orders[0]["gross_minor"] == 19900, orders[0])
        check("With the Kal Coins discount recorded",
              orders[0]["gross_minor"] - orders[0]["coin_discount_minor"] == orders[0]["payable_minor"],
              orders[0])

        click(driver, '[data-bl="done"]')
        WebDriverWait(driver, 10).until(
            lambda d: not d.find_elements(By.ID, "blCheckoutCard"))
        check("Continue closes the checkout", True)
        driver.execute_script("window.switchView('billing');")
        WebDriverWait(driver, 10).until(
            lambda d: "ACT" in d.find_element(By.ID, "view-billing").text)
        billing_text = driver.find_element(By.ID, "view-billing").text
        check("The page now shows the plan as active", "Active" in billing_text, billing_text[:200])

        # ===============================================================
        section("5. Extending again adds days rather than replacing them")
        # ===============================================================
        driver.execute_script(probe)
        open_checkout(driver, "act_yearly")
        yearly_summary = text_of(driver, ".bl-summary")
        check("The yearly pass is listed at ₹1,499", "₹1,499" in yearly_summary, yearly_summary)
        check("And runs for 365 days", "365" in yearly_summary, yearly_summary)
        click(driver, '[data-bl="pay"]')
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return window.__blStage() === 'success';"))
        me2 = requests.get(f"{API}/billing/me", headers=headers, timeout=20).json()
        check("The second purchase added its year on top",
              393 <= me2["plan"]["days_left"] <= 396, me2["plan"])
        orders2 = requests.get(f"{API}/billing/orders", headers=headers, timeout=20).json()
        check("Both purchases are in history", len(orders2) == 2, orders2)
        check("Newest first", orders2[0]["sku"] == "act_yearly", [o["sku"] for o in orders2])
        click(driver, '[data-bl="done"]')
        WebDriverWait(driver, 10).until(
            lambda d: not d.find_elements(By.ID, "blCheckoutCard"))

        # ===============================================================
        section("6. Cancelling leaves nothing behind")
        # ===============================================================
        body2, headers2 = register()
        sign_in(driver, body2)
        driver.execute_script(probe)
        open_checkout(driver, "act_monthly")
        click(driver, '.bl-modal__close')
        WebDriverWait(driver, 10).until(
            lambda d: not d.find_elements(By.ID, "blCheckoutCard"))
        check("Closing the summary closes the dialog", True)
        me3 = requests.get(f"{API}/billing/me", headers=headers2, timeout=20).json()
        check("Nothing was granted", me3["tier"] == "see", me3["tier"])
        check("And no payment recorded",
              requests.get(f"{API}/billing/orders", headers=headers2, timeout=20).json() == [])

        open_checkout(driver, "act_monthly")
        click(driver, '[data-bl="pay"]')
        WebDriverWait(driver, 20).until(
            lambda d: d.execute_script("return window.__blStage() === 'qr';"))
        click(driver, '.bl-modal__buttons [data-bl="close"]')
        WebDriverWait(driver, 10).until(
            lambda d: not d.find_elements(By.ID, "blCheckoutCard"))
        check("Cancelling at the QR closes the dialog", True)
        time.sleep(12)   # long enough that an uncancelled simulation would have paid
        me4 = requests.get(f"{API}/billing/me", headers=headers2, timeout=20).json()
        check("A cancelled payment never completes on its own", me4["tier"] == "see", me4["tier"])
        check("And still records nothing",
              requests.get(f"{API}/billing/orders", headers=headers2, timeout=20).json() == [])
        check("Reopening checkout works afterwards",
              (open_checkout(driver, "act_monthly") or True))

        errors = console_errors(driver)
        check("No JavaScript errors along the way", not errors, errors[:2])

    finally:
        driver.quit()

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
