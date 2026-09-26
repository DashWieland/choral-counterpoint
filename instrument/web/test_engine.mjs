// Batch validation of engine.js (the working copy of the next edition):
// compose pieces No. 1..200, demand every one violation-free and in bar form
// (the Stollen sung twice note for note, ornaments included; phrases of a
// hymn meter's 6 to 8 notes; one climax; the plate's count right), report stats.
// Then check that every frozen edition (engine-ed1.js, engine-ed2.js) still
// plays its pieces 1..200 (golden-edN.json; golden.mjs checks 20,000), and
// say whether engine.js still plays the latest edition's pieces.
import { readFileSync } from 'node:fs';
import { composePiece, checkChorale } from './engine.js';
import { FROZEN, digestOf, digestOfDigests, rangeDigest } from './golden.mjs';

const t0 = Date.now();
let ok = 0, failed = 0, chrom = 0, warnings = 0, ornaments = 0, slots = 0;
const keys = {};
const intervals = {};
const digests = [];
const mod12 = x => ((x % 12) + 12) % 12;
// a voice's sounding pitch at every eighth
const grid = evs => evs.flatMap(([m, ln]) => Array(ln).fill(m));
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
  // bar form
  const L = p.form.stollenChords;
  const ends = p.fermataEighths.map(e => e / 2 + 1);           // phrase-final chords, 1-based
  const lens = ends.map((f, i) => f - (i ? ends[i - 1] : 0));
  if (p.phrases !== ends.length || p.form.labels.length !== ends.length) broken.push('the plate miscounts the phrases');
  if (lens.some(l => l < 6 || l > 8)) broken.push(`a phrase outside the hymn meters (${lens.join(' ')})`);
  if (!ends.includes(L) || !ends.includes(2 * L)) broken.push('the Stollen does not end on a phrase');
  if (['s', 'a', 't', 'b'].some(v => sk[v].slice(0, L).join() !== sk[v].slice(L, 2 * L).join()))
    broken.push('the repeat is not the Stollen chord for chord');
  if (['s', 'a', 't', 'b'].some(v => { const g = grid(p.events[v]); return g.slice(0, 2 * L).join() !== g.slice(2 * L, 4 * L).join(); }))
    broken.push('the repeat is not the Stollen ornament for ornament');
  const top = Math.max(...sk.s);
  if (sk.s.filter(m => m === top).length !== 1) broken.push('the climax sounds more than once');
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
// census: Edition 2 keeps the first draft at 96.9% of addresses 1..20,000 (census.mjs)
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

const golden = ed => JSON.parse(readFileSync(new URL(`./golden-ed${ed}.json`, import.meta.url), 'utf8'));
const editions = Object.keys(FROZEN).map(Number), latest = Math.max(...editions);
for (const ed of editions) {
  if (rangeDigest(1, 200, ed) === golden(ed).first200) console.log(`Edition ${ed} (engine-ed${ed}.js): pieces 1..200 unchanged`);
  else { console.log(`EDITION ${ed} CHANGED: pieces 1..200 differ from golden-ed${ed}.json`); process.exitCode = 1; }
}
console.log(digestOfDigests(digests) === golden(latest).first200
  ? `engine.js still plays Edition ${latest} (pieces 1..200)`
  : `engine.js plays different pieces from Edition ${latest} (expected once the next edition diverges)`);
