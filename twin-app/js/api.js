
/* Resolved by js/config.js, which must load first. Kept as a local const so
   every existing reference in this file is unchanged. The fallback keeps the
   file working if it is ever loaded on a page that forgot config.js. */
const API_BASE = (typeof window !== 'undefined' && window.API_BASE)
  ? window.API_BASE
  : `http://${(!window.location.hostname || window.location.hostname === 'localhost') ? '127.0.0.1' : window.location.hostname}:8000`;

function getHeaders() {
    const headers = { "Content-Type": "application/json" };
    const session = JSON.parse(localStorage.getItem("twin_session") || "{}");
    if (session.token) {
        headers["Authorization"] = `Bearer ${session.token}`;
    }
    return headers;
}

async function login(username, password) {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });
    if (!res.ok) throw new Error("Login failed");
    return await res.json();
}

async function scanReceipt(file) {
    const formData = new FormData();
    formData.append("file", file);
    const session = JSON.parse(localStorage.getItem("twin_session") || "{}");
    const headers = {};
    if (session.token) {
        headers["Authorization"] = `Bearer ${session.token}`;
    }
    const res = await fetch(`${API_BASE}/hisaab/scan-receipt`, {
        method: "POST",
        headers: headers,
        body: formData
    });
    if (!res.ok) {
        const text = await res.text();
        let msg = "Failed to scan receipt";
        try {
            const j = JSON.parse(text);
            msg = j.detail || msg;
        } catch(e){}
        throw new Error(msg);
    }
    return await res.json();
}

async function fetchProfile() {
    const res = await fetch(`${API_BASE}/profile/me`, { headers: getHeaders() });
    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem('twin_session');
            window.location.href = 'login.html?expired=true';
        }
        throw new Error("Failed to fetch profile");
    }
    return await res.json();
}

/* A failed response as an Error that keeps the status and the server's detail.
   A 402 carries {error, feature, …} and the caller shows an upgrade prompt
   rather than an error, so that payload has to survive the throw. The message
   is the server's own when it sent a string, else `fallback`. */
async function responseError(res, fallback) {
    const body = await res.json().catch(() => null);
    const detail = body && body.detail;
    const err = new Error((typeof detail === 'string' && detail) || (detail && detail.message) || fallback);
    err.status = res.status;
    err.detail = detail;
    return err;
}

async function askTwin(message, sessionId = null) {
    const res = await fetch(`${API_BASE}/twin/chat`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ message, session_id: sessionId })
    });
    if (!res.ok) throw await responseError(res, "Chat failed");
    return await res.json();
}

async function getChatSessions() {
    const res = await fetch(`${API_BASE}/twin/chats`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch chats");
    return await res.json();
}

async function getChatSession(sessionId) {
    const res = await fetch(`${API_BASE}/twin/chats/${sessionId}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch chat session");
    return await res.json();
}

async function simulateDecision(decisionId, commitmentPct) {
    const res = await fetch(`${API_BASE}/twin/simulate`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ decision_id: decisionId, commitment_pct: commitmentPct })
    });
    if (!res.ok) throw new Error("Simulation failed");
    return await res.json();
}

// `decisionContext` is the hand-off from Ask Twin's contextual Simulation CTA:
// everything the conversation established (amount, purpose, horizon, stated
// risk constraints, the computed risk position). When present the backend uses
// those facts instead of re-parsing the sentence, so the user is never asked
// again for something they already answered. A scenario typed straight into the
// Simulate box sends null and takes the original server path unchanged.
async function simulateScenario(scenario, decisionContext = null, sessionId = null) {
    const res = await fetch(`${API_BASE}/twin/simulate-scenario`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
            scenario,
            decision_context: decisionContext,
            session_id: sessionId
        })
    });
    if (!res.ok) throw await responseError(res, "Simulation failed");
    return await res.json();
}

async function parseStatement(file) {
    const formData = new FormData();
    formData.append("file", file);
    
    // We cannot use getHeaders directly because Content-Type must be unset for FormData
    const headers = {};
    const session = JSON.parse(localStorage.getItem("twin_session") || "{}");
    if (session.token) {
        headers["Authorization"] = `Bearer ${session.token}`;
    }
    
    const res = await fetch(`${API_BASE}/onboard/parse-statement`, {
        method: "POST",
        headers: headers,
        body: formData
    });
    if (!res.ok) throw new Error("Parse failed");
    return await res.json();
}

async function confirmProfile(userId, persona, metrics) {
    const res = await fetch(`${API_BASE}/onboard/confirm`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ user_id: userId, persona, metrics })
    });
    if (!res.ok) throw new Error("Confirm failed");
    return await res.json();
}

async function startupOnboard(payload) {
    const res = await fetch(`${API_BASE}/onboard/startup`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Startup onboarding failed");
    }
    return await res.json();
}

async function fetchStartupOverview() {
    const res = await fetch(`${API_BASE}/startup/overview`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch startup overview");
    return await res.json();
}

async function fetchStartupHisaab() {
    const res = await fetch(`${API_BASE}/startup/hisaab`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch Hisaab");
    return await res.json();
}

async function addStartupTransaction(payload) {
    const res = await fetch(`${API_BASE}/startup/hisaab/transactions`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to add transaction");
    }
    return await res.json();
}

async function updateStartupTransaction(txnId, payload) {
    const res = await fetch(`${API_BASE}/startup/hisaab/transactions/${txnId}`, {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to update transaction");
    }
    return await res.json();
}

async function deleteStartupTransaction(txnId) {
    const res = await fetch(`${API_BASE}/startup/hisaab/transactions/${txnId}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to delete transaction");
    }
    return await res.json();
}

async function fetchWeeklyReport() {
    const res = await fetch(`${API_BASE}/startup/reports/weekly`, { headers: getHeaders() });
    if (!res.ok) throw await responseError(res, "Failed to fetch weekly report");
    return await res.json();
}

async function fetchWeeklySuggestions() {
    const res = await fetch(`${API_BASE}/startup/reports/weekly-suggestions`, { headers: getHeaders() });
    if (!res.ok) throw await responseError(res, "Failed to fetch weekly suggestions");
    return await res.json();
}

async function fetchWeeklySuggestionsHistory() {
    const res = await fetch(`${API_BASE}/startup/reports/weekly-suggestions/history`, { headers: getHeaders() });
    if (!res.ok) throw await responseError(res, "Failed to fetch report history");
    return await res.json();
}

async function fetchWeeklySuggestionsById(reportId) {
    const res = await fetch(`${API_BASE}/startup/reports/weekly-suggestions/${reportId}`, { headers: getHeaders() });
    if (!res.ok) throw await responseError(res, "Failed to fetch saved report");
    return await res.json();
}

/* ---- Startup: Fundraise Readiness ----
   `stage` is optional and only re-selects which benchmark table the backend
   scores against; it never alters the underlying figures. */
async function fetchFundraiseReadiness(stage) {
    const qs = stage ? `?stage=${encodeURIComponent(stage)}` : "";
    const res = await fetch(`${API_BASE}/startup/fundraise/readiness${qs}`, { headers: getHeaders() });
    if (!res.ok) throw new Error(await startupErrorDetail(res, "Failed to fetch fundraise readiness"));
    return await res.json();
}

/* The Startup feature routers answer a refused request with a specific,
   founder-readable `detail` ("Line 2: amount cannot be negative"). Surface it
   instead of a generic failure, falling back when the body is not JSON. */
async function startupErrorDetail(res, fallback) {
    try {
        const body = await res.json();
        if (body && typeof body.detail === "string") return body.detail;
    } catch (_) { /* not JSON */ }
    return fallback;
}

async function fetchFundraiseBenchmarks() {
    const res = await fetch(`${API_BASE}/startup/fundraise/benchmarks`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch benchmarks");
    return await res.json();
}

/* ---- Startup: Compliance Center ----
   `amountsAre` decides whether logged amounts are read as GST-inclusive or
   exclusive. The difference is material, which is why it is a parameter. */
async function fetchCompliance(fy, amountsAre) {
    const params = new URLSearchParams();
    if (fy) params.set("fy", fy);
    if (amountsAre) params.set("amounts_are", amountsAre);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${API_BASE}/startup/compliance${qs}`, { headers: getHeaders() });
    if (!res.ok) throw new Error(await startupErrorDetail(res, "Failed to fetch compliance calendar"));
    return await res.json();
}

/* Record filed / not applicable / the amount due, for one or many deadlines.
   Each item: { obligation_id, due_date, status, filed_on?, amount?, note? }. */
async function saveComplianceFilings(filings) {
    const res = await fetch(`${API_BASE}/startup/compliance/filings`, {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify({ filings })
    });
    if (!res.ok) throw new Error(await startupErrorDetail(res, "Could not save the filing"));
    return await res.json();
}

async function deleteComplianceFiling(obligationId, dueDate) {
    const params = new URLSearchParams({ obligation_id: obligationId, due_date: dueDate });
    const res = await fetch(`${API_BASE}/startup/compliance/filings?${params.toString()}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error(await startupErrorDetail(res, "Could not undo the filing"));
    return await res.json();
}

async function fetchComplianceConfig() {
    const res = await fetch(`${API_BASE}/startup/compliance/config`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch compliance config");
    return await res.json();
}

/* ---- Startup: GST Calculator ----
   Rates, slabs and thresholds all come from /startup/gst/config so nothing
   statutory is hardcoded in the frontend. */
async function fetchGstConfig() {
    const res = await fetch(`${API_BASE}/startup/gst/config`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch GST config");
    return await res.json();
}

async function calculateGst(payload) {
    const res = await fetch(`${API_BASE}/startup/gst/calculate`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await startupErrorDetail(res, "GST calculation failed"));
    return await res.json();
}

async function checkGstin(value) {
    const res = await fetch(`${API_BASE}/startup/gst/gstin?value=${encodeURIComponent(value)}`,
        { headers: getHeaders() });
    if (!res.ok) throw new Error("GSTIN check failed");
    return await res.json();
}

async function searchHsn(q) {
    const res = await fetch(`${API_BASE}/startup/gst/hsn?q=${encodeURIComponent(q || "")}`,
        { headers: getHeaders() });
    if (!res.ok) throw new Error("HSN search failed");
    return await res.json();
}

async function fetchGstProfile(fy) {
    const qs = fy ? `?fy=${encodeURIComponent(fy)}` : "";
    const res = await fetch(`${API_BASE}/startup/gst/profile${qs}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load saved GST working set");
    return await res.json();
}

async function saveGstProfile(fy, request) {
    const res = await fetch(`${API_BASE}/startup/gst/profile`, {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify({ fy: fy || null, request })
    });
    if (!res.ok) throw new Error(await startupErrorDetail(res, "Failed to save GST working set"));
    return await res.json();
}

async function onboardingChat(messages) {
    const res = await fetch(`${API_BASE}/onboard/chat`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ messages })
    });
    if (!res.ok) throw new Error("Chat failed");
    return await res.json();
}

async function renameChatSession(sessionId, title) {
    const res = await fetch(`${API_BASE}/twin/chats/${sessionId}`, {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error("Failed to rename chat");
    return await res.json();
}

// --- Simulation history ---------------------------------------------------
// Every completed run of /twin/simulate-scenario is stored against the profile,
// so the Simulate tab opens with what this account has already explored — from
// the website or the phone — and any of those runs can be reopened in full.

async function getSimulations(limit = 50) {
    const res = await fetch(`${API_BASE}/twin/simulations?limit=${limit}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch simulation history");
    return await res.json();
}

// Returns the response the pipeline produced when the run happened, not a fresh
// simulation — reopening a decision should show the numbers it was made on.
async function getSimulation(runId) {
    const res = await fetch(`${API_BASE}/twin/simulations/${runId}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to open that simulation");
    return await res.json();
}

async function deleteSimulation(runId) {
    const res = await fetch(`${API_BASE}/twin/simulations/${runId}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error("Failed to delete that simulation");
    return await res.json();
}

async function deleteChatSession(sessionId) {
    const res = await fetch(`${API_BASE}/twin/chats/${sessionId}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error("Failed to delete chat");
    return await res.json();
}

// Voice mode (Vapi). The browser gets a call configuration only — the public
// key plus a short-lived, user-scoped session token minted from this bearer
// token. No financial data and no user id are ever sent from the client.
async function startVoiceSession() {
    const res = await fetch(`${API_BASE}/voice/session`, {
        method: "POST",
        headers: getHeaders()
    });
    if (!res.ok) throw await responseError(res, "Could not start voice session");
    return await res.json();
}

async function triggerOmnidimCall(phone, reason) {
    const res = await fetch(`${API_BASE}/voice/omnidim/call`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ phone: phone || null, reason: reason || "financial update" })
    });
    // responseError carries the backend's own message, which matters here:
    // 400 no_phone_number and 402 quota_exceeded both need to be shown as
    // written rather than flattened into "could not trigger call".
    if (!res.ok) throw await responseError(res, "Could not trigger the call");
    return await res.json();
}


async function getVoiceStatus() {
    const res = await fetch(`${API_BASE}/voice/status`, { headers: getHeaders() });
    if (!res.ok) return { enabled: false };
    return await res.json();
}

async function fetchMarketPulse() {
    const res = await fetch(`${API_BASE}/market-pulse`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch market pulse");
    return await res.json();
}

/* Avatar upload. Deliberately does NOT set Content-Type: the browser has to
   generate the multipart boundary itself, and setting the header by hand is
   the classic way to make a multipart POST fail with a 422. */
/* Save edits from the account centre. Routes to whichever update endpoint
   matches the persona — both already exist and both take a partial body, so
   only the fields the user actually changed are sent. */
async function updateProfileDetails(payload, persona) {
    const path = persona === 'startup' ? '/onboard/startup/update' : '/onboard/individual/update';
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // FastAPI validation errors arrive as a list of {loc, msg}; surface the
        // first one rather than "[object Object]".
        let msg = data.detail;
        if (Array.isArray(msg)) msg = msg[0] && (msg[0].msg || JSON.stringify(msg[0]));
        throw new Error(msg || 'Could not save those changes.');
    }
    return data;
}

async function uploadAvatar(file) {
    const body = new FormData();
    body.append('file', file);
    const headers = getHeaders();
    delete headers['Content-Type'];
    const res = await fetch(`${API_BASE}/profile/avatar`, { method: 'POST', headers, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Could not upload that picture.');
    return data;
}

async function removeAvatar() {
    const res = await fetch(`${API_BASE}/profile/avatar`, { method: 'DELETE', headers: getHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Could not remove the picture.');
    return data;
}

async function fetchRiskProfile() {
    const res = await fetch(`${API_BASE}/profile/risk`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch risk profile");
    return await res.json();
}

async function getGmailStatus() {
    const res = await fetch(`${API_BASE}/gmail/status`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to fetch Gmail status");
    return await res.json();
}

async function syncGmailNow() {
    const res = await fetch(`${API_BASE}/gmail/sync-now`, { method: "POST", headers: getHeaders() });
    if (!res.ok) throw await responseError(res, "Gmail sync failed");
    return await res.json();
}

async function disconnectGmail(email) {
    const url = email ? `${API_BASE}/gmail/disconnect?email=${encodeURIComponent(email)}` : `${API_BASE}/gmail/disconnect`;
    const res = await fetch(url, { method: "POST", headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to disconnect Gmail");
    return await res.json();
}

/* ---------------------------------------------------------------- Daily Home
   One consolidated read for the dashboard, plus CRUD for the two things it
   owns. The local hour and date are sent so the greeting and "this month"
   follow the user's own clock rather than the server's timezone. */

async function fetchHome() {
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const qs = `?local_hour=${now.getHours()}&local_date=${localDate}`;
    const res = await fetch(`${API_BASE}/home${qs}`, { headers: getHeaders() });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to load your dashboard");
    }
    return await res.json();
}

async function createGoal(payload) {
    const res = await fetch(`${API_BASE}/home/goals`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to create goal");
    }
    return await res.json();
}

async function updateGoal(goalId, payload) {
    const res = await fetch(`${API_BASE}/home/goals/${goalId}`, {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to update goal");
    }
    return await res.json();
}

async function deleteGoal(goalId) {
    const res = await fetch(`${API_BASE}/home/goals/${goalId}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error("Failed to delete goal");
    return await res.json();
}

async function createUpcoming(payload) {
    const res = await fetch(`${API_BASE}/home/upcoming`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to add upcoming payment");
    }
    return await res.json();
}

async function markUpcomingPaid(itemId) {
    const res = await fetch(`${API_BASE}/home/upcoming/${itemId}/mark-paid`, {
        method: "POST",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error("Failed to mark as paid");
    return await res.json();
}

async function deleteUpcoming(itemId) {
    const res = await fetch(`${API_BASE}/home/upcoming/${itemId}`, {
        method: "DELETE",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error("Failed to delete upcoming payment");
    return await res.json();
}

/* Detected obligations awaiting the user's yes/no. MoneyKal never promotes one
   of these on its own — these two calls are the only way a suggestion becomes a
   real upcoming payment. */

async function confirmUpcoming(itemId, corrections) {
    const res = await fetch(`${API_BASE}/home/upcoming/${itemId}/confirm`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(corrections || {})
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to confirm payment");
    }
    return await res.json();
}

async function dismissUpcoming(itemId) {
    const res = await fetch(`${API_BASE}/home/upcoming/${itemId}/dismiss`, {
        method: "POST",
        headers: getHeaders()
    });
    if (!res.ok) throw new Error("Failed to dismiss suggestion");
    return await res.json();
}

async function fetchUpcomingSuggestions() {
    const res = await fetch(`${API_BASE}/home/upcoming/suggestions`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Failed to load suggestions");
    return await res.json();
}

/* One month of financial events. Deliberately separate from fetchHome(): month
   navigation should not re-fetch the whole dashboard on every arrow press. */
async function fetchHomeCalendar(year, month) {
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const res = await fetch(`${API_BASE}/home/calendar?year=${year}&month=${month}&local_date=${localDate}`,
        { headers: getHeaders() });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Failed to load that month");
    }
    return await res.json();
}

/* ------------------------------------------------------- live.life.fully
   The guilt-free lifestyle layer. One consolidated read, plus the "can I
   afford it" check. Everything this feature *writes* goes through the goal
   endpoints above — an experience stash is a FinancialGoal, so createGoal()
   and updateGoal() are reused rather than mirrored here. */

async function fetchLiveLife() {
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const res = await fetch(`${API_BASE}/live-life?local_date=${localDate}`, { headers: getHeaders() });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Could not load your Freedom Balance");
    }
    return await res.json();
}

/* ============ Tax Calculator (Individual) ============ */

/**
 * Statutory figures for a tax year — slabs, limits, deduction sections, ITR
 * rules. Served by the backend so no rate is ever duplicated in the frontend.
 */
async function fetchTaxConfig(taxYear) {
    const qs = taxYear ? `?tax_year=${encodeURIComponent(taxYear)}` : "";
    const res = await fetch(`${API_BASE}/tax/config${qs}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Could not load tax configuration");
    return await res.json();
}

/** Aggregate income heads without saving. Used for the live summary. */
async function collectTaxIncome(payload) {
    const res = await fetch(`${API_BASE}/tax/collect`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw await responseError(res, "Could not compute income summary");
    return await res.json();
}

/** Load saved inputs for a tax year. Returns empty defaults when none exist. */
async function fetchTaxProfile(taxYear) {
    const qs = taxYear ? `?tax_year=${encodeURIComponent(taxYear)}` : "";
    const res = await fetch(`${API_BASE}/tax/profile${qs}`, { headers: getHeaders() });
    if (!res.ok) throw new Error("Could not load your saved tax details");
    return await res.json();
}

/** Persist inputs for a tax year. */
async function saveTaxProfile(payload, taxYear) {
    const qs = taxYear ? `?tax_year=${encodeURIComponent(taxYear)}` : "";
    const res = await fetch(`${API_BASE}/tax/profile${qs}`, {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Could not save your tax details");
    }
    return await res.json();
}

async function checkExperienceAffordability(amount, goalId) {
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const res = await fetch(`${API_BASE}/live-life/check`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ amount, goal_id: goalId || null, local_date: localDate })
    });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.detail) || "Could not check that amount");
    }
    return await res.json();
}

async function generateItinerary(payload) {
    const res = await fetch(`${API_BASE}/live-life/itinerary`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("Could not generate itinerary");
    return await res.json();
}

async function runSweep() {
    // The route lives under the live.life.fully router (backend/routers/live_life.py).
    const res = await fetch(`${API_BASE}/live-life/sweep`, {
        method: "POST",
        headers: getHeaders()
    });
    if (!res.ok) throw await responseError(res, "Sweep failed");
    return await res.json();
}


/* ==========================================================================
   Money Splits + Notifications

   One helper does the work for all of them. The Split API is wide (30 routes)
   and every call shares the same three needs: send the bearer token, surface
   the server's own error message rather than a generic one, and tolerate a 204
   with no body. Writing that out per endpoint is how error handling drifts.
   ========================================================================== */

async function splitFetch(path, { method = 'GET', body = null, params = null } = {}) {
    let url = `${API_BASE}${path}`;
    if (params) {
        const qs = new URLSearchParams(
            Object.entries(params).filter(([, v]) => v !== null && v !== undefined)
        ).toString();
        if (qs) url += `?${qs}`;
    }
    const opts = { method, headers: getHeaders() };
    if (body !== null) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (res.status === 204) return null;

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }

    if (!res.ok) {
        const err = new Error(
            (data && (typeof data.detail === 'string' ? data.detail : data.detail?.message))
            || `Request failed (${res.status})`
        );
        err.status = res.status;
        // 402 carries {error, feature, message} — the caller shows an upgrade
        // prompt rather than an error, so the payload has to survive.
        err.detail = data && data.detail;
        throw err;
    }
    return data;
}

const splitApi = {
    me:              ()                  => splitFetch('/split/me'),
    entitlements:    ()                  => splitFetch('/split/entitlements'),

    friends:         ()                  => splitFetch('/split/friends'),
    friend:          (id)                => splitFetch(`/split/friends/${id}`),
    searchPeople:    (q)                 => splitFetch('/split/friends/search', { params: { q } }),
    addFriend:       (payload)           => splitFetch('/split/friends', { method: 'POST', body: payload }),

    groups:          (includeArchived)   => splitFetch('/split/groups', { params: { include_archived: !!includeArchived } }),
    group:           (id)                => splitFetch(`/split/groups/${id}`),
    createGroup:     (payload)           => splitFetch('/split/groups', { method: 'POST', body: payload }),
    updateGroup:     (id, payload)       => splitFetch(`/split/groups/${id}`, { method: 'PUT', body: payload }),
    addMember:       (id, payload)       => splitFetch(`/split/groups/${id}/members`, { method: 'POST', body: payload }),
    removeMember:    (id, personId)      => splitFetch(`/split/groups/${id}/members/${personId}`, { method: 'DELETE' }),
    groupAnalytics:  (id)                => splitFetch(`/split/groups/${id}/analytics`),
    exportGroup:     (id)                => splitFetch(`/split/groups/${id}/export`),

    invite:          (payload)           => splitFetch('/split/invitations', { method: 'POST', body: payload }),
    previewInvite:   (token)             => splitFetch(`/split/invite/${token}`),
    acceptInvite:    (token)             => splitFetch(`/split/invite/${token}/accept`, { method: 'POST' }),

    expenses:        (params)            => splitFetch('/split/expenses', { params }),
    expense:         (id)                => splitFetch(`/split/expenses/${id}`),
    createExpense:   (payload)           => splitFetch('/split/expenses', { method: 'POST', body: payload }),
    updateExpense:   (id, payload)       => splitFetch(`/split/expenses/${id}`, { method: 'PUT', body: payload }),
    deleteExpense:   (id)                => splitFetch(`/split/expenses/${id}`, { method: 'DELETE' }),

    settle:          (payload)           => splitFetch('/split/settlements', { method: 'POST', body: payload }),
    deleteSettlement:(id)                => splitFetch(`/split/settlements/${id}`, { method: 'DELETE' }),

    activity:        (params)            => splitFetch('/split/activity', { params })
};

/* ------------------------------------------------- Daily AI Insights schedule
   The Overview's Schedule dialog. Separate from the profile edit form it used
   to open: these write only the schedule, and the frequency list comes back
   from the server so the dialog cannot offer an option the scheduler has no
   way to honour. */
const insightScheduleApi = {
    get:    ()  => splitFetch('/home/insight-schedule'),
    save:   (p) => splitFetch('/home/insight-schedule', { method: 'PUT', body: p }),
    runNow: ()  => splitFetch('/home/insight-schedule/run-now', { method: 'POST' })
};

const notificationsApi = {
    list:        (params)  => splitFetch('/notifications', { params }),
    unreadCount: ()        => splitFetch('/notifications/unread-count'),
    markRead:    (ids)     => splitFetch('/notifications/read', { method: 'POST', body: { notification_ids: ids || null } }),
    preferences: ()        => splitFetch('/notifications/preferences'),
    savePreferences: (p)   => splitFetch('/notifications/preferences', { method: 'PUT', body: p })
};

/* ------------------------------------------------------------ Plans & Billing
   Checkout is three calls: price the order, ask for its UPI QR, then confirm
   payment. The QR and the amount inside it are built by the server from the
   order it already priced, so the browser never decides what is owed. Card,
   UPI and bank details never pass through this client. */
const billingApi = {
    me:          ()                  => splitFetch('/billing/me'),
    catalog:     ()                  => splitFetch('/billing/catalog'),
    orders:      ()                  => splitFetch('/billing/orders'),
    coins:       ()                  => splitFetch('/billing/coins'),
    createOrder: (sku, subjectRef, useCoins = true) =>
                   splitFetch('/billing/orders', { method: 'POST', body: { sku, subject_ref: subjectRef || null, use_coins: useCoins } }),
    setOrderCoins: (id, useCoins)    => splitFetch(`/billing/orders/${id}/coins`, { method: 'POST', body: { use_coins: useCoins } }),
    startUpiQr:  (id)                => splitFetch(`/billing/orders/${id}/upi-qr`, { method: 'POST', body: {} }),
    payOrder:    (id, method, reference = null) =>
                   splitFetch(`/billing/orders/${id}/pay`, { method: 'POST', body: { payment_method: method, transaction_reference: reference } })
};

window.api = {
    login,
    getGmailStatus,
    syncGmailNow,
    updateProfileDetails,
    uploadAvatar,
    removeAvatar,
    fetchRiskProfile,
    disconnectGmail,
    fetchProfile,
    fetchMarketPulse,
    askTwin,
    getChatSessions,
    getChatSession,
    simulateDecision,
    simulateScenario,
    getSimulations,
    getSimulation,
    deleteSimulation,
    parseStatement,
    confirmProfile,
    onboardingChat,
    renameChatSession,
    deleteChatSession,
    startupOnboard,
    fetchStartupOverview,
    fetchStartupHisaab,
    addStartupTransaction,
    updateStartupTransaction,
    deleteStartupTransaction,
    fetchWeeklyReport,
    fetchWeeklySuggestions,
    fetchWeeklySuggestionsHistory,
    fetchWeeklySuggestionsById,
    fetchFundraiseReadiness,
    fetchFundraiseBenchmarks,
    fetchCompliance,
    fetchComplianceConfig,
    saveComplianceFilings,
    deleteComplianceFiling,
    fetchGstConfig,
    calculateGst,
    checkGstin,
    searchHsn,
    fetchGstProfile,
    saveGstProfile,
    scanReceipt,
    startVoiceSession,
    triggerOmnidimCall,
    getVoiceStatus,
    fetchHome,
    fetchHomeCalendar,
    createGoal,
    updateGoal,
    deleteGoal,
    createUpcoming,
    markUpcomingPaid,
    deleteUpcoming,
    confirmUpcoming,
    dismissUpcoming,
    fetchUpcomingSuggestions,
    fetchLiveLife,
    checkExperienceAffordability,
    fetchTaxConfig,
    collectTaxIncome,
    fetchTaxProfile,
    saveTaxProfile,
    generateItinerary,
    runSweep,
    split: splitApi,
    notifications: notificationsApi,
    insightSchedule: insightScheduleApi,
    billing: billingApi
};
