// Builds the one image that leaves the device: secrets blacked out, faces pixelated,
// other PII replaced by a labelled chip naming its token, plus numbered element marks.

import type { ElementInfo } from '../dom/elements';
import type { Finding, Rect } from '../pii/types';
import { STYLE } from '../pii/types';

export interface TokenFinding extends Finding {
  token: string;
}

export interface Frame {
  canvas: HTMLCanvasElement;
  b64: string;
  mime: 'image/jpeg';
  w: number;
  h: number;
  sha256: string;
  bytes: number;
  /** Share of frame pixels covered by redactions (for the over-redaction metric). */
  redactedShare: number;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface ComposeOptions {
  maxWidth: number;
  marks: boolean;
  quality: number;
}

export async function composeFrame(
  shot: HTMLCanvasElement,
  viewport: { w: number; h: number },
  findings: TokenFinding[],
  elements: ElementInfo[],
  opts: ComposeOptions,
): Promise<Frame> {
  const s = Math.min(1, opts.maxWidth / viewport.w); // output px per CSS px
  const W = Math.round(viewport.w * s);
  const H = Math.round(viewport.h * s);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(shot, 0, 0, W, H);

  const px = (r: Rect, pad = 1) => ({
    x: Math.floor(r.x * s) - pad,
    y: Math.floor(r.y * s) - pad,
    w: Math.ceil(r.w * s) + 2 * pad,
    h: Math.ceil(r.h * s) + 2 * pad,
  });

  // Coverage mask at 1/4 resolution, for the redacted-share metric.
  const mw = Math.ceil(W / 4), mh = Math.ceil(H / 4);
  const mask = new Uint8Array(mw * mh);
  const cover = (R: { x: number; y: number; w: number; h: number }) => {
    for (let y = Math.max(0, R.y >> 2); y < Math.min(mh, (R.y + R.h) >> 2); y++)
      for (let x = Math.max(0, R.x >> 2); x < Math.min(mw, (R.x + R.w) >> 2); x++) mask[y * mw + x] = 1;
  };

  // Faces first (pixelate), then chips, then blackouts on top.
  const order = { blur: 0, token: 1, blackout: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[STYLE[a.type]] - order[STYLE[b.type]]);
  for (const f of sorted) {
    const style = STYLE[f.type];
    for (const r of f.rects) {
      const R = px(r, style === 'blur' ? 0 : 1);
      if (R.w <= 0 || R.h <= 0) continue;
      cover(R);
      if (style === 'blackout') {
        g.fillStyle = '#000';
        g.fillRect(R.x, R.y, R.w, R.h);
      } else if (style === 'blur') {
        const cell = Math.max(6, Math.round(Math.min(R.w, R.h) / 10));
        const small = document.createElement('canvas');
        small.width = Math.max(1, Math.ceil(R.w / cell));
        small.height = Math.max(1, Math.ceil(R.h / cell));
        small.getContext('2d')!.drawImage(c, R.x, R.y, R.w, R.h, 0, 0, small.width, small.height);
        g.imageSmoothingEnabled = false;
        g.drawImage(small, 0, 0, small.width, small.height, R.x, R.y, R.w, R.h);
        g.imageSmoothingEnabled = true;
        chip(g, f.token, { x: R.x, y: R.y + R.h - 16, w: R.w, h: 16 }, '#86198f', '#fae8ff');
      } else {
        g.fillStyle = '#dbeafe';
        g.fillRect(R.x, R.y, R.w, R.h);
        g.strokeStyle = '#2563eb';
        g.lineWidth = 1;
        g.strokeRect(R.x + 0.5, R.y + 0.5, R.w - 1, R.h - 1);
        chip(g, f.token, R, '#1e3a8a', null);
      }
    }
  }

  if (opts.marks) {
    g.font = 'bold 10px ui-monospace, Consolas, monospace';
    for (const e of elements) {
      const R = px(e.rect, 0);
      g.strokeStyle = 'rgba(234,88,12,.85)';
      g.lineWidth = 1;
      g.strokeRect(R.x + 0.5, R.y + 0.5, R.w - 1, R.h - 1);
      // Tag sits on the box's top-right corner, where it rarely covers a label or value.
      const tw = g.measureText(e.id).width + 4;
      const lx = Math.max(0, R.x + R.w - tw);
      const ly = R.y >= 12 ? R.y - 12 : R.y;
      g.fillStyle = 'rgba(234,88,12,.95)';
      g.fillRect(lx, ly, tw, 12);
      g.fillStyle = '#fff';
      g.fillText(e.id, lx + 2, ly + 10);
    }
  }

  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', opts.quality));
  const buf = await blob.arrayBuffer();
  let covered = 0;
  for (const v of mask) covered += v;
  return {
    canvas: c,
    b64: b64(buf),
    mime: 'image/jpeg',
    w: W,
    h: H,
    sha256: await sha256Hex(buf),
    bytes: buf.byteLength,
    redactedShare: covered / mask.length,
  };
}

function chip(g: CanvasRenderingContext2D, text: string, R: { x: number; y: number; w: number; h: number }, fg: string, bg: string | null) {
  const size = Math.max(7, Math.min(14, Math.floor(R.h * 0.72)));
  g.save();
  g.beginPath();
  g.rect(R.x, R.y, R.w, R.h);
  g.clip();
  g.font = `bold ${size}px ui-monospace, Consolas, monospace`;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(R.x, R.y, Math.min(R.w, g.measureText(text).width + 6), R.h);
  }
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.fillText(text, R.x + 3, R.y + R.h / 2 + 0.5);
  g.restore();
}
