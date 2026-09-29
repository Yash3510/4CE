// Copies the WASM runtimes the side panel loads at run time into public/, so the
// extension never fetches code from a CDN (MV3 forbids remote code anyway).
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = (name) => join('node_modules', name);

mkdirSync('public/mediapipe', { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  cpSync(join(pkgDir('@mediapipe/tasks-vision'), 'wasm', f), join('public/mediapipe', f));
}

mkdirSync('public/tesseract/core', { recursive: true });
cpSync(join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'public/tesseract/worker.min.js');
const core = pkgDir('tesseract.js-core');
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  cpSync(join(core, f), join('public/tesseract/core', f));
}
console.log('copied mediapipe + tesseract runtimes into public/');
