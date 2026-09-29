// Structure, text, context and known-value passes over the live DOM.
// Boxes come from the DOM itself (getBoundingClientRect / Range.getClientRects), so they are
// pixel-exact and a wrapped address gets one tight box per line, not one loose box.

import { inViewport, isVisible, labelFor, styleOf } from '../dom/elements';
import { knownRegexes } from '../tokens/scrub';
import type { Finding, PiiType, Rect } from './types';
import { nameFromEmail } from './names';
import { fieldType, scanText } from './validators';

export interface BlindRegion {
  kind: 'img' | 'canvas' | 'video' | 'iframe' | 'embed';
  rect: Rect;
  src?: string;
}

export interface DomScan {
  findings: Finding[];
  blind: BlindRegion[];
  /** Visible text in reading order (raw — scrubbed on the device before it is sent). */
  text: string;
}

export interface KnownValue {
  type: PiiType;
  value: string;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG']);
const BLOCKY = /^(block|flex|grid|table|table-cell|table-caption|list-item|flow-root|inline-block|table-row)$/;

function toRect(r: DOMRect): Rect {
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function clip(r: Rect): Rect | null {
  const x1 = Math.max(0, r.x);
  const y1 = Math.max(0, r.y);
  const x2 = Math.min(innerWidth, r.x + r.w);
  const y2 = Math.min(innerHeight, r.y + r.h);
  return x2 - x1 >= 1 && y2 - y1 >= 1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

function rangeRects(range: Range): Rect[] {
  return [...range.getClientRects()].map(toRect).map(clip).filter((r): r is Rect => !!r && r.w > 0.5 && r.h > 2);
}

/** Content box of a form control: where its value is drawn. */
function valueBox(el: Element): Rect[] {
  const r = el.getBoundingClientRect();
  const s = styleOf(el);
  const px = (v: string) => parseFloat(v) || 0;
  const box = {
    x: r.x + px(s.borderLeftWidth) + px(s.paddingLeft) - 2,
    y: r.y + px(s.borderTopWidth) + px(s.paddingTop) - 2,
    w: r.width - px(s.borderLeftWidth) - px(s.borderRightWidth) - px(s.paddingLeft) - px(s.paddingRight) + 4,
    h: r.height - px(s.borderTopWidth) - px(s.borderBottomWidth) - px(s.paddingTop) - px(s.paddingBottom) + 4,
  };
  const c = clip(box);
  return c ? [c] : [];
}

interface Segment {
  node: Text;
  start: number; // offset in block text
}
interface Block {
  el: Element;
  text: string;
  segs: Segment[];
}

function blockOf(el: Element): Element {
  for (let cur: Element | null = el; cur && cur !== document.body; cur = cur.parentElement) {
    if (BLOCKY.test(styleOf(cur).display)) return cur;
  }
  return document.body;
}

/** Visible text nodes grouped by the block they render in. */
function collectBlocks(): Block[] {
  const blocks = new Map<Element, Block>();
  const order: Block[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || !n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      for (let cur: Element | null = p; cur; cur = cur.parentElement) {
        if (SKIP.has(cur.tagName.toUpperCase()) || (cur as HTMLElement).dataset?.pardaOverlay !== undefined) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return isVisible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const b = blockOf(n.parentElement!);
    let blk = blocks.get(b);
    if (!blk) {
      blk = { el: b, text: '', segs: [] };
      blocks.set(b, blk);
      order.push(blk);
    }
    blk.segs.push({ node: n, start: blk.text.length });
    blk.text += n.nodeValue;
  }
  return order;
}

function rangeFor(blk: Block, start: number, end: number): Range | null {
  const r = document.createRange();
  let s: Segment | undefined;
  let e: Segment | undefined;
  for (const seg of blk.segs) {
    const len = seg.node.nodeValue!.length;
    if (!s && start < seg.start + len) s = seg;
    if (end <= seg.start + len) {
      e = seg;
      break;
    }
  }
  if (!s || !e) return null;
  r.setStart(s.node, start - s.start);
  r.setEnd(e.node, end - e.start);
  return r;
}

/** Text of the thing that labels this block: previous sibling, row header or column header. */
function contextFor(el: Element): string {
  const bits: string[] = [];
  const prev = el.previousElementSibling;
  if (prev) bits.push((prev.textContent || '').slice(0, 60));
  const cell = el.closest('td,th');
  if (cell) {
    // Table: the row's first cell and the column header.
    const row = cell.parentElement;
    const first = row?.firstElementChild;
    if (first && first !== cell) bits.push((first.textContent || '').slice(0, 60));
    const table = cell.closest('table');
    const idx = [...(row?.children || [])].indexOf(cell);
    const head = table?.querySelector('thead tr, tr')?.children[idx];
    if (head && head !== cell) bits.push((head.textContent || '').slice(0, 60));
  }
  const dd = el.closest('dd');
  if (dd) {
    // Definition list: only the <dt> that names this <dd>.
    let dt = dd.previousElementSibling;
    while (dt && dt.tagName !== 'DT') dt = dt.previousElementSibling;
    if (dt) bits.push((dt.textContent || '').slice(0, 60));
  }
  const lab = el.closest('label');
  if (lab && lab !== el) bits.push((lab.textContent || '').slice(0, 60));
  return bits.join(' | ');
}

const DISPLAY_TYPES: ReadonlySet<PiiType> = new Set(['NAME', 'ADDRESS', 'DOB', 'USERNAME']);
const LABEL_TAGS = new Set(['TH', 'DT', 'LABEL', 'LEGEND', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BUTTON', 'A', 'CAPTION']);

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function scanDom(known: KnownValue[] = []): DomScan {
  const findings: Finding[] = [];
  const add = (f: Finding) => {
    if (!f.rects.length) return;
    // One finding per place: if these boxes are already covered, keep whichever is more confident.
    const i = findings.findIndex((g) => g.rects.some((r) => f.rects.every((q) => overlaps(r, q))));
    if (i < 0) findings.push(f);
    else if (f.conf > findings[i].conf && f.rects.length >= findings[i].rects.length) findings[i] = f;
  };

  // 1. Structure pass: form controls, by meaning (type, autocomplete, label).
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')) {
    if (!isVisible(el) || !inViewport(el.getBoundingClientRect())) continue;
    const type = (el as HTMLInputElement).type;
    if (['hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color'].includes(type)) continue;
    const value = el.tagName === 'SELECT' ? (el as HTMLSelectElement).selectedOptions[0]?.text || '' : el.value;
    if (!value.trim()) continue;
    const label = [labelFor(el), el.name, el.id, (el as HTMLInputElement).placeholder].filter(Boolean).join(' ');
    const ft = fieldType({ inputType: type, autocomplete: el.getAttribute('autocomplete') || '', label });
    if (el.tagName === 'SELECT' && ft !== 'DOB') continue;
    if (ft) {
      add({ type: ft, value, rects: valueBox(el), pass: 'structure', conf: 0.97, rule: `field:${ft.toLowerCase()}` });
      continue;
    }
    const hits = scanText(value, { context: label });
    if (hits.length) {
      const best = hits.reduce((a, b) => (b.conf > a.conf ? b : a));
      add({ type: best.type, value, rects: valueBox(el), pass: 'text', conf: best.conf, rule: best.rule });
    }
  }

  // 2. Text pass (validators) and 3. context pass (label says Name/Address/DOB).
  const blocks = collectBlocks();
  for (const blk of blocks) {
    const ctx = contextFor(blk.el);
    const hits = scanText(blk.text, { context: ctx });
    for (const h of hits) {
      const r = rangeFor(blk, h.start, h.end);
      if (!r) continue;
      add({ type: h.type, value: h.value, rects: rangeRects(r), pass: h.rule === 'key-value' ? 'context' : 'text', conf: h.conf, rule: h.rule });
    }
    const own = blk.text.trim();
    const looksLikeLabel =
      LABEL_TAGS.has(blk.el.tagName) || /:\s*$/.test(own) || (own.length <= 40 && fieldType({ label: own }) !== null);
    if (!hits.length && ctx && own.length <= 200 && !looksLikeLabel) {
      const keyText = ctx.split(' | ').find((c) => c.trim().length > 0 && c.trim().length <= 40) || '';
      const t = keyText ? fieldType({ label: keyText }) : null;
      if (t && DISPLAY_TYPES.has(t)) {
        const trimmedStart = blk.text.search(/\S/);
        const trimmedEnd = blk.text.trimEnd().length;
        const r = rangeFor(blk, trimmedStart, trimmedEnd);
        if (r) add({ type: t, value: blk.text.trim(), rects: rangeRects(r), pass: 'context', conf: 0.85, rule: `label:${keyText.trim().toLowerCase()}` });
      }
    }
  }

  // 4. Known-value pass: anything already found, or in the user's profile, wherever else it appears.
  const values: KnownValue[] = [...known, ...findings.map((f) => ({ type: f.type, value: f.value }))];
  // An address like rohan.mehta@… names its owner: look for "Rohan Mehta" elsewhere too.
  for (const f of findings) {
    const n = f.type === 'EMAIL' ? nameFromEmail(f.value) : null;
    if (n) values.push({ type: 'NAME', value: n });
  }
  const seen = new Set<string>();
  for (const kv of values) {
    const key = kv.type + ':' + kv.value;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const re of knownRegexes(kv.type, kv.value)) {
      for (const blk of blocks) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(blk.text))) {
          const r = rangeFor(blk, m.index, m.index + m[0].length);
          // Keep the full known value so a partial hit ("Ananya") gets the same token as the whole ("Ananya Iyer").
          if (r) add({ type: kv.type, value: kv.value, rects: rangeRects(r), pass: 'known', conf: 0.9, rule: 'known-value' });
        }
      }
    }
  }

  // 5. Regions the DOM cannot read: handed to the pixel pass.
  const blind: BlindRegion[] = [];
  for (const el of document.querySelectorAll('img,canvas,video,iframe,embed,object')) {
    if (!isVisible(el)) continue;
    const c = clip(toRect(el.getBoundingClientRect()));
    if (!c || c.w < 40 || c.h < 32) continue;
    const tag = el.tagName.toLowerCase();
    const kind = (tag === 'object' ? 'embed' : tag) as BlindRegion['kind'];
    blind.push({ kind, rect: c, src: (el as HTMLImageElement).currentSrc || (el as HTMLIFrameElement).src || undefined });
  }

  const text = blocks
    .filter((b) => b.segs.some((s) => { const p = s.node.parentElement; return p && inViewport(p.getBoundingClientRect()); }))
    .map((b) => b.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);

  return { findings, blind, text };
}
