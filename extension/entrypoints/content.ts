// Content script: reads the page, finds PII with DOM-exact boxes, and carries out actions.
// It never talks to the network; everything goes to the side panel over extension messaging.

import { execute, type ExecAction } from '@/lib/dom/actions';
import { indexElements } from '@/lib/dom/elements';
import { scanDom, type KnownValue } from '@/lib/pii/detect-dom';
import type { Rect } from '@/lib/pii/types';

type Msg =
  | { kind: 'ping' }
  | { kind: 'snapshot'; known: KnownValue[] }
  | { kind: 'stable'; stamp: number; scroll: { x: number; y: number } }
  | { kind: 'settle'; quietMs?: number; maxMs?: number }
  | { kind: 'act'; action: ExecAction }
  | { kind: 'lens'; boxes: { rect: Rect; label: string; style: string }[] }
  | { kind: 'lens-off' };

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    if ((window as any).__parda) return;
    (window as any).__parda = true;

    let elementMap = new Map<string, Element>();
    let mutations = 0;
    let lastMutation = performance.now();
    const lens = document.createElement('div');
    lens.dataset.pardaOverlay = '';
    Object.assign(lens.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });

    new MutationObserver((recs) => {
      // Our own outline layer coming and going is not a page change.
      const ours = (r: MutationRecord) =>
        r.target === lens || lens.contains(r.target) || [...r.addedNodes, ...r.removedNodes].includes(lens);
      if (recs.some((r) => !ours(r))) {
        mutations++;
        lastMutation = performance.now();
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });

    const handle = async (msg: Msg): Promise<unknown> => {
      switch (msg.kind) {
        case 'ping':
          return { ok: true };
        case 'snapshot': {
          lens.remove();
          const t0 = performance.now();
          const { elements, map } = indexElements();
          elementMap = map;
          const t1 = performance.now();
          const scan = scanDom(msg.known);
          const t2 = performance.now();
          return {
            url: location.href,
            origin: location.origin,
            title: document.title,
            viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
            scroll: { x: scrollX, y: scrollY },
            stamp: mutations,
            elements,
            ...scan,
            timings: { indexMs: t1 - t0, scanMs: t2 - t1 },
          };
        }
        case 'stable':
          return { changed: mutations - msg.stamp, scrolled: scrollX !== msg.scroll.x || scrollY !== msg.scroll.y };
        case 'settle': {
          // Wait until the DOM has been quiet for quietMs (or maxMs passes).
          const quiet = msg.quietMs ?? 350;
          const deadline = performance.now() + (msg.maxMs ?? 3000);
          await new Promise((r) => setTimeout(r, 120));
          while (performance.now() < deadline && performance.now() - lastMutation < quiet) {
            await new Promise((r) => setTimeout(r, 80));
          }
          return { ok: true };
        }
        case 'act':
          return execute(msg.action, elementMap);
        case 'lens': {
          lens.replaceChildren(
            ...msg.boxes.map((b) => {
              const d = document.createElement('div');
              Object.assign(d.style, {
                position: 'fixed',
                left: `${b.rect.x}px`,
                top: `${b.rect.y}px`,
                width: `${b.rect.w}px`,
                height: `${b.rect.h}px`,
                outline: b.style === 'blackout' ? '2px solid #111' : b.style === 'blur' ? '2px dashed #c026d3' : '2px solid #2563eb',
                background: b.style === 'blackout' ? 'rgba(0,0,0,.18)' : 'rgba(37,99,235,.10)',
                borderRadius: '3px',
              });
              d.title = b.label;
              return d;
            }),
          );
          document.documentElement.append(lens);
          return { ok: true };
        }
        case 'lens-off':
          lens.remove();
          return { ok: true };
      }
    };

    browser.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
      handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
      return true;
    });
  },
});
