"""ULTRON-style checker: nothing grades its own work. The planner proposes, this rejects.

Rule checks always run. If FOURCE_CHECKER_MODEL is set, a second, different model is also asked
whether the action serves the goal (ADR-0003 in 4CE: the checker is never the planner's model)."""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

from .pii import scan

ALLOWED = {"click", "type", "select", "scroll", "press", "wait", "clear", "done", "fail"}
TOKEN_RE = re.compile(r"⟦([A-Z_]+_\d+)⟧|\[\[([A-Z_]+_\d+)\]\]")
IRREVERSIBLE = re.compile(
    r"submit|\bpay\b|place order|confirm|\bsend\b|delete|remove|transfer|purchase|buy|checkout|sign ?up|register|apply|file (the )?claim|authori[sz]e|proceed",
    re.I,
)
COMPATIBLE = {"USERNAME": {"EMAIL", "PHONE", "USERNAME"}}


def check(action: dict[str, Any], p: dict[str, Any]) -> tuple[bool, list[str]]:
    notes: list[str] = []
    do = action.get("do")
    if do not in ALLOWED:
        return False, [f'action "{do}" is not allowed']
    els = {e["id"]: e for e in p.get("elements", [])}
    target = action.get("target")
    el = els.get(target) if target else None
    if do in ("click", "type", "select", "clear") and not el and not action.get("point"):
        return False, [f"target {target!r} is not one of the numbered elements"]

    if do == "type":
        text = str(action.get("text", ""))
        known = {t["token"]: t for t in p.get("tokens", [])}
        for m in TOKEN_RE.finditer(text):
            tok = m.group(1) or m.group(2)
            if tok not in known:
                return False, [f"token {tok} does not exist"]
            field = (el or {}).get("field")
            ttype = known[tok]["type"]
            if field and field != ttype and ttype not in COMPATIBLE.get(field, set()):
                return False, [f"{tok} is a {ttype} but {target} is a {field} field"]
        literal = TOKEN_RE.sub("", text)
        if scan(literal):
            return False, ["the action contains a literal personal value; use a token instead"]

    label = f"{(el or {}).get('label', '')} {(el or {}).get('type', '')}"
    pressing_enter = do == "press" and action.get("key", "Enter") == "Enter" and (el or {}).get("type") != "search"
    if (do == "click" and ((el or {}).get("type") == "submit" or IRREVERSIBLE.search(label))) or pressing_enter:
        action["irreversible"] = True
        notes.append("irreversible: device will ask the user")
    return True, notes


class ModelChecker:
    def __init__(self) -> None:
        self.model = os.environ.get("FOURCE_CHECKER_MODEL")
        self.base = os.environ.get("FOURCE_CHECKER_URL", os.environ.get("FOURCE_MODEL_URL", "http://localhost:11434/v1")).rstrip("/")
        key = os.environ.get("FOURCE_CHECKER_KEY", os.environ.get("FOURCE_API_KEY"))
        self.headers = {"Authorization": f"Bearer {key}"} if key else {}

    @property
    def enabled(self) -> bool:
        return bool(self.model)

    async def review(self, action: dict[str, Any], p: dict[str, Any]) -> tuple[bool, str]:
        el = next((e for e in p.get("elements", []) if e["id"] == action.get("target")), None)
        prompt = (
            f"Goal: {p['goal']}\nPage: {p['page']['title']}\nProposed action: {action}\nTarget element: {el}\n"
            "Personal values are hidden as tokens like ⟦EMAIL_1⟧. Does this action move toward the goal, and does it "
            "avoid putting a token somewhere the goal did not ask for? Reply JSON {\"ok\": true|false, \"reason\": \"...\"}."
        )
        try:
            async with httpx.AsyncClient(timeout=60) as c:
                r = await c.post(f"{self.base}/chat/completions", headers=self.headers,
                                 json={"model": self.model, "messages": [{"role": "user", "content": prompt}], "temperature": 0})
                r.raise_for_status()
                txt = r.json()["choices"][0]["message"]["content"] or ""
        except httpx.HTTPError as e:
            return True, f"checker model unavailable ({e.__class__.__name__}); rule checks only"
        ok = not re.search(r'"ok"\s*:\s*false', txt, re.I)
        m = re.search(r'"reason"\s*:\s*"([^"]*)"', txt)
        return ok, m.group(1) if m else txt[:160]
