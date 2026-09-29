// node debug-findings.mjs <page> [scrollY] : list every finding with its pass and rule.
import { launch } from './lib.mjs';
const [page = 'bank.html', y = '0'] = process.argv.slice(2);
const { ctx, panel, open } = await launch();
const { tab } = await open(page);
if (process.env.TWICE) { await panel.evaluate(() => window.parda.observe('(first)')); }
await tab.evaluate((y) => scrollTo(0, y), Number(y));
await panel.waitForTimeout(300);
const fs = await panel.evaluate(async () => (await window.parda.observe('(debug)')).findings.map((f) => `${f.token.padEnd(12)} ${f.pass.padEnd(9)} ${f.rule.padEnd(22)} ${f.rects.map((r) => `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}]`).join(' ')}  ${JSON.stringify(f.value.slice(0, 30))}`));
console.log(fs.join('\n'));
await ctx.close();
