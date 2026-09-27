"""Terms & Conditions consent — browser test.

Drives the real login and registration pages in headless Chrome. The point of
this suite is the gate: that an unticked box stops a submit before any request
leaves the page, that the Terms open in a dialog without costing the user what
they have typed, and that a ticked box leaves the existing authentication flow
exactly as it was.

It also checks the acceptance actually reaches the database, by signing in
through the API afterwards and reading terms_accepted / terms_version /
terms_accepted_at back off the auth response.

Needs the API on :8000 and the site on :8080. Point the API at a throwaway
database — this suite creates accounts.
  DATABASE_URL=sqlite:///./terms_e2e.db python -m uvicorn backend.main:app --port 8000
  python -m http.server 8080 --directory twin-app

Run with:  python tests/test_terms_consent_browser.py
"""
import sys
import time
import uuid

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

API = "http://127.0.0.1:8000"
SITE = "http://127.0.0.1:8080"
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


def console_errors(driver):
    out = []
    for entry in driver.get_log("browser"):
        if entry["level"] == "SEVERE":
            # favicon 404s are noise from python -m http.server, not our code.
            if "favicon" in entry["message"]:
                continue
            out.append(entry["message"])
    return out


def fresh(driver, page):
    """Load a page with no session left over from a previous check."""
    driver.get(f"{SITE}/{page}")
    driver.execute_script("localStorage.clear();")
    driver.get(f"{SITE}/{page}")
    WebDriverWait(driver, 10).until(
        lambda d: d.execute_script("return document.readyState") == "complete"
    )


def tick(driver, block_id):
    """Click the visible box.

    The <input> itself is off-screen by design — `.mk-check input` is the
    existing pattern on this page, the same one "Remember my User ID" uses —
    so a person clicks the drawn box or the label, never the input.
    """
    driver.find_element(By.CSS_SELECTOR, f"#{block_id} .mk-check__box").click()


def main():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1440,900")
    opts.add_argument("--no-sandbox")
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    driver = webdriver.Chrome(options=opts)
    driver.implicitly_wait(2)

    try:
        # ================================================== LOGIN PAGE ======
        print("\n--- login.html: consent row ---")
        fresh(driver, "login.html")

        box = driver.find_element(By.ID, "loginTerms")
        check("consent checkbox present", box is not None)
        check("consent checkbox starts unticked", not box.is_selected())
        check(
            "consent label reads as expected",
            "I agree to the" in driver.find_element(By.CSS_SELECTOR, "#loginConsent .mk-consent__text").text,
            driver.find_element(By.CSS_SELECTOR, "#loginConsent .mk-consent__text").text,
        )
        check(
            "checkbox is visible without scrolling past the button",
            driver.find_element(By.ID, "loginConsent").is_displayed(),
        )

        print("\n--- login.html: submit is blocked while unticked ---")
        driver.find_element(By.ID, "authEmail").send_keys("someone@example.com")
        driver.find_element(By.ID, "authPassword").send_keys(PASSWORD)
        driver.find_element(By.ID, "btnLogin").click()
        time.sleep(0.6)

        requests_made = driver.execute_script(
            "return performance.getEntriesByType('resource')"
            ".filter(e => e.name.indexOf('/auth/login') !== -1).length"
        )
        check("no /auth/login request was made", requests_made == 0, requests_made)
        check("still on login.html", driver.current_url.endswith("login.html"))
        err = driver.find_element(By.ID, "loginTermsError")
        check("validation message shown", err.is_displayed() and len(err.text) > 10, err.text)
        check(
            "message names what is needed",
            "Terms" in err.text and "Privacy" in err.text,
            err.text,
        )
        check(
            "consent block carries the invalid state",
            "is-invalid" in driver.find_element(By.ID, "loginConsent").get_attribute("class"),
        )
        check(
            "checkbox marked aria-invalid",
            box.get_attribute("aria-invalid") == "true",
            box.get_attribute("aria-invalid"),
        )
        check(
            "submit button was not left spinning",
            "is-loading" not in driver.find_element(By.ID, "btnLogin").get_attribute("class"),
        )
        check("focus moved to the checkbox", driver.switch_to.active_element == box)

        print("\n--- login.html: the Terms dialog ---")
        trigger = driver.find_element(By.CSS_SELECTOR, "#loginConsent .mk-consent__link")
        trigger.click()
        WebDriverWait(driver, 5).until(
            lambda d: "is-open" in d.find_element(By.ID, "termsModal").get_attribute("class")
        )
        check("dialog opened", True)
        check(
            "reading the Terms did not tick the box",
            not driver.find_element(By.ID, "loginTerms").is_selected(),
        )
        sections = driver.find_elements(By.CSS_SELECTOR, "#termsModal .mk-terms__section")
        check("all clauses rendered", len(sections) == 19, len(sections))
        headings = [s.find_element(By.CSS_SELECTOR, ".mk-terms__heading").text for s in sections]
        for needed in [
            "Acceptance", "Eligibility", "Limitation of liability",
            "Governing law", "Intellectual property", "Prohibited",
        ]:
            check(f"clause present: {needed}", any(needed in h for h in headings))
        check(
            "version and date shown",
            "1.0" in driver.find_element(By.CSS_SELECTOR, "#termsModal .mk-terms__meta").text,
            driver.find_element(By.CSS_SELECTOR, "#termsModal .mk-terms__meta").text,
        )
        check(
            "advice disclaimer is in the callout",
            "not" in driver.find_element(By.CSS_SELECTOR, "#termsModal .mk-terms__callout").text,
        )
        check(
            "no stray markup left unparsed",
            "**" not in driver.find_element(By.CSS_SELECTOR, "#termsModal .mk-terms__body").text,
        )
        check("body is scrollable", driver.execute_script(
            "const b=document.querySelector('#termsModal .mk-terms__body');"
            "return b.scrollHeight > b.clientHeight;"
        ))
        check("page behind is scroll-locked", driver.execute_script(
            "return document.body.classList.contains('mk-scroll-locked');"
        ))

        print("\n--- login.html: closing the dialog ---")
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.5)
        check("Escape closes", "is-open" not in driver.find_element(By.ID, "termsModal").get_attribute("class"))
        check("scroll lock released", not driver.execute_script(
            "return document.body.classList.contains('mk-scroll-locked');"
        ))

        trigger.click()
        time.sleep(0.4)
        driver.find_element(By.CSS_SELECTOR, "#termsModal .mk-modal__close").click()
        time.sleep(0.5)
        check("close button closes", "is-open" not in driver.find_element(By.ID, "termsModal").get_attribute("class"))

        trigger.click()
        time.sleep(0.4)
        # Click the scrim near its top-left corner: its centre sits behind the
        # panel, which is where Selenium would otherwise aim.
        # Selenium 4 measures the offset from the element CENTRE, and the
        # scrim's centre is behind the panel, so aim at the viewport corner.
        scrim = driver.find_element(By.CSS_SELECTOR, "#termsModal .mk-modal__scrim")
        vw = driver.execute_script("return window.innerWidth;")
        vh = driver.execute_script("return window.innerHeight;")
        ActionChains(driver).move_to_element_with_offset(
            scrim, -(vw // 2 - 8), -(vh // 2 - 8)
        ).click().perform()
        time.sleep(0.5)
        check("scrim click closes", "is-open" not in driver.find_element(By.ID, "termsModal").get_attribute("class"))

        print("\n--- login.html: Privacy Policy opens on the privacy clause ---")
        driver.find_elements(By.CSS_SELECTOR, "#loginConsent .mk-consent__link")[1].click()
        time.sleep(0.6)
        landed = driver.execute_script(
            "const b=document.querySelector('#termsModal .mk-terms__body');"
            "const s=document.getElementById('terms-privacy');"
            "const d=s.getBoundingClientRect().top - b.getBoundingClientRect().top;"
            "return {scrollTop: b.scrollTop, offsetFromTop: Math.round(d),"
            " heading: s.querySelector('.mk-terms__heading').textContent};"
        )
        check("dialog scrolled away from the top", landed["scrollTop"] > 100, landed)
        check(
            "the privacy clause is the one at the top of the view",
            -4 <= landed["offsetFromTop"] <= 24,
            landed,
        )
        check("and it is the right clause", "Privacy" in landed["heading"], landed["heading"])
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.4)

        print("\n--- login.html: ticking clears the error ---")
        tick(driver, "loginConsent")
        time.sleep(0.3)
        check("checkbox now ticked", driver.find_element(By.ID, "loginTerms").is_selected())
        check(
            "error cleared on tick",
            "is-invalid" not in driver.find_element(By.ID, "loginConsent").get_attribute("class"),
        )

        print("\n--- login.html: keyboard operation ---")
        driver.execute_script("document.getElementById('loginTerms').checked = false;")
        driver.execute_script("document.getElementById('loginTerms').focus();")
        check("checkbox is focusable", driver.switch_to.active_element.get_attribute("id") == "loginTerms")
        driver.switch_to.active_element.send_keys(Keys.SPACE)
        time.sleep(0.2)
        check("space toggles the checkbox", driver.find_element(By.ID, "loginTerms").is_selected())
        driver.switch_to.active_element.send_keys(Keys.SPACE)
        time.sleep(0.2)
        check("space toggles it back", not driver.find_element(By.ID, "loginTerms").is_selected())

        print("\n--- login.html: the Terms trigger is reachable by keyboard ---")
        driver.execute_script(
            "document.querySelector('#loginConsent .mk-consent__link').focus();"
        )
        driver.switch_to.active_element.send_keys(Keys.ENTER)
        time.sleep(0.6)
        check("Enter on the link opens the dialog",
              "is-open" in driver.find_element(By.ID, "termsModal").get_attribute("class"))
        check("opening by keyboard did not tick the box",
              not driver.find_element(By.ID, "loginTerms").is_selected())
        check("focus moved into the dialog", driver.execute_script(
            "return document.getElementById('termsModal').contains(document.activeElement);"
        ))
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.4)
        tick(driver, "loginConsent")

        errs = console_errors(driver)
        check("no console errors on login.html", not errs, errs[:2])

        # ================================================== REGISTER =======
        print("\n--- register.html: gate blocks account creation ---")
        email = f"terms-{uuid.uuid4().hex[:10]}@example.com"
        fresh(driver, "register.html")
        driver.find_element(By.ID, "btnNext1").click()
        WebDriverWait(driver, 5).until(
            EC.visibility_of_element_located((By.ID, "regName"))
        )
        driver.find_element(By.ID, "regName").send_keys("Terms Tester")
        driver.find_element(By.ID, "regEmail").send_keys(email)
        driver.find_element(By.ID, "regPassword").send_keys(PASSWORD)

        check("consent row present on step 2", driver.find_element(By.ID, "regConsent").is_displayed())
        driver.find_element(By.ID, "btnCreateAccount").click()
        time.sleep(0.8)
        made = driver.execute_script(
            "return performance.getEntriesByType('resource')"
            ".filter(e => e.name.indexOf('/auth/register') !== -1).length"
        )
        check("no /auth/register request was made", made == 0, made)
        check(
            "register validation message shown",
            driver.find_element(By.ID, "regTermsError").is_displayed(),
        )
        check("no account created yet", requests.post(
            f"{API}/auth/login", json={"username": email, "password": PASSWORD}
        ).status_code == 401)

        print("\n--- register.html: ticking lets the real flow run ---")
        tick(driver, "regConsent")
        driver.find_element(By.ID, "btnCreateAccount").click()
        WebDriverWait(driver, 15).until(
            lambda d: "is-active" in d.find_element(By.ID, "step3-individual").get_attribute("class")
        )
        check("wizard advanced to the profile step", True)
        check("session token stored", bool(driver.execute_script(
            "return (JSON.parse(localStorage.getItem('twin_session')||'{}')).token;"
        )))

        r = requests.post(f"{API}/auth/login", json={"username": email, "password": PASSWORD})
        check("account really exists", r.status_code == 200, r.status_code)
        body = r.json()
        check("acceptance persisted: terms_accepted", body.get("terms_accepted") is True, body.get("terms_accepted"))
        check("acceptance persisted: terms_version", body.get("terms_version") == "1.0", body.get("terms_version"))
        check("acceptance persisted: terms_accepted_at", bool(body.get("terms_accepted_at")), body.get("terms_accepted_at"))

        errs = console_errors(driver)
        check("no console errors on register.html", not errs, errs[:2])

        # ============================================== LOGIN, HAPPY PATH ==
        print("\n--- login.html: ticked box, existing account, normal sign-in ---")
        fresh(driver, "login.html")
        driver.find_element(By.ID, "authEmail").send_keys(email)
        driver.find_element(By.ID, "authPassword").send_keys(PASSWORD)
        tick(driver, "loginConsent")
        driver.find_element(By.ID, "btnLogin").click()
        WebDriverWait(driver, 15).until(
            lambda d: "login.html" not in d.current_url
        )
        check(
            "signed in and routed onward",
            "register.html" in driver.current_url or "dashboard.html" in driver.current_url,
            driver.current_url,
        )

        # ================================================== MOBILE =========
        print("\n--- mobile viewport (390 x 844) ---")
        driver.set_window_size(390, 844)
        fresh(driver, "login.html")
        consent = driver.find_element(By.ID, "loginConsent")
        check("consent row visible on a phone", consent.is_displayed())
        check(
            "consent row does not overflow the viewport",
            driver.execute_script(
                "const r=document.getElementById('loginConsent').getBoundingClientRect();"
                "return r.right <= window.innerWidth + 1 && r.left >= -1;"
            ),
        )
        check("page does not scroll sideways", driver.execute_script(
            "return document.documentElement.scrollWidth <= window.innerWidth + 1;"
        ))
        check("consent row meets a usable tap size", driver.execute_script(
            "const r=document.querySelector('#loginConsent .mk-check--consent').getBoundingClientRect();"
            "return r.height >= 40;"
        ))

        driver.find_element(By.CSS_SELECTOR, "#loginConsent .mk-consent__link").click()
        time.sleep(0.6)
        check("dialog opens on a phone", "is-open" in driver.find_element(By.ID, "termsModal").get_attribute("class"))
        check("dialog fills the phone screen", driver.execute_script(
            "const p=document.querySelector('.mk-modal__panel--terms').getBoundingClientRect();"
            "return p.width >= window.innerWidth - 2 && p.height >= window.innerHeight - 4;"
        ))
        check("dialog content does not overflow sideways", driver.execute_script(
            "const b=document.querySelector('#termsModal .mk-terms__body');"
            "return b.scrollWidth <= b.clientWidth + 1;"
        ))

        errs = console_errors(driver)
        check("no console errors on mobile", not errs, errs[:2])

        # ================================================== HINDI ==========
        print("\n--- Hindi ---")
        driver.set_window_size(1440, 900)
        driver.get(f"{SITE}/login.html")
        driver.execute_script("localStorage.clear(); localStorage.setItem('moneykal_lang','hi');")
        driver.get(f"{SITE}/login.html")
        time.sleep(1.2)
        text = driver.find_element(By.CSS_SELECTOR, "#loginConsent .mk-consent__text").text
        check("consent label translated", "सहमत" in text and "नियम" in text, text)
        driver.execute_script("localStorage.removeItem('moneykal_lang');")

    finally:
        driver.quit()

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for f in FAILED:
            print("   FAILED:", f)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
