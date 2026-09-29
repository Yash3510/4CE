// Pixel pass: only for what the DOM cannot read (images, canvas, video, cross-origin frames).
// Faces: MediaPipe BlazeFace (GPU delegate, CPU fallback). Text: Tesseract.js LSTM (WASM),
// then the same validators as the text pass decide what is PII.

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { createWorker, type Worker as TessWorker } from 'tesseract.js';
import type { BlindRegion, KnownValue } from '../pii/detect-dom';
import type { Finding, PiiType, Rect } from '../pii/types';
import { fieldType, scanText } from '../pii/validators';
import { knownRegexes } from '../tokens/scrub';

const url = (p: string) => browser.runtime.getURL(p as any);

let faceDetector: FaceDetector | null = null;
let faceDelegate: 'GPU' | 'CPU' | null = null;
let ocrWorker: TessWorker | null = null;

export async function loadFaceDetector(): Promise<string> {
  if (faceDetector) return faceDelegate!;
  const files = await FilesetResolver.forVisionTasks(url('/mediapipe'));
  for (const delegate of ['GPU', 'CPU'] as const) {
    try {
      faceDetector = await FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: url('/models/blaze_face_short_range.tflite'), delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5,
      });
      faceDelegate = delegate;
      return delegate;
    } catch (e) {
      console.warn(`[parda] face detector ${delegate} failed`, e);
    }
  }
  throw new Error('face detector unavailable');
}

export async function loadOcr(): Promise<TessWorker> {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await createWorker('eng', 1, {
    workerPath: url('/tesseract/worker.min.js'),
    corePath: url('/tesseract/core'),
    langPath: url('/tesseract/lang'),
    workerBlobURL: false,
    gzip: true,
  });
  return ocrWorker;
}

function crop(src: CanvasImageSource, x: number, y: number, w: number, h: number, upscale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * upscale));
  c.height = Math.max(1, Math.round(h * upscale));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

export interface PixelOptions {
  faces: boolean;
  ocr: boolean;
  maxOcrRegions: number;
}

export interface PixelResult {
  findings: Finding[];
  faceMs: number;
  ocrMs: number;
  delegate: string | null;
}

/**
 * @param frame   full screenshot (device pixels)
 * @param scale   device pixels per CSS pixel in `frame`
 */
export async function pixelPass(
  frame: HTMLCanvasElement,
  scale: number,
  blind: BlindRegion[],
  known: KnownValue[],
  opts: PixelOptions,
): Promise<PixelResult> {
  const findings: Finding[] = [];
  let faceMs = 0;
  let ocrMs = 0;

  if (opts.faces) {
    const t0 = performance.now();
    try {
      await loadFaceDetector();
      const W = frame.width / scale, H = frame.height / scale;
      // Image crops first (tight boxes), the whole frame last (catches CSS backgrounds, video posters).
      const regions: Rect[] = [];
      for (const b of blind) {
        if (b.kind === 'embed' || b.rect.w < 20 || b.rect.h < 20) continue;
        // BlazeFace short-range wants a face that fills much of its input: pad small images
        // (avatars) with context and upscale, so a 40 px profile photo is still found.
        const pad = Math.max(b.rect.w, b.rect.h) < 160 ? 0.6 : 0.1;
        const x = Math.max(0, b.rect.x - b.rect.w * pad), y = Math.max(0, b.rect.y - b.rect.h * pad);
        regions.push({ x, y, w: Math.min(W - x, b.rect.w * (1 + 2 * pad)), h: Math.min(H - y, b.rect.h * (1 + 2 * pad)) });
      }
      regions.push({ x: 0, y: 0, w: W, h: H });
      const photos = blind.filter((b) => b.kind === 'img' || b.kind === 'video').map((b) => b.rect);
      const faces: Rect[] = [];
      for (const r of regions) {
        const up = Math.max(1, 256 / (Math.max(r.w, r.h) * scale));
        const c = crop(frame, r.x * scale, r.y * scale, r.w * scale, r.h * scale, up);
        const res = faceDetector!.detect(c);
        for (const d of res.detections) {
          const bb = d.boundingBox;
          if (!bb || (d.categories?.[0]?.score ?? 0) < 0.5) continue;
          // Grow the box to cover hair and chin, then map back to CSS pixels.
          const gx = bb.width * 0.12, gy = bb.height * 0.25;
          const k = scale * up;
          const f: Rect = {
            x: r.x + (bb.originX - gx) / k,
            y: r.y + (bb.originY - gy) / k,
            w: (bb.width + 2 * gx) / k,
            h: (bb.height + 1.6 * gy) / k,
          };
          // A face that fills much of a photo (avatar, ID photo): hide the whole photo.
          const photo = photos.find((p) => overlapOfSmaller(p, f) > 0.5 && (f.w * f.h) / (p.w * p.h) > 0.12);
          const box = photo ?? f;
          if (!faces.some((g) => overlapOfSmaller(g, box) > 0.3)) faces.push(box);
        }
      }
      for (const f of faces) findings.push({ type: 'FACE', value: `face@${Math.round(f.x)},${Math.round(f.y)}`, rects: [f], pass: 'pixel', conf: 0.9, rule: 'blazeface' });
    } catch (e) {
      console.warn('[parda] face pass failed', e);
    }
    faceMs = performance.now() - t0;
  }

  if (opts.ocr) {
    const t0 = performance.now();
    const targets = blind
      .filter((b) => b.rect.w >= 80 && b.rect.h >= 40)
      .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
      .slice(0, opts.maxOcrRegions);
    if (targets.length) {
      try {
        const worker = await loadOcr();
        for (const b of targets) findings.push(...(await ocrRegion(worker, frame, scale, b.rect, known)));
      } catch (e) {
        console.warn('[parda] OCR pass failed', e);
      }
    }
    ocrMs = performance.now() - t0;
  }
  return { findings: dedupe(findings), faceMs, ocrMs, delegate: faceDelegate };
}

/** Intersection over the smaller box: 1 when one box sits inside the other. */
export function overlapOfSmaller(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (Math.min(a.w * a.h, b.w * b.h) || 1);
}

/** Merge same-type findings whose boxes mostly overlap (OCR label + known-value hits on one line). */
export function dedupe(fs: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of [...fs].sort((a, b) => b.conf - a.conf)) {
    const twin = out.find((g) => g.type === f.type && g.rects.some((r) => f.rects.some((q) => overlapOfSmaller(r, q) > 0.6)));
    if (!twin) {
      out.push({ ...f, rects: [...f.rects] });
      continue;
    }
    // Grow the kept box to cover both, so a partial match never leaves part of the value showing.
    for (const q of f.rects) {
      const i = twin.rects.findIndex((r) => overlapOfSmaller(r, q) > 0.6);
      if (i < 0) continue;
      const r = twin.rects[i];
      const x = Math.min(r.x, q.x), y = Math.min(r.y, q.y);
      twin.rects[i] = { x, y, w: Math.max(r.x + r.w, q.x + q.w) - x, h: Math.max(r.y + r.h, q.y + q.h) - y };
    }
  }
  return out;
}

interface Word {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

/** OCR one region and run the validators over each line; boxes are unions of the matched words. */
export async function ocrRegion(worker: TessWorker, frame: HTMLCanvasElement, scale: number, r: Rect, known: KnownValue[]): Promise<Finding[]> {
  const up = r.w * scale < 900 ? 2 : 1;
  const c = crop(frame, r.x * scale, r.y * scale, r.w * scale, r.h * scale, up);
  const { data } = await worker.recognize(c, {}, { blocks: true, text: false });
  const lines: Word[][] = [];
  for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const line of para.lines) lines.push(line.words as Word[]);

  const out: Finding[] = [];
  const toCss = (x: number, y: number) => ({ x: r.x + x / up / scale, y: r.y + y / up / scale });
  let prevText = '';
  let prevX0 = 0;
  for (const raw of lines) {
    // Drop low-confidence specks (photo texture read as "|" or "‘") so they cannot widen a box.
    const words = raw.filter((w) => w.confidence >= 35 && /[A-Za-z0-9]/.test(w.text));
    if (!words.length) continue;
    let text = '';
    const spans: [number, number, Word][] = [];
    for (const w of words) {
      if (text) text += ' ';
      spans.push([text.length, text.length + w.text.length, w]);
      text += w.text;
    }
    const matches: { type: PiiType; start: number; end: number; conf: number; rule: string; value: string }[] = scanText(text, { context: prevText });
    for (const kv of known) {
      for (const re of knownRegexes(kv.type, kv.value)) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) matches.push({ type: kv.type, start: m.index, end: m.index + m[0].length, conf: 0.9, rule: 'known-value', value: kv.value });
      }
    }
    // A line under a "Name" / "Address" / "DOB" label is that kind of value.
    const labelType = prevText.length <= 30 ? fieldType({ label: prevText }) : null;
    // (OCR misreads such as "lyer" for "Iyer" would otherwise leave half a name showing.)
    if (labelType && ['NAME', 'ADDRESS', 'DOB'].includes(labelType) && !fieldType({ label: text })) {
      // Only the words in the label's column, not text that happens to share the baseline.
      const col = spans.filter(([, , w]) => w.bbox.x0 >= prevX0 - 12 * up);
      if (col.length) matches.push({ type: labelType, start: col[0][0], end: col[col.length - 1][1], conf: 0.75, rule: 'ocr-label', value: text.slice(col[0][0], col[col.length - 1][1]) });
    }
    for (const m of matches) {
      // A name hit swallows the next capitalised word or two ("Ananya" + OCR's "lyer" for "Iyer").
      if (m.type === 'NAME') {
        let i = spans.findIndex(([s, e]) => s < m.end && m.end <= e);
        for (let n = 0; n < 2 && i >= 0 && i + 1 < spans.length && /^[A-Zl][a-z]{1,15}[.,]?$/.test(spans[i + 1][2].text); n++) m.end = spans[++i][1];
      }
      const ws = spans.filter(([s, e]) => s < m.end && m.start < e).map(([, , w]) => w);
      if (!ws.length) continue;
      const x0 = Math.min(...ws.map((w) => w.bbox.x0)), y0 = Math.min(...ws.map((w) => w.bbox.y0));
      const x1 = Math.max(...ws.map((w) => w.bbox.x1)), y1 = Math.max(...ws.map((w) => w.bbox.y1));
      const a = toCss(x0 - 2, y0 - 2), b = toCss(x1 + 2, y1 + 2);
      const ocrConf = Math.min(...ws.map((w) => w.confidence)) / 100;
      out.push({ type: m.type, value: m.value, rects: [{ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }], pass: 'pixel', conf: Math.min(m.conf, 0.5 + ocrConf / 2), rule: `ocr:${m.rule}` });
    }
    prevText = text;
    prevX0 = Math.min(...words.map((w) => w.bbox.x0));
  }
  return out;
}
