"""Vapi voice layer tests — no Vapi account or network access required.

Verifies the two things that matter about the voice layer:
  1. Vapi can only reach user data through an independently authorised backend
     call (a forged, missing or wrong-scope token gets nothing).
  2. The answers come from the EXISTING Financial Twin brain, not from Vapi.

Run from the project root:  PYTHONPATH="." python -m pytest tests/test_voice_vapi.py -s
(or simply:                 PYTHONPATH="." python tests/test_voice_vapi.py)
"""
import os
import tempfile
import uuid

# Set before importing the backend — the voice config is read at import time.
os.environ.setdefault("VAPI_PUBLIC_KEY", "pk_test_dummy")
os.environ.setdefault("VAPI_SERVER_URL", "https://example-tunnel.test")

# Also set before importing the backend, and NOT with setdefault. This used to
# inherit whatever DATABASE_URL was ambient, which on a developer machine is
# backend/.env — the shared Supabase database. The tests below POST to
# /voice/session, which spends and records an ask_twin allowance, so every run
# wrote usage_counters rows to production. It now builds its own throwaway file.
_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_vapi_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

import json

from fastapi.testclient import TestClient

from backend.core.auth import create_access_token
from backend.database import Base, SessionLocal, engine
from backend.main import app
from backend.models.domain import Profile, User
from backend.services import vapi_service as vapi

Base.metadata.create_all(bind=engine)
client = TestClient(app)


def _fixture():
    """A user with a profile, created here rather than assumed.

    This used to require a pre-seeded database and assert its way out if it
    found none, which is what tied it to whatever database happened to be
    configured.
    """
    db = SessionLocal()
    profile = db.query(Profile).filter(Profile.user_id.isnot(None)).first()
    if profile is None:
        res = client.post("/auth/register", json={
            "username": f"vapi_{uuid.uuid4().hex[:8]}@moneykal.test",
            "password": "Password123!",
        })
        assert res.status_code == 200, res.text
        user_id = res.json()["user_id"]
        profile = Profile(user_id=user_id, key="individual", label="Individual",
                          raw_inputs={"full_name": "Test"})
        db.add(profile)
        db.commit()
        db.refresh(profile)
    user = db.query(User).filter(User.id == profile.user_id).first()
    return user, profile


def _tool_request(name, args):
    return {"message": {"type": "tool-calls", "toolCallList": [
        {"id": "call_1", "function": {"name": name, "arguments": args}}]}}


def test_voice_session_requires_authentication():
    assert client.post("/voice/session").status_code == 401


def test_voice_session_returns_a_safe_call_config():
    user, _ = _fixture()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': str(user.id)})}"}
    res = client.post("/voice/session", headers=headers)
    assert res.status_code == 200, res.text
    cfg = res.json()

    assert cfg["public_key"] == os.environ["VAPI_PUBLIC_KEY"]
    assert cfg["session_id"]

    # Only the three backend doors are exposed, and they point at this backend.
    tools = cfg["assistant"]["model"]["tools"]
    assert sorted(t["function"]["name"] for t in tools) == [
        "ask_financial_twin", "get_financial_snapshot", "simulate_financial_scenario"]
    assert tools[0]["server"]["url"].startswith(os.environ["VAPI_SERVER_URL"] + "/voice/tool")

    # Nothing secret is handed to the browser.
    assert "secret" not in json.dumps(cfg).lower()

    # The identity in the config is the signed, voice-scoped token we minted —
    # never a client-supplied user id.
    claims = vapi.decode_voice_token(tools[0]["server"]["headers"]["X-Voice-Token"])
    assert claims["scope"] == "voice"
    assert claims["sub"] == str(user.id)

    # The user can interrupt the assistant.
    assert "stopSpeakingPlan" in cfg["assistant"]


def test_tool_endpoint_rejects_unauthorised_callers():
    user, _ = _fixture()
    login_token = create_access_token({"sub": str(user.id)})
    body = _tool_request("get_financial_snapshot", {})

    assert client.post("/voice/tool", json=body).status_code == 401
    assert client.post("/voice/tool", json=body,
                       headers={"X-Voice-Token": "not.a.token"}).status_code == 401
    # A normal login token must not double as a voice token.
    assert client.post("/voice/tool", json=body,
                       headers={"X-Voice-Token": login_token}).status_code == 401


def test_snapshot_tool_returns_real_backend_figures():
    _, profile = _fixture()
    token = vapi.mint_voice_token(profile.user_id, vapi.new_session_id(), profile.key)

    res = client.post("/voice/tool", json=_tool_request("get_financial_snapshot", {}),
                      headers={"X-Voice-Token": token})
    assert res.status_code == 200, res.text
    result = res.json()["results"][0]
    assert result["toolCallId"] == "call_1"
    # Figures come from the existing grounding step, not from the voice agent.
    assert "Monthly income" in result["result"]


def test_tool_payload_variants_and_unknown_tools():
    _, profile = _fixture()
    token = vapi.mint_voice_token(profile.user_id, vapi.new_session_id(), profile.key)

    # Vapi has shipped both toolCallList and toolCalls, and string arguments.
    res = client.post("/voice/tool", headers={"X-Voice-Token": token}, json={
        "message": {"type": "tool-calls", "toolCalls": [
            {"id": "c2", "function": {"name": "get_financial_snapshot", "arguments": "{}"}}]}})
    assert res.status_code == 200, res.text

    # Token in the URL is accepted when headers are dropped in transit.
    res = client.post(f"/voice/tool?vs={token}",
                      json=_tool_request("get_financial_snapshot", {}))
    assert res.status_code == 200

    # An unknown tool degrades into speech, never a 500.
    res = client.post("/voice/tool", headers={"X-Voice-Token": token},
                      json=_tool_request("delete_everything", {}))
    assert res.status_code == 200
    assert "not available" in res.json()["results"][0]["result"]


def test_speech_shaping_never_changes_numbers():
    spoken = vapi.to_speech("**Invest** ₹7,000/month and you reach ₹4.9 lakh. [More](http://x.y)")
    assert "**" not in spoken and "http" not in spoken
    assert "7,000" in spoken and "4.9" in spoken


def test_end_of_call_clears_temporary_context_and_stores_nothing():
    session_id = vapi.new_session_id()
    vapi.append_session_turns(session_id, "question", "answer")
    assert vapi.get_session_turns(session_id)

    res = client.post("/voice/webhook", json={"message": {
        "type": "end-of-call-report",
        "endedReason": "customer-ended-call",
        "call": {"metadata": {"voice_session_id": session_id}},
        "messages": [{"role": "user", "message": "what is my salary?"}]}})
    assert res.status_code == 200
    # Temporary call context is dropped; transcripts are not durable memory.
    assert vapi.get_session_turns(session_id) == []
    assert vapi.VOICE_PERSIST_TRANSCRIPTS is False


def test_old_browser_voice_endpoints_are_gone():
    user, _ = _fixture()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': str(user.id)})}"}
    assert client.post("/twin/tts", headers=headers, json={"text": "hi"}).status_code == 404

    # ...while the text chat path is untouched.
    paths = {getattr(r, "path", "") for r in app.routes}
    assert {"/twin/chat", "/twin/chats", "/twin/simulate-scenario"} <= paths


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print(f"PASS  {name}")
    print(f"\n{passed} voice tests passed")
