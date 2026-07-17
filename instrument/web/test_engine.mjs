// Batch validation of the JS engine port: compose pieces No. 1..200,
// demand every one violation-free, report stats.
import { composePiece, checkChorale } from './engine.js';

const t0 = Date.now();
let ok = 0, failed = 0, chrom = 0, warnings = 0, ornaments = 0, slots = 0;
const keys = {};
const intervals = {};
for (let n = 1; n <= 200; n++) {
  const p = composePiece(n);
  if (!p) { failed++; console.log(`No. ${n}: FAILED to compose`); continue; }
  if (p.violations !== 0) { failed++; console.log(`No. ${n}: violations!`); continue; }
  ok++;
  warnings += p.warnings;
  keys[p.key] = (keys[p.key] || 0) + 1;
  const scale = new Set((p.mode === 'major' ? [0,2,4,5,7,9,11] : [0,2,3,5,7,8,10,11])
    .map(d => (d + p.tonicPc) % 12));
  for (const vn of ['s','a','t','b']) {
    for (const m of p.skeleton[vn]) if (!scale.has(((m % 12) + 12) % 12)) { chrom++; break; }
  }
  const nEv = Object.values(p.events).reduce((a, v) => a + v.length, 0);
  ornaments += nEv - 4 * p.skeleton.s.length;
  slots += p.skeleton.s.length;
  const sop = p.skeleton.s;
  for (let i = 1; i < sop.length; i++) {
    const iv = Math.max(-7, Math.min(7, sop[i] - sop[i-1]));
    intervals[iv] = (intervals[iv] || 0) + 1;
  }
  // determinism: recomposing the same number must give the identical piece
  if (n <= 5) {
    const q = composePiece(n);
    if (JSON.stringify(q.events) !== JSON.stringify(p.events))
      console.log(`No. ${n}: NOT DETERMINISTIC`);
  }
}
const ms = (Date.now() - t0) / 200;
console.log(`\n${ok}/200 clean, ${failed} failed | ${ms.toFixed(1)} ms/piece`);
console.log(`avg warnings ${(warnings/ok).toFixed(2)} | chromatic voice-lines ${chrom} | ` +
            `${(ornaments/ok).toFixed(1)} ornaments/piece (${slots/ok|0} slots avg)`);
const tot = Object.values(intervals).reduce((a,b)=>a+b,0);
const top = Object.entries(intervals).sort((a,b)=>b[1]-a[1]).slice(0,5)
  .map(([iv,c])=>`${iv}:${Math.round(100*c/tot)}%`).join(' ');
console.log(`soprano intervals: ${top}`);
console.log('keys:', Object.entries(keys).map(([k,c])=>`${k}×${c}`).join(' '));
