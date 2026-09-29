// End-to-end run of the real extension in Chromium against the testbed.
//   node e2e.mjs [page] [goal]        (server must be running on :8765)
// Loads the built extension, pins the agent to a testbed tab, fills the profile from
// testbed/persona.json, runs the loop with auto-approval, then asks the server what it received.

import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER = process.env.PARDA_SERVER ?? 'http://127.0.0.1:8765';
const EXT = resolve('../extension/.output/chrome-mv3');
const PAGE = process.argv[2] ?? 'claim.html';
const GOAL = process.argv[3] ?? 'Fill the travel claim form with my details and file the claim';
const OUT = resolve('out');
mkdirSync(OUT, { recursive: true });

const persona = await (await fetch(`${SERVER}/testbed/persona.json`)).json();
const canaries = (await (await fetch(`${SERVER}/testbed/canaries.json`)).json()).values;
const profile = Object.fromEntries(
  ['NAME', 'EMAIL', 'PHONE', 'DOB', 'ADDRESS', 'PINCODE', 'AADHAAR', 'PAN', 'ACCOUNT', 'IFSC', 'UPI'].map((k) => [k, persona.profile[k]]),
);

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'parda-')), {
  channel: 'chromium',
  headless: process.env.HEADED ? false : true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];

const panel = await ctx.newPage();
panel.on('console', (m) => m.type() === 'error' && console.log('[panel]', m.text()));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForFunction(() => !!window.parda);

// Open the target in its own window so captureVisibleTab sees it, not the panel.
const target = await panel.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true, width: 1280, height: 860 });
  return { tabId: w.tabs[0].id, windowId: w.id };
}, `${SERVER}/testbed/${PAGE}`);
await panel.evaluate(async ({ target, profile, canaries, server }) => {
  const a = window.parda;
  a.pinned = target;
  await chrome.storage.local.set({ profile });
  a.loadProfile(profile);
  a.settings.canaries = canaries;
  a.settings.serverUrl = server;
  for (let i = 0; i < 50; i++) {
    const t = await chrome.tabs.get(target.tabId);
    if (t.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, { target, profile, canaries, server: SERVER });
await panel.waitForTimeout(600);

// 1. Preview: what would leave the device for this page.
const preview = await panel.evaluate(async (goal) => {
  const o = await window.parda.observe(goal);
  return {
    redactions: o.findings.map((f) => ({ token: f.token, type: f.type, pass: f.pass, conf: +f.conf.toFixed(2) })),
    elements: o.snap.elements.length,
    gate: o.gate,
    recheck: o.frameRecheckHits,
    kb: Math.round(o.frame.bytes / 1024),
    share: +(o.frame.redactedShare * 100).toFixed(1),
    timings: Object.fromEntries(Object.entries(o.timings).map(([k, v]) => [k, Math.round(v)])),
    delegate: o.delegate,
    frame: o.frame.canvas.toDataURL('image/png'),
    shot: o.shot.toDataURL('image/png'),
    payloadText: JSON.stringify({ ...o.payload, frame: { ...o.payload.frame, b64: `<${o.payload.frame.b64.length} base64 chars>` } }, null, 1),
  };
}, GOAL);
const stem = PAGE.replace('.html', '');
writeFileSync(join(OUT, `${stem}-sent.png`), Buffer.from(preview.frame.split(',')[1], 'base64'));
writeFileSync(join(OUT, `${stem}-original.png`), Buffer.from(preview.shot.split(',')[1], 'base64'));
writeFileSync(join(OUT, `${stem}-payload.json`), preview.payloadText);
console.log(`\n== ${PAGE}: preview ==`);
console.log(`${preview.redactions.length} redactions, ${preview.elements} elements, frame ${preview.kb} KB, ${preview.share}% hidden, faces on ${preview.delegate}`);
console.log('gate:', preview.gate.ok ? `ok (${preview.gate.scanned} strings)` : preview.gate.hits, '| frame re-check patched:', preview.recheck);
console.log('timings ms:', preview.timings);
const byType = {};
for (const r of preview.redactions) byType[`${r.type}/${r.pass}`] = (byType[`${r.type}/${r.pass}`] ?? 0) + 1;
console.log('by type/pass:', byType);

if (process.env.PREVIEW_ONLY) {
  await ctx.close();
  process.exit(0);
}

// 2. Run the agent; approve every prompt (a person would read them first).
await panel.evaluate(() => window.parda.reset());
await panel.evaluate(({ profile, canaries }) => { window.parda.loadProfile(profile); window.parda.settings.canaries = canaries; }, { profile, canaries });
await panel.fill('#goal', GOAL);
await panel.click('#run');
const approvals = [];
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  if (await panel.isVisible('#approval')) {
    approvals.push(await panel.textContent('#ap-title'));
    await panel.click('#ap-yes');
  }
  const running = await panel.evaluate(() => window.parda.running);
  if (!running && Date.now() - t0 > 1500) break;
  await panel.waitForTimeout(250);
}
const log = await panel.$$eval('#log li', (lis) => lis.map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
console.log(`\n== run (${((Date.now() - t0) / 1000).toFixed(1)} s) ==`);
for (const l of log) console.log(' ', l);
console.log('approvals asked:', approvals);

const targetPage = ctx.pages().find((p) => p.url().includes(PAGE));
if (targetPage) {
  await targetPage.screenshot({ path: join(OUT, `${stem}-after.png`) });
  console.log('page shows:', (await targetPage.innerText('main')).split('\n').find((l) => /filed|placed|Claim/i.test(l)) ?? '(no confirmation text)');
}
// Side-panel screenshots at side-panel size, for the README and the deck.
await panel.setViewportSize({ width: 440, height: 980 });
await panel.click('nav button[data-tab="steps"]');
await panel.screenshot({ path: join(OUT, `${stem}-panel-steps.png`) });
await panel.click('nav button[data-tab="receipt"]');
await panel.waitForTimeout(800);
await panel.screenshot({ path: join(OUT, `${stem}-panel-receipt.png`) });
await panel.click('nav button[data-tab="view"]');
await panel.screenshot({ path: join(OUT, `${stem}-panel-view.png`) });
const client = await panel.evaluate(() => window.parda.receipt.summary());
const session = await panel.evaluate(() => window.parda.session);
const server = await (await fetch(`${SERVER}/v1/receipt?session=${session}`)).json();
const chainOk = await panel.evaluate(() => window.parda.audit.verify());
console.log('\n== receipt ==');
console.log('client:', client);
console.log('server:', { payloads: server.payloads, bytes: server.bytes, pii_hits: server.pii_hits, canary_hits: server.canary_hits, scanner: server.scanner });
if (server.hits?.length) console.log('server hits:', server.hits);
console.log('audit chain verifies:', chainOk);
await ctx.close();
