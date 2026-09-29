// Hash-chained audit trail (same idea as 4CE's fource_audit): each entry's hash covers the
// previous hash, so editing or dropping any step breaks every hash after it.

import { sha256Hex } from '../redact/compose';

export interface AuditEntry {
  i: number;
  at: string;
  kind: string;
  data: unknown;
  prev: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export class AuditChain {
  entries: AuditEntry[] = [];

  get head(): string {
    return this.entries.at(-1)?.hash ?? GENESIS;
  }

  async append(kind: string, data: unknown): Promise<AuditEntry> {
    const i = this.entries.length;
    const at = new Date().toISOString();
    const prev = this.head;
    const hash = await sha256Hex(`${prev}|${i}|${at}|${kind}|${canonical(data)}`);
    const e = { i, at, kind, data, prev, hash };
    this.entries.push(e);
    return e;
  }

  async verify(): Promise<boolean> {
    let prev = GENESIS;
    for (const e of this.entries) {
      if (e.prev !== prev) return false;
      if ((await sha256Hex(`${e.prev}|${e.i}|${e.at}|${e.kind}|${canonical(e.data)}`)) !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }
}
