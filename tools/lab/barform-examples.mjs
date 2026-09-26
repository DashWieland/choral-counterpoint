// Listening examples for the bar-form proposal: addresses 1-4, not picked.
//   node --no-warnings barform-examples.mjs [first=1] [last=4]
// Writes docs/engine-review/examples/shipped-NNNN.mid (the live engine's piece, exactly as
// the machine plays it), docs/engine-review/examples/barform-NNNN.mid (fix flags + the
// bar-form planner), both at 72 bpm, and docs/engine-review/examples/barform-sopranos.txt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { composePiece } from './shipped.mjs';
import { composePieceLab, mulberry32 } from './engine.lab.mjs';
import { barformMelody } from './barform.mjs';
import { writeMidi } from './midi.mjs';

const [first = 1, last = 4] = process.argv.slice(2).map(Number);
const FIXES = ['sbParallel', 'bassAug2', 'bassSpace', 'tonicEnd', 'formulaFit', 'seamFix', 'register', 'innerRules'];   // Edition 2's set
const flags = Object.fromEntries(FIXES.map(f => [f, true]));
flags.melodyFn = barformMelody;
const dir = new URL('../../docs/engine-review/examples/', import.meta.url);
mkdirSync(dir, { recursive: true });

const mod12 = x => ((x % 12) + 12) % 12;
const LETTERS = 'CDEFGAB', NAT = [0, 2, 4, 5, 7, 9, 11];
const STEP = {
  major: [0, 0, 1, 2, 2, 3, 3, 4, 4, 5, 6, 6],
  minor: [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6],
};
// spell a MIDI note in its key (G# in A minor, Cb in Eb minor)
function spell(m, key) {
  const [tonicName, mode] = key.split(' ');
  const tonicPc = NAT[LETTERS.indexOf(tonicName[0])] + (tonicName.includes('b') ? -1 : 0);
  const letter = (LETTERS.indexOf(tonicName[0]) + STEP[mode][mod12(m - tonicPc)]) % 7;
  let acc = mod12(m - NAT[letter]);
  if (acc > 6) acc -= 12;
  const octave = Math.floor((m - acc) / 12) - 1;
  return LETTERS[letter] + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc)) + octave;
}
const pad = n => String(n).padStart(4, '0');

// label phrases by identity: equal phrases share a letter
function labels(sop, fermatas) {
  const seen = new Map(), out = [];
  let st = 0;
  for (const f of fermatas) {
    const key = sop.slice(st, f).join(',');
    if (!seen.has(key)) seen.set(key, String.fromCharCode(65 + seen.size));
    out.push(seen.get(key));
    st = f;
  }
  return out;
}
function listing(p, fermatas, key) {
  const lab = labels(p.skeleton.s, fermatas);
  const lines = [];
  let st = 0;
  fermatas.forEach((f, i) => {
    const ph = p.skeleton.s.slice(st, f);
    lines.push(`  ${lab[i]}  ${ph.map(m => spell(m, key)).join(' ')}`);
    st = f;
  });
  return { lab, lines };
}

const out = [
  'Soprano lines of the listening examples (skeleton: one note per chord, before ornaments).',
  'shipped = the live engine, composePiece(N), what ?piece=N plays today.',
  'barform = the lab engine with the Edition 2 fix flags and the bar-form planner (tools/lab/barform.mjs).',
  'Letters mark identical phrases; each line ends at a fermata. MIDI at 72 bpm, fermatas held double.',
  '',
];
for (let n = first; n <= last; n++) {
  const a = composePiece(n);
  writeMidi(new URL(`shipped-${pad(n)}.mid`, dir), a, 72);
  const aFerm = a.fermataEighths.map(e => e / 2 + 1);
  const la = listing(a, aFerm, a.key);
  out.push(`No. ${n}  shipped  ${a.key}, ${a.skeleton.s.length} chords, ${aFerm.length} phrases, ` +
    `form ${la.lab.join(' ')}, kept at draft ${a.attempt + 1}, ${a.warnings} warnings`);
  out.push(...la.lines, '');

  const b = composePieceLab(n, flags);
  writeMidi(new URL(`barform-${pad(n)}.mid`, dir), b, 72);
  const mel = barformMelody(b.tonicPc, b.mode, b.phrases, mulberry32(n * 1000 + b.attempt * 7 + 13));
  const f = mel.form, L = f.stollenChords, sk = b.skeleton;
  const diff = [];
  for (let i = 0; i < L; i++) if (['s', 'a', 't', 'b'].some(v => sk[v][i] !== sk[v][L + i])) diff.push(i + 1);
  const lb = listing(b, b.fermatas, b.key);
  const climaxAt = sk.s.indexOf(f.climax) + 1;
  out.push(`No. ${n}  barform  ${b.key}, ${sk.s.length} chords, ${b.fermatas.length} phrases, ` +
    `form ${f.labels.join(' ')}${f.reprise ? ' (Reprisenbar)' : ''}, meter ${f.meter.join('.')}, ` +
    `${f.ambitus} ambitus, climax ${spell(f.climax, b.key)} at chord ${climaxAt}, ` +
    `kept at draft ${b.attempt + 1} (bass line ${b.bassTry + 1}), ${b.warnings} warnings`);
  out.push(...lb.lines);
  out.push(`  Stollen repeat harmonized ${diff.length ? `differently at ${diff.length} of ${L} chords (${diff.join(', ')})` : 'identically'}`);
  out.push('');
  console.log(`No. ${n}: shipped ${a.key} ${a.skeleton.s.length} chords | barform ${b.key} ${sk.s.length} chords ${f.labels.join('')}`);
}
writeFileSync(new URL('barform-sopranos.txt', dir), out.join('\n'));
console.log(out.join('\n'));
