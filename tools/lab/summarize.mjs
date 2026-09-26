// Write results/summary.json: every run's aggregates without the per-address
// hashes (those stay local; compare.mjs needs them, so re-run run.mjs first).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('./results/', import.meta.url);
const out = {};
for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json').sort()) {
  const r = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  delete r.hashes;
  for (const [k, v] of Object.entries(r))          // other per-address arrays too
    if (Array.isArray(v) && v.length > 200) delete r[k];
  out[f.slice(0, -5)] = r;
}
writeFileSync(new URL('summary.json', dir), JSON.stringify(out, null, 1) + '\n');
console.log(`summary.json: ${Object.keys(out).length} runs`);
