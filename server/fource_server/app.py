"""4CE server: receives only the redacted view, plans one action, checks it, returns it.

Run:  uv run fource-server            (planner: Qwen3-VL via Ollama if reachable, else rules)
Env:  FOURCE_MODEL_URL  OpenAI-compatible base URL   (default http://localhost:11434/v1, Ollama)
      FOURCE_MODEL      model name                   (default qwen3-vl:4b)
      FOURCE_API_KEY    key for hosted endpoints
      FOURCE_PLANNER    auto | vlm | rules           (default auto)
      FOURCE_CHECKER_MODEL  optional second model for the ULTRON check
"""

from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .auditor import Auditor
from .checker import ModelChecker, check
from .planner import Timer, make_planner

ROOT = Path(__file__).resolve().parents[2]
TESTBED = ROOT / "testbed"
LOGS = Path(os.environ.get("FOURCE_LOG_DIR", ROOT / "server" / "logs"))

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    vlm, rules = make_planner()
    mode = os.environ.get("FOURCE_PLANNER", "auto")
    use_vlm = mode == "vlm" or (mode == "auto" and await vlm.available())
    state.update(
        vlm=vlm if use_vlm else None,
        rules=rules,
        checker=ModelChecker(),
        auditor=Auditor(LOGS, TESTBED / "canaries.json", use_presidio=os.environ.get("FOURCE_PRESIDIO", "1") == "1"),
    )
    print(f"[4ce] planner: {vlm.name + ' @ ' + vlm.base_url if use_vlm else 'rules (no model reachable)'}")
    print(f"[4ce] auditor: {state['auditor'].scanner}; logs in {LOGS}")
    yield


app = FastAPI(title="4CE server", lifespan=lifespan)
# The extension calls from a chrome-extension:// or moz-extension:// origin.
app.add_middleware(CORSMiddleware, allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$|^http://(localhost|127\.0\.0\.1)(:\d+)?$", allow_methods=["*"], allow_headers=["*"])


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "planner": state["vlm"].name if state["vlm"] else "rules", "checker": state["checker"].model or "rules", "scanner": state["auditor"].scanner}


@app.post("/v1/step")
async def step(request: Request) -> JSONResponse:
    raw = await request.body()
    p = json.loads(raw)
    t0 = time.perf_counter()
    audit = state["auditor"].inspect(p, raw)

    planner = state["vlm"] or state["rules"]
    notes: list[str] = []
    with Timer() as tp:
        try:
            action = await planner.plan(p)
        except Exception as e:  # noqa: BLE001 - model down mid-run: fall back rather than stall the agent
            notes.append(f"{planner.name} failed ({e.__class__.__name__}); used rules")
            planner = state["rules"]
            action = await planner.plan(p)
        ok, n = check(action, p)
        notes += n
        if not ok and planner is not state["rules"]:
            # One retry with the rejection as feedback, then the rules planner.
            action = await planner.plan(p, feedback="; ".join(n))
            ok, n = check(action, p)
            notes += ["retry: " + "; ".join(n)]
            if not ok:
                planner = state["rules"]
                action = await planner.plan(p)
                ok, n = check(action, p)
                notes += ["fallback rules: " + "; ".join(n)]
        if ok and state["checker"].enabled and action.get("do") not in ("done", "fail", "scroll", "wait"):
            ok2, why = await state["checker"].review(action, p)
            notes.append(f"checker: {why}")
            if not ok2:
                action = {"do": "fail", "reason": f"checker rejected: {why}", "summary": why}
        if not ok:
            action = {"do": "fail", "reason": "; ".join(notes), "summary": "No safe action found."}

    return JSONResponse({
        "action": action,
        "planner": planner.name,
        "check": {"ok": ok, "notes": notes},
        "audit": {"pii_hits": audit["pii_hits"], "canary_hits": audit["canary_hits"], "frame_sha_ok": audit["frame_sha_ok"]},
        "latency_ms": {"plan": round(tp.ms), "total": round((time.perf_counter() - t0) * 1000)},
    })


@app.get("/v1/receipt")
async def receipt(session: str) -> dict[str, Any]:
    return state["auditor"].receipt(session)


@app.get("/")
async def index() -> RedirectResponse:
    return RedirectResponse("/testbed/")


app.mount("/testbed", StaticFiles(directory=TESTBED, html=True), name="testbed")


def main() -> None:
    import uvicorn  # noqa: PLC0415

    uvicorn.run("fource_server.app:app", host=os.environ.get("FOURCE_HOST", "127.0.0.1"), port=int(os.environ.get("FOURCE_PORT", "8765")))
