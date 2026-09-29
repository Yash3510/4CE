// Egress gate: the last check before any byte leaves the device. It re-runs the validators
// on every page-derived string in the payload, looks for every raw value the vault holds and
// for planted canaries, and blocks the request on any hit. Every decision lands in the receipt.

import { knownValueRegex, scanText } from '../pii/validators';
import type { Vault } from '../tokens/vault';

// Fields that carry our own identifiers, hashes or image bytes, not page content.
const SKIP_KEYS = new Set(['b64', 'sha256', 'session', 'id', 'token', 'target', 'pass', 'mime', 'rule', 'source', 'type', 'field', 'tag', 'role', 'box', 'boxes']);

export function outgoingStrings(v: unknown, path = '$', out: [string, string][] = []): [string, string][] {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => outgoingStrings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) outgoingStrings(x, `${path}.${k}`, out);
  }
  return out;
}

export interface GateHit {
  kind: 'validator' | 'vault' | 'canary';
  type: string;
  path: string;
}

export interface GateResult {
  ok: boolean;
  hits: GateHit[];
  scanned: number;
  ms: number;
}

export function egressCheck(payload: unknown, vault: Vault, canaries: string[]): GateResult {
  const t0 = performance.now();
  const strings = outgoingStrings(payload);
  const hits: GateHit[] = [];
  const vaultRes = vault.entries().map((e) => ({ e, re: knownValueRegex(e.type, e.value) })).filter((x) => x.re);
  const canaryRes = canaries.map((c) => ({ c, re: new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]?'), 'i') }));
  for (const [path, s] of strings) {
    for (const m of scanText(s)) hits.push({ kind: 'validator', type: m.type, path });
    for (const { e, re } of vaultRes) {
      re!.lastIndex = 0;
      if (re!.test(s)) hits.push({ kind: 'vault', type: e.type, path });
    }
    for (const { re } of canaryRes) if (re.test(s)) hits.push({ kind: 'canary', type: 'CANARY', path });
  }
  return { ok: hits.length === 0, hits, scanned: strings.length, ms: performance.now() - t0 };
}

export interface ReceiptEntry {
  step: number;
  at: string;
  endpoint: string;
  decision: 'sent' | 'blocked' | 'local';
  bytes: number;
  payloadSha256: string;
  frameSha256?: string;
  redactions: number;
  tokens: number;
  gateHits: GateHit[];
  frameRecheckHits: number;
}

export class Receipt {
  entries: ReceiptEntry[] = [];
  add(e: ReceiptEntry) {
    this.entries.push(e);
  }
  summary() {
    const sent = this.entries.filter((e) => e.decision === 'sent');
    return {
      requestsSent: sent.length,
      requestsBlocked: this.entries.filter((e) => e.decision === 'blocked').length,
      bytesSent: sent.reduce((a, e) => a + e.bytes, 0),
      redactions: sent.reduce((a, e) => a + e.redactions, 0),
      gateHitsOnSent: sent.reduce((a, e) => a + e.gateHits.length, 0),
    };
  }
}
