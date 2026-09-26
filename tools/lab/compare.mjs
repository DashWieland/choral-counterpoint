// Renumbering impact and per-key difficulty, from results/*.json.
import { readFileSync, readdirSync } from 'node:fs';
const dir = new URL('./results/', import.meta.url);
const load = n => JSON.parse(readFileSync(new URL(`${n}.json`, dir), 'utf8'));
const base = load('baseline');
const names = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
for (const n of names) {
  const r = load(n);
  let changed = 0;
  for (let i = 0; i < base.hashes.length; i++) if (r.hashes[i] !== base.hashes[i]) changed++;
  console.log(`${n.padEnd(18)} changes ${(100 * changed / base.hashes.length).toFixed(1).padStart(5)}% of pieces 1..${base.N}`);
}
const perTonic = r => {
  const t = {};
  for (const [k, v] of Object.entries(r.byKey)) {
    const tonic = k.split(' ')[0];
    const x = t[tonic] || (t[tonic] = { p: 0, d: 0 }); x.p += v.pieces; x.d += v.drafts;
  }
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, (v.d / v.p).toFixed(2)]));
};
console.log('drafts per piece by tonic, baseline :', JSON.stringify(perTonic(base)));
for (const n of ['register', 'cheapReg3', 'recommended'])
  try { console.log(`drafts per piece by tonic, ${n.padEnd(9)}:`, JSON.stringify(perTonic(load(n)))); } catch {}
