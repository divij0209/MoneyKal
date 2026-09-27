"""
live.life.fully — browser test.

Drives the overlay in headless Chrome against real seeded data: it opens from
the sidebar, renders a real Freedom Balance with the story that explains it
(the income flow, what is shaping it, the what-if levers and the plain-language
reading), and every interactive part responds.

Most of these assertions exist because the page had silently fallen apart. A
CSS edit put .llf-portal back into the selector list that resets every block on
the page, which handed each of them the sidebar button's display:flex and
padding and collapsed the whole document into one scattered row. Nothing caught
it, because nothing here was tested. So the checks below are deliberately about
*geometry and paint* rather than about content: rows must stack rather than sit
side by side, a label must never overlap its amount, the journey line must be
stroked rather than filled, and the controls must be the themed ones rather
than the browser's defaults.

Needs the API on :8000 and the site on :8080.
  python -m uvicorn backend.main:app --port 8000
  python -m http.server 8080 --directory twin-app

Run with:  python tests/test_live_life_browser.py
"""
import json, os, sys, time, uuid
import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

API = "http://127.0.0.1:8000"
SITE = "http://127.0.0.1:8080"
PW = "Password123!"
OUT = os.path.dirname(os.path.abspath(__file__))
tag = uuid.uuid4().hex[:6]
email = f"llfi_{tag}@moneykal.test"

PASSED, FAILED = 0, []


def check(label, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {detail}")


b = requests.post(f"{API}/auth/register", json={"username": email, "password": PW}).json()
H = {"Authorization": "Bearer " + b["access_token"]}
requests.post(f"{API}/onboard/confirm", headers=H, json={
    "full_name": "Divij Sharma", "email": email, "occupation": "Product Designer",
    "monthly_income": 185000, "total_savings": 940000, "monthly_expenses": 72000,
    "outstanding_loans": 260000, "existing_investments": 415000,
    "goal_title": "Japan trip", "goal_target_amount": 400000}).raise_for_status()
requests.post(f"{API}/home/goals", headers=H, json={
    "name": "Japan trip", "icon": "✈️", "category": "travel",
    "target_amount": 400000, "current_amount": 145000, "is_primary": True})
for t in [{"type": "out", "category": "Food & Dining", "amount": 8400, "description": "Eating out"},
          {"type": "in", "category": "Salary", "amount": 185000, "description": "Salary"}]:
    requests.post(f"{API}/startup/hisaab/transactions", headers=H, json=t)

opts = Options()
opts.add_argument("--headless=new")
opts.add_argument("--window-size=1500,1000")
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
br = webdriver.Chrome(options=opts)
wait = WebDriverWait(br, 25)

br.get(f"{SITE}/dashboard.html")
br.execute_script(
    "localStorage.setItem('twin_session', arguments[0]);"
    "localStorage.setItem('moneykal_ov_theme','dark');",
    json.dumps({"token": b["access_token"], "userId": b["user_id"],
                "username": b["username"], "profileKey": "individual"}))
br.get(f"{SITE}/dashboard.html")
wait.until(EC.presence_of_element_located((By.ID, "llfPortal")))
time.sleep(4)

print("=" * 66)
print("live.life.fully — interaction")
print("=" * 66)

br.find_element(By.ID, "llfPortal").click()
wait.until(lambda d: d.find_element(By.ID, "llf").get_attribute("hidden") is None)
time.sleep(3)
check("Overlay opens from the sidebar", True)

# ---- Freedom balance counted up to a real figure ----
val = br.find_element(By.ID, "llfFreedomValue").text
check("The freedom balance renders a real figure",
      val.strip() not in ("", "N/A") and any(c.isdigit() for c in val), val)

# ---- Layout sanity: nothing collapsed into a row ----
geom = br.execute_script("""
  const rows = [...document.querySelectorAll('.llf-break__row')];
  if (!rows.length) return {rows: 0};
  const tops = rows.map(r => Math.round(r.getBoundingClientRect().top));
  const stacked = new Set(tops).size === tops.length;
  const widths = rows.map(r => r.getBoundingClientRect().width);
  return {rows: rows.length, stacked, minWidth: Math.round(Math.min(...widths))};
""")
check("Breakdown rows stack vertically, not side by side",
      geom.get("rows", 0) >= 3 and geom.get("stacked"), str(geom))
check("Breakdown rows are full width, not crushed",
      geom.get("minWidth", 0) > 500, str(geom))

# ---- The story explains the number on the first screen ----
story = br.execute_script("""
  const bar = document.querySelector('.llf-flow__bar');
  const segs = [...document.querySelectorAll('.llf-flow__seg')];
  const reading = document.querySelector('.llf-fb__reading-title');
  const result = document.querySelector('.llf-flow__step.is-result');
  return {
    lead: (document.querySelector('.llf-fb__lead') || {}).textContent || '',
    reading: reading ? reading.textContent : '',
    readingOnScreen: reading ? reading.getBoundingClientRect().bottom < innerHeight : false,
    barOnScreen: bar ? bar.getBoundingClientRect().bottom < innerHeight : false,
    barWidth: bar ? bar.getBoundingClientRect().width : 0,
    segSum: segs.reduce((a, s) => a + s.getBoundingClientRect().width, 0),
    result: result ? result.textContent : ''
  };
""")
check("The figure is followed by what it means, in words",
      story["lead"].strip() and story["reading"].strip(), str(story))
check("Figure, reading and the income bar share the first screen",
      story["readingOnScreen"] and story["barOnScreen"], str(story))
check("The income bar's cuts fill it exactly",
      story["barWidth"] > 0 and abs(story["barWidth"] - story["segSum"]) < 2, str(story))
check("The sum under the bar ends in what is left to decide about",
      "Left to decide about" in story["result"] or "Short this month" in story["result"], story["result"])

# ---- Levers preview a change without leaving the page ----
levers = br.find_elements(By.CSS_SELECTOR, "[data-llf-lever]")
if levers:
    br.execute_script("arguments[0].scrollIntoView({block:'center'})", levers[0])
    time.sleep(1.0)
    before = br.find_element(By.ID, "llfLeverValue").text
    br.execute_script("arguments[0].click()", levers[0])
    time.sleep(1.0)
    after = br.find_element(By.ID, "llfLeverValue").text
    check("Picking a lever previews a different Freedom Balance",
          after != before and any(c.isdigit() for c in after), f"{before} -> {after}")
    check("The Simulate hand-off unlocks once a change is picked",
          br.find_element(By.CSS_SELECTOR, "[data-llf-simulate]").is_enabled())
    br.execute_script("arguments[0].click()", levers[0])
    time.sleep(0.8)
    check("Un-picking it returns to today's figure",
          br.find_element(By.ID, "llfLeverValue").text == before)
else:
    print("  (no levers for this dataset)")

check("A plain-language reading closes the story",
      len(br.find_elements(By.CSS_SELECTOR, ".llf-meaning__p")) >= 2)

# ---- Labels and amounts do not overlap ----
overlap = br.execute_script("""
  const bad = [];
  for (const r of document.querySelectorAll('.llf-break__row')) {
    const l = r.querySelector('.llf-break__label');
    const a = r.querySelector('.llf-break__amt');
    if (!l || !a) continue;
    const lb = l.getBoundingClientRect(), ab = a.getBoundingClientRect();
    if (lb.right > ab.left + 1) bad.push(l.textContent.trim().slice(0, 24));
  }
  return bad;
""")
check("Label and amount never overlap", not overlap, str(overlap))

# ---- The journey line draws as a stroke, not a filled blob ----
# It paints on reveal, so bring it into view and let the observer fire.
br.execute_script(
    "const f=document.querySelector('.llf-prog'); if (f) f.scrollIntoView({block:'center'});")
time.sleep(2.0)
art = br.execute_script("""
  const f = document.querySelector('.llf-prog__fill');
  if (!f) return null;
  const cs = getComputedStyle(f);
  return {fill: cs.fill, stroke: cs.stroke, dash: f.style.strokeDasharray || '',
          offset: f.style.strokeDashoffset || ''};
""")
check("Journey line is stroked, with no black fill",
      art and art["fill"] in ("none", "rgba(0, 0, 0, 0)"), str(art))
check("Journey line is dash-animated to its percentage",
      art and art["dash"] and art["offset"], str(art))

# ---- Duplicate category emoji is gone ----
dup = br.execute_script("""
  const bg = document.querySelector('.llf-cat__bg-emoji');
  return bg ? getComputedStyle(bg).display : 'absent';
""")
check("The duplicated backdrop emoji is hidden", dup in ("none", "absent"), str(dup))

# ---- "of" spacing ----
runon = br.execute_script("""
  return [...document.querySelectorAll('.llf-cat__of, .llf-stash__target')]
    .map(e => Math.round(parseFloat(getComputedStyle(e).marginLeft)));
""")
check("A gap separates the saved figure from 'of <target>'",
      runon and all(m >= 4 for m in runon), str(runon))

# ---- Quick amount chips are styled, not browser default ----
chip = br.execute_script("""
  const c = document.querySelector('.llf-quick');
  if (!c) return null;
  const cs = getComputedStyle(c);
  return {bg: cs.backgroundColor, radius: cs.borderRadius, color: cs.color};
""")
check("Preset amount chips are themed, not white default buttons",
      chip and chip["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), str(chip))

# ---- Clicking a preset fills the amount field ----
chips = br.find_elements(By.CSS_SELECTOR, "[data-llf-quick]")
if chips:
    br.execute_script("arguments[0].scrollIntoView({block:'center'})", chips[1])
    time.sleep(0.6)
    br.execute_script("arguments[0].click()", chips[1])
    time.sleep(1.5)
    filled = br.execute_script(
        "const i=document.querySelector('.llf-check__input'); return i ? i.value : '';")
    check("Clicking a preset amount fills the field", bool(filled), repr(filled))
else:
    check("Clicking a preset amount fills the field", False, "no chips found")

# ---- The tradeoff slider is custom and reacts ----
sl = br.find_elements(By.ID, "llfTradeoffSlider")
if sl:
    style = br.execute_script("""
      const s = document.getElementById('llfTradeoffSlider');
      return {appearance: getComputedStyle(s).webkitAppearance,
              bg: getComputedStyle(s).backgroundImage.slice(0, 30)};
    """)
    check("Slider is a custom control, not the native widget",
          style["appearance"] == "none" and "gradient" in style["bg"], str(style))

    br.execute_script(
        "document.getElementById('llfTradeoffSlider').scrollIntoView({block:'center'});")
    time.sleep(1.2)
    before = br.find_element(By.ID, "llfTradeoffResult").text
    br.execute_script("""
      const s = document.getElementById('llfTradeoffSlider');
      s.value = 4000;
      s.dispatchEvent(new Event('input', {bubbles: true}));
    """)
    time.sleep(1.2)
    after = br.find_element(By.ID, "llfTradeoffResult").text
    shown = br.find_element(By.ID, "llfTradeoffVal").text
    fill = br.execute_script(
        "return document.getElementById('llfTradeoffSlider').style.getPropertyValue('--llf-fill');")
    check("Dragging the slider recomputes the impact", after != before and len(after) > 10, after[:70])
    check("The slider's value is echoed above it", "4" in shown, shown)
    check("The slider track fills as it moves", fill and fill != "0%", repr(fill))
else:
    print("  (no tradeoff slider for this dataset)")

# ---- Disclosure toggles ----
why = br.find_elements(By.CSS_SELECTOR, "[data-llf-why]")
if why:
    br.execute_script("arguments[0].scrollIntoView({block:'center'})", why[0])
    time.sleep(0.5)
    body = br.find_element(By.CSS_SELECTOR, ".llf-why__body")
    was = body.get_attribute("hidden") is not None
    br.execute_script("arguments[0].click()", why[0])
    time.sleep(1.0)
    now = br.find_element(By.CSS_SELECTOR, ".llf-why__body").get_attribute("hidden") is not None
    check("'How is this worked out?' opens the working", was and not now, f"{was} -> {now}")

# ---- Closing ----
br.execute_script("document.getElementById('llfClose').click()")
time.sleep(1.5)
check("The overlay closes again",
      br.execute_script("return document.getElementById('llf').hasAttribute('hidden')"))

errs = [l["message"][:150] for l in br.get_log("browser")
        if l["level"] == "SEVERE" and "favicon" not in l["message"]
        and "Failed to load resource" not in l["message"]]
check("No JavaScript errors throughout", not errs, str(errs[:2]))

br.quit()
print("=" * 66)
print(f"  {PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print("    -", f)
print("=" * 66)
sys.exit(1 if FAILED else 0)
