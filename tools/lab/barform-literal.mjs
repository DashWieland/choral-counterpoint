// The repeated Stollen, literal or re-harmonized? For each bar-form piece
// (Edition 2's rules), copy the first statement's alto, tenor and bass into
// the repeat and ask the checker whether the joins still hold: the Stollen's
// last chord into its own first chord, and the repeat's last chord into the
// Abgesang. Reports how often a literal repeat is possible and writes plain
// (unornamented) versions of both for listening, so only the harmony differs.
//   node --no-warnings barform-literal.mjs [N=3000] [examplesUpTo=4]
import { composePieceLab } from './engine.lab.mjs';
import { checkChorale } from './shipped.mjs';
import { barformMelody } from './barform.mjs';
import { writeMidi } from './midi.mjs';
import { mkdirSync } from 'node:fs';

const [N = 3000, EX = 4] = process.argv.slice(2).map(Number);
const FIXES = ['sbParallel', 'bassAug2', 'bassSpace', 'tonicEnd', 'formulaFit', 'seamFix', 'register', 'innerRules'];
const dir = new URL('../../docs/engine-review/examples/', import.meta.url);
mkdirSync(dir, { recursive: true });

let form = null;
const flags = Object.fromEntries(FIXES.map(f => [f, true]));
flags.melodyFn = (...args) => { const r = barformMelody(...args); form = r.form; return r; };

const plain = (skel, fermatas) => ({
  events: Object.fromEntries(['s', 'a', 't', 'b'].map(v => [v, skel[v].map(m => [m, 2])])),
  fermataEighths: fermatas.map(f => 2 * (f - 1)),
});

let pieces = 0, alreadyLiteral = 0, literalOk = 0, literalWarnDelta = 0;
const fails = {};
for (let n = 1; n <= N; n++) {
  const p = composePieceLab(n, flags);
  if (!p) continue;
  pieces++;
  const L = form.stollenChords, sk = p.skeleton;
  const lit = { s: sk.s.slice(), a: sk.a.slice(), t: sk.t.slice(), b: sk.b.slice() };
  for (let i = L; i < 2 * L; i++) for (const v of ['a', 't', 'b']) lit[v][i] = sk[v][i - L];
  const same = ['a', 't', 'b'].every(v => lit[v].every((m, i) => m === sk[v][i]));
  if (same) alreadyLiteral++;
  const before = checkChorale(sk, p.tonicPc, p.mode, p.fermatas);
  const { V, W } = checkChorale(lit, p.tonicPc, p.mode, p.fermatas);
  if (!V.length) { literalOk++; literalWarnDelta += W.length - before.W.length; }
  else for (const v of V) { const k = v.replace(/\s*\(.*$/, '').replace(/\d+/g, '#'); fails[k] = (fails[k] || 0) + 1; }
  if (n <= EX) {
    const id = String(n).padStart(4, '0');
    writeMidi(new URL(`plain-varied-${id}.mid`, dir), plain(sk, p.fermatas));
    if (!V.length) writeMidi(new URL(`plain-literal-${id}.mid`, dir), plain(lit, p.fermatas));
    console.log(`No. ${n} (${p.key}, ${form.labels.join('')}, Stollen ${L} chords): ` +
      (V.length ? `literal repeat breaks the checker (${V[0]})` : 'literal repeat passes the checker'));
  }
}
console.log(`${pieces} bar-form pieces: the repeat was already literal in ${alreadyLiteral}; ` +
  `copying the Stollen passes the checker in ${literalOk} (${(100 * literalOk / pieces).toFixed(1)}%), ` +
  `with ${(literalWarnDelta / Math.max(literalOk, 1)).toFixed(2)} more warnings per piece; failures: ${JSON.stringify(fails)}`);
