"""Server-side PII scanner used by the auditor.

An independent re-implementation of the extension's validators (Aadhaar/Verhoeff and PAN
ported from Microsoft Presidio's India recognizers, MIT). The server runs it over every
payload it receives, so the receipt shows what actually arrived, not what the client claims.
If Presidio is installed, its analyzer runs too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def verhoeff_ok(digits: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _D[c][_P[i % 8][int(ch)]]
    return c == 0


def verhoeff_digit(digits: str) -> str:
    """Check digit to append so that digits + result passes Verhoeff (used by the testbed generator)."""
    inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _D[c][_P[(i + 1) % 8][int(ch)]]
    return str(inv[c])


def luhn_ok(digits: str) -> bool:
    total, dbl = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if dbl:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        dbl = not dbl
    return total % 10 == 0


def is_aadhaar(s: str) -> bool:
    d = re.sub(r"\D", "", s)
    return len(d) == 12 and d[0] >= "2" and verhoeff_ok(d) and d != d[::-1]


@dataclass
class Hit:
    type: str
    value: str
    rule: str


def _ctx(text: str, start: int, pattern: str) -> bool:
    return re.search(pattern, text[max(0, start - 48):start], re.I) is not None


_RULES: list[tuple[str, str, object]] = [
    ("EMAIL", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", None),
    ("CARD", r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])", lambda m, t, s: luhn_ok(re.sub(r"\D", "", m)) and len(set(re.sub(r"\D", "", m))) > 1),
    ("AADHAAR", r"(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])", lambda m, t, s: is_aadhaar(m)),
    ("PAN", r"\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b", None),
    ("IFSC", r"\b[A-Z]{4}0[A-Z0-9]{6}\b", None),
    ("PHONE", r"(?<![\d+])(?:(?:\+|00)91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)", None),
    ("ACCOUNT", r"(?<![\d-])\d{9,18}(?![\d-])", lambda m, t, s: _ctx(t, s, r"account|a/c|acct")),
    ("PASSPORT", r"\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b", lambda m, t, s: _ctx(t, s, r"passport")),
    ("VOTER_ID", r"\b[A-Z]{3}\d{7}\b", lambda m, t, s: _ctx(t, s, r"voter|epic")),
    ("OTP", r"(?<![\d-])\d{4,8}(?![\d-])", lambda m, t, s: _ctx(t, s, r"\botp\b|one[- ]time|verification code")),
]


def scan(text: str) -> list[Hit]:
    hits: list[Hit] = []
    taken: list[tuple[int, int]] = []
    for typ, pat, check in _RULES:
        for m in re.finditer(pat, text):
            if check and not check(m.group(0), text, m.start()):  # type: ignore[operator]
                continue
            if any(m.start() < e and s < m.end() for s, e in taken):
                continue
            taken.append((m.start(), m.end()))
            hits.append(Hit(typ, m.group(0), f"builtin:{typ.lower()}"))
    return hits


class PresidioScanner:
    """Optional: Presidio's analyzer (with its India recognizers) as a second opinion."""

    def __init__(self) -> None:
        from presidio_analyzer import AnalyzerEngine  # noqa: PLC0415
        from presidio_analyzer.nlp_engine import NlpEngineProvider  # noqa: PLC0415

        provider = NlpEngineProvider(nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        })
        self.engine = AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])
        self.entities = [
            "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "IN_AADHAAR", "IN_PAN", "IN_PASSPORT",
            "IN_VOTER", "IN_GSTIN", "IBAN_CODE",
        ]

    def scan(self, text: str) -> list[Hit]:
        res = self.engine.analyze(text=text, language="en", entities=self.entities, score_threshold=0.6)
        return [Hit(r.entity_type, text[r.start:r.end], "presidio") for r in res]


def load_presidio() -> PresidioScanner | None:
    try:
        return PresidioScanner()
    except Exception as e:  # noqa: BLE001 - optional dependency
        print(f"[parda] Presidio not loaded: {e.__class__.__name__}: {e}")
        return None
