// Where do the bass search's soprano/bass parallels come from? For each
// attempt's bass line (attempts 0..k of No. 1..N), classify every parallel
// 5th/8ve step by whether Bach's outer-voice table had a transition from the
// bass's previous pitch class for this soprano motion (else the search fell
// back to the 'arrivals' table, which ignores where the bass came from).
import { melody, bassLine, pairParallel, mulberry32, choice, KEYS, ORACLE } from './engine.lab.mjs';
const N = Number(process.argv[2] || 3000);
const mod12 = x => ((x % 12) + 12) % 12;
let lines = 0, withPar = 0, parSteps = 0, parFallback = 0, octaves = 0, stepsTotal = 0, stepsFallback = 0;
for (let n = 1; n <= N; n++) {
  const pr = mulberry32(n * 2654435761 + 1);
  const [, tonicPc] = choice(pr, KEYS);
  const mode = pr() < 0.45 ? 'minor' : 'major';
  const phrases = choice(pr, [2, 3, 3, 4]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const rng = mulberry32(n * 1000 + attempt * 7 + 13);
    const { pitches: sop, fermatas } = melody(tonicPc, mode, phrases, rng);
    if (sop.some(x => x === undefined)) continue;
    const bass = bassLine(sop, fermatas, tonicPc, mode, rng, 10, 0.15 * attempt);
    if (!bass) continue;
    lines++;
    const ferm = new Set(fermatas);
    let any = false;
    for (let i = 1; i < sop.length; i++) {
      const rel = m => mod12(m - tonicPc);
      const cad = ferm.has(i + 1) || i === sop.length - 1 ? 1 : 0;
      const table = ORACLE.transitions[`${mode}|${rel(sop[i - 1])}>${rel(sop[i])}|${cad}`] || {};
      const known = Object.keys(table).some(k => Number(k.split('>')[0]) === rel(bass[i - 1]));
      stepsTotal++; if (!known) stepsFallback++;
      if (pairParallel(sop[i - 1], bass[i - 1], sop[i], bass[i])) {
        any = true; parSteps++;
        if (!known) parFallback++;
        if (mod12(sop[i] - bass[i]) === 0) octaves++;
      }
    }
    if (any) withPar++;
  }
}
console.log(`${lines} bass lines; ${withPar} (${(100 * withPar / lines).toFixed(1)}%) contain a soprano/bass parallel; ` +
  `${parSteps} parallel steps, ${octaves} octaves; ${parFallback} of them (${(100 * parFallback / parSteps).toFixed(1)}%) ` +
  `where Bach's table had no move from that bass note; fallback steps overall ${(100 * stepsFallback / stepsTotal).toFixed(1)}%`);
