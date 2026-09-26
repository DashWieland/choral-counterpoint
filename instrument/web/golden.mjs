// Golden test: within an edition, piece No. N must never change (?piece=N
// links exist in the wild). golden-edN.json holds SHA-256 digests of the
// frozen engine-edN.js's composePiece(n) for pieces 1..10 one by one,
// pieces 1..200 as one digest (test_engine.mjs checks that on every run),
// and 1..20,000 in blocks of 1,000.
//
//   node golden.mjs                        check every frozen edition (minutes)
//   node golden.mjs 2000                   check only the blocks inside 1..2,000
//   node golden.mjs --edition 2            check one edition
//   node golden.mjs --edition 3 --write    record a new edition's digests, once
//
// A failing block names its range; bisect it with pieceDigest(n, edition).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { composePiece as ed1 } from './engine-ed1.js';
import { composePiece as ed2 } from './engine-ed2.js';

// the frozen editions (engine.js, the working copy, is none of them)
export const FROZEN = { 1: ed1, 2: ed2 };
const fileOf = edition => new URL(`./golden-ed${edition}.json`, import.meta.url);
const BLOCK = 1000, TOTAL = 20000;

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

// the identity of a composed piece: what the machine plays and shows
export const digestOf = p =>
  sha(p ? JSON.stringify([p.key, p.phrases, p.fermataEighths, p.events]) : 'null');

export const pieceDigest = (n, edition = 1) => digestOf(FROZEN[edition](n));

// digest of a run of consecutive piece digests (what golden-edN.json stores)
export const digestOfDigests = ds => {
  const h = createHash('sha256');
  for (const d of ds) h.update(d);
  return h.digest('hex').slice(0, 16);
};

export function rangeDigest(from, to, edition = 1) {
  const ds = [];
  for (let n = from; n <= to; n++) ds.push(pieceDigest(n, edition));
  return digestOfDigests(ds);
}

if ((process.argv[1] || '').endsWith('golden.mjs')) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const at = args.indexOf('--edition');
  const only = at >= 0 ? Number(args[at + 1]) : null;
  const limit = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--edition') || TOTAL);
  if (write) {
    // an edition's digests are written once, when it is founded; a mismatch
    // later means ?piece=N links now play different music
    if (!FROZEN[only]) { console.log('--write needs --edition N of a frozen edition'); process.exit(1); }
    if (existsSync(fileOf(only))) { console.log(`golden-ed${only}.json exists: never rewrite it`); process.exit(1); }
    const pieces = {};
    for (let n = 1; n <= 10; n++) pieces[n] = pieceDigest(n, only);
    const blocks = [];
    for (let from = 1; from <= TOTAL; from += BLOCK)
      blocks.push({ from, to: from + BLOCK - 1, digest: rangeDigest(from, from + BLOCK - 1, only) });
    writeFileSync(fileOf(only), JSON.stringify({
      edition: only,
      note: `composePiece(n) of instrument/web/engine-ed${only}.js. Never rewrite this file to make a test pass: a mismatch means ?piece=N&ed=${only} links now play different music.`,
      pieces, first200: rangeDigest(1, 200, only), blocks,
    }, null, 1) + '\n');
    console.log(`wrote golden-ed${only}.json`);
  } else {
    let bad = 0;
    for (const edition of only ? [only] : Object.keys(FROZEN).map(Number)) {
      const g = JSON.parse(readFileSync(fileOf(edition), 'utf8'));
      let miss = 0;
      for (let n = 1; n <= 10; n++)
        if (pieceDigest(n, edition) !== g.pieces[n]) { miss++; console.log(`Edition ${edition}, No. ${n} changed`); }
      for (const b of g.blocks) {
        if (b.to > limit) break;
        if (rangeDigest(b.from, b.to, edition) !== b.digest) { miss++; console.log(`Edition ${edition}, pieces ${b.from}..${b.to} changed`); }
      }
      console.log(miss ? `EDITION ${edition} CHANGED: ${miss} mismatch(es)`
        : `Edition ${edition} intact: pieces 1..${Math.min(limit, TOTAL)} unchanged`);
      bad += miss;
    }
    process.exit(bad ? 1 : 0);
  }
}
