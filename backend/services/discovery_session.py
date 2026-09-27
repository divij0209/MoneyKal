"""
Persistence for the Financial Discovery layer's per-conversation state.

Kept out of the router so the chat endpoint stays readable, and out of the
engine so the engine stays testable without a database. One row per chat
session (models.domain.ChatDiscoveryState), loaded at the top of a turn and
saved at the bottom.

Every function here is failure-tolerant on purpose. Discovery state is an
enhancement to a conversation, not the conversation itself: if the row can't be
read or written, the turn still has to produce an answer. The worst case is
that the twin forgets it already asked something — which is exactly the
behaviour it had before this table existed.
"""
import logging
from typing import Any, Optional

from backend.models.domain import ChatDiscoveryState
from backend.schemas.discovery_models import ConversationDiscoveryState, DecisionContext

logger = logging.getLogger(__name__)


def load_state(db: Any, session_id: Optional[str]) -> ConversationDiscoveryState:
    """The conversation's accumulated discovery state, or a fresh one.

    A session with no row is a conversation that started before this layer
    existed (or has simply not discovered anything yet). Both are the same
    thing to the engine: nothing known, nothing asked."""
    if not db or not session_id:
        return ConversationDiscoveryState()
    try:
        row = db.query(ChatDiscoveryState).filter(
            ChatDiscoveryState.session_id == session_id
        ).first()
        if not row or not row.state:
            return ConversationDiscoveryState()
        return ConversationDiscoveryState(**row.state)
    except Exception as e:
        logger.error(f"Could not load discovery state: {type(e).__name__}")
        return ConversationDiscoveryState()


def save_state(
    db: Any,
    session_id: Optional[str],
    state: ConversationDiscoveryState,
    decision_context: Optional[DecisionContext] = None,
) -> None:
    """Upsert the state for this session.

    `decision_context` is only written when one exists — a turn that produced
    no simulatable decision must not erase the context a previous turn did, or
    reopening the conversation would lose a CTA the user could still act on."""
    if not db or not session_id:
        return
    try:
        row = db.query(ChatDiscoveryState).filter(
            ChatDiscoveryState.session_id == session_id
        ).first()
        payload = state.model_dump()
        if not row:
            row = ChatDiscoveryState(session_id=session_id)
            db.add(row)
        row.decision_type = state.decision_type
        row.user_intent = (state.user_intent or "")[:500]
        row.state = payload
        if decision_context is not None:
            row.decision_context = decision_context.model_dump()
        db.commit()
    except Exception as e:
        logger.error(f"Could not save discovery state: {type(e).__name__}")
        db.rollback()


def load_decision_context(db: Any, session_id: Optional[str]) -> Optional[DecisionContext]:
    """The last decision context this conversation produced.

    Used when Simulation is opened with only a session id — the phone's
    navigation params, for instance, or a CTA tapped after a reload."""
    if not db or not session_id:
        return None
    try:
        row = db.query(ChatDiscoveryState).filter(
            ChatDiscoveryState.session_id == session_id
        ).first()
        if not row or not row.decision_context:
            return None
        return DecisionContext(**row.decision_context)
    except Exception as e:
        logger.error(f"Could not load decision context: {type(e).__name__}")
        return None
