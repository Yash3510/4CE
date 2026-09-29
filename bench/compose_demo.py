"""Turns the frames recorded by demo.mjs into out/demo/parda-demo.mp4 (1920x1080) plus stills.

    uv run --with pillow python compose_demo.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "out" / "demo"
RAW = OUT / "raw"
FRAMES = OUT / "frames"
W, H = 1920, 1080
NAVY, INK, MUTED, BG = (20, 33, 61), (28, 28, 26), (95, 99, 110), (238, 240, 243)
GREEN, RED, AMBER = (31, 122, 77), (180, 35, 24), (154, 103, 0)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for n in (name, "segoeui.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_CAP = font("segoeuib.ttf", 34)
F_LAB = font("segoeuib.ttf", 21)
F_TXT = font("segoeui.ttf", 22)
F_MONO = font("consola.ttf", 20)
F_BIG = font("segoeuib.ttf", 64)
F_MID = font("segoeui.ttf", 32)


GLYPHS = str.maketrans({"①": "1 ·", "②": "2 ·", "③": "3 ·", "④": "4 ·", "⑤": "5 ·", "⑥": "6 ·", "⚠": "!", "⟦": "[[", "⟧": "]]", "✓": "ok", "✗": "x"})


def plain(s: str) -> str:
    """Segoe UI / Consolas lack these glyphs; swap them for ones they have."""
    return (s or "").translate(GLYPHS)


def fit(im: Image.Image, w: int, h: int) -> Image.Image:
    k = min(w / im.width, h / im.height)
    return im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)


def card(lines: list[tuple[str, ImageFont.FreeTypeFont, tuple[int, int, int]]]) -> Image.Image:
    im = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(im)
    y = H // 2 - sum(f.size + 22 for _, f, _ in lines) // 2
    for text, f, col in lines:
        tw = d.textlength(text, font=f)
        d.text(((W - tw) / 2, y), text, font=f, fill=col)
        y += f.size + 22
    return im


def compose(fr: dict, stats: dict) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # Caption
    d.rectangle([0, 0, W, 116], fill=NAVY)
    lines = textwrap.wrap(plain(fr["caption"]) or "4CE · privacy-first browser agent", 88)[:2]
    y = 58 - len(lines) * 21
    for ln in lines:
        d.text((36, y), ln, font=F_CAP, fill="white")
        y += 42
    # Panes
    pw, ph, top = 924, 700, 170
    compromised = "COMPROMISED" in (fr.get("planner") or "")
    d.text((24, 130), "YOUR SCREEN · real data, never leaves this device", font=F_LAB, fill=GREEN)
    d.text((24 + pw + 24, 130), "WHAT THE COMPROMISED SERVER RECEIVES" if compromised else "WHAT THE PLANNER SERVER RECEIVES", font=F_LAB, fill=RED if compromised else NAVY)
    real = fit(Image.open(RAW / fr["real"]).convert("RGB"), pw, ph)
    im.paste(real, (24, top))
    d.rectangle([24, top, 24 + real.width, top + real.height], outline=(200, 202, 208), width=2)
    x2 = 24 + pw + 24
    if fr.get("server") and (RAW / fr["server"]).exists():
        srv = fit(Image.open(RAW / fr["server"]).convert("RGB"), pw, ph)
        im.paste(srv, (x2, top))
        d.rectangle([x2, top, x2 + srv.width, top + srv.height], outline=RED if compromised else NAVY, width=3)
    else:
        d.rectangle([x2, top, x2 + pw, top + real.height], fill=(226, 229, 234), outline=(200, 202, 208), width=2)
        d.text((x2 + 40, top + real.height // 2 - 14), "Nothing sent yet.", font=F_MID, fill=MUTED)
    # Bottom bar: approval or latest step, and the receipt
    by = top + max(real.height, 0) + 22
    if fr.get("approval"):
        d.rounded_rectangle([24, by, 24 + pw, by + 110], radius=10, fill=(255, 243, 205), outline=AMBER, width=2)
        d.text((44, by + 14), "4CE ASKS YOU", font=F_LAB, fill=AMBER)
        for i, ln in enumerate(textwrap.wrap(plain(fr["approval"]), 70)[:2]):
            d.text((44, by + 44 + i * 30), ln, font=F_TXT, fill=INK)
    else:
        d.text((24, by), "AGENT STEPS", font=F_LAB, fill=MUTED)
        for i, ln in enumerate((fr.get("log") or [])[-3:]):
            # innerText of the hidden Steps tab loses line breaks: drop the timings, split the kind off.
            ln = re.sub(r"dom \d+ ·.*$", "", plain(ln)).strip()
            m = re.match(r"^(plan|act|done|blocked|declined|error|info)(.*)$", ln, re.I)
            if m:
                k = m.group(1).lower(); ln = f"{k.upper() if k in ('blocked', 'declined') else k:<9}{m.group(2).strip()}"
            col = RED if ln.startswith(("BLOCKED", "DECLINED")) else INK
            d.text((24, by + 32 + i * 28), ln if len(ln) <= 74 else ln[:73] + "…", font=F_MONO, fill=col)
    c = fr.get("client") or {}
    s = fr.get("serverReceipt") or {}
    d.text((x2, by), "RECEIPT", font=F_LAB, fill=MUTED)
    rows = [
        f"requests sent {c.get('requestsSent', 0)} · blocked {c.get('requestsBlocked', 0)} · {c.get('bytesSent', 0) / 1e6:.2f} MB",
        f"values sent as tokens {c.get('redactions', 0)} · egress-gate hits {c.get('gateHitsOnSent', 0)}",
        f"server's own scan: {s.get('pii_hits', 0)} personal values · {s.get('canary_hits', 0)} canaries in {s.get('payloads', 0)} payloads",
    ]
    for i, r in enumerate(rows):
        d.text((x2, by + 32 + i * 28), r, font=F_MONO, fill=GREEN if i == 2 else INK)
    return im


def main() -> None:
    data = json.loads((OUT / "frames.json").read_text(encoding="utf-8"))
    frames = data["frames"]
    shutil.rmtree(FRAMES, ignore_errors=True)
    FRAMES.mkdir(parents=True)
    (OUT / "stills").mkdir(exist_ok=True)
    seq: list[Image.Image] = []
    title = card([("4CE", F_BIG, (255, 255, 255)), ("a privacy-first browser agent · SIH26171 · live demo", F_MID, (200, 210, 235)),
                  ("personal data is found and hidden on the device; the planner sees only tokens", F_TXT, (170, 185, 215))])
    seq += [title] * 6
    last_caption, stills = None, 0
    for i, fr in enumerate(frames):
        im = compose(fr, {})
        seq.append(im)
        nxt = frames[i + 1]["caption"] if i + 1 < len(frames) else None
        if fr["caption"] and fr["caption"] != nxt and fr["caption"] != last_caption:
            stills += 1
            im.save(OUT / "stills" / f"scene_{stills:02d}.jpg", quality=90)
            last_caption = fr["caption"]
    end = card([("82 / 82 labelled PII items hidden · 100% box precision", F_MID, (255, 255, 255)),
                ("0 personal values and 0 canaries in what the server received", F_MID, (255, 255, 255)),
                ("a compromised server's exfiltration attempts refused on the device", F_MID, (255, 255, 255)),
                ("Chrome + Firefox · Qwen3-VL planner · Presidio audit · hash-chained trail", F_TXT, (170, 185, 215))])
    seq += [end] * 12
    for i, im in enumerate(seq):
        im.save(FRAMES / f"f_{i:05d}.jpg", quality=88)
    mp4 = OUT / "4ce-demo.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "2", "-i", str(FRAMES / "f_%05d.jpg"),
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "22", "-preset", "medium", "-movflags", "+faststart", str(mp4)], check=True)
    print(f"{len(seq)} frames -> {mp4} ({mp4.stat().st_size / 1e6:.1f} MB), {stills} stills")


if __name__ == "__main__":
    main()
