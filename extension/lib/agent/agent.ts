// The agent loop, run from the side panel:
//   observe (DOM + screenshot) → find PII (structure, text, context, known, pixel) → tokenise →
//   compose the redacted frame → re-check it → egress gate → server plans one action →
//   local checks (allow-list, token origin, field kind, irreversible → ask the user) →
//   late binding (tokens → real values, on the device) → act → wait for the page to settle.
// Every step is written to the hash-chained audit trail and every request to the receipt.

import { AuditChain } from '../audit/chain';
import type { ExecAction, ExecResult } from '../dom/actions';
import type { ElementInfo } from '../dom/elements';
import { egressCheck, Receipt, type GateResult } from '../egress/gate';
import type { BlindRegion, KnownValue } from '../pii/detect-dom';
import type { Finding, PiiType, Rect } from '../pii/types';
import { SECRET } from '../pii/types';
import { scanText } from '../pii/validators';
import { composeFrame, sha256Hex, type Frame, type TokenFinding } from '../redact/compose';
import { scrubText } from '../tokens/scrub';
import { TOKEN_RE, Vault, wrap } from '../tokens/vault';
import { loadOcr, pixelPass } from '../vision/pixel';
import type { Profile, Settings } from './settings';

export interface Snapshot {
  url: string;
  origin: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  scroll: { x: number; y: number };
  stamp: number;
  elements: ElementInfo[];
  findings: Finding[];
  blind: BlindRegion[];
  text: string;
  timings: { indexMs: number; scanMs: number };
}

export interface ServerAction extends Omit<ExecAction, 'do'> {
  do: ExecAction['do'] | 'done' | 'fail';
  reason?: string;
  summary?: string;
  irreversible?: boolean;
}

export interface Observation {
  step: number;
  snap: Snapshot;
  shot: HTMLCanvasElement;
  findings: TokenFinding[];
  frame: Frame;
  payload: StepPayload;
  gate: GateResult;
  frameRecheckHits: number;
  timings: Record<string, number>;
  unstable: boolean;
  delegate: string | null;
}

export interface HistoryItem {
  step: number;
  action: ServerAction;
  result: ExecResult;
}

export interface StepPayload {
  session: string;
  step: number;
  goal: string;
  page: { url: string; title: string; viewport: [number, number] };
  frame: { mime: string; b64: string; w: number; h: number; sha256: string };
  elements: Record<string, unknown>[];
  text: string;
  redactions: { token: string; type: PiiType; pass: string; conf: number; boxes: number[][] }[];
  tokens: { token: string; type: PiiType; source: string }[];
  history: HistoryItem[];
}

export interface StepLog {
  step: number;
  kind: 'plan' | 'act' | 'blocked' | 'declined' | 'done' | 'error' | 'info';
  text: string;
  action?: ServerAction;
  ms?: Record<string, number>;
}

export interface UiHooks {
  status(s: string): void;
  observed(o: Observation): void;
  log(e: StepLog): void;
  approve(req: { kind: 'irreversible' | 'consent' | 'unusual'; title: string; detail: string }): Promise<boolean>;
  receipt(): void;
}

const ALLOWED = new Set(['click', 'type', 'select', 'scroll', 'press', 'wait', 'clear', 'done', 'fail']);
const IRREVERSIBLE =
  /submit|\bpay\b|pay now|place order|confirm|\bsend\b|delete|remove|transfer|purchase|buy|checkout|sign ?up|register|apply|file (the )?claim|authori[sz]e|proceed|book now|withdraw/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Agent {
  vault = new Vault();
  audit = new AuditChain();
  receipt = new Receipt();
  session = crypto.randomUUID();
  history: HistoryItem[] = [];
  stepNo = 0;
  stopRequested = false;
  running = false;
  last?: Observation;
  /** Test hook: pin the agent to a tab instead of following the active tab. */
  pinned?: { tabId: number; windowId: number };

  constructor(public settings: Settings, public profile: Profile, private ui: UiHooks) {
    this.loadProfile(profile);
  }

  loadProfile(p: Profile) {
    this.profile = p;
    for (const [type, value] of Object.entries(p)) {
      if (value && value.trim()) this.vault.tokenFor(type as PiiType, value.trim(), '*', 'profile');
    }
  }

  reset() {
    this.vault = new Vault();
    this.loadProfile(this.profile);
    this.audit = new AuditChain();
    this.receipt = new Receipt();
    this.session = crypto.randomUUID();
    this.history = [];
    this.stepNo = 0;
    this.last = undefined;
  }

  // ---------- browser plumbing ----------

  async target(): Promise<{ tabId: number; windowId: number; url?: string }> {
    if (this.pinned) {
      const t = await browser.tabs.get(this.pinned.tabId);
      return { ...this.pinned, url: t.url };
    }
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || tab.windowId === undefined) throw new Error('no active tab');
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
  }

  private async send<T>(tabId: number, msg: unknown): Promise<T> {
    const trySend = async () => {
      const r = (await browser.tabs.sendMessage(tabId, msg)) as T & { error?: string };
      if (r && (r as any).error) throw new Error((r as any).error);
      return r;
    };
    try {
      return await trySend();
    } catch (e) {
      if (!String(e).includes('Receiving end does not exist') && !String(e).includes('Could not establish connection')) throw e;
      // Tab was open before the extension loaded: inject the content script, then retry.
      if (browser.scripting) await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
      else await (browser.tabs as any).executeScript(tabId, { file: '/content-scripts/content.js' });
      await sleep(100);
      return trySend();
    }
  }

  private async capture(windowId: number): Promise<HTMLCanvasElement> {
    const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c;
  }

  private async waitForLoad(tabId: number, maxMs = 10000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const t = await browser.tabs.get(tabId);
      if (t.status === 'complete') return;
      await sleep(150);
    }
  }

  // ---------- observe: everything up to (not including) the network ----------

  async observe(goal: string): Promise<Observation> {
    const t: Record<string, number> = {};
    const tStart = performance.now();
    const { tabId, windowId } = await this.target();
    const known: KnownValue[] = this.vault.entries().filter((e) => e.type !== 'FACE').map((e) => ({ type: e.type, value: e.value }));

    // Scan, capture, then confirm nothing moved in between (rescan if it did).
    let snap!: Snapshot;
    let shot!: HTMLCanvasElement;
    let unstable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let t0 = performance.now();
      snap = await this.send<Snapshot>(tabId, { kind: 'snapshot', known });
      t.domMs = performance.now() - t0;
      t0 = performance.now();
      shot = await this.capture(windowId);
      t.captureMs = performance.now() - t0;
      const st = await this.send<{ changed: number; scrolled: boolean }>(tabId, { kind: 'stable', stamp: snap.stamp, scroll: snap.scroll });
      unstable = st.changed > 0 || st.scrolled;
      if (!unstable) break;
      await sleep(250 + attempt * 250);
    }
    t.indexMs = snap.timings.indexMs;
    t.scanMs = snap.timings.scanMs;
    const scale = shot.width / snap.viewport.w;

    // Pixel pass on regions the DOM cannot read.
    const px = await pixelPass(shot, scale, snap.blind, [...known, ...snap.findings.map((f) => ({ type: f.type, value: f.value }))], {
      faces: this.settings.faces,
      ocr: this.settings.ocr,
      maxOcrRegions: 4,
    });
    t.faceMs = px.faceMs;
    t.ocrMs = px.ocrMs;

    const origin = snap.origin;
    const tokenise = (fs: Finding[]): TokenFinding[] => fs.map((f) => ({ ...f, token: this.vault.tokenFor(f.type, f.value, origin) }));
    let findings = tokenise([...snap.findings, ...px.findings]);

    let t0 = performance.now();
    let frame = await composeFrame(shot, snap.viewport, findings, snap.elements, {
      maxWidth: this.settings.maxWidth,
      marks: this.settings.marks,
      quality: this.settings.jpegQuality,
    });
    t.composeMs = performance.now() - t0;

    // Read the outgoing frame back with OCR; patch anything that still looks like PII.
    let frameRecheckHits = 0;
    if (this.settings.verifyFrame) {
      t0 = performance.now();
      const extra = await this.recheckFrame(frame, snap.viewport.w, findings);
      frameRecheckHits = extra.length;
      if (extra.length) {
        findings = [...findings, ...tokenise(extra)];
        frame = await composeFrame(shot, snap.viewport, findings, snap.elements, {
          maxWidth: this.settings.maxWidth,
          marks: this.settings.marks,
          quality: this.settings.jpegQuality,
        });
      }
      t.verifyMs = performance.now() - t0;
    }

    const step = this.stepNo + 1;
    const payload = this.buildPayload(step, goal, snap, frame, findings);
    t0 = performance.now();
    const gate = egressCheck(payload, this.vault, this.settings.canaries);
    t.gateMs = performance.now() - t0;
    t.observeMs = performance.now() - tStart;

    const obs: Observation = { step, snap, shot, findings, frame, payload, gate, frameRecheckHits, timings: t, unstable, delegate: px.delegate };
    this.last = obs;
    this.ui.observed(obs);
    return obs;
  }

  private async recheckFrame(frame: Frame, cssWidth: number, have: TokenFinding[]): Promise<Finding[]> {
    const worker = await loadOcr();
    const { data } = await worker.recognize(frame.canvas, {}, { blocks: true, text: false });
    const s = frame.w / cssWidth;
    const out: Finding[] = [];
    const known = this.vault.entries();
    for (const block of data.blocks ?? [])
      for (const para of block.paragraphs)
        for (const line of para.lines) {
          const words = line.words;
          let text = '';
          const spans: [number, number, (typeof words)[number]][] = [];
          for (const w of words) {
            if (text) text += ' ';
            spans.push([text.length, text.length + w.text.length, w]);
            text += w.text;
          }
          const hits = scanText(text).map((m) => ({ ...m }));
          for (const e of known) if (e.type !== 'FACE' && e.norm.length >= 6 && text.toLowerCase().includes(e.value.toLowerCase())) {
            const i = text.toLowerCase().indexOf(e.value.toLowerCase());
            hits.push({ type: e.type, start: i, end: i + e.value.length, value: e.value, conf: 0.9, rule: 'known-value' });
          }
          for (const h of hits) {
            const ws = spans.filter(([a, b]) => a < h.end && h.start < b).map(([, , w]) => w);
            if (!ws.length) continue;
            const r: Rect = {
              x: Math.min(...ws.map((w) => w.bbox.x0)) / s - 2,
              y: Math.min(...ws.map((w) => w.bbox.y0)) / s - 2,
              w: (Math.max(...ws.map((w) => w.bbox.x1)) - Math.min(...ws.map((w) => w.bbox.x0))) / s + 4,
              h: (Math.max(...ws.map((w) => w.bbox.y1)) - Math.min(...ws.map((w) => w.bbox.y0))) / s + 4,
            };
            const inside = have.some((f) => f.rects.some((q) => r.x >= q.x - 4 && r.y >= q.y - 4 && r.x + r.w <= q.x + q.w + 4 && r.y + r.h <= q.y + q.h + 4));
            if (!inside) out.push({ type: h.type, value: h.value, rects: [r], pass: 'pixel', conf: h.conf, rule: `verify:${h.rule}` });
          }
        }
    return out;
  }

  private buildPayload(step: number, goal: string, snap: Snapshot, frame: Frame, findings: TokenFinding[]): StepPayload {
    const o = snap.origin;
    const v = this.vault;
    const scrub = (s?: string) => (s ? scrubText(s, v, o) : s);
    const box = (r: Rect) => [
      Math.round((r.x / snap.viewport.w) * 1000),
      Math.round((r.y / snap.viewport.h) * 1000),
      Math.round(((r.x + r.w) / snap.viewport.w) * 1000),
      Math.round(((r.y + r.h) / snap.viewport.h) * 1000),
    ];
    const elements = snap.elements.map((e) => {
      let value: string | undefined = e.value;
      if (value && value.trim()) {
        value = e.field ? wrap(v.tokenFor(e.field, value.trim(), o)) : scrub(value);
      }
      return {
        id: e.id,
        tag: e.tag,
        type: e.type,
        role: e.role,
        label: scrub(e.label),
        placeholder: scrub(e.placeholder),
        value,
        field: e.field ?? undefined,
        checked: e.checked,
        options: e.options?.map((x) => scrub(x)),
        href: e.href ? scrubUrl(e.href, v, o) : undefined,
        box: box(e.rect),
      };
    });
    return {
      session: this.session,
      step,
      goal: scrub(goal)!,
      page: { url: scrubUrl(snap.url, v, o), title: scrub(snap.title) ?? '', viewport: [snap.viewport.w, snap.viewport.h] },
      frame: { mime: frame.mime, b64: frame.b64, w: frame.w, h: frame.h, sha256: frame.sha256 },
      elements,
      text: scrub(snap.text) ?? '',
      redactions: findings.map((f) => ({ token: f.token, type: f.type, pass: f.pass, conf: Math.round(f.conf * 100) / 100, boxes: f.rects.map(box) })),
      tokens: v.catalog(),
      history: this.history.slice(-8),
    };
  }

  // ---------- the loop ----------

  async run(goal: string) {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    try {
      while (!this.stopRequested && this.stepNo < this.settings.maxSteps) {
        const r = await this.stepOnce(goal);
        if (r !== 'continue') break;
        if (this.settings.stepPauseMs) await sleep(this.settings.stepPauseMs);
      }
      if (this.stepNo >= this.settings.maxSteps) this.ui.log({ step: this.stepNo, kind: 'info', text: `stopped after ${this.stepNo} steps` });
    } catch (e) {
      this.ui.log({ step: this.stepNo, kind: 'error', text: String((e as Error)?.message ?? e) });
    } finally {
      this.running = false;
      this.ui.status('idle');
    }
  }

  async stepOnce(goal: string): Promise<'continue' | 'done' | 'stop'> {
    const tStep = performance.now();
    this.ui.status('reading page on device…');
    const obs = await this.observe(goal);
    this.stepNo = obs.step;
    const { payload, gate, frame } = obs;
    const body = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(body).length;
    const payloadSha = await sha256Hex(body);
    const manifest = payload.redactions.map(({ token, type, pass, boxes }) => ({ token, type, pass, boxes }));

    await this.audit.append('observe', {
      step: obs.step,
      url: payload.page.url,
      frame: frame.sha256,
      redactions: manifest,
      unstable: obs.unstable,
      frameRecheckHits: obs.frameRecheckHits,
    });

    if (!gate.ok) {
      this.receipt.add({ step: obs.step, at: new Date().toISOString(), endpoint: '/v1/step', decision: 'blocked', bytes: 0, payloadSha256: payloadSha, frameSha256: frame.sha256, redactions: manifest.length, tokens: payload.tokens.length, gateHits: gate.hits, frameRecheckHits: obs.frameRecheckHits });
      await this.audit.append('gate-block', { step: obs.step, hits: gate.hits });
      this.ui.log({ step: obs.step, kind: 'blocked', text: `egress gate blocked the request: ${gate.hits.map((h) => `${h.type} in ${h.path}`).join(', ')}` });
      this.ui.receipt();
      return 'stop';
    }

    this.ui.status('asking the planner (redacted view only)…');
    const t0 = performance.now();
    const res = await fetch(`${this.settings.serverUrl.replace(/\/$/, '')}/v1/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const serverMs = performance.now() - t0;
    this.receipt.add({ step: obs.step, at: new Date().toISOString(), endpoint: '/v1/step', decision: 'sent', bytes, payloadSha256: payloadSha, frameSha256: frame.sha256, redactions: manifest.length, tokens: payload.tokens.length, gateHits: [], frameRecheckHits: obs.frameRecheckHits });
    await this.audit.append('send', { step: obs.step, payload: payloadSha, bytes });
    this.ui.receipt();
    if (!res.ok) throw new Error(`server ${res.status}: ${await res.text()}`);
    const plan = (await res.json()) as { action: ServerAction; planner: string; check?: { ok: boolean; notes: string[] }; latency_ms?: number };
    const a = plan.action;
    await this.audit.append('plan', { step: obs.step, action: a, planner: plan.planner, check: plan.check });
    const timings: Record<string, number> = { ...obs.timings, serverMs };
    this.ui.log({ step: obs.step, kind: 'plan', text: `${plan.planner}: ${describe(a)}${a.reason ? ` — ${a.reason}` : ''}`, action: a, ms: timings });

    if (a.do === 'done' || a.do === 'fail') {
      const summary = a.summary ? this.vault.reveal(a.summary) : '';
      this.ui.log({ step: obs.step, kind: 'done', text: a.do === 'done' ? `done. ${summary}` : `planner gave up. ${summary}` });
      await this.audit.append('done', { step: obs.step, outcome: a.do });
      return 'done';
    }

    // ---- local checks, independent of the server's own checker ----
    const verdict = await this.checkLocally(a, obs);
    if (!verdict.ok) {
      const result = { ok: false, detail: verdict.reason };
      this.history.push({ step: obs.step, action: a, result });
      await this.audit.append('refused', { step: obs.step, action: a, reason: verdict.reason });
      this.ui.log({ step: obs.step, kind: verdict.declined ? 'declined' : 'blocked', text: verdict.reason });
      return verdict.declined ? 'continue' : 'continue';
    }

    // ---- late binding: tokens become real values here, and only here ----
    const exec = { ...a } as ExecAction;
    if (a.text) exec.text = this.vault.resolve(a.text, obs.snap.origin).text;
    if (a.point) exec.point = [(a.point[0] / 1000) * obs.snap.viewport.w, (a.point[1] / 1000) * obs.snap.viewport.h];

    this.ui.status(`acting: ${describe(a)}`);
    const { tabId } = await this.target();
    const t1 = performance.now();
    let result: ExecResult;
    try {
      result = await this.send<ExecResult>(tabId, { kind: 'act', action: exec });
    } catch (e) {
      // A click that navigates tears down the content script before it can answer.
      result = { ok: true, detail: 'page navigated' };
    }
    await sleep(150);
    await this.waitForLoad(tabId);
    try {
      await this.send(tabId, { kind: 'settle' });
    } catch {
      /* page still loading */
    }
    timings.actMs = performance.now() - t1;
    timings.stepMs = performance.now() - tStep;
    this.history.push({ step: obs.step, action: a, result });
    await this.audit.append('act', { step: obs.step, action: a, result });
    this.ui.log({ step: obs.step, kind: 'act', text: `${result.ok ? '✓' : '✗'} ${result.detail}`, ms: timings });
    return 'continue';
  }

  private async checkLocally(a: ServerAction, obs: Observation): Promise<{ ok: boolean; reason: string; declined?: boolean }> {
    if (!ALLOWED.has(a.do)) return { ok: false, reason: `action "${a.do}" is not on the allow-list` };
    const el = a.target ? obs.snap.elements.find((e) => e.id === a.target) : undefined;
    if ((a.do === 'click' || a.do === 'type' || a.do === 'select' || a.do === 'clear') && !el && !a.point) {
      return { ok: false, reason: `target ${a.target} is not on this page` };
    }
    const origin = obs.snap.origin;

    if (a.do === 'type' && a.text) {
      const r = this.vault.resolve(a.text, origin);
      if (r.unknown.length) return { ok: false, reason: `unknown token(s) ${r.unknown.join(', ')}` };
      if (r.denied.length) return { ok: false, reason: `token use refused: ${r.denied.map((d) => `${d.token} (${d.reason})`).join('; ')}` };
      // A token typed into a field that is not of its kind is how an injected page would try to exfiltrate it.
      for (const e of r.used) {
        const fits = !el?.field || el.field === e.type || (el.field === 'USERNAME' && (e.type === 'EMAIL' || e.type === 'PHONE'));
        if (!el?.field || !fits) {
          const ok = await this.ui.approve({
            kind: 'unusual',
            title: `Type your ${e.type.toLowerCase()} into “${el?.label || a.target}”?`,
            detail: `The planner wants to put ${wrap(e.token)} into a field that ${el?.field ? `looks like ${el.field.toLowerCase()}` : 'is not recognised as that kind of field'}. Only approve if that is what you asked for.`,
          });
          if (!ok) return { ok: false, reason: `you declined typing ${e.token} into ${a.target}`, declined: true };
        }
      }
      for (const e of r.needsConsent) {
        const ok = await this.ui.approve({
          kind: 'consent',
          title: `Use your ${e.type.toLowerCase()} on ${origin}?`,
          detail: `${wrap(e.token)} comes from your profile. It will be typed on this site by your browser; the server never sees the value.`,
        });
        if (!ok) return { ok: false, reason: `you declined using ${e.token} on ${origin}`, declined: true };
        this.vault.approve(e.token, origin);
      }
      if (SECRET.has(el?.field as PiiType) && !r.used.length) {
        return { ok: false, reason: 'refusing to type a literal into a secret field' };
      }
    }

    const label = `${el?.label ?? ''} ${el?.type ?? ''}`;
    const irreversible =
      a.irreversible ||
      (a.do === 'click' && (el?.type === 'submit' || IRREVERSIBLE.test(label))) ||
      (a.do === 'press' && (a.key ?? 'Enter') === 'Enter' && !!el?.inForm);
    if (irreversible) {
      const ok = await this.ui.approve({
        kind: 'irreversible',
        title: `Approve: ${describe(a)} on “${el?.label || a.target}”?`,
        detail: 'This may submit, pay or send something. Nothing happens unless you approve.',
      });
      await this.audit.append('approval', { step: obs.step, action: a, approved: ok });
      if (!ok) return { ok: false, reason: 'you declined the irreversible action', declined: true };
    }
    return { ok: true, reason: '' };
  }
}

export function describe(a: ServerAction): string {
  switch (a.do) {
    case 'type':
      return `type ${a.text} into ${a.target}`;
    case 'select':
      return `select “${a.option ?? a.text}” in ${a.target}`;
    case 'scroll':
      return `scroll ${a.direction ?? 'down'}`;
    case 'press':
      return `press ${a.key ?? 'Enter'}`;
    case 'wait':
      return `wait ${a.ms ?? 1000} ms`;
    default:
      return `${a.do}${a.target ? ` ${a.target}` : a.point ? ` @${a.point}` : ''}`;
  }
}

function scrubUrl(u: string, v: Vault, origin: string): string {
  let decoded = u;
  try {
    decoded = decodeURIComponent(u.replace(/\+/g, ' '));
  } catch {
    /* keep raw */
  }
  return scrubText(decoded, v, origin);
}

export { TOKEN_RE };
