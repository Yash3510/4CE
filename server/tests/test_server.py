"""Server tests: validators, checker, auditor (it must catch a leak), both planners, and /v1/step."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from parda_server import app as appmod
from parda_server.checker import check
from parda_server.pii import is_aadhaar, luhn_ok, scan, verhoeff_digit
from parda_server.planner import RulesPlanner, VlmPlanner, extract_json


def payload(**over):
    p = {
        "session": "t1",
        "step": 1,
        "goal": "Fill the claim form with my details and file the claim",
        "page": {"url": "http://127.0.0.1/claim", "title": "Claim", "viewport": [1280, 800]},
        "frame": {"mime": "image/jpeg", "b64": "", "w": 0, "h": 0, "sha256": ""},
        "elements": [
            {"id": "e1", "tag": "input", "type": "text", "label": "Full name", "field": "NAME", "value": "", "box": [10, 10, 100, 20]},
            {"id": "e2", "tag": "input", "type": "email", "label": "Email", "field": "EMAIL", "value": "⟦EMAIL_1⟧", "box": [10, 30, 100, 40]},
            {"id": "e3", "tag": "textarea", "label": "Remarks", "value": "", "box": [10, 50, 100, 60]},
            {"id": "e4", "tag": "button", "type": "submit", "label": "File claim", "box": [10, 70, 50, 80]},
        ],
        "text": "Signed in as ⟦NAME_1⟧",
        "redactions": [{"token": "NAME_1", "type": "NAME", "pass": "known", "conf": 0.9, "boxes": [[1, 1, 2, 2]]}],
        "tokens": [{"token": "NAME_1", "type": "NAME", "source": "profile"}, {"token": "EMAIL_1", "type": "EMAIL", "source": "profile"}],
        "history": [],
    }
    p.update(over)
    return p


def test_checksums():
    body = "84933775295"
    assert verhoeff_digit(body) == "3" and is_aadhaar("8493 3775 2953")
    assert not is_aadhaar("8493 3775 2954")
    assert luhn_ok("4003823294250125") and not luhn_ok("4003823294250126")


def test_scan_finds_indian_pii_and_ignores_tokens():
    hits = {h.type for h in scan("PAN BQKPI4821M, Aadhaar 8493 3775 2953, mail a.b@mail.test, +91 82372 42965")}
    assert {"PAN", "AADHAAR", "EMAIL", "PHONE"} <= hits
    assert scan("Signed in as ⟦NAME_1⟧, card ⟦CARD_1⟧") == []


def test_checker_rejects_literal_pii_wrong_kind_and_unknown_target():
    p = payload()
    assert check({"do": "type", "target": "e1", "text": "⟦NAME_1⟧"}, p)[0]
    assert not check({"do": "type", "target": "e1", "text": "8493 3775 2953"}, p)[0]  # literal value
    assert not check({"do": "type", "target": "e1", "text": "⟦EMAIL_1⟧"}, p)[0]  # EMAIL into a NAME field
    assert not check({"do": "type", "target": "e1", "text": "⟦AADHAAR_9⟧"}, p)[0]  # unknown token
    assert not check({"do": "click", "target": "e99"}, p)[0]
    assert not check({"do": "navigate", "target": "e1"}, p)[0]
    a = {"do": "click", "target": "e4"}
    assert check(a, p)[0] and a["irreversible"] is True


@pytest.mark.asyncio
async def test_rules_planner_fills_then_submits():
    rp = RulesPlanner()
    a = await rp.plan(payload())
    assert a == {"do": "type", "target": "e1", "text": "⟦NAME_1⟧", "reason": "fill the name field from the profile"}
    filled = payload(elements=[{**e, "value": "⟦NAME_1⟧"} if e["id"] == "e1" else e for e in payload()["elements"]])
    a = await rp.plan(filled)
    assert a["do"] == "click" and a["target"] == "e4"


@pytest.mark.asyncio
async def test_vlm_planner_sends_image_and_scheme_and_parses_reply():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        seen["body"] = body
        reply = '<think>fill name</think>{"thought": "name first", "action": {"do": "type", "target": "e1", "text": "⟦NAME_1⟧"}}'
        return httpx.Response(200, json={"choices": [{"message": {"content": reply}}]})

    vp = VlmPlanner("http://mock/v1", "qwen3-vl:4b")
    vp.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    a = await vp.plan(payload(frame={"mime": "image/jpeg", "b64": "AAAA", "w": 1, "h": 1, "sha256": "x"}))
    assert a["do"] == "type" and a["text"] == "⟦NAME_1⟧" and a["reason"] == "name first"
    msgs = seen["body"]["messages"]
    assert "typed tokens" in msgs[0]["content"]
    assert msgs[1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert "⟦NAME_1⟧ type=NAME source=profile" in msgs[1]["content"][0]["text"]


def test_extract_json_handles_prose_and_fences():
    assert extract_json('Sure!\n```json\n{"action": {"do": "done"}}\n```') == {"action": {"do": "done"}}
    assert extract_json("no json here") is None


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PARDA_PLANNER", "rules")
    monkeypatch.setenv("PARDA_PRESIDIO", "0")
    monkeypatch.setattr(appmod, "LOGS", tmp_path)
    with TestClient(appmod.app) as c:
        yield c


def test_step_endpoint_and_receipt_clean(client):
    r = client.post("/v1/step", content=json.dumps(payload()).encode())
    assert r.status_code == 200
    j = r.json()
    assert j["action"]["do"] == "type" and j["audit"]["pii_hits"] == 0 and j["audit"]["canary_hits"] == 0
    rc = client.get("/v1/receipt", params={"session": "t1"}).json()
    assert rc["payloads"] == 1 and rc["pii_hits"] == 0


def test_auditor_flags_a_leak(client):
    canary = json.loads((appmod.TESTBED / "canaries.json").read_text())["values"][0]
    leaky = payload(session="leak", text=f"Nominee {canary}, PAN BQKPI4821M")
    j = client.post("/v1/step", content=json.dumps(leaky).encode()).json()
    assert j["audit"]["pii_hits"] >= 1 and j["audit"]["canary_hits"] >= 1
