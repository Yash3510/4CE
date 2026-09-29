import { Agent, type Observation, type StepLog } from '@/lib/agent/agent';
import { loadProfile, loadSettings, PROFILE_FIELDS, saveProfile, saveSettings, type Settings } from '@/lib/agent/settings';
import { STYLE } from '@/lib/pii/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let settings: Settings;
let agent: Agent;
let pendingApproval: ((ok: boolean) => void) | null = null;

// ---------- tabs ----------
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  b.onclick = () => showTab(b.dataset.tab!);
}
function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll<HTMLElement>('main > section')) p.hidden = p.dataset.panel !== name;
  if (name === 'receipt') renderReceipt();
}

// ---------- UI hooks for the agent ----------
const ui = {
  status(s: string) {
    $('#status').textContent = s;
  },
  observed(o: Observation) {
    renderObservation(o);
  },
  log(e: StepLog) {
    const li = document.createElement('li');
    li.className = e.kind;
    const ms = e.ms ? Object.entries(e.ms).map(([k, v]) => `${k.replace(/Ms$/, '')} ${Math.round(v)}`).join(' · ') : '';
    li.innerHTML = `<span class="k">${e.kind}</span>${esc(e.text)}${ms ? `<span class="ms">${ms} ms</span>` : ''}`;
    $('#log').append(li);
    li.scrollIntoView({ block: 'nearest' });
  },
  approve(req: { kind: string; title: string; detail: string }) {
    $('#ap-kind').textContent = req.kind === 'irreversible' ? 'Needs your approval' : req.kind === 'consent' ? 'Use profile data on this site' : 'Unusual request';
    $('#ap-title').textContent = req.title;
    $('#ap-detail').textContent = req.detail;
    // A reflexive or leftover double-click must not approve: Decline has the focus, Approve arms
    // after a moment, and a suspicious request makes approving the visibly risky choice.
    const yes = $<HTMLButtonElement>('#ap-yes');
    const no = $<HTMLButtonElement>('#ap-no');
    const risky = req.kind === 'unusual';
    yes.textContent = risky ? 'Type it anyway' : 'Approve';
    yes.className = risky ? 'danger' : 'primary';
    no.className = risky ? 'primary' : '';
    yes.disabled = true;
    $('#approval').hidden = false;
    no.focus();
    setTimeout(() => (yes.disabled = false), 800);
    return new Promise<boolean>((resolve) => {
      pendingApproval = (ok) => {
        $('#approval').hidden = true;
        pendingApproval = null;
        resolve(ok);
      };
    });
  },
  receipt() {
    renderReceipt();
  },
};
$('#ap-yes').onclick = () => pendingApproval?.(true);
$('#ap-no').onclick = () => pendingApproval?.(false); // anything but approve withholds

// ---------- server view ----------
let lastObs: Observation | null = null;
function renderObservation(o: Observation) {
  lastObs = o;
  drawFrame();
  $('#frame-empty').hidden = true;
  const passes = new Map<string, number>();
  for (const f of o.findings) passes.set(f.pass, (passes.get(f.pass) ?? 0) + 1);
  const kb = (o.frame.bytes / 1024).toFixed(0);
  $('#frame-stats').innerHTML = [
    `<span>${o.findings.length} redactions</span>`,
    ...[...passes].map(([p, n]) => `<span>${p} ${n}</span>`),
    `<span>${o.snap.elements.length} elements</span>`,
    `<span>${kb} KB frame</span>`,
    `<span>${(o.frame.redactedShare * 100).toFixed(1)}% of pixels hidden</span>`,
    o.gate.ok ? `<span class="ok">egress gate ✓ (${o.gate.scanned} strings)</span>` : `<span class="bad">gate blocked: ${o.gate.hits.length} hits</span>`,
    o.frameRecheckHits ? `<span class="bad">frame re-check patched ${o.frameRecheckHits}</span>` : settings.verifyFrame ? `<span class="ok">frame re-check clean</span>` : '',
    o.unstable ? `<span class="bad">page kept changing</span>` : '',
    o.delegate ? `<span>faces on ${o.delegate}</span>` : '',
  ].join('');
  $('#timings').textContent = Object.entries(o.timings).map(([k, v]) => `${k.replace(/Ms$/, '')} ${Math.round(v)}ms`).join(' · ');
  $('#red-rows').innerHTML = o.findings
    .map((f) => `<tr><td>${f.token}</td><td>${f.type}${STYLE[f.type] === 'blackout' ? ' ■' : STYLE[f.type] === 'blur' ? ' ▒' : ''}</td><td>${f.pass}</td><td>${f.conf.toFixed(2)}</td></tr>`)
    .join('');
  if (($('#lens') as HTMLInputElement).checked) sendLens(true);
}
function drawFrame() {
  if (!lastObs) return;
  const src = ($('#show-original') as HTMLInputElement).checked ? lastObs.shot : lastObs.frame.canvas;
  const c = $('#frame') as HTMLCanvasElement;
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
}
$('#show-original').onchange = drawFrame;
$('#lens').onchange = () => sendLens(($('#lens') as HTMLInputElement).checked);
async function sendLens(on: boolean) {
  if (!lastObs) return;
  const { tabId } = await agent.target();
  const msg = on
    ? { kind: 'lens', boxes: lastObs.findings.flatMap((f) => f.rects.map((rect) => ({ rect, label: `${f.token} (${f.pass})`, style: STYLE[f.type] }))) }
    : { kind: 'lens-off' };
  browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ---------- receipt ----------
async function renderReceipt() {
  const s = agent.receipt.summary();
  $('#rc-client').innerHTML = `
    <span>Session</span><code>${agent.session}</code>
    <span>Requests sent</span><b>${s.requestsSent}</b>
    <span>Requests blocked</span><b>${s.requestsBlocked}</b>
    <span>Bytes sent</span><b>${s.bytesSent.toLocaleString()}</b>
    <span>Redactions sent as tokens</span><b>${s.redactions}</b>
    <span>Gate hits on sent requests</span><b>${s.gateHitsOnSent}</b>`;
  $('#rc-audit').innerHTML = `<span>Entries</span><b>${agent.audit.entries.length}</b><span>Head</span><code>${agent.audit.head}</code>`;
  try {
    const r = await fetch(`${settings.serverUrl}/v1/receipt?session=${agent.session}`);
    if (r.ok) {
      const j = await r.json();
      $('#rc-server').innerHTML = `
        <span>Payloads received</span><b>${j.payloads}</b>
        <span>Bytes received</span><b>${(j.bytes ?? 0).toLocaleString()}</b>
        <span>PII found by server-side scan</span><b style="color:var(${j.pii_hits ? '--bad' : '--ok'})">${j.pii_hits}</b>
        <span>Canary values seen</span><b style="color:var(${j.canary_hits ? '--bad' : '--ok'})">${j.canary_hits}</b>
        <span>Scanner</span><span>${esc(j.scanner ?? '')}</span>`;
    }
  } catch {
    /* server offline */
  }
}
$('#rc-refresh').onclick = renderReceipt;
$('#rc-verify').onclick = async () => {
  const ok = await agent.audit.verify();
  ui.log({ step: agent.stepNo, kind: ok ? 'info' : 'error', text: ok ? `audit chain verified (${agent.audit.entries.length} entries)` : 'audit chain BROKEN' });
  showTab('steps');
};
$('#rc-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ session: agent.session, receipt: agent.receipt.entries, summary: agent.receipt.summary(), audit: agent.audit.entries }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `parda-receipt-${agent.session.slice(0, 8)}.json`;
  a.click();
};

// ---------- profile + settings ----------
async function renderProfile() {
  const p = await loadProfile();
  $('#profile').innerHTML = PROFILE_FIELDS.map(
    (f) => `<label>${f.label} <input name="${f.type}" placeholder="${f.placeholder}" value="${esc(p[f.type] ?? '')}" autocomplete="off" /></label>`,
  ).join('');
}
$('#profile-save').onclick = async () => {
  const fd = new FormData($('#profile') as HTMLFormElement);
  const p: Record<string, string> = {};
  for (const [k, v] of fd) if (String(v).trim()) p[k] = String(v).trim();
  await saveProfile(p);
  agent.loadProfile(p);
  ui.status('profile saved on this device');
};
function renderSettings() {
  const f = $('#settings') as HTMLFormElement;
  for (const [k, v] of Object.entries(settings)) {
    const el = f.elements.namedItem(k) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join('\n') : String(v);
  }
  const gpu = 'gpu' in navigator ? 'WebGPU available' : 'no WebGPU (WASM fallback)';
  $('#env').textContent = `${gpu} · ${navigator.hardwareConcurrency} cores · ${navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium'}`;
}
$('#settings-save').onclick = async () => {
  const f = $('#settings') as HTMLFormElement;
  const get = (k: string) => f.elements.namedItem(k) as HTMLInputElement;
  settings = {
    ...settings,
    serverUrl: get('serverUrl').value.trim().replace(/\/$/, ''),
    maxSteps: Number(get('maxSteps').value) || 15,
    faces: get('faces').checked,
    ocr: get('ocr').checked,
    verifyFrame: get('verifyFrame').checked,
    marks: get('marks').checked,
    maxWidth: Number(get('maxWidth').value) || 1280,
    canaries: (f.elements.namedItem('canaries') as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  await saveSettings(settings);
  agent.settings = settings;
  checkServer();
  ui.status('settings saved');
};
$('#load-canaries').onclick = async () => {
  try {
    const r = await fetch(`${settings.serverUrl}/testbed/canaries.json`);
    const j = await r.json();
    (($('#settings') as HTMLFormElement).elements.namedItem('canaries') as HTMLTextAreaElement).value = (j.values as string[]).join('\n');
    ui.status(`loaded ${j.values.length} canaries — press Save`);
  } catch (e) {
    ui.status(`could not load canaries: ${e}`);
  }
};

async function checkServer() {
  const pill = $('#server');
  try {
    const r = await fetch(`${settings.serverUrl}/v1/health`);
    const j = await r.json();
    pill.textContent = `server ✓ ${j.planner}`;
    pill.className = 'pill ok';
  } catch {
    pill.textContent = 'server offline';
    pill.className = 'pill bad';
  }
}

// ---------- controls ----------
const goal = () => ($('#goal') as HTMLTextAreaElement).value.trim();
$('#preview').onclick = async () => {
  try {
    ui.status('redacting on device…');
    const o = await agent.observe(goal() || '(preview)');
    agent.receipt.add({ step: o.step, at: new Date().toISOString(), endpoint: '(preview, not sent)', decision: 'local', bytes: 0, payloadSha256: '', frameSha256: o.frame.sha256, redactions: o.findings.length, tokens: o.payload.tokens.length, gateHits: o.gate.hits, frameRecheckHits: o.frameRecheckHits });
    ui.status(`preview ready — nothing was sent (${Math.round(o.timings.observeMs)} ms on device)`);
    showTab('view');
  } catch (e) {
    ui.status(`preview failed: ${(e as Error).message}`);
  }
};
$('#run').onclick = () => {
  if (!goal()) return ui.status('type a goal first');
  showTab('steps');
  agent.run(goal());
};
$('#step').onclick = async () => {
  if (!goal()) return ui.status('type a goal first');
  try {
    await agent.stepOnce(goal());
  } catch (e) {
    ui.log({ step: agent.stepNo, kind: 'error', text: (e as Error).message });
  }
  ui.status('idle');
};
$('#stop').onclick = () => {
  agent.stopRequested = true;
  pendingApproval?.(false);
  ui.status('stopping…');
};
$('#reset').onclick = () => {
  agent.reset();
  $('#log').innerHTML = '';
  $('#red-rows').innerHTML = '';
  lastObs = null;
  ($('#frame') as HTMLCanvasElement).width = 0;
  $('#frame-empty').hidden = false;
  $('#frame-stats').innerHTML = '';
  $('#timings').textContent = '';
  ui.status('new session');
};

// ---------- boot ----------
(async () => {
  settings = await loadSettings();
  agent = new Agent(settings, await loadProfile(), ui);
  // Test hook: ?tab=<id>&win=<id> pins the agent to one tab (used by the e2e harness).
  const q = new URLSearchParams(location.search);
  if (q.get('tab')) agent.pinned = { tabId: Number(q.get('tab')), windowId: Number(q.get('win')) };
  // Demo mode (?demo=1): a caption bar the presenter script can drive.
  if (q.get('demo')) {
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    cap.hidden = true;
    document.body.prepend(cap);
    (window as any).pardaCaption = (t: string) => {
      cap.textContent = t;
      cap.hidden = !t;
    };
  }
  (window as any).parda = agent;
  renderSettings();
  renderProfile();
  checkServer();
})();
