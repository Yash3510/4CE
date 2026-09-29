// Benchmark: runs the extension's real on-device pipeline over every testbed page (top of the
// page and one screen down) and scores it against the data-gt ground truth.
//
//   coverage recall  — share of labelled PII items whose box is ≥80 % covered by redactions
//   typed recall     — same, but the covering redaction must also have the right class
//   precision        — share of redaction boxes that overlap a labelled item
//   pixel precision  — share of redacted pixels that lie inside labelled boxes (1 − over-redaction)
//   mean IoU         — labelled box vs the union of redaction boxes over it
//
//   node bench.mjs            (server must be running on :8765; results → out/bench.json)

import { writeFileSync } from 'node:fs';
import { launch } from './lib.mjs';

const PAGES = ['claim.html', 'bank.html', 'checkout.html', 'webmail.html', 'idcard.html', 'canvas.html'];
const SAME = { USERNAME: ['EMAIL', 'PHONE'], CARD_EXP: ['DOB'], PINCODE: ['ADDRESS'], ADDRESS: ['PINCODE'] };

// Ground truth, read from the page in viewport CSS pixels (same frame as the findings).
const readTruth = () => {
  const out = [];
  const vis = (r) => r.w > 1 && r.h > 1 && r.x < innerWidth && r.y < innerHeight && r.x + r.w > 0 && r.y + r.h > 0;
  const clip = (r) => {
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    return { x, y, w: Math.min(innerWidth, r.x + r.w) - x, h: Math.min(innerHeight, r.y + r.h) - y };
  };
  for (const el of document.querySelectorAll('[data-gt]')) {
    let rects;
    if (el.matches('input,textarea,select')) {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      const px = (v) => parseFloat(v) || 0;
      rects = [{ x: b.x + px(s.borderLeftWidth) + px(s.paddingLeft), y: b.y + px(s.borderTopWidth) + px(s.paddingTop), w: b.width - px(s.borderLeftWidth) - px(s.borderRightWidth) - px(s.paddingLeft) - px(s.paddingRight), h: b.height - px(s.borderTopWidth) - px(s.borderBottomWidth) - px(s.paddingTop) - px(s.paddingBottom) }];
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      rects = [...range.getClientRects()].map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
    }
    for (const r of rects.filter(vis)) out.push({ type: el.dataset.gt, rect: clip(r) });
  }
  for (const img of document.querySelectorAll('img[data-gt-img]')) {
    const b = img.getBoundingClientRect();
    const r = { x: b.x, y: b.y, w: b.width, h: b.height };
    if (vis(r)) out.push({ type: img.dataset.gtImg, rect: clip(r) });
  }
  const gi = document.getElementById('gt-image');
  if (gi) {
    const { img, boxes } = JSON.parse(gi.textContent);
    const el = document.querySelector(img), b = el.getBoundingClientRect(), k = b.width / el.naturalWidth;
    for (const g of boxes) {
      const r = { x: b.x + g.box[0] * k, y: b.y + g.box[1] * k, w: g.box[2] * k, h: g.box[3] * k };
      if (vis(r)) out.push({ type: g.type, rect: clip(r) });
    }
  }
  if (window.__gtCanvas) {
    const b = document.getElementById('stmt').getBoundingClientRect();
    for (const g of window.__gtCanvas) {
      const r = { x: b.x + g.box[0], y: b.y + g.box[1], w: g.box[2], h: g.box[3] };
      if (vis(r)) out.push({ type: g.type, rect: clip(r) });
    }
  }
  return out;
};

const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const area = (r) => r.w * r.h;

/** Rasterise boxes onto a 2 px grid so unions and overlaps are exact enough and cheap. */
function mask(rects, W = 1280, H = 800, g = 2) {
  const m = new Uint8Array((W / g) * (H / g));
  for (const r of rects)
    for (let y = Math.max(0, Math.floor(r.y / g)); y < Math.min(H / g, Math.ceil((r.y + r.h) / g)); y++)
      for (let x = Math.max(0, Math.floor(r.x / g)); x < Math.min(W / g, Math.ceil((r.x + r.w) / g)); x++) m[y * (W / g) + x] = 1;
  return m;
}
const count = (m) => m.reduce((a, v) => a + v, 0);
const and = (a, b) => a.map((v, i) => v & b[i]);

const { ctx, panel, open } = await launch();
const rows = [];
const perType = {};
const timings = [];
let redPx = 0, redInGt = 0;

for (const page of PAGES) {
  const { tab } = await open(page);
  for (const scroll of [0, 700]) {
    await tab.evaluate((y) => scrollTo(0, y), scroll);
    const atY = await tab.evaluate(() => scrollY);
    if (scroll && atY < 50) continue; // page is only one screen tall
    await panel.waitForTimeout(250);
    const truth = await tab.evaluate(readTruth);
    const obs = await panel.evaluate(async () => {
      const o = await window.parda.observe('(benchmark)');
      return { findings: o.findings.map((f) => ({ type: f.type, pass: f.pass, rects: f.rects })), timings: o.timings, gate: o.gate.ok, recheck: o.frameRecheckHits };
    });
    timings.push(obs.timings);
    const fRects = obs.findings.flatMap((f) => f.rects.map((r) => ({ ...r, type: f.type })));

    // Recall per labelled item.
    for (const g of truth) {
      const t = (perType[g.type] ??= { items: 0, covered: 0, typed: 0, iouSum: 0 });
      t.items++;
      const over = fRects.filter((r) => inter(r, g.rect) > 0);
      const gm = mask([g.rect]);
      const cov = count(and(gm, mask(over))) / Math.max(1, count(gm));
      const typedOver = over.filter((r) => r.type === g.type || (SAME[g.type] ?? []).includes(r.type));
      const tcov = count(and(gm, mask(typedOver))) / Math.max(1, count(gm));
      if (cov >= 0.8) t.covered++;
      if (tcov >= 0.8) t.typed++;
      const um = mask(over);
      const union = count(gm.map((v, i) => v | um[i]));
      t.iouSum += union ? count(and(gm, um)) / union : 0;
    }
    // Precision per redaction box, and pixel precision.
    const gtMask = mask(truth.map((g) => g.rect));
    let tp = 0;
    for (const r of fRects) if (truth.some((g) => inter(r, g.rect) > 0.3 * Math.min(area(r), area(g.rect)))) tp++;
    const fm = mask(fRects);
    redPx += count(fm);
    redInGt += count(and(fm, gtMask));
    rows.push({ page, scroll: atY, truth: truth.length, redactions: fRects.length, precision: fRects.length ? tp / fRects.length : 1, gate: obs.gate, recheck: obs.recheck });
    const fp = fRects.filter((r) => !truth.some((g) => inter(r, g.rect) > 0.3 * Math.min(area(r), area(g.rect))));
    if (fp.length) console.log(`  ${page}@${atY} unlabelled redactions:`, fp.map((r) => `${r.type}[${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)}x${Math.round(r.h)}]`).join(' '));
    const missed = truth.filter((g) => count(and(mask([g.rect]), fm)) / Math.max(1, count(mask([g.rect]))) < 0.8);
    if (missed.length) console.log(`  ${page}@${atY} missed:`, missed.map((g) => `${g.type}[${Math.round(g.rect.x)},${Math.round(g.rect.y)}]`).join(' '));
  }
  await tab.close();
}
await ctx.close();

const tot = Object.values(perType).reduce((a, t) => ({ items: a.items + t.items, covered: a.covered + t.covered, typed: a.typed + t.typed, iouSum: a.iouSum + t.iouSum }), { items: 0, covered: 0, typed: 0, iouSum: 0 });
const allBoxes = rows.reduce((a, r) => a + r.redactions, 0);
const precision = rows.reduce((a, r) => a + r.precision * r.redactions, 0) / allBoxes;
const med = (k) => {
  const v = timings.map((t) => t[k] ?? 0).sort((a, b) => a - b);
  return Math.round(v[Math.floor(v.length / 2)]);
};
const p95 = (k) => {
  const v = timings.map((t) => t[k] ?? 0).sort((a, b) => a - b);
  return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * 0.95))]);
};

console.log('\nper class        items  covered  typed   mean IoU');
for (const [k, t] of Object.entries(perType).sort()) {
  console.log(`  ${k.padEnd(14)} ${String(t.items).padStart(5)}  ${((t.covered / t.items) * 100).toFixed(0).padStart(6)}%  ${((t.typed / t.items) * 100).toFixed(0).padStart(5)}%  ${(t.iouSum / t.items).toFixed(2).padStart(8)}`);
}
const summary = {
  frames: rows.length,
  labelledItems: tot.items,
  coverageRecall: +(tot.covered / tot.items).toFixed(3),
  typedRecall: +(tot.typed / tot.items).toFixed(3),
  boxPrecision: +precision.toFixed(3),
  pixelPrecision: +(redInGt / redPx).toFixed(3),
  meanIoU: +(tot.iouSum / tot.items).toFixed(3),
  gateBlocked: rows.filter((r) => !r.gate).length,
  onDeviceMs: { median: med('observeMs'), p95: p95('observeMs') },
  stageMedianMs: Object.fromEntries(['domMs', 'captureMs', 'faceMs', 'ocrMs', 'composeMs', 'verifyMs', 'gateMs'].map((k) => [k.replace(/Ms$/, ''), med(k)])),
};
console.log('\n', summary);
writeFileSync(new URL('./out/bench.json', import.meta.url), JSON.stringify({ summary, perType, rows }, null, 1));
