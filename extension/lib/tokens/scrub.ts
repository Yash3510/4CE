// Scrub a string before it can leave the device: validator hits and every value the
// vault already knows are replaced with their tokens.

import { knownValueRegex, scanText } from '../pii/validators';
import type { Vault } from './vault';
import { wrap } from './vault';

export function scrubText(text: string, vault: Vault, origin: string, context?: string): string {
  if (!text) return text;
  let out = '';
  let last = 0;
  for (const m of scanText(text, { context })) {
    out += text.slice(last, m.start) + wrap(vault.tokenFor(m.type, m.value, origin));
    last = m.end;
  }
  out += text.slice(last);
  // Values found by structure/context passes (names, addresses) or held in the profile.
  for (const e of vault.entries()) {
    for (const re of knownRegexes(e.type, e.value)) {
      out = out.replace(re, wrap(e.token));
    }
  }
  return out;
}

/** The full value, plus each part of a name so "Hi Ananya" is caught when the profile says "Ananya Iyer". */
export function knownRegexes(type: Parameters<typeof knownValueRegex>[0], value: string): RegExp[] {
  const res: RegExp[] = [];
  const full = knownValueRegex(type, value);
  if (full) res.push(full);
  // Parts only for a clean one-line name of two or three words, never for multi-line text.
  if (type === 'NAME' && /^[A-Za-z.' ]+$/.test(value.trim()) && value.trim().split(/\s+/).length <= 3) {
    for (const part of value.split(/\s+/)) {
      if (part.length >= 3 && !NAME_STOP.has(part.toLowerCase())) {
        const r = knownValueRegex('NAME', part);
        if (r) res.push(r);
      }
    }
  }
  return res;
}

const NAME_STOP = new Set(['mr', 'mrs', 'ms', 'dr', 'shri', 'smt', 'kumar', 'kumari', 'devi', 'the', 'and']);
