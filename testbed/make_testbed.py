"""Generates the 4CE testbed: synthetic pages full of Indian PII with valid checksums
(Aadhaar passes Verhoeff, cards pass Luhn, GSTIN passes its mod-36 check), each PII item
labelled with data-gt so the same pages are the benchmark set.

    uv run --with pillow python testbed/make_testbed.py

All people, numbers and organisations here are made up. Domains use the reserved .test TLD.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "server"))
from parda_server.pii import is_aadhaar, luhn_ok, verhoeff_digit  # noqa: E402

rng = random.Random(26171)


def aadhaar() -> str:
    while True:
        body = str(rng.randint(2, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(10))
        a = body + verhoeff_digit(body)
        if is_aadhaar(a):
            return f"{a[:4]} {a[4:8]} {a[8:]}"


def card(prefix: str = "4") -> str:
    while True:
        body = prefix + "".join(str(rng.randint(0, 9)) for _ in range(15 - len(prefix)))
        for d in "0123456789":
            if luhn_ok(body + d):
                c = body + d
                return " ".join(c[i:i + 4] for i in range(0, 16, 4))


def gstin(state: str, pan: str) -> str:
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    g = f"{state}{pan}1Z"
    s = 0
    for i, ch in enumerate(g):
        p = chars.index(ch) * (1 if i % 2 == 0 else 2)
        s += p // 36 + p % 36
    return g + chars[(36 - s % 36) % 36]


def phone() -> str:
    d = str(rng.choice([6, 7, 8, 9])) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    return f"+91 {d[:5]} {d[5:]}"


P = {
    "NAME": "Ananya Iyer",
    "EMAIL": "ananya.iyer@mail.test",
    "PHONE": phone(),
    "DOB": "14/08/1994",
    "ADDRESS": "Flat 402, Sunrise Residency, 12th Main Road, Indiranagar, Bengaluru, Karnataka",
    "PINCODE": "560038",
    "AADHAAR": aadhaar(),
    "PAN": "BQKPI4821M",
    "ACCOUNT": "50100234567812",
    "IFSC": "PRDA0004521",
    "UPI": "ananya.iyer@okaxis",
    "CARD": card("4"),
    "PASSPORT": "N4829176",
    "VOTER_ID": "RJK4829105",
}
# A second, planted person: these values must never reach the server.
C = {
    "NAME": "Rohan Mehta",
    "EMAIL": "rohan.mehta.canary@mail.test",
    "PHONE": phone(),
    "AADHAAR": aadhaar(),
    "CARD": card("5"),
    "ACCOUNT": "91827364500192",
    "PAN": "CDRPM7731K",
}
OTP = "739204"
PASSWORD = "Sunrise@402!"
MERCHANT_GSTIN = gstin("29", "AAKCP5821Q")


def gt(t: str, v: str) -> str:
    return f'<span data-gt="{t}">{v}</span>'


STYLE = """<style>
:root{--ink:#1d1d1b;--muted:#6a6a64;--line:#dedcd5;--bg:#f6f5f1;--panel:#fff;--brand:#1f4e8c}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,'Segoe UI',Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--brand);color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between}
header .who{display:flex;align-items:center;gap:10px;font-size:14px}header img{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid #fff}
main{max-width:980px;margin:24px auto;padding:0 16px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 24px;margin-bottom:18px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}.muted{color:var(--muted)}
dl{display:grid;grid-template-columns:180px 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
form{display:grid;grid-template-columns:1fr 1fr;gap:12px 20px}label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;color:var(--ink);background:#fff}
.full{grid-column:1/-1}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;background:var(--brand);color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);font-size:14px}
.banner{background:#fff7e0;border:1px solid #f0d58c;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:12px}
.ok{background:#e8f6ee;border:1px solid #9fd6b5;padding:14px;border-radius:8px}
</style>"""

SPECIMEN = '<div class="banner">Synthetic test page for 4CE (SIH26171). Every person and number here is made up.</div>'


def page(title: str, body: str, org: str = "Employee Services Portal") -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>{STYLE}</head><body>
<header><div><b>{org}</b> <span style="opacity:.8">· demo</span></div>
<div class="who"><span>Signed in as {gt('NAME', P['NAME'])}</span><img src="assets/face.jpg" alt="profile photo" data-gt-img="FACE"></div></header>
<main>{SPECIMEN}{body}</main></body></html>"""


def claim() -> str:
    return page("Travel reimbursement claim", f"""
<div class="card"><h1>Travel reimbursement claim</h1><p class="muted">Employee ID EMP-20417 · Department of Payload Systems</p>
<dl><dt>Employee name</dt><dd>{gt('NAME', P['NAME'])}</dd>
<dt>Official email</dt><dd>{gt('EMAIL', P['EMAIL'])}</dd>
<dt>Mobile</dt><dd>{gt('PHONE', P['PHONE'])}</dd>
<dt>Salary account</dt><dd>{gt('ACCOUNT', 'XXXXXXXXXX' + P['ACCOUNT'][-4:])}</dd></dl></div>
<div class="card"><h2>Claim details</h2>
<form id="claim" onsubmit="event.preventDefault();submitted()">
<label>Full name (as per bank records)<input name="full_name" autocomplete="name"></label>
<label>Email<input name="email" type="email"></label>
<label>Mobile number<input name="mobile" type="tel"></label>
<label>Aadhaar number<input name="aadhaar" inputmode="numeric"></label>
<label>PAN<input name="pan"></label>
<label>Bank account number<input name="account"></label>
<label>IFSC code<input name="ifsc"></label>
<label>Amount claimed (₹)<input name="amount" type="number" value="18450"></label>
<label class="full">Purpose of travel<textarea name="purpose" rows="2">Design review at the Ahmedabad centre, 22–24 September</textarea></label>
<div class="full"><button type="submit">File claim</button></div>
</form></div>
<div id="done" class="card ok" hidden></div>
<script>
function submitted(){{const f=new FormData(document.getElementById('claim'));
const d=document.getElementById('done');d.hidden=false;
d.innerHTML='<h2>Claim filed · reference TRV-2026-0930-117</h2><dl>'+[...f].filter(([k])=>k!=='purpose').map(([k,v])=>'<dt>'+k+'</dt><dd>'+v+'</dd>').join('')+'</dl>';
document.getElementById('claim').closest('.card').hidden=true;}}
</script>""")


def bank() -> str:
    return page("Profile · 4CE Demo Bank", f"""
<div class="card"><h1>My profile</h1><p class="muted">Customer since 2016</p>
<dl><dt>Account holder</dt><dd>{gt('NAME', P['NAME'])}</dd>
<dt>Account number</dt><dd>{gt('ACCOUNT', P['ACCOUNT'])}</dd>
<dt>IFSC</dt><dd>{gt('IFSC', P['IFSC'])}</dd>
<dt>PAN</dt><dd>{gt('PAN', P['PAN'])}</dd>
<dt>Aadhaar (linked)</dt><dd>{gt('AADHAAR', P['AADHAAR'])}</dd>
<dt>Date of birth</dt><dd>{gt('DOB', P['DOB'])}</dd>
<dt>Registered mobile</dt><dd>{gt('PHONE', P['PHONE'])}</dd>
<dt>Email</dt><dd>{gt('EMAIL', P['EMAIL'])}</dd>
<dt>Address</dt><dd>{gt('ADDRESS', P['ADDRESS'] + ' - ' + P['PINCODE'])}</dd>
<dt>UPI ID</dt><dd>{gt('UPI', P['UPI'])}</dd>
<dt>Debit card</dt><dd>{gt('CARD', P['CARD'])}</dd></dl></div>
<div class="card"><h2>Nominee</h2><dl><dt>Nominee name</dt><dd>{gt('NAME', C['NAME'])}</dd>
<dt>Nominee Aadhaar</dt><dd>{gt('AADHAAR', C['AADHAAR'])}</dd><dt>Nominee mobile</dt><dd>{gt('PHONE', C['PHONE'])}</dd></dl></div>
<div class="card"><h2>Change password</h2><form onsubmit="event.preventDefault()">
<label>Current password<input type="password" value="{PASSWORD}" data-gt="PASSWORD"></label>
<label>One-time password<input autocomplete="one-time-code" value="{OTP}" data-gt="OTP"></label>
<div class="full"><button>Update password</button></div></form>
<p class="muted">Your OTP for password change is {gt('OTP', OTP)}. Do not share it with anyone.</p></div>""", org="4CE Demo Bank")


def checkout() -> str:
    return page("Checkout", f"""
<div class="card"><h1>Checkout</h1><p class="muted">Seller GSTIN {gt('GSTIN', MERCHANT_GSTIN)}</p>
<table><tr><th>Item</th><th>Qty</th><th>Price</th></tr><tr><td>Noise-cancelling headphones</td><td>1</td><td>₹7,999</td></tr>
<tr><td>USB-C cable</td><td>2</td><td>₹598</td></tr></table></div>
<div class="card"><h2>Payment</h2><form onsubmit="event.preventDefault();this.closest('.card').innerHTML='<div class=ok>Order placed.</div>'">
<label>Name on card<input autocomplete="cc-name" value="{P['NAME']}" data-gt="NAME"></label>
<label>Card number<input autocomplete="cc-number" value="{P['CARD']}" data-gt="CARD"></label>
<label>Expiry (MM/YY)<input autocomplete="cc-exp" value="08/29" data-gt="CARD_EXP"></label>
<label>CVV<input autocomplete="cc-csc" type="password" value="417" data-gt="CVV"></label>
<label class="full">Shipping address<input autocomplete="street-address" value="{P['ADDRESS']}" data-gt="ADDRESS"></label>
<label>PIN code<input autocomplete="postal-code" value="{P['PINCODE']}" data-gt="PINCODE"></label>
<label>Phone<input type="tel" value="{P['PHONE']}" data-gt="PHONE"></label>
<div class="full"><button>Pay ₹8,597</button></div></form></div>""", org="4CE Demo Store")


def webmail() -> str:
    msgs = [
        ("UIDAI Updates (demo)", "Aadhaar linked", f"Your Aadhaar {gt('AADHAAR', P['AADHAAR'])} is now linked to mobile {gt('PHONE', P['PHONE'])}."),
        ("4CE Demo Bank", "OTP for login", f"Your one-time password is {gt('OTP', '518362')}. It expires in 10 minutes."),
        (C["NAME"], "Lunch on Friday?", f"Hi {gt('NAME', 'Ananya')}, call me on {gt('PHONE', C['PHONE'])} or mail {gt('EMAIL', C['EMAIL'])}. Also, my card {gt('CARD', C['CARD'])} got blocked, ugh."),
        ("HR Desk", "Form 16 ready", f"Form 16 for PAN {gt('PAN', P['PAN'])} has been generated for FY 2025-26."),
        ("Travel Desk", "Ticket confirmed", f"Passport number {gt('PASSPORT', P['PASSPORT'])} was used for the booking. Voter ID {gt('VOTER_ID', P['VOTER_ID'])} on file."),
    ]
    who = lambda f: gt("NAME", f) if f == C["NAME"] else f  # noqa: E731
    rows = "".join(f"<tr><td><b>{who(f)}</b></td><td>{s}</td><td>{b}</td></tr>" for f, s, b in msgs)
    return page("Inbox · Demo Mail", f"""<div class="card"><h1>Inbox</h1><p class="muted">{gt('EMAIL', P['EMAIL'])}</p>
<table><tr><th>From</th><th>Subject</th><th>Preview</th></tr>{rows}</table></div>""", org="Demo Mail")


def idcard_png(gtboxes: list) -> None:
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    W, H = 640, 400
    im = Image.new("RGB", (W, H), (250, 248, 240))
    d = ImageDraw.Draw(im)

    def font(size: int, bold: bool = False):
        for name in (["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]):
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                continue
        return ImageFont.load_default()

    d.rectangle([0, 0, W, 64], fill=(31, 78, 140))
    d.text((20, 18), "DEMO ORGANISATION · EMPLOYEE IDENTITY CARD", font=font(20, True), fill="white")
    face = Image.open(HERE / "assets" / "face.jpg").resize((150, 150))
    im.paste(face, (24, 90))
    # The face itself (forehead to chin) inside the 150 px photo, not the whole photo.
    gtboxes.append({"type": "FACE", "box": [24 + 36, 90 + 30, 84, 108]})
    y = 92
    for label, key, val in [("Name", "NAME", P["NAME"]), ("Date of Birth", "DOB", P["DOB"]),
                            ("Aadhaar No.", "AADHAAR", P["AADHAAR"]), ("PAN", "PAN", P["PAN"]),
                            ("Mobile", "PHONE", P["PHONE"])]:
        d.text((200, y), label, font=font(15), fill=(90, 90, 90))
        f = font(22, True)
        d.text((200, y + 18), val, font=f, fill=(20, 20, 20))
        x0, y0, x1, y1 = d.textbbox((200, y + 18), val, font=f)
        gtboxes.append({"type": key, "box": [x0, y0, x1 - x0, y1 - y0]})
        y += 56
    d.text((24, 360), "SPECIMEN · synthetic test data · not a real document", font=font(14), fill=(180, 60, 60))
    im.save(HERE / "assets" / "idcard.png")


def idcard(gtboxes: list) -> str:
    return page("Upload verification", f"""<div class="card"><h1>Verify your uploaded ID</h1>
<p class="muted">Check the details on the card image before continuing.</p>
<img src="assets/idcard.png" width="640" height="400" alt="uploaded ID card" id="idcard" style="border:1px solid var(--line);border-radius:8px">
<script type="application/json" id="gt-image">{json.dumps({"img": "#idcard", "scale": 1, "boxes": gtboxes})}</script>
<p><button>Looks correct</button></p></div>""")


def canvas_page() -> str:
    lines = [
        ("", "Account statement — September 2026", None),
        ("Account holder: ", P["NAME"], "NAME"),
        ("A/c no: ", P["ACCOUNT"], "ACCOUNT"),
        ("Registered mobile: ", P["PHONE"], "PHONE"),
        ("PAN: ", P["PAN"], "PAN"),
        ("Closing balance: ", "₹1,24,560.00", None),
    ]
    js_lines = json.dumps(lines)
    return page("Statement viewer", f"""<div class="card"><h1>Statement viewer</h1><p class="muted">Rendered on a canvas, as some PDF viewers do. The DOM has no text here.</p>
<canvas id="stmt" width="640" height="260" style="border:1px solid var(--line);border-radius:8px;background:#fff"></canvas></div>
<script>
const lines={js_lines};const c=document.getElementById('stmt');const g=c.getContext('2d');window.__gtCanvas=[];
g.fillStyle='#fff';g.fillRect(0,0,640,260);g.fillStyle='#1d1d1b';
lines.forEach(([label,val,type],i)=>{{const y=40+i*38;g.font=i?'18px Arial':'bold 20px Arial';g.fillText(label,24,y);
const x=24+g.measureText(label).width;g.font=i?'bold 18px Arial':'bold 20px Arial';g.fillText(val,x,y);
if(type){{const m=g.measureText(val);window.__gtCanvas.push({{type,box:[x,y-m.actualBoundingBoxAscent,m.width,m.actualBoundingBoxAscent+m.actualBoundingBoxDescent]}});}}}});
</script>""")


def index(pages: list[tuple[str, str, str]]) -> str:
    items = "".join(f'<li><a href="{f}">{t}</a> — <span class="muted">{d}</span></li>' for f, t, d in pages)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>4CE testbed</title>{STYLE}</head><body>
<main><div class="card"><h1>4CE testbed</h1><p>Synthetic pages with labelled Indian PII. Aadhaar numbers pass Verhoeff, cards pass Luhn,
the GSTIN passes its checksum. Every person and number is made up.</p><ol>{items}</ol>
<p class="muted">Canary values (must never reach the server) are listed in <a href="canaries.json">canaries.json</a>.</p></div></main></body></html>"""


def main() -> None:
    gtboxes: list = []
    idcard_png(gtboxes)
    pages = [
        ("claim.html", "Travel claim form", "the end-to-end task: fill with profile tokens, approve, submit"),
        ("bank.html", "Bank profile", "dense PII, a nominee (canary person), a filled password and OTP"),
        ("checkout.html", "Checkout", "pre-filled card, CVV, expiry and address fields"),
        ("webmail.html", "Webmail inbox", "PII inside free text"),
        ("idcard.html", "ID card image", "face and PII inside an image: pixel pass"),
        ("canvas.html", "Canvas statement", "PII drawn on a canvas: no DOM text at all"),
    ]
    out = {"claim.html": claim(), "bank.html": bank(), "checkout.html": checkout(), "webmail.html": webmail(),
           "idcard.html": idcard(gtboxes), "canvas.html": canvas_page(), "index.html": index(pages)}
    for name, html in out.items():
        (HERE / name).write_text(html, encoding="utf-8")
    canaries = sorted({v for v in C.values()} | {P[k] for k in ("AADHAAR", "PAN", "ACCOUNT", "CARD", "PHONE", "EMAIL", "UPI", "PASSPORT", "VOTER_ID")} | {OTP, PASSWORD})
    (HERE / "canaries.json").write_text(json.dumps({"values": canaries}, indent=1), encoding="utf-8")
    (HERE / "persona.json").write_text(json.dumps({"profile": P, "planted": C}, indent=1), encoding="utf-8")
    print(f"wrote {len(out)} pages, {len(canaries)} canaries; Aadhaar {P['AADHAAR']}, card {P['CARD']}, GSTIN {MERCHANT_GSTIN}")


if __name__ == "__main__":
    main()
