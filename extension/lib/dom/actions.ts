// Carries out one typed action on the page. Real values arrive here already
// resolved by the vault in the side panel; nothing on this path talks to the network.

export interface ExecAction {
  do: 'click' | 'type' | 'select' | 'scroll' | 'press' | 'wait' | 'clear';
  target?: string;
  point?: [number, number]; // CSS px, used only when the server points instead of naming an element
  text?: string;
  option?: string;
  direction?: 'up' | 'down';
  key?: string;
  ms?: number;
}

export interface ExecResult {
  ok: boolean;
  detail: string;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // Use the prototype setter so frameworks that track the value (React etc.) see the change.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function scrollIntoViewIfNeeded(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
}

export async function execute(a: ExecAction, map: Map<string, Element>): Promise<ExecResult> {
  let el: Element | null = a.target ? map.get(a.target) ?? null : null;
  if (!el && a.point) el = document.elementFromPoint(a.point[0], a.point[1]);
  const needsEl = a.do === 'click' || a.do === 'type' || a.do === 'select' || a.do === 'clear';
  if (needsEl && (!el || !el.isConnected)) return { ok: false, detail: `element ${a.target ?? a.point} not found` };

  switch (a.do) {
    case 'click': {
      scrollIntoViewIfNeeded(el!);
      (el as HTMLElement).focus?.();
      (el as HTMLElement).click();
      return { ok: true, detail: 'clicked' };
    }
    case 'clear':
    case 'type': {
      const text = a.do === 'clear' ? '' : a.text ?? '';
      scrollIntoViewIfNeeded(el!);
      const h = el as HTMLElement;
      h.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, text);
      } else if (h.isContentEditable) {
        h.textContent = text;
        h.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      } else {
        return { ok: false, detail: 'target is not editable' };
      }
      return { ok: true, detail: `typed ${text.length} chars` };
    }
    case 'select': {
      if (!(el instanceof HTMLSelectElement)) return { ok: false, detail: 'target is not a <select>' };
      const want = (a.option ?? a.text ?? '').trim().toLowerCase();
      const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ??
        [...el.options].find((o) => o.text.toLowerCase().includes(want));
      if (!opt) return { ok: false, detail: `no option "${want}"` };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `selected ${opt.text.trim()}` };
    }
    case 'scroll': {
      const dy = (a.direction === 'up' ? -1 : 1) * Math.round(innerHeight * 0.8);
      scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
      return { ok: true, detail: `scrolled ${a.direction ?? 'down'}` };
    }
    case 'press': {
      const target = (el as HTMLElement) ?? (document.activeElement as HTMLElement) ?? document.body;
      const key = a.key ?? 'Enter';
      for (const type of ['keydown', 'keypress', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
      }
      if (key === 'Enter' && (target as HTMLInputElement).form) (target as HTMLInputElement).form!.requestSubmit();
      return { ok: true, detail: `pressed ${key}` };
    }
    case 'wait': {
      await new Promise((r) => setTimeout(r, Math.min(a.ms ?? 1000, 5000)));
      return { ok: true, detail: 'waited' };
    }
  }
  return { ok: false, detail: `unknown action ${(a as ExecAction).do}` };
}
