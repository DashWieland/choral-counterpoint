// Genuinely different settings of one tune: widen the bass beam to 60, keep
// every complete line that harmonizes and passes the checker, then pick the
// best line plus the two lines most different from what is already chosen
// (bass pitch classes that differ), trading score for difference.
// Usage: node --no-warnings diverse.mjs [N=300] [exampleNo]
import { composePieceLab, withLabFlags, melody, bassLine, harmonizeExact, mulberry32 } from './engine.lab.mjs';
import { checkChorale } from './shipped.mjs';
import { writeMidi } from './midi.mjs';
import { mkdirSync } from 'node:fs';
const N = Number(process.argv[2] || 300), EX = Number(process.argv[3] || 0);
const FLAGS = { sbParallel: true, bassAug2: true, seamFix: true, formulaFit: true, register: true, tonicEnd: true };
const mod12 = x => ((x % 12) + 12) % 12;
let tunes = 0, withThree = 0, dB = 0, dC = 0, pairs = 0;
for (let n = 1; n <= N; n++) {
  const p = composePieceLab(n, FLAGS);
  if (!p) continue;
  const { tonicPc, mode } = p;
  const rng = mulberry32(n * 1000 + p.attempt * 7 + 13);
  const { pitches: sop, fermatas } = withLabFlags(FLAGS, () => melody(tonicPc, mode, p.phrases, rng));
  const basses = withLabFlags({ ...FLAGS, _allBeams: true },
    () => bassLine(sop, fermatas, tonicPc, mode, rng, 60, 0.15 * p.attempt)) || [];
  const valid = [];
  for (const bass of basses) {
    const inner = harmonizeExact(sop, bass, fermatas, tonicPc, mode);
    if (!inner) continue;
    const skel = { s: sop, a: inner.map(x => x[0]), t: inner.map(x => x[1]), b: bass };
    if (!checkChorale(skel, tonicPc, mode, fermatas).V.length) valid.push(skel);
  }
  if (!valid.length) continue;
  tunes++;
  const dist = (x, y) => x.b.reduce((d, m, i) => d + (mod12(m) !== mod12(y.b[i]) ? 1 : 0), 0);
  const chosen = [valid[0]];
  while (chosen.length < 3) {
    let best = null, bestD = -1;
    for (const v of valid) {
      const d = Math.min(...chosen.map(c => dist(v, c)));
      if (d > bestD) { bestD = d; best = v; }
    }
    if (!best || bestD === 0) break;
    chosen.push(best);
  }
  if (chosen.length === 3) {
    withThree++;
    for (let k = 1; k < 3; k++) {
      const L = sop.length;
      dB += dist(chosen[k], chosen[0]) / L;
      let dc = 0;
      for (let i = 0; i < L; i++) {
        const a = new Set(['s', 'a', 't', 'b'].map(v => mod12(chosen[0][v][i])));
        const b = new Set(['s', 'a', 't', 'b'].map(v => mod12(chosen[k][v][i])));
        if ([...a].some(x => !b.has(x)) || [...b].some(x => !a.has(x))) dc++;
      }
      dC += dc / L; pairs++;
    }
  }
  if (n === EX) {
    mkdirSync(new URL('../../docs/engine-review/examples/', import.meta.url), { recursive: true });
    chosen.forEach((skel, k) => {
      const events = {}; for (const v of ['s', 'a', 't', 'b']) events[v] = skel[v].map(m => [m, 2]);
      writeMidi(new URL(`../../docs/engine-review/examples/settings-${String(n).padStart(4, '0')}-${k + 1}.mid`, import.meta.url),
        { events, fermataEighths: fermatas.map(f => 2 * (f - 1)) });
    });
    const nm = m => ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'][mod12(m)] + (Math.floor(m / 12) - 1);
    console.log(`No. ${n} (${p.key}): tune ${sop.map(nm).join(' ')}`);
    chosen.forEach((c, k) => console.log(`  setting ${k + 1} bass: ${c.b.map(nm).join(' ')}`));
  }
}
console.log(`${tunes} tunes; ${(100 * withThree / tunes).toFixed(1)}% have three settings that differ; ` +
  `the two alternatives change the bass on ${(100 * dB / pairs).toFixed(0)}% of chords and the harmony on ${(100 * dC / pairs).toFixed(0)}%`);
