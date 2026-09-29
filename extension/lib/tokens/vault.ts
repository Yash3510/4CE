// The token vault: real values stay here, on the device; the server only ever sees tokens.
// Late binding: when the server asks to type ⟦EMAIL_1⟧, the vault swaps in the real value
// locally, and only on a site that value is allowed to go to.

import { normalize } from '../pii/validators';
import type { PiiType } from '../pii/types';
import { SECRET } from '../pii/types';

export type TokenSource = 'screen' | 'profile';

export interface VaultEntry {
  token: string; // e.g. EMAIL_1
  type: PiiType;
  value: string;
  norm: string;
  source: TokenSource;
  /** Origins the value was captured on. Screen values may only be typed back on these. */
  origins: Set<string>;
  /** Origins the user has approved for a profile value. */
  approved: Set<string>;
}

export interface Resolution {
  text: string;
  used: VaultEntry[];
  /** Tokens that exist but may not be used on this origin. */
  denied: { token: string; reason: string }[];
  /** Profile tokens that need the user's one-time approval for this origin. */
  needsConsent: VaultEntry[];
  unknown: string[];
}

export const TOKEN_RE = /⟦([A-Z_]+_\d+)⟧|\[\[([A-Z_]+_\d+)\]\]/g;
export const wrap = (token: string) => `⟦${token}⟧`;

export class Vault {
  private byKey = new Map<string, VaultEntry>();
  private byToken = new Map<string, VaultEntry>();
  private counters = new Map<string, number>();

  private key(type: PiiType, value: string) {
    return `${type}:${normalize(type, value)}`;
  }

  tokenFor(type: PiiType, value: string, origin: string, source: TokenSource = 'screen'): string {
    const k = this.key(type, value);
    let e = this.byKey.get(k);
    if (!e) {
      const n = (this.counters.get(type) ?? 0) + 1;
      this.counters.set(type, n);
      e = {
        token: `${type}_${n}`,
        type,
        value,
        norm: normalize(type, value),
        source,
        origins: new Set(),
        approved: new Set(),
      };
      this.byKey.set(k, e);
      this.byToken.set(e.token, e);
    }
    if (source === 'screen') e.origins.add(origin);
    // A profile value seen on a page keeps its profile source, but is now also known on that origin.
    return e.token;
  }

  get(token: string) {
    return this.byToken.get(token);
  }

  entries(): VaultEntry[] {
    return [...this.byToken.values()];
  }

  /** Token list for the server: names and types only, never values. */
  catalog() {
    return this.entries().map((e) => ({ token: e.token, type: e.type, source: e.source }));
  }

  approve(token: string, origin: string) {
    this.byToken.get(token)?.approved.add(origin);
  }

  clearScreenValues() {
    for (const e of this.entries()) {
      if (e.source === 'screen') {
        this.byToken.delete(e.token);
        this.byKey.delete(this.key(e.type, e.value));
      }
    }
  }

  /** For showing the user their own data in the side panel only; never for anything sent or typed. */
  reveal(text: string): string {
    return text.replace(TOKEN_RE, (whole, a, b) => {
      const e = this.byToken.get(a || b);
      return e && e.type !== 'FACE' ? `${e.value}` : whole;
    });
  }

  /** Replace every token in `text` with its real value, enforcing origin rules. */
  resolve(text: string, origin: string): Resolution {
    const res: Resolution = { text, used: [], denied: [], needsConsent: [], unknown: [] };
    res.text = text.replace(TOKEN_RE, (whole, a, b) => {
      const token = a || b;
      const e = this.byToken.get(token);
      if (!e) {
        res.unknown.push(token);
        return whole;
      }
      if (e.source === 'screen') {
        if (!e.origins.has(origin)) {
          res.denied.push({ token, reason: `captured on ${[...e.origins].join(', ')}, not ${origin}` });
          return whole;
        }
        if (SECRET.has(e.type)) {
          res.denied.push({ token, reason: 'secrets seen on screen are never re-typed' });
          return whole;
        }
      } else if (!e.approved.has(origin) && !e.origins.has(origin)) {
        res.needsConsent.push(e);
      }
      res.used.push(e);
      return e.value;
    });
    return res;
  }
}
