// Numbered list of the interactive elements in the viewport.
// Visibility, interactivity and top-most checks are adapted from Nanobrowser's
// buildDomTree.js (Apache-2.0, itself derived from browser-use, MIT); see THIRD_PARTY_NOTICES.md.

import type { PiiType, Rect } from '../pii/types';
import { fieldType } from '../pii/validators';

export interface ElementInfo {
  id: string;
  tag: string;
  type?: string;
  role?: string;
  label: string;
  value?: string;
  placeholder?: string;
  field?: PiiType | null;
  rect: Rect;
  checked?: boolean;
  options?: string[];
  href?: string;
  inForm?: boolean;
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'option']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio', 'checkbox', 'tab',
  'switch', 'slider', 'spinbutton', 'combobox', 'searchbox', 'textbox', 'listbox', 'option',
]);
const POINTER_CURSORS = new Set(['pointer', 'text', 'grab', 'move', 'cell', 'copy', 'zoom-in', 'zoom-out']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link']);

const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
export function styleOf(el: Element): CSSStyleDeclaration {
  let s = styleCache.get(el);
  if (!s) {
    s = getComputedStyle(el);
    styleCache.set(el, s);
  }
  return s;
}

export function isVisible(el: Element): boolean {
  const h = el as HTMLElement;
  const s = styleOf(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  return (h.offsetWidth > 0 && h.offsetHeight > 0) || el.getClientRects().length > 0;
}

export function inViewport(r: DOMRect | Rect): boolean {
  const x = 'x' in r ? r.x : 0;
  const w = 'w' in r ? r.w : (r as DOMRect).width;
  const h = 'h' in r ? r.h : (r as DOMRect).height;
  const y = r.y;
  return w > 0 && h > 0 && x + w > 0 && y + h > 0 && x < innerWidth && y < innerHeight;
}

function isTopElement(el: Element, r: DOMRect): boolean {
  const root = el.getRootNode() as Document | ShadowRoot;
  const points = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 4, r.top + 4],
    [r.right - 4, r.bottom - 4],
  ];
  return points.some(([x, y]) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const top = root.elementFromPoint?.(x, y) ?? document.elementFromPoint(x, y);
    for (let cur: Element | null = top; cur; cur = cur.parentElement) if (cur === el) return true;
    // label wrapping an input, or the input inside the element at that point
    return !!top && (el.contains(top) || (top as HTMLLabelElement).control === el);
  });
}

function isInteractive(el: Element, parent: Element | null): boolean {
  const tag = el.tagName.toLowerCase();
  const h = el as HTMLInputElement;
  if (INTERACTIVE_TAGS.has(tag)) {
    if (h.disabled || (tag === 'input' && h.type === 'hidden')) return false;
    if (tag === 'a' && !(el as HTMLAnchorElement).href && !el.getAttribute('role')) {
      return POINTER_CURSORS.has(styleOf(el).cursor);
    }
    return true;
  }
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if ((el as HTMLElement).isContentEditable && !(parent as HTMLElement | null)?.isContentEditable) return true;
  if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
  // Cursor set on this element, not inherited from an interactive parent.
  const cur = styleOf(el).cursor;
  return cur === 'pointer' && (!parent || styleOf(parent).cursor !== 'pointer');
}

const clean = (s: string | null | undefined, max = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Accessible-name-ish label: aria, <label>, table/definition-list neighbour, placeholder. */
export function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    if (t.trim()) return clean(t);
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const f = el as HTMLInputElement;
    if (f.type === 'submit' || f.type === 'button' || f.type === 'reset') return clean(f.value || f.title || f.type);
    const lab = f.labels?.[0] ?? el.closest('label');
    if (lab) {
      const t = [...lab.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE || !(n as Element).matches?.('input,select,textarea'))
        .map((n) => n.textContent).join(' ');
      if (t.trim()) return clean(t);
    }
    const cell = el.closest('td,dd');
    const prev = cell?.previousElementSibling;
    if (prev && /^(th|td|dt)$/i.test(prev.tagName)) return clean(prev.textContent);
    const prevSib = el.previousElementSibling;
    if (prevSib && /^(span|div|p|b|strong)$/i.test(prevSib.tagName) && clean(prevSib.textContent).length < 60) {
      return clean(prevSib.textContent);
    }
    return clean(f.placeholder || f.title || (f.name || f.id || '').replace(/[_-]+/g, ' '));
  }
  const text = clean((el as HTMLElement).innerText ?? el.textContent);
  if (text) return text;
  const img = el.querySelector('img[alt]');
  return clean(img?.getAttribute('alt') || el.getAttribute('title') || '');
}

export interface IndexResult {
  elements: ElementInfo[];
  map: Map<string, Element>;
}

/** Walk the document (and open shadow roots) and number every visible, top-most interactive element. */
export function indexElements(): IndexResult {
  const elements: ElementInfo[] = [];
  const map = new Map<string, Element>();
  let n = 0;

  const visit = (el: Element, parent: Element | null, insideInteractive: boolean) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || (el as HTMLElement).dataset?.pardaOverlay !== undefined) return;
    if (!isVisible(el)) return;
    let marked = false;
    const isControl = tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button';
    if ((isControl || !insideInteractive) && isInteractive(el, parent)) {
      const r = el.getBoundingClientRect();
      if (inViewport(r) && isTopElement(el, r)) {
        const id = `e${++n}`;
        map.set(id, el);
        elements.push(describe(el, id, r));
        marked = true;
      }
    }
    const kids = el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : [...el.children];
    for (const k of kids) visit(k, el, insideInteractive || marked);
  };
  if (document.body) visit(document.body, null, false);
  return { elements, map };
}

function describe(el: Element, id: string, r: DOMRect): ElementInfo {
  const tag = el.tagName.toLowerCase();
  const f = el as HTMLInputElement;
  const info: ElementInfo = {
    id,
    tag,
    label: labelFor(el),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
  const role = el.getAttribute('role');
  if (role) info.role = role;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    info.type = tag === 'input' ? f.type : tag;
    info.placeholder = clean(f.placeholder, 60) || undefined;
    info.inForm = !!f.form;
    if (tag === 'select') {
      const s = el as HTMLSelectElement;
      info.options = [...s.options].slice(0, 30).map((o) => clean(o.text, 40));
      info.value = clean(s.selectedOptions[0]?.text, 60);
    } else if (f.type === 'checkbox' || f.type === 'radio') {
      info.checked = f.checked;
    } else {
      info.value = f.value;
    }
    info.field = fieldType({
      inputType: f.type,
      autocomplete: f.getAttribute('autocomplete') || '',
      label: [info.label, f.name, f.id, f.placeholder].filter(Boolean).join(' '),
    });
  } else if (tag === 'button') {
    info.type = (el as HTMLButtonElement).type;
    info.inForm = !!(el as HTMLButtonElement).form;
  } else if (tag === 'a') {
    info.href = (el as HTMLAnchorElement).href;
  } else if ((el as HTMLElement).isContentEditable) {
    info.type = 'contenteditable';
    info.value = clean((el as HTMLElement).innerText, 200);
  }
  return info;
}
