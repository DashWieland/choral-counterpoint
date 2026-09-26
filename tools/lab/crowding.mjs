// Is the inner-voice squeeze the bass crowding the soprano? For every draft
// of the shipped engine at No. 1..N, find the closest soprano-bass distance
// in the draft and compare drafts whose inner voices failed with drafts that
// harmonized.
import { melody, bassLine, harmonize, mulberry32, choice, KEYS } from './engine.lab.mjs';
const N = Number(process.argv[2] || 3000);
const tally = { failed: {}, ok: {} };
const bucket = g => g <= 0 ? '<=0 (unison/crossed)' : g <= 3 ? '1-3' : g <= 7 ? '4-7' : g <= 12 ? '8-12' : '>12';
for (let n = 1; n <= N; n++) {
  const pr = mulberry32(n * 2654435761 + 1);
  const [, tonicPc] = choice(pr, KEYS);
  const mode = pr() < 0.45 ? 'minor' : 'major';
  const phrases = choice(pr, [2, 3, 3, 4]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = mulberry32(n * 1000 + attempt * 7 + 13);
    const { pitches: sop, fermatas } = melody(tonicPc, mode, phrases, rng);
    if (sop.some(x => x === undefined)) continue;
    const bass = bassLine(sop, fermatas, tonicPc, mode, rng, 10, 0.15 * attempt);
    if (!bass) continue;
    const gap = Math.min(...sop.map((s, i) => s - bass[i]));
    const inner = harmonize(sop, bass, fermatas, tonicPc, mode);
    const t = inner ? tally.ok : tally.failed;
    t[bucket(gap)] = (t[bucket(gap)] || 0) + 1;
    if (inner) break;                      // the shipped engine stops at the first harmonized draft (checker aside)
  }
}
for (const k of ['failed', 'ok']) {
  const tot = Object.values(tally[k]).reduce((a, b) => a + b, 0);
  console.log(`${k.padEnd(6)} (${tot}): ` + Object.entries(tally[k]).sort().map(([b, c]) => `${b}: ${(100 * c / tot).toFixed(1)}%`).join(', '));
}
