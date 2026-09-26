// How many different complete settings does one tune admit, using only the
// engine's own machinery? For each address's kept tune, take every bass line
// left in the width-10 beam, fill the inner voices exactly, gate with the
// checker, and count distinct passing four-voice settings. Usage:
//   node --no-warnings settings.mjs [N=1000] [exampleNo]
import { composePieceLab, withLabFlags, melody, bassLine, harmonizeExact, mulberry32 } from './engine.lab.mjs';
import { checkChorale } from './shipped.mjs';
import { writeMidi } from './midi.mjs';
import { mkdirSync } from 'node:fs';

const N = Number(process.argv[2] || 1000), EX = Number(process.argv[3] || 0);
const FLAGS = { sbParallel: true, bassAug2: true, seamFix: true, formulaFit: true, register: true, tonicEnd: true };
let tunes = 0, total = 0, many = 0, diffB = 0, diffC = 0, pairs = 0, bigB = 0;
const mod12 = x => ((x % 12) + 12) % 12;
const hist = {};
for (let n = 1; n <= N; n++) {
  const p = composePieceLab(n, FLAGS);
  if (!p) continue;
  const { tonicPc, mode } = p;
  const rng = mulberry32(n * 1000 + p.attempt * 7 + 13);
  const { pitches: sop, fermatas } = withLabFlags(FLAGS, () => melody(tonicPc, mode, p.phrases, rng));
  if (JSON.stringify(sop) !== JSON.stringify(p.skeleton.s)) throw new Error(`tune mismatch at ${n}`);
  const basses = withLabFlags({ ...FLAGS, _allBeams: true },
    () => bassLine(sop, fermatas, tonicPc, mode, rng, 10, 0.15 * p.attempt)) || [];
  const seen = new Set(), good = [];
  for (const bass of basses) {
    const inner = harmonizeExact(sop, bass, fermatas, tonicPc, mode);
    if (!inner) continue;
    const skel = { s: sop, a: inner.map(x => x[0]), t: inner.map(x => x[1]), b: bass };
    if (checkChorale(skel, tonicPc, mode, fermatas).V.length) continue;
    const key = JSON.stringify([skel.a, skel.t, skel.b]);
    if (!seen.has(key)) { seen.add(key); good.push(skel); }
  }
  for (let k = 1; k < good.length; k++) {
    const L = sop.length; let db = 0, dc = 0;
    for (let i = 0; i < L; i++) {
      if (mod12(good[k].b[i]) !== mod12(good[0].b[i])) db++;
      const c0 = new Set(['s','a','t','b'].map(v => mod12(good[0][v][i]))), ck = new Set(['s','a','t','b'].map(v => mod12(good[k][v][i])));
      if ([...c0].some(x => !ck.has(x)) || [...ck].some(x => !c0.has(x))) dc++;
    }
    diffB += db / L; diffC += dc / L; pairs++; if (db / L >= 0.3) bigB++;
  }
  tunes++; total += good.length; hist[good.length] = (hist[good.length] || 0) + 1;
  if (good.length >= 3) many++;
  if (n === EX) {
    mkdirSync(new URL('../../docs/engine-review/examples/', import.meta.url), { recursive: true });
    good.slice(0, 3).forEach((skel, k) => {
      const events = {}; for (const v of ['s', 'a', 't', 'b']) events[v] = skel[v].map(m => [m, 2]);
      writeMidi(new URL(`../../docs/engine-review/examples/settings-${String(n).padStart(4, '0')}-${k + 1}.mid`, import.meta.url),
        { events, fermataEighths: fermatas.map(f => 2 * (f - 1)) });
    });
    console.log(`No. ${n} (${p.key}, ${sop.length} chords): wrote ${Math.min(3, good.length)} of ${good.length} settings`);
  }
}
console.log(`${tunes} tunes: mean ${(total / tunes).toFixed(2)} distinct valid settings from the beam's bass lines; ` +
  `${(100 * many / tunes).toFixed(1)}% have 3 or more; histogram ${JSON.stringify(hist)}`);
console.log(`vs the best setting, an alternative changes the bass pitch class on ${(100 * diffB / pairs).toFixed(0)}% of chords and the harmony on ${(100 * diffC / pairs).toFixed(0)}% on average; ${(100 * bigB / pairs).toFixed(0)}% of alternatives change 30%+ of the bass`);
