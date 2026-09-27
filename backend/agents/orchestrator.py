from backend.core.money import group_indian
from typing import Dict, Any, List
import datetime

from backend.agents.sub_agents import risk_agent, compliance_agent, explainer_agent, concise_explainer_agent
from backend.schemas.api_models import ChatResponse, ScenarioSimulateResponse, StageTrace
from backend.market_intelligence.service import MarketIntelligenceService
from backend.database import SessionLocal
from backend.services.gemini_service import gemini_service
from backend.services.financial_simulator import (
    build_financial_context, ctx_to_dict, parse_scenario, describe_understanding,
    run_calculator, validate_result, classify_intent,
    assess_plausibility, not_modelled_result,
    params_from_decision_context, describe_context_understanding, build_alternative_paths,
)

RECOMMEND_SYSTEM_PROMPT = """You are the Recommend agent inside an Agentic Financial Decision Twin.
You are given a user's scenario, their real financial profile, and numbers that have ALREADY been
calculated deterministically by backend code.

Rules:
- Do NOT invent, recalculate, or contradict any number given to you. Only reference numbers you were given.
- Give ONE clear recommendation — never stay neutral.
- Keep it grounded in the user's specific figures, in plain, friendly language, 2-4 sentences.
- Respond ONLY with valid JSON in this exact shape, no markdown fences:
{"recommendation": "<2-4 sentence recommendation>", "why": "<2-4 sentence rationale citing the specific figures you were given>"}
"""

TEACH_SYSTEM_PROMPT = """You are the Teach agent inside an Agentic Financial Decision Twin.
Explain, in 3-5 simple sentences with no jargon, the core financial concept behind the scenario the
user is exploring (for example: compound interest, EMI/FOIR affordability, opportunity cost, emergency
funds, or goal-based saving). You may reference the user's own numbers if given, but never invent new
ones. Do not repeat the recommendation — this is pure financial education. Respond with plain text only."""


_mi_cache = {"data": None, "ts": 0}

class Orchestrator:
    def process_query(
        self,
        profile: Any,
        query: str,
        chat_history: List[Dict[str, str]] = None,
        db: Any = None,
        discovery_brief: str = None,
        style: str = "detailed",
    ) -> ChatResponse:
        """The grounded answer path — unchanged in structure.

        `discovery_brief` is the only addition: when the Financial Discovery
        layer (backend/agents/discovery.py) has already worked out what the
        user is actually deciding, it hands that down as an extra instruction
        block. The Data grounding, the market intelligence and the Explainer
        agent all still run exactly as before; the Explainer simply now knows
        the scope of the question instead of inferring it from one sentence.
        `style` selects the register of the reply. "detailed" is the original
        ten-section report and remains the default, so every existing caller
        (Simulation's informational path, the startup persona, voice) behaves
        exactly as before. Ask Twin passes "concise" unless the user actually
        asked for a breakdown — a page of tables is the wrong answer to
        "should I put 10k in an index fund?".

        Called without a brief this behaves identically to before."""
        trace = []

        # 0. Fetch Market Intelligence Context (cached for 5 minutes to avoid slow repeated calls)
        if _mi_cache["data"] and (datetime.datetime.utcnow().timestamp() - _mi_cache["ts"]) < 300:
            mi_context = _mi_cache["data"]
        else:
            db = SessionLocal()
            try:
                mi_service = MarketIntelligenceService(db)
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
                    f_usd = ex.submit(mi_service.get_exchange_rate, "USDINR=X")
                    f_nifty = ex.submit(mi_service.get_stock_price, "^NSEI")
                    f_infl = ex.submit(mi_service.get_economic_indicator, "INFLATION_IN", "INFCPIITM")
                    f_news = ex.submit(mi_service.get_news_sentiment, "finance")

                    def _safe(fut, default=None, timeout=4):
                        try:
                            return fut.result(timeout=timeout)
                        except Exception:
                            return default

                    mi_context = {
                        "USDINR": _safe(f_usd, 83.5),
                        "NIFTY": _safe(f_nifty, None),
                        "INFLATION_IN": _safe(f_infl, 4.8),
                        "news_sentiment": _safe(f_news, "neutral"),
                    }
                _mi_cache["data"] = mi_context
                _mi_cache["ts"] = datetime.datetime.utcnow().timestamp()
            except Exception as e:
                mi_context = {"error": str(e)}
            finally:
                db.close()

        # 1. Data Agent (direct passthrough — no LLM hop, so real numbers never
        #    get dropped or paraphrased away) — grounds the request in the SAME
        #    normalized financial context Simulation uses (build_financial_context),
        #    plus trimmed profile fields and live market data.
        financial_context = build_financial_context(profile)
        trimmed_metrics = [{"label": m.get("label"), "value": m.get("value")} for m in (profile.metrics or [])]
        trimmed_alerts = [{"text": a.get("text")} for a in (profile.alerts or [])][:3]
        
        recent_txns = []
        if hasattr(profile, "startup_transactions") and profile.startup_transactions:
            # Sort newest first, take up to 30 transactions
            sorted_txns = sorted(profile.startup_transactions, key=lambda x: x.txn_date.isoformat() if x.txn_date else "", reverse=True)
            for t in sorted_txns[:30]:
                recent_txns.append({
                    "date": str(t.txn_date) if t.txn_date else None,
                    "type": t.type,
                    "category": t.category,
                    "amount": t.amount,
                    "desc": t.description
                })

        freedom_balance_info = None
        goals_info = None
        upcoming_info = None
        health_score_info = None
        insights_info = None
        if db:
            try:
                from backend.services import home_service, live_life_service, health_score_service, home_insights
                from datetime import date
                home_ctx = home_service.build_home_context(db, profile, today=date.today())
                freedom = live_life_service.build_freedom_balance(home_ctx)
                freedom_balance_info = {
                    "value": freedom.get("value"),
                    "status": freedom.get("status"),
                    "label": freedom.get("label"),
                    "note": freedom.get("note")
                }
                
                # Inject Goals, Upcoming, Health, Insights
                goals = home_service.build_goals(home_ctx)
                goals_info = goals.get("primary_goal")
                
                upcoming = home_service.build_upcoming(home_ctx)
                upcoming_info = upcoming
                
                health_score_info = health_score_service.calculate_health_score(home_ctx)
                
                available = home_service.build_available_money(home_ctx)
                has_data = home_service.has_any_financial_data(home_ctx)
                insights_info = home_insights.generate_insight(home_ctx, upcoming, goals, available, has_data)
                
            except Exception as e:
                freedom_balance_info = {"error": str(e)}

        data_ctx = {
            "currency": profile.currency,
            "metrics": trimmed_metrics,
            "alerts": trimmed_alerts,
            "recent_transactions": recent_txns,
            "freedom_balance": freedom_balance_info,
            "financial_goals": goals_info,
            "upcoming_payments_bills_taxes": upcoming_info,
            "financial_health_score": health_score_info,
            "daily_ai_insights": insights_info,
            "financial_context": ctx_to_dict(financial_context),
            "market_intelligence": mi_context,
        }
        data_res = str(data_ctx)
        trace.append({"agent": "Data", "action": "Fetched user profile metrics, alerts, and market intelligence", "output": data_res})

        # Fast-path: trivial greetings/small talk skip the full LLM pipeline
        _GREETINGS = {"hi", "hello", "hey", "hii", "hiya", "yo", "sup", "hola", "namaste"}
        if query.strip().lower().strip("!.? ") in _GREETINGS:
            greeting_reply = "Hey there! I'm grounded in your financial profile. Ask me about your runway, savings, spending, or any decision you're weighing, and I'll pull real numbers into the answer."
            trace.append({"agent": "Explainer", "action": "Fast-path greeting reply (skipped Risk/Compliance)", "output": greeting_reply})
            return ChatResponse(
                session_id="",
                answer=greeting_reply,
                confidence="high",
                sources=[{"source": "Profile Database", "timestamp": datetime.datetime.utcnow().isoformat()}],
                reasoning_trace=trace,
                disclaimer="This is an AI-generated simulation and does not constitute financial advice.",
            )

        # 2. Explainer Agent (Single-pass inference to avoid Groq rate limits)
        # We collapse Risk and Compliance into the Explainer's instruction
        # since it's capable of doing all three steps in a single prompt.
        if style == "concise":
            instruction = (
                f"Answer this conversationally and concisely, grounded in the figures above, and "
                f"check for unlicensed-advice flags as you go: {query}"
            )
        else:
            instruction = (
                f"Simulate financial impact, check for unlicensed advice flags, and format the response "
                f"as a 10-point response for query: {query}"
            )
        if discovery_brief:
            # Appended rather than substituted: the Explainer keeps its full
            # existing instruction and output contract, and gains the scope the
            # discovery layer established.
            instruction = instruction + "\n" + discovery_brief

        agent = concise_explainer_agent if style == "concise" else explainer_agent
        exp_res = agent.process(
            {"data": data_res},
            instruction,
            chat_history=chat_history,
            # A conversational reply is a few short paragraphs; the report is
            # ten sections. Budgeting for the report either way wastes tokens
            # and invites the model to pad.
            max_output_tokens=900 if style == "concise" else 2048,
        )
        trace.append({
            "agent": "Explainer",
            "action": (
                f"Formatted the final {'conversational' if style == 'concise' else 'structured'} "
                f"output (single-pass)"
                + (", scoped by the Financial Discovery brief" if discovery_brief else "")
            ),
            "output": exp_res,
        })

        # Construct response
        response = ChatResponse(
            session_id="",
            answer=exp_res,
            confidence="high",
            sources=[
                {"source": "Profile Database", "timestamp": datetime.datetime.utcnow().isoformat()},
                {"source": "Market Intelligence API", "timestamp": datetime.datetime.utcnow().isoformat()}
            ],
            reasoning_trace=trace,
            disclaimer="This is an AI-generated simulation and does not constitute financial advice. Ensure you consult a certified financial advisor."
        )
        return response

    def run_scenario_simulation(
        self,
        profile: Any,
        scenario_text: str,
        decision_context: Dict[str, Any] = None,
    ) -> ScenarioSimulateResponse:
        """Entry point for the Simulation page. Routes on intent:

        - Informational questions about the user's current state ("what's
          my runway?") are answered directly by the same Ask Twin/RAG flow
          (process_query) — no hypothetical to calculate.
        - Actual hypothetical scenarios ("what if I invest ₹20k/month?") run
          the full Understand -> Watch -> Simulate -> Recommend -> Teach ->
          Check pipeline with real calculations and a timeline.

        `decision_context` is the hand-off from the chatbot's Simulation CTA.
        When present, the decision has already been established in conversation,
        so intent classification is skipped (arriving here from a CTA is itself
        the signal that a decision exists) and the numbers come from the
        structured context instead of being re-parsed out of a sentence. A
        scenario typed directly into the Simulate box still takes the original
        path, unchanged.
        """
        if decision_context:
            return self._run_scenario_pipeline(profile, scenario_text, decision_context)
        if classify_intent(scenario_text) == "informational":
            return self._answer_informational(profile, scenario_text)
        return self._run_scenario_pipeline(profile, scenario_text)

    def _answer_informational(self, profile: Any, query_text: str) -> ScenarioSimulateResponse:
        """Informational questions reuse the exact Ask Twin/RAG flow — same
        agents, same grounding — instead of a separate/duplicate answer path."""
        stages: List[Dict[str, str]] = [{
            "agent": "Understand",
            "status": "done",
            "summary": "Classified as an informational question about your current finances, routed to the same grounded flow Ask Twin uses, rather than a hypothetical simulation.",
        }]

        ctx = build_financial_context(profile)
        buffer_txt = f", emergency buffer {ctx.buffer_months:.1f} months" if ctx.buffer_months is not None else ""
        stages.append({
            "agent": "Watch",
            "status": "done",
            "summary": (
                f"Retrieved your current profile. Income {ctx.currency}{group_indian(ctx.income)}/mo, "
                f"expenses {ctx.currency}{group_indian(ctx.expenses)}/mo, savings {ctx.currency}{group_indian(ctx.savings)}, "
                f"surplus {ctx.currency}{group_indian(ctx.surplus)}/mo{buffer_txt}."
            ),
        })

        # Same orchestration Ask Twin's chat endpoint uses — no duplicate logic.
        chat_response = self.process_query(profile, query_text)

        stages.append({
            "agent": "Check",
            "status": "done",
            "summary": "Answered directly from your stored profile data. No hypothetical numbers or projections were introduced.",
        })

        financial_impact: Dict[str, Any] = {
            "monthly_income": round(ctx.income, 2),
            "monthly_expenses": round(ctx.expenses, 2),
            "monthly_surplus": round(ctx.surplus, 2),
            "total_savings": round(ctx.savings, 2),
        }
        if ctx.buffer_months is not None:
            financial_impact["emergency_buffer_months"] = round(ctx.buffer_months, 1)
        if ctx.goal_progress_pct is not None:
            financial_impact["goal_progress_pct"] = ctx.goal_progress_pct

        return ScenarioSimulateResponse(
            scenario=query_text,
            scenario_type="informational",
            mode="informational",
            parsed_params={},
            stages=[StageTrace(**s) for s in stages],
            financial_impact=financial_impact,
            timeline=[],
            recommendation=chat_response.answer,
            why="",
            risks=[],
            assumptions=[],
            teaching="",
            disclaimer=chat_response.disclaimer,
        )

    def _run_scenario_pipeline(
        self,
        profile: Any,
        scenario_text: str,
        decision_context: Dict[str, Any] = None,
    ) -> ScenarioSimulateResponse:
        """Understand -> Watch -> Simulate -> Recommend -> Teach -> Check.

        Understand/Watch/Simulate/Check are deterministic backend code (no
        LLM invents numbers). Recommend/Teach call Gemini, but only to
        phrase language around numbers already computed here.

        The only thing `decision_context` changes is where the Understand stage
        gets its parameters from. Every stage after it runs identically — the
        same calculators, the same validation, the same grounded context.
        """
        stages: List[Dict[str, str]] = []

        # 2. Watch — retrieve the user's real financial context (same
        #    grounding step Ask Twin's Data agent uses). Pulled up ahead of
        #    Understand because a context-driven parse needs it; the stage
        #    trace below still reports them in the order the user reads.
        ctx = build_financial_context(profile)

        # 1. Understand — either parse the natural-language scenario, or adopt
        #    what the conversation already established.
        if decision_context:
            scenario_type, params = params_from_decision_context(ctx, decision_context)
            understanding = describe_context_understanding(scenario_type, decision_context, ctx.currency)
        else:
            scenario_type, params = parse_scenario(scenario_text)
            understanding = describe_understanding(scenario_type, params, ctx.currency)
        stages.append({
            "agent": "Understand",
            "status": "done",
            "summary": understanding,
        })
        buffer_txt = f", emergency buffer {ctx.buffer_months:.1f} months" if ctx.buffer_months is not None else ""
        stages.append({
            "agent": "Watch",
            "status": "done",
            "summary": (
                f"Retrieved your current profile. Income {ctx.currency}{group_indian(ctx.income)}/mo, "
                f"expenses {ctx.currency}{group_indian(ctx.expenses)}/mo, savings {ctx.currency}{group_indian(ctx.savings)}, "
                f"surplus {ctx.currency}{group_indian(ctx.surplus)}/mo{buffer_txt}."
            ),
        })

        # 3. Simulate — deterministic financial calculations
        impact, timeline, assumptions, calc_risks = run_calculator(scenario_type, ctx, params)

        # Plausibility is checked here rather than in the Check stage below,
        # because Recommend runs in between and an implausible figure must not
        # reach the LLM prompt either — a model handed "−₹6.67 crore" will
        # write a confident paragraph around it.
        plausibility = assess_plausibility(ctx, scenario_type, impact, timeline)
        if not plausibility["plausible"]:
            impact, timeline, assumptions, calc_risks = not_modelled_result(
                ctx, plausibility["problems"]
            )
            stages.append({
                "agent": "Simulate",
                "status": "warning",
                "summary": (
                    "Ran the projection and rejected it before display: "
                    + "; ".join(plausibility["problems"]) + "."
                ),
            })
        else:
            stages.append({
                "agent": "Simulate",
                "status": "done",
                "summary": f"Ran deterministic financial projections across {len(timeline)} milestone(s).",
            })

        # 4. Recommend — Gemini phrases a recommendation strictly around the
        #    numbers already computed above
        self._last_recommendation_source = "template"
        recommendation, why = self._recommend(scenario_text, ctx, scenario_type, impact, calc_risks, decision_context)
        used_model = self._last_recommendation_source == "model"
        stages.append({
            "agent": "Recommend",
            "status": "done" if used_model else "degraded",
            "summary": (
                "Generated a personalized recommendation grounded in the computed numbers."
                if used_model else
                "The language model was unavailable, so this recommendation is the built-in "
                "deterministic write-up of the same computed numbers rather than personalised prose. "
                "Every figure above is unaffected — none of them ever come from a model."
            ),
        })

        # 5. Teach — explain the underlying concept
        teaching = self._teach(scenario_text, scenario_type, ctx)
        stages.append({
            "agent": "Teach",
            "status": "done",
            "summary": "Explained the financial concept behind this scenario.",
        })

        # 6. Check — validate the inputs AND the computed output. Checking only
        #    inputs is what let every absurd projection through with a clean
        #    "No red flags found."
        check_notes = validate_result(ctx, scenario_type, params)
        risks = list(calc_risks) + check_notes
        if not plausibility["plausible"]:
            stages.append({
                "agent": "Check",
                "status": "warning",
                "summary": (
                    "Rejected the projection as not credible and withheld it. "
                    "Checked both the inputs and the computed result."
                ),
            })
        else:
            stages.append({
                "agent": "Check",
                "status": "done",
                "summary": (
                    f"Validated calculation inputs and the computed result, flagged {len(risks)} risk(s)."
                    if risks else
                    "Validated calculation inputs and sanity-checked the computed result. No red flags found."
                ),
            })

        # Alternatives. Simulation exists to show consequences, not to ratify
        # the chatbot's recommendation, so where risk posture is the axis that
        # matters the user gets three genuinely different paths to compare —
        # all computed by the same deterministic math above.
        alternative_paths = build_alternative_paths(scenario_type, ctx, params, decision_context)
        if alternative_paths:
            stages.append({
                "agent": "Simulate",
                "status": "done",
                "summary": f"Modelled {len(alternative_paths)} alternative approaches for comparison, not just the one discussed.",
            })

        return ScenarioSimulateResponse(
            scenario=scenario_text,
            scenario_type=scenario_type,
            mode="scenario",
            parsed_params={k: v for k, v in params.items() if k != "all_amounts_detected"},
            stages=[StageTrace(**s) for s in stages],
            financial_impact=impact,
            timeline=timeline,
            recommendation=recommendation,
            why=why,
            risks=risks if risks else ["No material risks identified from the available data."],
            assumptions=assumptions,
            teaching=teaching,
            disclaimer="This simulation is educational and based on your current financial profile. Consider consulting a certified financial advisor before making major financial decisions.",
            decision_context=decision_context,
            alternative_paths=alternative_paths,
        )

    def _recommend(self, scenario_text, ctx, scenario_type, impact, calc_risks, decision_context=None):
        if gemini_service.available():
            prompt = (
                f"Scenario: {scenario_text}\n"
                f"Scenario type: {scenario_type}\n"
                f"User's financial profile: {ctx_to_dict(ctx)}\n"
                f"Already-computed financial impact: {impact}\n"
                f"Already-flagged risks: {calc_risks}\n"
            )
            if decision_context:
                # What the chatbot's discovery layer established. Included so
                # the recommendation respects the purpose, horizon and
                # constraints the user already stated instead of re-deriving
                # them — and so it never asks for what has been answered.
                constraints = decision_context.get("risk_constraints") or {}
                priorities = [p.get("label") for p in (decision_context.get("blocking_priorities") or [])]
                prompt += (
                    f"Established in the user's conversation with MoneyKal. "
                    f"objective: {decision_context.get('objective')}; "
                    f"horizon: {decision_context.get('time_horizon_years')} year(s); "
                    f"stated risk constraints: {constraints}; "
                    f"computed risk position: {decision_context.get('risk_profile')}; "
                    f"priorities that should come first: {priorities}.\n"
                    f"Respect all of the above. Never contradict a constraint the user stated, and never "
                    f"ask for information already listed here.\n"
                )
            data = gemini_service.generate_json(prompt, system_instruction=RECOMMEND_SYSTEM_PROMPT, temperature=0.4)
            if data and data.get("recommendation"):
                self._last_recommendation_source = "model"
                return data.get("recommendation", ""), data.get("why", "")
        # Reached when the model is unconfigured, over quota, or returned
        # nothing usable. The deterministic template still describes the same
        # computed numbers; it just is not personalised prose.
        self._last_recommendation_source = "template"
        return self._fallback_recommendation(scenario_type, impact, calc_risks, ctx)

    def _teach(self, scenario_text, scenario_type, ctx):
        if gemini_service.available():
            prompt = f"Scenario: {scenario_text}\nScenario type: {scenario_type}\nUser's financial profile: {ctx_to_dict(ctx)}"
            try:
                return gemini_service.generate(prompt, system_instruction=TEACH_SYSTEM_PROMPT, temperature=0.5, max_output_tokens=512)
            except Exception:
                pass
        return self._fallback_teaching(scenario_type)

    @staticmethod
    def _fallback_recommendation(scenario_type, impact, calc_risks, ctx):
        if calc_risks:
            return (
                "Hold off before committing to this exactly as described.",
                calc_risks[0],
            )
        surplus_after = impact.get("monthly_surplus_after")
        if surplus_after is not None and surplus_after < 0:
            return (
                "This isn't affordable as described. It would push your monthly cash flow negative.",
                f"Your projected monthly surplus after this change is {ctx.currency}{group_indian(surplus_after)}, below zero.",
            )
        return (
            "This looks workable based on your current numbers. Proceed, but keep an eye on your emergency buffer.",
            "Your projected surplus stays positive across the scenario's timeline given your current income and expenses.",
        )

    @staticmethod
    def _fallback_teaching(scenario_type):
        concepts = {
            "invest_monthly": "This is a Systematic Investment Plan (SIP) — investing a fixed amount every month regardless of market conditions. Over time, compounding means your returns start earning their own returns, which is why longer time horizons matter more than trying to time the market.",
            "emi_affordability": "Lenders and planners commonly use FOIR (Fixed Obligation to Income Ratio), keeping total loan/EMI payments under ~40% of your income, to judge affordability, because it leaves room for living expenses and savings even if income dips.",
            "increase_savings": "Redirecting spending into savings compounds over time: even a modest monthly increase, sustained consistently, adds up faster than most people expect because each month's contribution starts growing immediately.",
            "goal_timeline": "Goal-based saving works backward from a target: how much you still need, divided by how much you save each month, tells you the timeline. Increasing the monthly amount shortens it faster than almost any other lever.",
            "income_loss": "An emergency fund exists precisely for this scenario, it's sized in 'months of expenses covered' rather than a fixed amount, because its job is to buy you time during an income gap without forcing high-interest borrowing.",
        }
        return concepts.get(scenario_type, "Every financial decision trades off liquidity (cash on hand), growth (returns over time), and risk (what could go wrong). Weighing a scenario means checking it against all three, not just the immediate cost or benefit.")


orchestrator = Orchestrator()
