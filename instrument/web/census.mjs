// The census of an engine: compose a range of addresses in parallel and report
// what a listener would meet there. This is the gate for an edition's
// changes that can't be matched against the lab (such as its seeding).
//
//   node census.mjs [from=1] [to=20000] [workers=16] [engine=./engine.js]
//   node census.mjs sample [count=2000] [workers=16]    random addresses up to 2^53
//
// Reports: addresses that keep their first draft, drafts per address, empty
// addresses, pieces that don't end on the tonic, soprano notes out of range,
// and warnings per piece.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mod12 = x => ((x % 12) + 12) % 12;

if (isMainThread) {
  const args = process.argv.slice(2);
  const sample = args[0] === 'sample';
  let addresses;
  if (sample) {
    // deterministic spread over the whole shelf: 2^53 * (k + 0.5) / count, jittered by a hash
    const count = Number(args[1] || 2000);
    addresses = Array.from({ length: count }, (_, k) =>
      Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(2 ** (53 * (k + 0.5) / count)))));
  } else {
    const from = Number(args[0] || 1), to = Number(args[1] || 20000);
    addresses = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const W = Number(args[2] || 16);
  const engine = args[3] ? pathToFileURL(resolve(args[3])).href
    : new URL('./engine.js', import.meta.url).href;
  const chunk = Math.ceil(addresses.length / W);
  const parts = await Promise.all(Array.from({ length: W }, (_, w) => new Promise((res, rej) => {
    const list = addresses.slice(w * chunk, (w + 1) * chunk);
    if (!list.length) return res(null);
    const wk = new Worker(new URL(import.meta.url), { workerData: { list, engine } });
    wk.on('message', res); wk.on('error', rej);
  })));
  const t = { n: 0, nulls: 0, first: 0, drafts: 0, offTonic: 0, sopRange: 0, warnings: 0 };
  for (const p of parts.filter(Boolean)) for (const k of Object.keys(t)) t[k] += p[k];
  const kept = t.n - t.nulls;
  console.log(`${sample ? `${t.n} addresses spread up to 2^53` : `No. ${addresses[0]}..${addresses[addresses.length - 1]}`}: ` +
    `first draft kept ${(100 * t.first / kept).toFixed(1)}%, ${(t.drafts / kept).toFixed(3)} drafts per address, ` +
    `${t.nulls} empty, ${t.offTonic} off the tonic, ${t.sopRange} with the soprano out of range, ` +
    `${(t.warnings / kept).toFixed(2)} warnings per piece`);
} else {
  const { composePiece } = await import(workerData.engine);
  const r = { n: 0, nulls: 0, first: 0, drafts: 0, offTonic: 0, sopRange: 0, warnings: 0 };
  for (const n of workerData.list) {
    r.n++;
    const p = composePiece(n);
    if (!p) { r.nulls++; continue; }
    r.drafts += p.attempt + 1;
    if (p.attempt === 0) r.first++;
    const s = p.skeleton, L = s.s.length - 1;
    if (mod12(s.s[L] - p.tonicPc) || mod12(s.b[L] - p.tonicPc)) r.offTonic++;
    if (s.s.some(m => m < 60 || m > 81)) r.sopRange++;
    r.warnings += p.warnings;
  }
  parentPort.postMessage(r);
}
