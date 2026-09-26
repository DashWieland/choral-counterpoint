// Measure one flag set over addresses 1..N in parallel and write
// results/<name>.json. Usage:
//   node --no-warnings run.mjs <name> [flag,flag,...] [N=20000] [workers=20]
// Flags: those listed in engine.lab.mjs, plus barform (the bar-form planner)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';

const mod12 = x => ((x % 12) + 12) % 12;
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
// warning text without chord numbers, e.g. "s out of range", "direct fifths"
const wkey = w => w.replace(/chord \d+: /, '').replace(/\s*\([^)]*\)/g, '').replace(/\d+/g, '#').trim();

if (isMainThread) {
  const [name, flagStr = '', Nstr = '20000', Wstr = '20'] = process.argv.slice(2);
  const flags = {}; for (const f of flagStr.split(',').filter(Boolean)) flags[f] = true;
  const N = Number(Nstr), W = Number(Wstr);
  const chunk = Math.ceil(N / W);
  const t0 = Date.now();
  const parts = await Promise.all(Array.from({ length: W }, (_, w) => new Promise((res, rej) => {
    const lo = 1 + w * chunk, hi = Math.min(N, (w + 1) * chunk);
    if (lo > hi) return res(null);
    const wk = new Worker(new URL(import.meta.url), { workerData: { lo, hi, flags } });
    wk.on('message', res); wk.on('error', rej);
  })));
  const agg = { name, flags: Object.keys(flags), N, nulls: 0, drafts: 0, firstDraft: 0,
    stages: {}, maxDrafts: 0, maxAt: 0, warnPieces: 0, warnings: {}, lastNotTonic: 0,
    sopRange: 0, byKey: {}, undef: 0, bassTryUsed: 0, tunesDiscarded: 0, firstTune: 0, lastBassNotTonic: 0 };
  const hashes = new Array(N).fill(0);
  for (const p of parts.filter(Boolean)) {
    for (const k of ['nulls', 'drafts', 'firstDraft', 'warnPieces', 'lastNotTonic', 'sopRange', 'undef', 'bassTryUsed', 'tunesDiscarded', 'firstTune', 'lastBassNotTonic'])
      agg[k] += p[k];
    for (const [k, v] of Object.entries(p.stages)) agg.stages[k] = (agg.stages[k] || 0) + v;
    for (const [k, v] of Object.entries(p.warnings)) agg.warnings[k] = (agg.warnings[k] || 0) + v;
    for (const [k, v] of Object.entries(p.byKey)) {
      const b = agg.byKey[k] || (agg.byKey[k] = { pieces: 0, drafts: 0 });
      b.pieces += v.pieces; b.drafts += v.drafts;
    }
    if (p.maxDrafts > agg.maxDrafts) { agg.maxDrafts = p.maxDrafts; agg.maxAt = p.maxAt; }
    p.hashes.forEach((h, i) => { hashes[p.lo - 1 + i] = h; });
  }
  agg.meanDrafts = +(agg.drafts / N).toFixed(4);
  agg.firstDraftShare = +(agg.firstDraft / N).toFixed(4);
  agg.meanTunesDiscarded = +(agg.tunesDiscarded / N).toFixed(4);
  agg.firstTuneShare = +(agg.firstTune / N).toFixed(4);
  agg.wallSeconds = (Date.now() - t0) / 1000;
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`./results/${name}.json`, import.meta.url), JSON.stringify({ ...agg, hashes }));
  const top = Object.entries(agg.stages).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${name}: tunes thrown away/address ${agg.meanTunesDiscarded}, first tune kept ${(100 * agg.firstTuneShare).toFixed(1)}%, mean drafts ${agg.meanDrafts}, ` +
    `nulls ${agg.nulls}, max ${agg.maxDrafts} (No. ${agg.maxAt}) | stages: ${top} | ` +
    `soprano not ending on tonic ${agg.lastNotTonic}, bass not ending on tonic ${agg.lastBassNotTonic}, soprano-range pieces ${agg.sopRange}, warned pieces ${agg.warnPieces} | ${agg.wallSeconds}s`);
} else {
  const { composePieceLab } = await import('./engine.lab.mjs');
  const { lo, hi, flags } = workerData;
  // functions can't cross into a worker: 'barform' names the bar-form planner
  if (flags.barform) flags.melodyFn = (await import('./barform.mjs')).barformMelody;
  const r = { lo, nulls: 0, drafts: 0, firstDraft: 0, stages: {}, maxDrafts: 0, maxAt: 0,
    warnPieces: 0, warnings: {}, lastNotTonic: 0, sopRange: 0, byKey: {}, undef: 0, bassTryUsed: 0, hashes: [], tunesDiscarded: 0, firstTune: 0, lastBassNotTonic: 0 };
  for (let n = lo; n <= hi; n++) {
    const trace = [];
    const p = composePieceLab(n, flags, trace);
    for (const t of trace) { r.stages[t.stage] = (r.stages[t.stage] || 0) + 1; if (t.undef) r.undef++; }
    const drafts = trace.length;
    r.drafts += drafts;
    if (drafts === 1) r.firstDraft++;
    if (drafts > r.maxDrafts) { r.maxDrafts = drafts; r.maxAt = n; }
    if (!p) { r.nulls++; r.hashes.push(0); continue; }
    if (p.bassTry > 0) r.bassTryUsed++;
    r.tunesDiscarded += p.attempt;
    if (p.attempt === 0) r.firstTune++;
    if (mod12(p.skeleton.b[p.skeleton.b.length - 1] - p.tonicPc) !== 0) r.lastBassNotTonic++;
    const key = p.key;
    const b = r.byKey[key] || (r.byKey[key] = { pieces: 0, drafts: 0 });
    b.pieces++; b.drafts += drafts;
    if (p.W.length) r.warnPieces++;
    const seen = new Set();
    for (const w of p.W) { const k = wkey(w); if (!seen.has(k)) { seen.add(k); r.warnings[k] = (r.warnings[k] || 0) + 1; } }
    if (p.W.some(w => /s out of range/.test(w))) r.sopRange++;
    if (mod12(p.skeleton.s[p.skeleton.s.length - 1] - p.tonicPc) !== 0) r.lastNotTonic++;
    r.hashes.push(fnv(key + JSON.stringify(p.events)));
  }
  parentPort.postMessage(r);
}
