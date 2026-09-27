from typing import Dict, Any, List

from backend.services.groq_service import groq_service
from backend.agents.prompts import (
    EXPLAINER_SYSTEM_PROMPT,
    CONCISE_EXPLAINER_SYSTEM_PROMPT,
    INVESTMENT_RECOMMENDATION_PROMPT,
)


class Agent:
    """Powers the Tathya chatbot pipeline (Data/Risk/Compliance/Explainer,
    reached via POST /twin/chat for both the individual and startup
    personas). Runs on Groq — every other AI call in the backend
    (Simulation's Recommend/Teach, onboarding extraction, market-sentiment
    tagging) still runs on Gemini via gemini_service, untouched."""

    def __init__(self, name: str, description: str, system_prompt_override: str = None):
        self.name = name
        self.description = description
        self.system_prompt_override = system_prompt_override

    def process(self, context: Dict[str, Any], instructions: str, chat_history: List[Dict[str, str]] = None, max_output_tokens: int = 2048) -> str:
        if not groq_service.available():
            return f"[{self.name}] Mock processing for: {instructions[:30]}..."

        sys_prompt = self.system_prompt_override or f"You are the {self.name} Agent.\nDescription: {self.description}"
        user_prompt = f"Context:\n{context}\n\nTask:\n{instructions}"

        try:
            # Retry-on-rate-limit backoff lives centrally in groq_service.generate()
            # so every chatbot sub-agent (Data/Risk/Compliance/Explainer, for both
            # the individual and startup personas) benefits from it.
            return groq_service.generate(
                user_prompt,
                system_instruction=sys_prompt,
                chat_history=chat_history,
                temperature=0.4,
                max_output_tokens=max_output_tokens,
            )
        except Exception as e:
            # Never crash the request — the chatbot degrades to a visible,
            # readable error bubble instead of a 500.
            err_str = str(e)
            if "rate limit" in err_str.lower() or "rate_limit" in err_str.lower() or " 429" in err_str or err_str.startswith("429"):
                return f"[{self.name}] Rate limit exceeded after retries. Please wait a moment and try again."
            return f"[{self.name}] Error invoking LLM: {err_str}"


def is_agent_error(text: str) -> bool:
    """Whether an Agent.process() result is actually its failure sentinel.

    Agent.process never raises — it returns a readable "[Name] ..." string so a
    chat turn degrades to a visible message instead of a 500. That is right for
    the general case, but it means the caller cannot tell an answer from an
    outage by looking at it. Callers that hold a better fallback (a fully
    computed recommendation, say) need to be able to."""
    t = (text or "").lstrip()
    return t.startswith(("[Data]", "[Risk]", "[Compliance]", "[Explainer]", "[Advisor]"))


# Define the sub-agents
data_agent = Agent("Data", "Fetches and normalizes the user's private data and live external data (Market Intelligence).")
risk_agent = Agent("Risk", "Runs financial projection/simulation logic given the gathered data. Explicitly factor in macroeconomic data like inflation, interest rates, and market performance in your projections.")
compliance_agent = Agent("Compliance", "Checks the draft recommendation against basic guardrails.")
explainer_agent = Agent(
    name="Explainer",
    description="Converts the raw simulation output into the final structured, human-readable response.",
    system_prompt_override=EXPLAINER_SYSTEM_PROMPT
)

# The same Explainer, in conversational register. This is now the default for
# Ask Twin; `explainer_agent` above is unchanged and is still what runs when the
# user actually asks for a detailed breakdown, a comparison or projections.
# Both are handed identical grounding — only the shape of the reply differs.
concise_explainer_agent = Agent(
    name="Explainer",
    description="Answers the user's financial question conversationally, grounded in their real figures.",
    system_prompt_override=CONCISE_EXPLAINER_SYSTEM_PROMPT
)

# Phrases an investment recommendation that services/investment_advisor.py has
# already computed in full. It is given the numbers and is forbidden from
# producing any others, which is what keeps an allocation the output of
# arithmetic rather than of a language model.
investment_agent = Agent(
    name="Advisor",
    description="Delivers a pre-computed investment recommendation in the user's own terms.",
    system_prompt_override=INVESTMENT_RECOMMENDATION_PROMPT
)
