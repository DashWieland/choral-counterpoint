// How do the shipped pieces end? Classify the final chord (bass degree +
// soprano degree) for No. 1..N.
import { composePiece } from './shipped.mjs';
const N = Number(process.argv[2] || 20000);
const mod12 = x => ((x % 12) + 12) % 12;
const name = { 0: 'I', 2: 'ii', 3: 'III(b3)', 4: 'I6/iii', 5: 'IV', 7: 'V', 8: 'VI', 9: 'vi', 10: 'bVII', 11: 'vii' };
const bassOff = {}, sopOffOnTonic = {};
let nBass = 0, nSop = 0, examples = {};
for (let n = 1; n <= N; n++) {
  const p = composePiece(n), s = p.skeleton, L = s.s.length - 1;
  const bd = mod12(s.b[L] - p.tonicPc), sd = mod12(s.s[L] - p.tonicPc);
  if (bd !== 0) {
    nBass++;
    const k = `bass on ${bd} (${name[bd] || bd}), ${p.mode}`;
    bassOff[k] = (bassOff[k] || 0) + 1;
    (examples[k] ||= []).length < 3 && examples[k].push(n);
  } else if (sd !== 0) {
    nSop++;
    const k = `tonic bass, soprano on ${sd}`;
    sopOffOnTonic[k] = (sopOffOnTonic[k] || 0) + 1;
  }
}
console.log(`No. 1..${N}: ${nBass} end with the bass off the tonic; ${nSop} more end on a tonic bass with the soprano off the tonic`);
for (const [k, v] of Object.entries(bassOff).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}  e.g. ${examples[k].join(', ')}`);
console.log(' ', JSON.stringify(sopOffOnTonic));
