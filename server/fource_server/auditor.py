"""The server's own record of what it received: every payload is scanned for PII and canaries on
arrival and logged (without the image bytes) to logs/received.jsonl; the redacted frames are saved
to logs/frames/ so anyone can open exactly what the planner saw."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from .pii import PresidioScanner, load_presidio, scan

SKIP = {"b64", "sha256", "session", "id", "token", "target", "pass", "mime", "type", "field", "tag", "role", "box", "boxes", "source"}


def strings(v: Any, path: str = "$") -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if isinstance(v, str):
        out.append((path, v))
    elif isinstance(v, list):
        for i, x in enumerate(v):
            out += strings(x, f"{path}[{i}]")
    elif isinstance(v, dict):
        for k, x in v.items():
            if k not in SKIP:
                out += strings(x, f"{path}.{k}")
    return out


class Auditor:
    def __init__(self, log_dir: Path, canary_file: Path | None, use_presidio: bool = True) -> None:
        self.log_dir = log_dir
        (log_dir / "frames").mkdir(parents=True, exist_ok=True)
        self.canaries: list[str] = []
        if canary_file and canary_file.exists():
            self.canaries = json.loads(canary_file.read_text(encoding="utf-8"))["values"]
        self.presidio: PresidioScanner | None = load_presidio() if use_presidio else None
        self.sessions: dict[str, dict[str, Any]] = defaultdict(lambda: {"payloads": 0, "bytes": 0, "pii_hits": 0, "canary_hits": 0, "hits": []})

    @property
    def scanner(self) -> str:
        return "builtin validators" + (" + Presidio" if self.presidio else "") + f" + {len(self.canaries)} canaries"

    def inspect(self, payload: dict[str, Any], raw: bytes) -> dict[str, Any]:
        hits: list[dict[str, str]] = []
        norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum())  # noqa: E731
        canaries = [norm(c) for c in self.canaries]
        for path, s in strings(payload):
            for h in scan(s):
                hits.append({"kind": "pii", "type": h.type, "path": path, "rule": h.rule})
            if self.presidio:
                for h in self.presidio.scan(s):
                    hits.append({"kind": "pii", "type": h.type, "path": path, "rule": h.rule})
            ns = norm(s)
            for c in canaries:
                if c and c in ns:
                    hits.append({"kind": "canary", "type": "CANARY", "path": path, "rule": "canary"})
        sess = self.sessions[payload.get("session", "?")]
        sess["payloads"] += 1
        sess["bytes"] += len(raw)
        sess["pii_hits"] += sum(h["kind"] == "pii" for h in hits)
        sess["canary_hits"] += sum(h["kind"] == "canary" for h in hits)
        sess["hits"] += hits

        frame = payload.get("frame") or {}
        frame_sha = ""
        if frame.get("b64"):
            img = base64.b64decode(frame["b64"])
            frame_sha = hashlib.sha256(img).hexdigest()
            (self.log_dir / "frames" / f"{frame_sha[:16]}.jpg").write_bytes(img)
        record = {k: v for k, v in payload.items() if k != "frame"}
        record["frame"] = {k: v for k, v in frame.items() if k != "b64"} | {"sha256_verified": frame_sha, "file": f"frames/{frame_sha[:16]}.jpg"}
        record["received_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        record["payload_sha256"] = hashlib.sha256(raw).hexdigest()
        record["audit_hits"] = hits
        with (self.log_dir / "received.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return {"pii_hits": sum(h["kind"] == "pii" for h in hits), "canary_hits": sum(h["kind"] == "canary" for h in hits), "hits": hits, "frame_sha_ok": frame_sha == frame.get("sha256")}

    def receipt(self, session: str) -> dict[str, Any]:
        s = self.sessions.get(session) or {"payloads": 0, "bytes": 0, "pii_hits": 0, "canary_hits": 0, "hits": []}
        return {**s, "scanner": self.scanner}
