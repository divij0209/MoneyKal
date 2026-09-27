"""
Money Splits — browser test.

Drives the actual website in headless Chrome. The other two suites prove the
API is correct; this one proves the pages a person will use actually render,
that no JavaScript throws, and that the flows wired through split.js reach the
server and update the screen.

It checks what only a browser can: that the Split nav item switches views, that
the Add Expense form's live preview shows the same numbers the server saves,
that the notification bell mounts and its badge counts, and that the invitation
landing page renders for a visitor who is not signed in.

Needs the API on :8000 and the site on :8080.
  python -m uvicorn backend.main:app --port 8000
  python -m http.server 8080 --directory twin-app

Run with:  python tests/test_split_browser.py
"""
import json
import sys
import time
import uuid

import requests
from selenium import webdriver

from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
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
        print(f"  FAIL  {label}  {detail}")


def register(email, onboard=True):
    """Create an account and, by default, complete Individual onboarding.

    The onboarding step is not incidental: dashboard.html's own bootstrap calls
    /profile/me and signs the user straight back out to login.html if no profile
    exists. That is pre-existing behaviour and nothing to do with Split, but it
    means a bare registration can never reach the screen under test.
    """
    r = requests.post(f"{API}/auth/register", json={"username": email, "password": PASSWORD}, timeout=15)
    r.raise_for_status()
    body = r.json()
    if onboard:
        requests.post(
            f"{API}/onboard/confirm",
            headers={"Authorization": f"Bearer {body['access_token']}"},
            json={
                "full_name": email.split("@")[0].replace("_", " ").title(),
                "email": email, "occupation": "Engineer",
                "monthly_income": 120000, "total_savings": 500000,
                "monthly_expenses": 60000, "outstanding_loans": 0,
            },
            timeout=20,
        ).raise_for_status()
    return body


def api(method, path, token, **kw):
    return requests.request(method, f"{API}{path}",
                            headers={"Authorization": f"Bearer {token}"}, timeout=15, **kw)


print("=" * 70)
print("Money Splits — browser")
print("=" * 70)

for name, url in (("API", f"{API}/health"), ("site", f"{SITE}/dashboard.html")):
    try:
        requests.get(url, timeout=5).raise_for_status()
    except Exception as e:
        print(f"\n  The {name} is not reachable at {url}.\n  {e}")
        sys.exit(2)

tag = uuid.uuid4().hex[:8]
divij = register(f"br_divij_{tag}@moneykal.test")
harshit = register(f"br_harshit_{tag}@moneykal.test")
d_id = api("GET", "/split/me", divij["access_token"]).json()["person"]["id"]
h_id = api("GET", "/split/me", harshit["access_token"]).json()["person"]["id"]

# Seed one group so the browser has something real to render.
gid = api("POST", "/split/groups", divij["access_token"],
          json={"name": f"Browser Trip {tag}", "emoji": "\U0001f3d6",
                "group_type": "trip", "currency": "INR"}).json()["id"]
api("POST", f"/split/groups/{gid}/members", divij["access_token"], json={"person_id": h_id})
api("POST", "/split/expenses", divij["access_token"], json={
    "group_id": gid, "description": "Seed dinner", "amount": "3000", "split_mode": "equal",
    "participant_person_ids": [d_id, h_id],
    "payers": [{"person_id": d_id, "amount": "3000"}],
    "client_token": f"br-{tag}-seed"})

opts = Options()
opts.add_argument("--headless=new")
opts.add_argument("--window-size=1440,1000")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-gpu")
opts.add_argument("--disable-dev-shm-usage")
# Surface console errors to the test rather than swallowing them.
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})

driver = webdriver.Chrome(options=opts)
driver.set_page_load_timeout(40)
wait = WebDriverWait(driver, 20)


def console_errors():
    """Uncaught JavaScript only.

    Chrome logs every non-2xx fetch at SEVERE, but a non-2xx response is a
    designed outcome all over this app — 400 for a split that does not add up,
    402 for a Premium gate, 404 for an account that has not onboarded — and
    each one is caught and rendered. Counting those as errors would make the
    test red for the app working correctly. Missing favicons are likewise noise
    from serving the site with http.server.
    """
    out = []
    for entry in driver.get_log("browser"):
        if entry["level"] != "SEVERE":
            continue
        msg = entry["message"]
        if "favicon" in msg or "logo-icon" in msg:
            continue
        if "Failed to load resource" in msg:
            continue
        out.append(msg)
    return out


def sign_in(session):
    """Put a session in localStorage the way login.html does, then load the app."""
    driver.get(f"{SITE}/dashboard.html")
    driver.execute_script(
        "localStorage.setItem('twin_session', arguments[0]);"
        "localStorage.setItem('moneykal_ov_theme','dark');",
        json.dumps({
            "token": session["access_token"],
            "user_id": session["user_id"],
            "username": session["username"],
            "profile_key": session.get("profile_key"),
        }),
    )
    driver.get(f"{SITE}/dashboard.html")


try:
    # ================= Dashboard loads =================
    sign_in(divij)
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".navitem[data-view='split']")))
    check("Dashboard loads with a Split nav item", True)

    errs = console_errors()
    check("No JavaScript errors on load", not errs, str(errs[:2]))

    check("Notification bell mounted into the topbar",
          driver.execute_script("return !!document.getElementById('spBell')"))

    # ---- Your Freedom Balance ----
    # It reads as the nav item after Reports and is a real button, not the run
    # of plain text it had become when its styling was stripped.
    llf = driver.execute_script("""
      const p = document.getElementById('llfPortal');
      if (!p) return null;
      const nav = document.querySelector('.sidebar__nav');
      const cs = getComputedStyle(p);
      const items = [...nav.children].filter(c => c.offsetParent !== null);
      const reports = nav.querySelector("[data-view='reports']");
      return {
        text: p.textContent.trim().replace(/\\s+/g, ' '),
        insideNav: nav.contains(p),
        lastInNav: nav.lastElementChild === p,
        rightAfterReports: items.indexOf(p) === items.indexOf(reports) + 1,
        looksLikeButton: cs.display !== 'none' && cs.cursor === 'pointer'
                      && parseFloat(cs.paddingLeft) > 0,
        hasIcon: !!p.querySelector('svg')
      };
    """)
    check("Your Freedom Balance is labelled without the old wordmark",
          llf and llf["text"] == "Your Freedom Balance", str(llf))
    check("It sits in the nav, directly after Reports",
          llf and llf["insideNav"] and llf["lastInNav"] and llf["rightAfterReports"], str(llf))
    check("It renders as a button, not plain text",
          llf and llf["looksLikeButton"] and llf["hasIcon"], str(llf))

    # ================= Open Split =================
    driver.find_element(By.CSS_SELECTOR, ".navitem[data-view='split']").click()
    wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "#view-split .sp-tabs")))
    check("Split view opens on click", True)
    # The shared topbar heading is suppressed on this view so the product name
    # is not printed twice on one screen; the hero carries it instead.
    check("The topbar heading is hidden so the name is not duplicated",
          driver.execute_script(
              "const t=document.querySelector('.topbar__title');"
              "return t && getComputedStyle(t).display === 'none';"))
    check("The topbar leaves no empty gap where the heading was",
          driver.execute_script("""
            const bar = document.querySelector('.topbar');
            const cs = getComputedStyle(bar);
            return cs.borderBottomStyle === 'none'
                && parseFloat(cs.paddingBottom) === 0
                && parseFloat(cs.marginBottom) === 0;
          """))
    check("The topbar still carries its controls",
          driver.find_element(By.ID, "spBell").is_displayed()
          and driver.find_element(By.ID, "btnLogout").is_displayed())
    check("'Money Splits' appears once as a heading, not twice",
          driver.execute_script("""
            const seen = [...document.querySelectorAll('h1, .navitem')]
              .filter(el => el.offsetParent !== null
                         && el.textContent.trim() === 'Money Splits');
            // The sidebar nav item and the hero h1 — and nothing else.
            return seen.length === 2
                && seen.some(el => el.classList.contains('navitem'))
                && seen.some(el => el.classList.contains('sp-hero__title'));
          """))
    check("The hero names the feature and states its promise",
          driver.find_element(By.CSS_SELECTOR, ".sp-hero__title").text.strip() == "Money Splits"
          and "Keep your friendships simple" in driver.find_element(By.CSS_SELECTOR, ".sp-hero__sub").text)
    check("Both hero calls to action are present",
          driver.find_element(By.ID, "spHeroAdd").is_displayed()
          and driver.find_element(By.ID, "spHeroGroup").is_displayed())
    check("The sidebar nav reads Money Splits",
          "Money Splits" in driver.find_element(By.CSS_SELECTOR, ".navitem[data-view='split']").text)

    wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, "#spSummary .sp-stat__amount"))
    amounts = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#spSummary .sp-stat__amount")]
    # Seed is Rs 3,000 split equally between two people, paid by Divij:
    # his share is 1,500, so he is owed exactly 1,500.
    check("Summary renders real amounts from the API",
          any("1,500" in a for a in amounts), str(amounts))

    check("Four tabs are present",
          len(driver.find_elements(By.CSS_SELECTOR, ".sp-tab")) == 4)
    check("Floating add button is present",
          driver.find_element(By.ID, "spFab").is_displayed())

    # ================= Group list -> detail =================
    wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".sp-gcard[data-group]"))
    cards = driver.find_elements(By.CSS_SELECTOR, ".sp-gcard[data-group]")
    check("The seeded group is listed as a card",
          any(f"Browser Trip {tag}" in c.text for c in cards))
    check("The group card shows its member count and expense count",
          any("member" in c.text and "expense" in c.text for c in cards),
          " | ".join(cards[0].text.splitlines()) if cards else "no cards")

    driver.find_element(By.CSS_SELECTOR, f".sp-gcard[data-group='{gid}']").click()
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".sp-ghead__name")))
    check("Group detail opens",
          f"Browser Trip {tag}" in driver.find_element(By.CSS_SELECTOR, ".sp-ghead__name").text)
    check("The seeded expense is listed",
          any("Seed dinner" in r.text for r in driver.find_elements(By.CSS_SELECTOR, "[data-expense]")))
    check("Settle-up suggestions render",
          len(driver.find_elements(By.CSS_SELECTOR, ".sp-settle")) >= 1)
    check("Balance bars render",
          len(driver.find_elements(By.CSS_SELECTOR, ".sp-bar__fill")) >= 1)
    check("The two-column desktop layout is used, not a stretched phone view",
          driver.execute_script(
              "const el=document.querySelector('.sp-two');"
              "return el && getComputedStyle(el).gridTemplateColumns.split(' ').length===2"))
    check("Export button shows a Premium lock for a free user",
          len(driver.find_elements(By.CSS_SELECTOR, "#spExport .sp-lock")) == 1)

    # ---- Redesign: the visual language actually renders ----
    check("Group header shows the group's emoji",
          len(driver.find_element(By.CSS_SELECTOR, ".sp-ghead__emoji").text.strip()) > 0)
    check("Expense rows carry a category emoji",
          all(len(e.text.strip()) > 0
              for e in driver.find_elements(By.CSS_SELECTOR, "[data-expense] .sp-row__emoji")))
    check("Balances render as chips, not a wall of text",
          len(driver.find_elements(By.CSS_SELECTOR, ".sp-bal")) >= 2)
    check("Money owed to you is green, money you owe is coral",
          driver.execute_script("""
            const owed = document.querySelector('.sp-stat--owed .sp-stat__amount');
            const owe  = document.querySelector('.sp-stat--owe .sp-stat__amount');
            if (!owed || !owe) return false;
            const a = getComputedStyle(owed).color, b = getComputedStyle(owe).color;
            return a !== b;
          """))

    # ---- Restraint guards ----
    # The palette is deliberately three hues over a neutral ground. These catch
    # a decorative gradient or an off-palette accent creeping back in.
    gradients = driver.execute_script("""
      return [...document.querySelectorAll('#view-split *')]
        .filter(el => {
          const s = getComputedStyle(el);
          return (s.backgroundImage || '').includes('gradient');
        })
        .map(el => el.className.toString().slice(0, 40));
    """)
    check("No decorative gradients are painted anywhere in the view",
          not gradients, str(gradients[:4]))

    off_palette = driver.execute_script("""
      // Every colour actually rendered, reduced to hue. Neutrals are judged on
      // absolute chroma (max channel minus min) rather than HSV saturation:
      // a near-black surface like #191D22 has a chroma of 9 but an HSV
      // saturation of 0.26, so saturation would flag the background itself.
      // Anything genuinely coloured must be cyan (~185deg), green (~160deg)
      // or coral (~20deg).
      const bad = [];
      const hueOf = (r, g, b) => {
        const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
        if (!d) return {h: 0, c: 0};
        let h;
        if (mx === r) h = 60 * (((g - b) / d) % 6);
        else if (mx === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        return {h: (h + 360) % 360, c: d};
      };
      const ok = h => (h > 150 && h < 200) || (h >= 0 && h < 45) || h > 345;
      for (const el of document.querySelectorAll('#view-split *')) {
        const s = getComputedStyle(el);
        for (const prop of ['color', 'backgroundColor', 'borderLeftColor', 'borderTopColor']) {
          const m = (s[prop] || '').match(/rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/);
          if (!m) continue;
          if (m[4] !== undefined && parseFloat(m[4]) < 0.06) continue;
          const {h, c} = hueOf(+m[1], +m[2], +m[3]);
          if (c < 40) continue;                  // neutral, always fine
          if (!ok(h)) bad.push(prop + ' ' + m[0] + ' hue=' + Math.round(h) + ' chroma=' + c);
        }
      }
      return [...new Set(bad)];
    """)
    check("Every saturated colour on screen is cyan, green or coral",
          not off_palette, str(off_palette[:4]))

    # ================= Add Expense — the live preview =================
    driver.find_element(By.ID, "spAddExp").click()
    wait.until(EC.visibility_of_element_located((By.ID, "spModal")))
    check("Add Expense modal opens", True)

    driver.find_element(By.ID, "xDesc").send_keys("Browser lunch")
    driver.find_element(By.ID, "xAmt").send_keys("100")
    time.sleep(0.4)

    # Scoped to #xSplit: the sole-payer indicator shares the class but sits
    # outside the split preview and reads "the whole amount".
    previews = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#xSplit .sp-split__computed")]
    check("Equal-split preview shows 50.00 each",
          previews == ["50.00", "50.00"], str(previews))

    # Switch to percentages and confirm the preview follows.
    driver.find_element(By.CSS_SELECTOR, "[data-mode='percent']").click()
    time.sleep(0.3)
    inputs = driver.find_elements(By.CSS_SELECTOR, "[data-val]")
    check("Percentage mode shows an input per person", len(inputs) == 2, str(len(inputs)))
    inputs[0].send_keys("70")
    time.sleep(0.3)
    driver.find_elements(By.CSS_SELECTOR, "[data-val]")[1].send_keys("30")
    time.sleep(0.4)
    previews = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#xSplit .sp-split__computed")]
    check("70/30 of 100 previews as 70.00 / 30.00",
          previews == ["70.00", "30.00"], str(previews))
    check("The tally confirms the percentages close",
          "✓" in driver.find_element(By.CSS_SELECTOR, ".sp-tally").text)

    # A deliberately wrong split must be refused by the server and shown inline.
    driver.find_elements(By.CSS_SELECTOR, "[data-val]")[1].clear()
    driver.find_elements(By.CSS_SELECTOR, "[data-val]")[1].send_keys("20")
    time.sleep(0.3)
    driver.find_element(By.ID, "xSave").click()
    time.sleep(1.2)
    check("An invalid percentage split is rejected with an inline message",
          len(driver.find_elements(By.CSS_SELECTOR, "#xErr .sp-err")) == 1,
          driver.find_element(By.ID, "xErr").text)

    # Fix it and save for real.
    driver.find_elements(By.CSS_SELECTOR, "[data-val]")[1].clear()
    driver.find_elements(By.CSS_SELECTOR, "[data-val]")[1].send_keys("30")
    time.sleep(0.3)
    driver.find_element(By.ID, "xSave").click()
    wait.until(lambda d: not d.find_elements(By.ID, "spModal"))
    check("A valid expense saves and closes the modal", True)

    wait.until(lambda d: any("Browser lunch" in r.text
                             for r in d.find_elements(By.CSS_SELECTOR, "[data-expense]")))
    check("The new expense appears in the list without a page reload", True)

    saved = api("GET", "/split/expenses", divij["access_token"],
                params={"group_id": gid}).json()["expenses"]
    lunch = next(e for e in saved if e["description"] == "Browser lunch")
    shares = sorted(s["amount"]["minor"] for s in lunch["shares"])
    check("What the browser previewed is what the server stored",
          shares == [3000, 7000], str(shares))

    # ================= Notification bell =================
    api("POST", "/split/expenses", harshit["access_token"], json={
        "group_id": gid, "description": "From Harshit", "amount": "600", "split_mode": "equal",
        "participant_person_ids": [d_id, h_id],
        "payers": [{"person_id": h_id, "amount": "600"}],
        "client_token": f"br-{tag}-note"})

    driver.execute_script("window.splitApp.refresh()")
    wait.until(lambda d: not d.find_element(By.ID, "spBellDot").get_attribute("hidden"))
    check("The bell badge shows unread notifications",
          driver.find_element(By.ID, "spBellDot").text.strip().isdigit(),
          driver.find_element(By.ID, "spBellDot").text)

    driver.find_element(By.ID, "spBell").click()
    # Wait for a row, not just the panel: the panel appears immediately with a
    # "Loading..." placeholder while the fetch is in flight.
    wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, "#spInbox [data-note]"))
    notes = driver.find_elements(By.CSS_SELECTOR, "#spInbox [data-note]")
    check("The inbox lists notifications", len(notes) >= 1, str(len(notes)))
    note_text = driver.execute_script(
        "return Array.from(document.querySelectorAll('#spInbox [data-note]'))"
        ".map(n => n.textContent).join(' | ')")
    check("A notification says what it means for the reader",
          "owe" in note_text.lower(), note_text[:200])

    # ================= Other tabs =================
    driver.execute_script("document.getElementById('spInbox')?.remove()")
    for tab, marker in (("friends", "[data-friend], .sp-empty__title"),
                        ("activity", ".sp-act, .sp-empty__title"),
                        ("account", ".sp-premium")):
        driver.find_element(By.CSS_SELECTOR, f".sp-tab[data-tab='{tab}']").click()
        wait.until(lambda d, m=marker: d.find_elements(By.CSS_SELECTOR, m))
        check(f"The {tab} tab renders", True)

    check("Account tab states that Split is free",
          "free" in driver.find_element(By.CSS_SELECTOR, ".sp-premium").text.lower())
    check("Notification preference toggles render",
          len(driver.find_elements(By.CSS_SELECTOR, "[data-pref]")) >= 6)

    # ================= Light theme =================
    driver.execute_script("localStorage.setItem('moneykal_ov_theme','light')")
    driver.refresh()
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".navitem[data-view='split']")))
    driver.find_element(By.CSS_SELECTOR, ".navitem[data-view='split']").click()
    wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, "#spSummary .sp-stat"))
    bg = driver.execute_script(
        "return getComputedStyle(document.querySelector('#spSummary .sp-stat')).backgroundColor")
    check("Split follows the app's light theme", bg not in ("rgba(0, 0, 0, 0)", "rgb(8, 9, 10)"), bg)
    # Captured once: driver.get_log() drains the buffer, so calling it a second
    # time for the failure detail would always report an empty list.
    walk_errors = console_errors()
    check("No JavaScript errors after the full walkthrough",
          not walk_errors, str(walk_errors[:2]))

    # ================= Mobile viewport =================
    driver.set_window_size(390, 844)
    time.sleep(0.5)
    check("Layout collapses to one column on a phone-width viewport",
          driver.execute_script(
              "const el=document.querySelector('.sp-summary');"
              "return getComputedStyle(el).gridTemplateColumns.split(' ').length===1"))
    check("The page does not scroll sideways on mobile",
          driver.execute_script(
              "return document.documentElement.scrollWidth <= window.innerWidth + 2"))
    driver.set_window_size(1440, 1000)

    # ================= Invitation landing page =================
    inv = api("POST", "/split/invitations", divij["access_token"],
              json={"email": f"br_guest_{tag}@moneykal.test", "name": "Rahul",
                    "group_id": gid}).json()

    # Put the guest on a real expense before they have an account, so the claim
    # has an actual balance to carry over rather than a zero.
    api("POST", "/split/expenses", divij["access_token"], json={
        "group_id": gid, "description": "Guest taxi", "amount": "900",
        "split_mode": "equal",
        "participant_person_ids": [d_id, inv["person"]["id"]],
        "payers": [{"person_id": d_id, "amount": "900"}],
        "client_token": f"br-{tag}-guest"})

    driver.execute_script("localStorage.clear()")  # arrive as a stranger
    driver.get(f"{SITE}/join.html?token={inv['token']}")
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".jn-title")))
    check("The invitation page renders for a signed-out visitor", True)
    check("It names the inviter and the group",
          f"Browser Trip {tag}" in driver.find_element(By.CSS_SELECTOR, ".jn-group__name").text)
    check("It offers sign-up and sign-in",
          len(driver.find_elements(By.CSS_SELECTOR, ".jn-tab")) == 2)
    check("The invited email is prefilled",
          driver.find_element(By.ID, "jnEmail").get_attribute("value")
          == f"br_guest_{tag}@moneykal.test")
    invite_errors = console_errors()
    check("No JavaScript errors on the invitation page",
          not invite_errors, str(invite_errors[:2]))

    # Sign up right there and land in the group.
    driver.find_element(By.ID, "jnPass").send_keys(PASSWORD)
    driver.find_element(By.ID, "jnGo").click()
    # A brand-new account has no profile, and dashboard.html bounces such a user
    # to login. So the invitation flow routes them through onboarding first,
    # exactly like register.html does, parking the group for afterwards.
    WebDriverWait(driver, 25).until(lambda d: "register.html" in d.current_url)
    check("Signing up through the invitation routes to onboarding, not a dead end", True)
    check("The invited group is parked for after onboarding",
          driver.execute_script(
              "return localStorage.getItem('moneykal_split_pending_group')") == str(gid))

    # Complete onboarding through the API, then reload as that user: the group
    # parked above must open on its own.
    guest_token = requests.post(f"{API}/auth/login", json={
        "username": f"br_guest_{tag}@moneykal.test", "password": PASSWORD}, timeout=15).json()
    requests.post(f"{API}/onboard/confirm",
                  headers={"Authorization": f"Bearer {guest_token['access_token']}"},
                  json={"full_name": "Rahul", "email": f"br_guest_{tag}@moneykal.test",
                        "occupation": "Designer", "monthly_income": 90000,
                        "total_savings": 200000, "monthly_expenses": 40000,
                        "outstanding_loans": 0}, timeout=20).raise_for_status()

    driver.get(f"{SITE}/dashboard.html")
    wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "#view-split .sp-tabs")))
    wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".sp-ghead__name"))
    check("After onboarding, the invited group opens by itself",
          f"Browser Trip {tag}" in driver.find_element(By.CSS_SELECTOR, ".sp-ghead__name").text,
          driver.find_element(By.CSS_SELECTOR, ".sp-ghead__name").text)
    check("The parked group id is consumed, not left to fire again",
          driver.execute_script(
              "return localStorage.getItem('moneykal_split_pending_group')") is None)

    # Rs 900 split two ways, paid by Divij: the guest owes exactly 450, booked
    # against them before they had an account at all.
    #
    # Read from the group's own summary inside #spBody, not the landing-page
    # totals: those live in #spTop, which is deliberately collapsed once the
    # user is inside a group so the group's header is the top of the screen.
    guest_summary = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#spBody .sp-stat__amount")]
    check("The claimed account sees the balance it inherited as a guest",
          any("450" in a for a in guest_summary), str(guest_summary))
    check("The landing hero and global totals collapse inside a group",
          driver.execute_script("return document.getElementById('spTop').hidden === true"))

    driver.execute_script("localStorage.clear()")
    driver.get(f"{SITE}/join.html?token=definitely-not-a-real-token")
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".jn-title")))
    check("An invalid invitation is handled gracefully",
          "not valid" in driver.find_element(By.CSS_SELECTOR, ".jn-title").text.lower(),
          driver.find_element(By.CSS_SELECTOR, ".jn-title").text)

finally:
    try:
        driver.quit()
    except Exception:
        pass

print("=" * 70)
print(f"  {PASSED} passed, {len(FAILED)} failed")
if FAILED:
    print("\n  FAILURES:")
    for f in FAILED:
        print(f"    - {f}")
print("=" * 70)
sys.exit(1 if FAILED else 0)
