"""Market Pulse — a thin personalization layer over the existing news service.

This module adds no new news provider. It reuses
`MarketIntelligenceService` (and through it `NewsAPIClient` and the existing
Redis/DB cache) for the raw articles, then does three things on top:

  1. reads the signals that already exist on the user's profile,
  2. ranks the fetched articles against those signals,
  3. asks the existing `gemini_service` for a short "why this matters to you"
     line per article, falling back to a deterministic sentence if the model
     is unavailable.

Nothing here invents user data: every signal is read from the profile,
startup/enterprise record, or the user's own transactions, and a signal that
isn't present simply drops out of the ranking.
"""

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.market_intelligence.service import MarketIntelligenceService
from backend.models.domain import NewsItem, Profile, StartupTransaction
from backend.services.gemini_service import gemini_service

logger = logging.getLogger(__name__)

MAX_SIGNALS = 5
NEWS_CACHE_SECONDS = 2700          # 45 min — shared across users, keyed by query


# --------------------------------------------------------------------------
# Topics. Each is a query for the existing NewsAPIClient plus the keywords we
# score headlines against and the user signal that makes it relevant.
# --------------------------------------------------------------------------
TOPICS: List[Dict[str, Any]] = [
    {
        "id": "rates",
        "label": "RBI & RATES",
        "query": "RBI repo rate OR interest rates India",
        "keywords": ["rbi", "repo", "interest rate", "rate cut", "rate hike", "lending",
                     "monetary policy", "emi", "loan", "borrowing", "credit"],
        "needs": "debt",
    },
    {
        "id": "fx",
        "label": "USD / INR",
        "query": "rupee dollar exchange rate India",
        "keywords": ["rupee", "usd", "inr", "dollar", "currency", "forex", "fx",
                     "exchange rate", "import", "export"],
        "needs": "fx",
    },
    {
        "id": "markets",
        "label": "MARKETS",
        "query": "Sensex Nifty Indian stock market",
        "keywords": ["sensex", "nifty", "stock", "equity", "market", "shares",
                     "mutual fund", "investor", "ipo", "rally", "correction"],
        "needs": "investments",
    },
    {
        "id": "inflation",
        "label": "INFLATION & COSTS",
        "query": "India inflation CPI consumer prices",
        "keywords": ["inflation", "cpi", "prices", "cost of living", "fuel",
                     "food prices", "wpi", "tariff"],
        "needs": "expenses",
    },
    {
        "id": "funding",
        "label": "FUNDING & CAPITAL",
        "query": "India startup funding venture capital",
        "keywords": ["funding", "venture", "vc", "raise", "series a", "valuation",
                     "startup", "investment round"],
        "needs": "fundraising",
    },
]


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def build_user_context(profile: Profile, db: Session) -> Dict[str, Any]:
    """Collect only the signals that actually exist on this profile.

    Returns a small dict — this is what gets ranked against and what is sent to
    the model, deliberately kept minimal so no more of the user's financial
    detail leaves the process than the task requires.
    """
    ctx: Dict[str, Any] = {
        "persona": profile.key or "individual",
        "currency": profile.currency or "₹",
        "signals": {},          # signal -> truthy weight
        "facts": {},            # short human-readable facts for the model
    }
    signals = ctx["signals"]
    facts = ctx["facts"]

    raw = profile.raw_inputs or {}
    goal = profile.goal or {}

    # ---- Individual ----
    if _num(raw.get("outstanding_loans")) > 0:
        signals["debt"] = 3
        facts["outstanding_loans"] = _num(raw.get("outstanding_loans"))
    if _num(raw.get("existing_investments")) > 0:
        signals["investments"] = 3
        facts["investments"] = _num(raw.get("existing_investments"))
    if _num(raw.get("monthly_expenses")) > 0:
        signals["expenses"] = 2
        facts["monthly_expenses"] = _num(raw.get("monthly_expenses"))
    if _num(raw.get("monthly_income")) > 0:
        facts["monthly_income"] = _num(raw.get("monthly_income"))
    if _num(raw.get("total_savings")) > 0:
        facts["total_savings"] = _num(raw.get("total_savings"))
    if goal.get("title"):
        facts["goal"] = goal.get("title")
        facts["goal_progress_pct"] = goal.get("progress")

    # ---- Startup ----
    sp = getattr(profile, "startup_profile", None)
    if sp:
        ctx["persona"] = "startup"
        if sp.industry:
            facts["industry"] = sp.industry
            signals["industry"] = 3
        if sp.stage:
            facts["stage"] = sp.stage
        if _num(sp.business_loans_debt) > 0:
            signals["debt"] = 3
            facts["business_debt"] = _num(sp.business_loans_debt)
        if _num(sp.current_cash) > 0:
            facts["cash_position"] = _num(sp.current_cash)
        if _num(sp.monthly_revenue) > 0:
            facts["monthly_revenue"] = _num(sp.monthly_revenue)
        burn = _num(sp.fixed_costs) + _num(sp.variable_costs) or _num(sp.monthly_burn_input)
        if burn > 0:
            signals["expenses"] = 2
            facts["monthly_burn"] = burn
        if sp.currently_fundraising:
            signals["fundraising"] = 3
            facts["currently_fundraising"] = True
            if _num(sp.fundraising_target) > 0:
                facts["fundraising_target"] = _num(sp.fundraising_target)
        if sp.headcount:
            facts["headcount"] = sp.headcount

    # ---- Enterprise ----
    ep = getattr(profile, "enterprise_profile", None)
    if ep:
        ctx["persona"] = "enterprise"
        if ep.industry:
            facts["industry"] = ep.industry
            signals["industry"] = 3
        if _num(ep.fx_exposure_pct) > 0:
            signals["fx"] = 4
            facts["fx_exposure_pct"] = _num(ep.fx_exposure_pct)
        if _num(ep.debt_amount) > 0:
            signals["debt"] = 3
            facts["debt"] = _num(ep.debt_amount)
        if _num(ep.treasury_balance) > 0:
            facts["treasury_balance"] = _num(ep.treasury_balance)
        if _num(ep.operating_expenses) > 0:
            signals["expenses"] = 2
            facts["operating_expenses"] = _num(ep.operating_expenses)
        if _num(ep.annual_turnover) > 0:
            facts["annual_turnover"] = _num(ep.annual_turnover)
        if ep.currently_fundraising:
            signals["fundraising"] = 3

    # ---- Spending shape, from the user's own transactions ----
    try:
        txns = (db.query(StartupTransaction)
                .filter(StartupTransaction.profile_id == profile.id)
                .order_by(StartupTransaction.txn_date.desc())
                .limit(120).all())
        if txns:
            by_cat: Dict[str, float] = {}
            for t in txns:
                if t.type == "out":
                    by_cat[t.category or "Uncategorized"] = by_cat.get(t.category or "Uncategorized", 0) + _num(t.amount)
            if by_cat:
                signals.setdefault("expenses", 2)
                top = sorted(by_cat.items(), key=lambda kv: -kv[1])[:3]
                facts["top_spend_categories"] = [c for c, _ in top]
    except Exception as e:                                   # never break the feed on this
        logger.warning(f"Market Pulse: could not read transactions: {e}")

    return ctx


def _topics_for(ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Pick the topics worth fetching, most relevant first.

    Capped at three so a page load makes at most three upstream news calls;
    each is cached and shared across users.
    """
    signals = ctx["signals"]
    ranked = sorted(TOPICS, key=lambda t: -signals.get(t["needs"], 0))
    chosen = [t for t in ranked if signals.get(t["needs"], 0) > 0][:3]
    if not chosen:
        # No personal signals yet — still show the broadly useful ones.
        chosen = [t for t in TOPICS if t["id"] in ("rates", "markets", "inflation")]
    return chosen


def _score(article: Dict[str, Any], topic: Dict[str, Any], ctx: Dict[str, Any]) -> float:
    text = f"{article.get('title') or ''} {article.get('description') or ''}".lower()
    if not text.strip():
        return 0.0
    score = float(ctx["signals"].get(topic["needs"], 0)) * 2.0
    score += sum(1.0 for kw in topic["keywords"] if kw in text)
    industry = (ctx["facts"].get("industry") or "").lower()
    if industry and industry in text:
        score += 4.0
    return score


def _fallback_why(topic: Dict[str, Any], ctx: Dict[str, Any]) -> str:
    """Deterministic explanation used when the model is unavailable. Hedged and
    tied to a signal we know is present."""
    facts = ctx["facts"]
    tid = topic["id"]
    if tid == "rates" and ("outstanding_loans" in facts or "business_debt" in facts or "debt" in facts):
        return "You carry outstanding borrowing, so a shift in rates could affect repayment costs and any future financing decisions."
    if tid == "fx" and "fx_exposure_pct" in facts:
        return f"Roughly {facts['fx_exposure_pct']:.0f}% of your exposure is currency-linked, so continued movement may influence international costs and cash-flow planning."
    if tid == "markets" and "investments" in facts:
        return "You hold invested capital, so market direction may be worth monitoring when you next review allocation."
    if tid == "inflation" and ("monthly_expenses" in facts or "monthly_burn" in facts or "operating_expenses" in facts):
        return "Your monthly costs are a large share of your position, so sustained price pressure could affect how much you keep each month."
    if tid == "funding" and facts.get("currently_fundraising"):
        return "You are raising at the moment, so funding-market conditions may be relevant to timing and terms."
    if tid == "industry" or facts.get("industry"):
        return f"This sits in {facts.get('industry')}, the sector you operate in, so it may be worth monitoring."
    return "This is general financial context; connect more of your financial detail for a sharper read on how it applies to you."


def _explain_with_ai(items: List[Dict[str, Any]], ctx: Dict[str, Any]) -> Dict[int, str]:
    """One call to the existing Gemini service for all selected items."""
    if not gemini_service.available() or not items:
        return {}

    listing = "\n".join(
        f"{i}. [{it['category']}] {it['headline']}: {it.get('summary') or ''}"[:400]
        for i, it in enumerate(items)
    )
    context_lines = "\n".join(f"- {k}: {v}" for k, v in ctx["facts"].items())

    system = (
        "You are MoneyKal's market analyst. For each news item, write one short sentence "
        "(maximum 30 words) explaining why it may matter to this specific user, grounded only "
        "in the financial context provided. Be calm and precise, never sensational. "
        "Use hedged language such as 'could affect', 'may be relevant because', 'worth monitoring', "
        "'may influence'. Never predict a definite outcome. Never invent facts about the user. "
        "If the context does not support a personal link, say plainly that it is general context. "
        "Return JSON: {\"explanations\": [{\"index\": <number>, \"why\": \"<sentence>\"}]}"
    )
    prompt = (
        f"User financial context:\n{context_lines or '- (limited data available)'}\n\n"
        f"News items:\n{listing}\n\n"
        "Write one explanation per item, keyed by its index."
    )

    data = gemini_service.generate_json(prompt, system_instruction=system, temperature=0.3, max_output_tokens=900)
    if not data:
        return {}
    out: Dict[int, str] = {}
    for row in (data.get("explanations") or []):
        try:
            idx = int(row.get("index"))
            why = (row.get("why") or "").strip()
            if why:
                out[idx] = why
        except (TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------------------
# Freshness
#
# Market commentary has a shelf life. An undated headline about rates or the
# index reads as current no matter how old it is, so the age is both enforced
# and shown: anything past the window is dropped, and whatever survives carries
# its date to the client.
# ---------------------------------------------------------------------------

MAX_ARTICLE_AGE_DAYS = 30


def _parse_published(value: Any) -> Optional[datetime]:
    """Parse the several date shapes news providers return, or give up quietly."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    text = str(value).strip()
    if not text:
        return None
    # ISO 8601, with or without a trailing Z / offset.
    try:
        cleaned = text.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(cleaned)
        return parsed.replace(tzinfo=None) - (parsed.utcoffset() or timedelta(0))
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
                "%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.replace(tzinfo=None) - (parsed.utcoffset() or timedelta(0))
        except ValueError:
            continue
    return None


def _age_label(published: Optional[datetime], now: Optional[datetime] = None) -> Optional[str]:
    """'2 hours ago' / '3 days ago'. None when the date is unknown, so the UI can
    say 'date unavailable' rather than implying freshness it cannot vouch for."""
    if not published:
        return None
    now = now or datetime.utcnow()
    delta = now - published
    seconds = delta.total_seconds()
    if seconds < 0:
        return "just now"
    if seconds < 3600:
        mins = max(1, int(seconds // 60))
        return "%d minute%s ago" % (mins, "" if mins == 1 else "s")
    if seconds < 86400:
        hours = int(seconds // 3600)
        return "%d hour%s ago" % (hours, "" if hours == 1 else "s")
    days = int(seconds // 86400)
    return "%d day%s ago" % (days, "" if days == 1 else "s")


def _is_fresh(published: Optional[datetime], now: Optional[datetime] = None) -> bool:
    """An item with NO date is kept.

    Dropping undated items would empty the rail whenever a provider omits the
    field, which is a worse failure than showing an item whose age we admit we
    do not know. The client renders those without a timestamp.
    """
    if published is None:
        return True
    now = now or datetime.utcnow()
    return (now - published) <= timedelta(days=MAX_ARTICLE_AGE_DAYS)


def _dedupe_key(headline: Optional[str]) -> str:
    """Same story, different wire. Normalised so near-identical headlines from
    two syndicating outlets do not both occupy a slot in a five-item rail."""
    return re.sub(r"[^a-z0-9]+", " ", (headline or "").lower()).strip()


def get_market_pulse(profile: Profile, db: Session) -> Dict[str, Any]:
    """Existing news service -> rank against this user -> explain -> top signals."""
    service = MarketIntelligenceService(db)
    ctx = build_user_context(profile, db)
    now = datetime.utcnow()

    scored: List[Dict[str, Any]] = []
    for topic in _topics_for(ctx):
        # Cache key is versioned: entries written before published_at was
        # captured have the wrong shape, and reusing one would put undated items
        # back on the rail for the life of the cache.
        cache_key = f"market_pulse:news:v2:{topic['id']}"
        articles = service._get_from_cache(cache_key)
        if articles is None:
            articles = service.news_api.get_news(topic["query"]) or []
            if articles:
                # Trim to what we render, so the cached blob stays small.
                articles = [{
                    "title": a.get("title"),
                    "description": a.get("description"),
                    "url": a.get("url"),
                    "source": (a.get("source") or {}).get("name"),
                    "published_at": a.get("publishedAt") or a.get("published_at"),
                } for a in articles if a.get("title")]
                service._set_cache(cache_key, articles, expire=NEWS_CACHE_SECONDS)
        for a in articles or []:
            published = _parse_published(a.get("published_at"))
            if not _is_fresh(published, now):
                continue
            scored.append({
                "category": topic["label"],
                "topic_id": topic["id"],
                "headline": a.get("title"),
                "summary": a.get("description"),
                "url": a.get("url"),
                "source": a.get("source"),
                "published_at": published,
                "_score": _score(a, topic, ctx),
                "_topic": topic,
            })

    # Same story off two wires occupies two of five slots unless it is removed
    # here; the highest-scoring copy wins because scored is already sorted.
    scored.sort(key=lambda x: -x["_score"])
    unique: List[Dict[str, Any]] = []
    seen_headlines = set()
    for item in scored:
        key = _dedupe_key(item.get("headline"))
        if key and key in seen_headlines:
            continue
        seen_headlines.add(key)
        unique.append(item)
    scored = unique

    # One item per topic first, so the rail isn't five headlines about one thing.
    picked: List[Dict[str, Any]] = []
    seen_topics = set()
    for item in scored:
        if item["topic_id"] not in seen_topics:
            picked.append(item)
            seen_topics.add(item["topic_id"])
    for item in scored:
        if len(picked) >= MAX_SIGNALS:
            break
        if item not in picked:
            picked.append(item)
    picked = picked[:MAX_SIGNALS]

    # Fallback to whatever the existing service already stored, if the API is down.
    if not picked:
        # The same freshness rule applies to the stored fallback. This table is
        # exactly where the September-2026 rail was serving 2024 index levels
        # from: without the cutoff, "the API is down" silently becomes "here is
        # two-year-old market data, undated".
        cutoff = now - timedelta(days=MAX_ARTICLE_AGE_DAYS)
        recent = (db.query(NewsItem)
                  .filter(NewsItem.timestamp >= cutoff)
                  .order_by(NewsItem.timestamp.desc())
                  .limit(MAX_SIGNALS).all())
        picked = [{
            "category": (n.category or "MARKETS").upper(),
            "topic_id": n.category or "markets",
            "headline": n.headline,
            "summary": n.summary,
            "url": None,
            "source": None,
            "published_at": n.timestamp,
            "_score": 0,
            "_topic": TOPICS[0],
        } for n in recent if n.headline]

    if not picked:
        # Said plainly rather than backfilled with whatever is oldest in the
        # table. An empty, honest rail beats a full, stale one.
        return {
            "signals": [], "personalized": False,
            "as_of": now.isoformat(),
            "max_age_days": MAX_ARTICLE_AGE_DAYS,
            "message": (
                "No market news from the last %d days is available right now. "
                "Nothing older is shown, because out-of-date market commentary is "
                "worse than none." % MAX_ARTICLE_AGE_DAYS
            ),
        }

    explanations = _explain_with_ai(picked, ctx)

    signals = []
    for i, item in enumerate(picked):
        why = explanations.get(i) or _fallback_why(item["_topic"], ctx)
        max_score = max((p["_score"] for p in picked), default=0)
        published = item.get("published_at")
        signals.append({
            "category": item["category"],
            "headline": item["headline"],
            "summary": item["summary"],
            "relevance": "high" if item["_score"] >= max(6, max_score * 0.75) else ("medium" if item["_score"] >= 3 else "low"),
            "why_it_matters": why,
            "source": item["source"],
            "url": item["url"],
            # Both forms: the ISO stamp for anything that needs to sort or
            # compare, and the phrase the UI actually prints. Null when the
            # provider gave no date, which the client shows as unknown rather
            # than guessing.
            "published_at": published.isoformat() if published else None,
            "age_label": _age_label(published, now),
        })

    return {
        "signals": signals,
        "personalized": bool(ctx["signals"]),
        "as_of": now.isoformat(),
        "max_age_days": MAX_ARTICLE_AGE_DAYS,
    }
