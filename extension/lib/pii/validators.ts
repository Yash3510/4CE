// Pattern + checksum detectors for Indian and common PII.
// Aadhaar (Verhoeff), PAN, GSTIN, passport and voter-ID rules are ported from
// Microsoft Presidio's India recognizers (MIT licence), see THIRD_PARTY_NOTICES.md.
// Checksums decide before any model is asked: a 12-digit number is only an
// Aadhaar if its Verhoeff digit is right, a card only if it passes Luhn.

import { GREETING_RE, isLikelyName, NAME_SEQ_RE } from './names';
import type { PiiType, TextMatch } from './types';

// ---------- checksums ----------

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(digits: string): boolean {
  let c = 0;
  const rev = digits.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = VD[c][VP[i % 8][rev[i]]];
  return c === 0;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinChecksum(g: string): boolean {
  if (g.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(g[i]);
    if (v < 0) return false;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

export function isAadhaar(raw: string): boolean {
  const d = digitsOf(raw);
  return d.length === 12 && d[0] >= '2' && verhoeff(d) && d !== d.split('').reverse().join('');
}

// Visa, Mastercard (51-55, 2221-2720), Amex, Discover, RuPay (60, 65, 81, 82, 508, 353, 356), Diners, JCB.
const IIN = /^(4|5[1-5]|2[2-7]|3[47]|3[05689]|6[05]|8[12]|508|353|356|62)/;
export function isCard(raw: string): { ok: boolean; knownIin: boolean } {
  const d = digitsOf(raw);
  if (d.length < 13 || d.length > 19 || !luhn(d) || /^(\d)\1+$/.test(d)) return { ok: false, knownIin: false };
  return { ok: true, knownIin: IIN.test(d) };
}

// ---------- context words ----------

const CTX: Partial<Record<PiiType, RegExp>> = {
  AADHAAR: /aadha?ar|\buid(ai)?\b|आधार/i,
  PAN: /\bpan\b|permanent account/i,
  ACCOUNT: /account|\ba\/c\b|\bacc(t)?\.?\s*(no|number|#)|khata|खाता/i,
  IFSC: /ifsc/i,
  PHONE: /mobile|phone|\btel\b|contact|whats\s?app|\bmob\b|call|मोबाइल/i,
  DOB: /\bdob\b|d\.o\.b|date of birth|birth\s?date|\bborn\b|जन्म/i,
  OTP: /\botp\b|one[- ]time|verification code|passcode|security code|login code/i,
  CVV: /\bcvv\b|\bcvc\b|card verification|security code/i,
  PINCODE: /\bpin\s?code\b|\bpin\b|postal|\bzip\b|पिन/i,
  PASSPORT: /passport/i,
  VOTER_ID: /voter|\bepic\b|election/i,
  UPI: /\bupi\b|\bvpa\b|pay to|payment address/i,
  CARD_EXP: /\bexp(iry|ires)?\b|valid (thru|till|through)|mm\s?\/\s?yy/i,
  CARD: /card/i,
};

function hasCtx(type: PiiType, text: string, start: number, extra?: string): boolean {
  const re = CTX[type];
  if (!re) return false;
  const window = text.slice(Math.max(0, start - 48), start);
  return re.test(window) || (!!extra && re.test(extra));
}

const UPI_HANDLES = new Set(
  (
    'ybl ibl axl okaxis okhdfcbank okicici oksbi paytm ptyes ptaxis pthdfc ptsbi upi apl yapl rapl abfspay axisbank ' +
    'icici hdfcbank sbi kotak barodampay idfcbank indus federal pnb boi cnrb unionbank jupiteraxis fam freecharge mbk ' +
    'airtel jio slice naviaxis yesbank dbs citi hsbc sc rbl kbl aubank equitas timecosmos waaxis wahdfcbank wasbi waicici'
  ).split(' '),
);

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

interface Rule {
  type: PiiType;
  re: RegExp;
  /** Returns a confidence in [0,1], or 0 to reject. */
  score: (m: string, text: string, start: number, ctx?: string) => number;
  name: string;
}

const RULES: Rule[] = [
  {
    name: 'email',
    type: 'EMAIL',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    score: () => 0.99,
  },
  {
    name: 'upi',
    type: 'UPI',
    re: /[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,20}(?![A-Za-z0-9.-]*\.[A-Za-z])/g,
    score: (m, t, s, c) => {
      const handle = m.split('@')[1].toLowerCase();
      if (UPI_HANDLES.has(handle)) return 0.96;
      return hasCtx('UPI', t, s, c) ? 0.85 : 0;
    },
  },
  {
    name: 'gstin+checksum',
    type: 'GSTIN',
    re: /\b(?:0[1-9]|[1-3][0-9])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
    score: (m) => (gstinChecksum(m) ? 0.98 : 0.6),
  },
  {
    name: 'card+luhn',
    type: 'CARD',
    re: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    score: (m, t, s, c) => {
      const r = isCard(m);
      if (!r.ok) return 0;
      if (r.knownIin) return 0.97;
      return hasCtx('CARD', t, s, c) ? 0.9 : 0.55;
    },
  },
  {
    name: 'aadhaar+verhoeff',
    type: 'AADHAAR',
    re: /(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    score: (m, t, s, c) => (isAadhaar(m) ? (hasCtx('AADHAAR', t, s, c) ? 0.99 : 0.93) : 0),
  },
  {
    name: 'aadhaar-masked',
    type: 'AADHAAR',
    re: /(?<![\w])[Xx*•]{4}[ -]?[Xx*•]{4}[ -]?\d{4}(?!\d)/g,
    score: () => 0.85,
  },
  {
    name: 'pan',
    type: 'PAN',
    re: /\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b/g,
    score: (m, t, s, c) => (hasCtx('PAN', t, s, c) ? 0.99 : 0.93),
  },
  {
    name: 'ifsc',
    type: 'IFSC',
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    score: (m, t, s, c) => (hasCtx('IFSC', t, s, c) ? 0.98 : 0.88),
  },
  {
    name: 'phone-in',
    type: 'PHONE',
    re: /(?<![\d+])(?:(?:\+|00)91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
    score: (m, t, s, c) => {
      // "OTP 9876543210" in the same sentence is not a phone; a nearby label only adds weight
      // (an "Account number" label still wins through the account rule's higher score).
      if (hasCtx('ACCOUNT', t, s) || hasCtx('OTP', t, s)) return 0;
      return hasCtx('PHONE', t, s, c) || /^(\+|00)91/.test(m) ? 0.97 : 0.88;
    },
  },
  {
    name: 'phone-intl',
    type: 'PHONE',
    re: /\+(?!91)\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g,
    score: () => 0.8,
  },
  {
    name: 'account+ctx',
    type: 'ACCOUNT',
    re: /(?<![\d-])\d{9,18}(?![\d-])/g,
    score: (m, t, s, c) => (hasCtx('ACCOUNT', t, s, c) ? 0.9 : 0),
  },
  {
    name: 'account-masked',
    type: 'ACCOUNT',
    re: /(?<![\w])[Xx*•]{4,14}\d{3,4}(?!\d)/g,
    score: (m, t, s, c) => (hasCtx('ACCOUNT', t, s, c) ? 0.8 : 0),
  },
  {
    name: 'passport+ctx',
    type: 'PASSPORT',
    re: /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b/g,
    score: (m, t, s, c) => (hasCtx('PASSPORT', t, s, c) ? 0.92 : 0),
  },
  {
    name: 'voter+ctx',
    type: 'VOTER_ID',
    re: /\b[A-Z]{3}\d{7}\b/g,
    score: (m, t, s, c) => (hasCtx('VOTER_ID', t, s, c) ? 0.92 : 0),
  },
  {
    name: 'otp+ctx',
    type: 'OTP',
    re: /(?<![\d-])\d{4,8}(?![\d-])/g,
    score: (m, t, s, c) => (hasCtx('OTP', t, s, c) ? 0.95 : 0),
  },
  {
    name: 'cvv+ctx',
    type: 'CVV',
    re: /(?<![\d-])\d{3,4}(?![\d-])/g,
    score: (m, t, s, c) => (hasCtx('CVV', t, s, c) ? 0.9 : 0),
  },
  {
    name: 'card-exp+ctx',
    type: 'CARD_EXP',
    re: /\b(?:0[1-9]|1[0-2])\s?\/\s?(?:\d{2}|20\d{2})\b/g,
    score: (m, t, s, c) => (hasCtx('CARD_EXP', t, s, c) ? 0.88 : 0),
  },
  {
    name: 'dob+ctx',
    type: 'DOB',
    re: new RegExp(
      String.raw`\b(?:(?:0?[1-9]|[12]\d|3[01])[\/\-.](?:0?[1-9]|1[0-2])[\/\-.](?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(?:${MONTHS})\.?,?\s+(?:19|20)\d{2})\b`,
      'gi',
    ),
    score: (m, t, s, c) => (hasCtx('DOB', t, s, c) ? 0.95 : 0),
  },
  {
    name: 'pincode+ctx',
    type: 'PINCODE',
    re: /(?<!\d)[1-9]\d{2}\s?\d{3}(?!\d)/g,
    score: (m, t, s, c) => {
      if (hasCtx('PINCODE', t, s, c)) return 0.88;
      // "Bengaluru - 560034" style: a capitalised word then a separator then six digits
      return /[A-Za-z]{3,}\s*[-,]\s*$/.test(t.slice(Math.max(0, s - 24), s)) ? 0.75 : 0;
    },
  },
];

// "Name: Ananya Iyer", "Address - 12, MG Road ..." in one run of text (also used on OCR lines).
const KV_KEYS: [RegExp, PiiType][] = [
  [/(?:full\s+|applicant(?:'s)?\s+|customer\s+|employee\s+|account\s*holder(?:'s)?\s*|card\s*holder(?:'s)?\s*|father(?:'s)?\s+|mother(?:'s)?\s+|spouse(?:'s)?\s+|guardian(?:'s)?\s+)?name|account\s*holder|nominee|s\/o|d\/o|w\/o/i, 'NAME'],
  [/(?:residential\s+|permanent\s+|correspondence\s+|billing\s+|shipping\s+|delivery\s+|home\s+)?address/i, 'ADDRESS'],
  [/date\s+of\s+birth|\bdob\b|d\.o\.b/i, 'DOB'],
];
const KV_RE =
  /(?:^|[\n|]|\s{2,})\s*((?:[A-Za-z'\/]+\s+){0,3}?(?:name|holder|nominee|address|date of birth|dob|d\.o\.b|s\/o|d\/o|w\/o))\s*[:\-–]\s*([^\n|]{2,160})/gi;

function scanKeyValue(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  KV_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KV_RE.exec(text))) {
    const key = m[1];
    const type = KV_KEYS.find(([re]) => re.test(key))?.[1];
    if (!type || /(bank|branch|company|product|file|city|state|scheme|course|department|project|hotel|place|user)\s*name/i.test(key)) continue;
    let value = m[2];
    if (type === 'NAME') value = (value.match(/^[A-Za-z][A-Za-z.' ]{1,60}?(?=\s{2,}|\s*[,;(]|$)/) || [''])[0];
    if (type === 'DOB') value = (value.match(/^[\w ,./-]{6,20}?(?=\s{2,}|$)/) || [''])[0];
    value = value.trim();
    if (value.length < 2) continue;
    const start = m.index + m[0].indexOf(m[2]);
    out.push({ type, start, end: start + value.length, value, conf: 0.85, rule: 'key-value' });
  }
  return out;
}

/** Names in free text: after a greeting or honorific, or a capitalised pair the gazetteer knows. */
function scanNames(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  GREETING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GREETING_RE.exec(text))) {
    const start = m.index + m[0].lastIndexOf(m[1]);
    const words = m[1].split(/\s+/);
    // "Hi Ananya" is a name; "Dear Customer" is not.
    if (isLikelyName(words) || isLikelyName([words[0], words[0]])) {
      out.push({ type: 'NAME', start, end: start + m[1].length, value: m[1], conf: 0.85, rule: 'greeting' });
    }
  }
  NAME_SEQ_RE.lastIndex = 0;
  while ((m = NAME_SEQ_RE.exec(text))) {
    if (isLikelyName(m[0].split(/\s+/))) out.push({ type: 'NAME', start: m.index, end: m.index + m[0].length, value: m[0], conf: 0.78, rule: 'name-gazetteer' });
  }
  return out;
}

export interface ScanOptions {
  /** Label or nearby text that describes the scanned string (e.g. the field's label). */
  context?: string;
  minConf?: number;
}

/** Find PII in a run of text. Returns non-overlapping matches, best first on overlap. */
export function scanText(text: string, opts: ScanOptions = {}): TextMatch[] {
  const minConf = opts.minConf ?? 0.5;
  const found: TextMatch[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const conf = rule.score(m[0], text, m.index, opts.context);
      if (conf >= minConf) {
        found.push({ type: rule.type, start: m.index, end: m.index + m[0].length, value: m[0], conf, rule: rule.name });
      }
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  found.push(...scanKeyValue(text), ...scanNames(text));
  // Resolve overlaps: higher confidence wins, then longer span.
  found.sort((a, b) => b.conf - a.conf || b.end - b.start - (a.end - a.start));
  const kept: TextMatch[] = [];
  for (const f of found) {
    if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// ---------- field semantics (structure pass) ----------

const AUTOCOMPLETE: Record<string, PiiType> = {
  'cc-number': 'CARD',
  'cc-csc': 'CVV',
  'cc-exp': 'CARD_EXP',
  'cc-exp-month': 'CARD_EXP',
  'cc-exp-year': 'CARD_EXP',
  'cc-name': 'NAME',
  'cc-given-name': 'NAME',
  'cc-family-name': 'NAME',
  email: 'EMAIL',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'tel-local': 'PHONE',
  name: 'NAME',
  'given-name': 'NAME',
  'family-name': 'NAME',
  'additional-name': 'NAME',
  nickname: 'NAME',
  bday: 'DOB',
  'bday-day': 'DOB',
  'bday-month': 'DOB',
  'bday-year': 'DOB',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'address-line3': 'ADDRESS',
  'postal-code': 'PINCODE',
  'one-time-code': 'OTP',
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
  username: 'USERNAME',
};

const LABEL_RULES: [RegExp, PiiType][] = [
  [/aadha?ar|\buid\b|आधार/i, 'AADHAAR'],
  [/gstin|\bgst\s*(no|number|#)/i, 'GSTIN'],
  [/\bpan\b|permanent account/i, 'PAN'],
  [/passport/i, 'PASSPORT'],
  [/voter|\bepic\b/i, 'VOTER_ID'],
  [/ifsc/i, 'IFSC'],
  [/\bupi\b|\bvpa\b/i, 'UPI'],
  [/\bcvv\b|\bcvc\b|security code/i, 'CVV'],
  [/card\s*(number|no\b|#)|credit card|debit card/i, 'CARD'],
  [/expir|valid (thru|till)|mm\s*\/\s*yy/i, 'CARD_EXP'],
  [/account\s*(number|no\b|#)|\ba\/c\b|\bacct\b|bank account/i, 'ACCOUNT'],
  [/\botp\b|one[- ]time|verification code/i, 'OTP'],
  [/pin\s?code|postal|\bzip\b/i, 'PINCODE'],
  [/password|passcode|\bm?pin\b/i, 'PASSWORD'],
  [/e-?mail/i, 'EMAIL'],
  [/mobile|phone|\btel\b|contact (no|number)|whats\s?app/i, 'PHONE'],
  [/date of birth|\bdob\b|birth\s?date|d\.o\.b/i, 'DOB'],
  [/user\s*name|username|login id|user id/i, 'USERNAME'],
  [/address|street|locality|house|flat no|landmark/i, 'ADDRESS'],
];
const NOT_PERSON_NAME = /(bank|branch|company|organi[sz]ation|product|file|city|state|district|scheme|course|department|project|trip|hotel|airline|place|item|event|team|business|shop|store|group)\s*name/i;
const PERSON_NAME = /\bname\b|first name|last name|surname|given name|account holder|card\s*holder|applicant|father|mother|spouse|nominee|guardian/i;

/** Decide what kind of personal data a form field holds from its type, autocomplete and label. */
export function fieldType(opts: { inputType?: string; autocomplete?: string; label?: string }): PiiType | null {
  // autocomplete is the most specific signal (a CVV box is often type=password).
  for (const tok of (opts.autocomplete || '').toLowerCase().split(/\s+/)) {
    if (AUTOCOMPLETE[tok]) return AUTOCOMPLETE[tok];
  }
  const t = (opts.inputType || '').toLowerCase();
  if (t === 'password') return 'PASSWORD';
  if (t === 'email') return 'EMAIL';
  if (t === 'tel') return 'PHONE';
  const label = opts.label || '';
  if (!label) return null;
  for (const [re, type] of LABEL_RULES) if (re.test(label)) return type;
  if (PERSON_NAME.test(label) && !NOT_PERSON_NAME.test(label)) return 'NAME';
  return null;
}

// ---------- normalisation for token identity and known-value search ----------

const NUMERIC: ReadonlySet<PiiType> = new Set(['AADHAAR', 'CARD', 'ACCOUNT', 'PHONE', 'OTP', 'CVV', 'PINCODE']);

export function normalize(type: PiiType, value: string): string {
  if (NUMERIC.has(type)) {
    const d = digitsOf(value);
    return type === 'PHONE' ? d.slice(-10) : d;
  }
  if (type === 'EMAIL' || type === 'UPI') return value.trim().toLowerCase();
  if (['PAN', 'IFSC', 'GSTIN', 'PASSPORT', 'VOTER_ID'].includes(type)) return value.replace(/\s/g, '').toUpperCase();
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A regex that finds a known value in page text, tolerant of spacing and dashes. */
export function knownValueRegex(type: PiiType, value: string): RegExp | null {
  const norm = normalize(type, value);
  if (!norm || norm.length < 3) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (NUMERIC.has(type)) {
    if (norm.length < 6) return null; // too short to search for safely (OTP/CVV/PIN)
    const prefix = type === 'PHONE' ? '(?:(?:\\+|00)?91[\\s-]?)?' : '';
    return new RegExp(`(?<![\\d+])${prefix}${norm.split('').map(esc).join('[\\s-]?')}(?!\\d)`, 'g');
  }
  const words = norm.split(' ').map(esc);
  return new RegExp(`(?<![\\w])${words.join('\\s+')}(?![\\w])`, 'gi');
}
