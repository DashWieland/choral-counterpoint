// Batch validation of engine.js (the working copy of the next edition):
// compose pieces No. 1..200, demand every one violation-free, report stats.
// Then check that frozen Edition 1 (engine-ed1.js) still plays its pieces
// 1..200 (golden-ed1.json; golden.mjs checks 20,000), and say whether
// engine.js still plays Edition 1's pieces.
import { readFileSync } from 'node:fs';
import { composePiece, checkChorale } from './engine.js';
import { digestOf, digestOfDigests, rangeDigest } from './golden.mjs';

const t0 = Date.now();
let ok = 0, failed = 0, chrom = 0, warnings = 0, ornaments = 0, slots = 0;
const keys = {};
const intervals = {};
const digests = [];
const mod12 = x => ((x % 12) + 12) % 12;
let firstDraft = 0, drafts = 0;
for (let n = 1; n <= 200; n++) {
  const p = composePiece(n);
  digests.push(digestOf(p));
  if (!p) { failed++; console.log(`No. ${n}: FAILED to compose`); continue; }
  if (p.violations !== 0) { failed++; console.log(`No. ${n}: violations!`); continue; }
  // properties the engine review found missing in Edition 1
  const sk = p.skeleton, last = sk.s.length - 1;
  const broken = [];
  if (['s', 'a', 't', 'b'].some(v => sk[v].some(m => !Number.isInteger(m)))) broken.push('a note is not a pitch');
  if (mod12(sk.s[last] - p.tonicPc) || mod12(sk.b[last] - p.tonicPc)) broken.push('does not end on the tonic');
  if (sk.s.some(m => m < 60 || m > 81)) broken.push('soprano out of range');
  if (broken.length) { failed++; console.log(`No. ${n}: ${broken.join('; ')}`); continue; }
  drafts += p.attempt + 1;
  if (p.attempt === 0) firstDraft++;
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
// census: Edition 2 keeps the first draft at ~97.7% of addresses (lab, 1..20,000)
const firstShare = firstDraft / Math.max(ok, 1);
console.log(`census: first draft kept at ${(100 * firstShare).toFixed(1)}% of addresses, ` +
            `${(drafts / Math.max(ok, 1)).toFixed(2)} drafts per piece`);
if (firstShare < 0.9) { console.log('CENSUS FAILED: fewer than 90% of addresses keep their first draft'); process.exitCode = 1; }
if (failed) process.exitCode = 1;
console.log(`avg warnings ${(warnings/ok).toFixed(2)} | chromatic voice-lines ${chrom} | ` +
            `${(ornaments/ok).toFixed(1)} ornaments/piece (${slots/ok|0} slots avg)`);
const tot = Object.values(intervals).reduce((a,b)=>a+b,0);
const top = Object.entries(intervals).sort((a,b)=>b[1]-a[1]).slice(0,5)
  .map(([iv,c])=>`${iv}:${Math.round(100*c/tot)}%`).join(' ');
console.log(`soprano intervals: ${top}`);
console.log('keys:', Object.entries(keys).map(([k,c])=>`${k}×${c}`).join(' '));

const golden = JSON.parse(readFileSync(new URL('./golden-ed1.json', import.meta.url), 'utf8'));
if (rangeDigest(1, 200) === golden.first200) console.log('Edition 1 (engine-ed1.js): pieces 1..200 unchanged');
else { console.log('EDITION 1 CHANGED: pieces 1..200 differ from golden-ed1.json'); process.exitCode = 1; }
console.log(digestOfDigests(digests) === golden.first200
  ? 'engine.js still plays Edition 1 (pieces 1..200)'
  : 'engine.js plays different pieces from Edition 1 (expected once the next edition diverges)');
