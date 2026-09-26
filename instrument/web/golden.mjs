// Edition 1 golden test: piece No. N must never change (?piece=N links exist
// in the wild). golden-ed1.json holds SHA-256 digests of composePiece(n) for
// pieces 1..10 one by one, pieces 1..200 as one digest (test_engine.mjs checks
// that on every run), and 1..20,000 in blocks of 1,000.
//
//   node golden.mjs             check all 20,000 (a few minutes)
//   node golden.mjs 2000        check only the blocks inside 1..2,000
//   node golden.mjs --write     record the digests (only when founding an edition)
//
// A failing block names its range; bisect it with pieceDigest(n).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { composePiece } from './engine.js';

const FILE = new URL('./golden-ed1.json', import.meta.url);
const BLOCK = 1000, TOTAL = 20000;

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

// the identity of a composed piece: what the machine plays and shows
export const digestOf = p =>
  sha(p ? JSON.stringify([p.key, p.phrases, p.fermataEighths, p.events]) : 'null');

export const pieceDigest = n => digestOf(composePiece(n));

// digest of a run of consecutive piece digests (what golden-ed1.json stores)
export const digestOfDigests = ds => {
  const h = createHash('sha256');
  for (const d of ds) h.update(d);
  return h.digest('hex').slice(0, 16);
};

export function rangeDigest(from, to) {
  const ds = [];
  for (let n = from; n <= to; n++) ds.push(pieceDigest(n));
  return digestOfDigests(ds);
}

if ((process.argv[1] || '').endsWith('golden.mjs')) {
  const write = process.argv.includes('--write');
  const limit = Number(process.argv.find(a => /^\d+$/.test(a)) || TOTAL);
  if (write) {
    const pieces = {};
    for (let n = 1; n <= 10; n++) pieces[n] = pieceDigest(n);
    const blocks = [];
    for (let from = 1; from <= TOTAL; from += BLOCK)
      blocks.push({ from, to: from + BLOCK - 1, digest: rangeDigest(from, from + BLOCK - 1) });
    writeFileSync(FILE, JSON.stringify({
      edition: 1,
      note: 'composePiece(n) of instrument/web/engine.js. Never rewrite this file to make a test pass: a mismatch means ?piece=N links now play different music.',
      pieces, first200: rangeDigest(1, 200), blocks,
    }, null, 1) + '\n');
    console.log(`wrote ${FILE.pathname}`);
  } else {
    const g = JSON.parse(readFileSync(FILE, 'utf8'));
    let bad = 0;
    for (let n = 1; n <= 10; n++)
      if (pieceDigest(n) !== g.pieces[n]) { bad++; console.log(`No. ${n} changed`); }
    for (const b of g.blocks) {
      if (b.to > limit) break;
      if (rangeDigest(b.from, b.to) !== b.digest) { bad++; console.log(`pieces ${b.from}..${b.to} changed`); }
    }
    const checked = Math.min(limit, TOTAL);
    console.log(bad ? `EDITION 1 CHANGED: ${bad} mismatch(es)` : `Edition 1 intact: pieces 1..${checked} unchanged`);
    process.exit(bad ? 1 : 0);
  }
}
