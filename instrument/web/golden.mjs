// Golden test: piece No. N must not change by accident (?piece=N links exist
// in the wild). golden.json holds SHA-256 digests of engine.js's
// composePiece(n) for pieces 1..10 one by one, pieces 1..200 as one digest
// (test_engine.mjs checks that on every run), and 1..20,000 in blocks of 1,000.
//
//   node golden.mjs                     check all 20,000 (several minutes)
//   node golden.mjs 2000                check only the blocks inside 1..2,000
//   node golden.mjs --write --replace   re-record, when the engine changes on purpose
//
// A failing block names its range; bisect it with pieceDigest(n).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { composePiece } from './engine.js';

const FILE = new URL('./golden.json', import.meta.url);
const BLOCK = 1000, TOTAL = 20000;

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

// the identity of a composed piece: what the machine plays and shows
export const digestOf = p =>
  sha(p ? JSON.stringify([p.key, p.phrases, p.fermataEighths, p.events]) : 'null');

export const pieceDigest = n => digestOf(composePiece(n));

// digest of a run of consecutive piece digests (what golden.json stores)
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
  const args = process.argv.slice(2);
  const limit = Number(args.find(a => /^\d+$/.test(a)) || TOTAL);
  if (args.includes('--write')) {
    // re-recording changes what every address is promised to play: only
    // when the engine changes on purpose, and only by asking for it
    if (existsSync(FILE) && !args.includes('--replace')) {
      console.log('golden.json exists: re-record it only on purpose, with --write --replace');
      process.exit(1);
    }
    const pieces = {};
    for (let n = 1; n <= 10; n++) pieces[n] = pieceDigest(n);
    const blocks = [];
    for (let from = 1; from <= TOTAL; from += BLOCK)
      blocks.push({ from, to: from + BLOCK - 1, digest: rangeDigest(from, from + BLOCK - 1) });
    writeFileSync(FILE, JSON.stringify({
      engine: 'instrument/web/engine.js',
      note: 'composePiece(n) of engine.js: the pieces the machine plays. Re-record only when the engine changes on purpose, in the same commit: node golden.mjs --write --replace. A mismatch otherwise means ?piece=N links now play different music.',
      pieces, first200: rangeDigest(1, 200), blocks,
    }, null, 1) + '\n');
    console.log('wrote golden.json');
  } else {
    const g = JSON.parse(readFileSync(FILE, 'utf8'));
    let bad = 0;
    for (let n = 1; n <= 10; n++)
      if (pieceDigest(n) !== g.pieces[n]) { bad++; console.log(`No. ${n} changed`); }
    for (const b of g.blocks) {
      if (b.to > limit) break;
      if (rangeDigest(b.from, b.to) !== b.digest) { bad++; console.log(`pieces ${b.from}..${b.to} changed`); }
    }
    console.log(bad ? `PIECES CHANGED: ${bad} mismatch(es)`
      : `engine.js intact: pieces 1..${Math.min(limit, TOTAL)} unchanged`);
    process.exit(bad ? 1 : 0);
  }
}
