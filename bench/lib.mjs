// Shared harness: launch Chromium with the built extension and pin the agent to a testbed tab.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SERVER = process.env.FOURCE_SERVER ?? 'http://127.0.0.1:8765';
const EXT = resolve(import.meta.dirname, '../extension/.output/chrome-mv3');

export async function launch() {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), '4ce-')), {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const panel = await ctx.newPage();
  panel.on('console', (m) => m.type() === 'error' && console.log('[panel]', m.text()));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForFunction(() => !!window.fource);

  const persona = await (await fetch(`${SERVER}/testbed/persona.json`)).json();
  const canaries = (await (await fetch(`${SERVER}/testbed/canaries.json`)).json()).values;
  const profile = Object.fromEntries(
    ['NAME', 'EMAIL', 'PHONE', 'DOB', 'ADDRESS', 'PINCODE', 'AADHAAR', 'PAN', 'ACCOUNT', 'IFSC', 'UPI'].map((k) => [k, persona.profile[k]]),
  );

  /** Open `page` in its own window (so captureVisibleTab sees it) and pin the agent to it. */
  async function open(page) {
    const target = await panel.evaluate(async (url) => {
      const w = await chrome.windows.create({ url, focused: true, width: 1280, height: 860 });
      return { tabId: w.tabs[0].id, windowId: w.id };
    }, `${SERVER}/testbed/${page}`);
    await panel.evaluate(async ({ target, profile, canaries, server }) => {
      const a = window.fource;
      a.reset();
      a.pinned = target;
      await chrome.storage.local.set({ profile });
      a.loadProfile(profile);
      a.settings.canaries = canaries;
      a.settings.serverUrl = server;
      for (let i = 0; i < 50; i++) {
        if ((await chrome.tabs.get(target.tabId)).status === 'complete') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }, { target, profile, canaries, server: SERVER });
    await panel.waitForTimeout(500);
    const tab = ctx.pages().find((p) => p.url().endsWith(`/testbed/${page}`));
    return { target, tab };
  }
  return { ctx, panel, open, profile, canaries };
}
