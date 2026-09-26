// Where do the bar-form planner's thirds come from? Planner only (no
// harmonization): intervals inside phrases by position, against Bach's
// corpus tables. Options set BARFORM_OPTS (key=value).
//   node --no-warnings barform-thirds.mjs [N=4000] [key=value,...]
// (melodies only, seeded as Edition 1 drafts: any seeds would do)
const E = await import('./engine.lab.mjs');
const { barformMelody, BARFORM_OPTS, BARFORM_STATS } = await import('./barform.mjs');
const N = Number(process.argv[2] || 4000);
for (const kv of (process.argv[3] || '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  BARFORM_OPTS[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
}
const cat = a => a === 0 ? 'rep' : a <= 2 ? 'step' : a <= 4 ? 'third' : a === 5 ? 'fourth' : a === 7 ? 'fifth' : a <= 9 ? 'sixth' : 'larger';
const H = {};
const add = (where, a) => { const h = H[where] || (H[where] = { n: 0 }); h[cat(a)] = (h[cat(a)] || 0) + 1; h.n++; };
let span = 0, tunes = 0, lens = 0, phrases = 0;
const t0 = performance.now();
for (let n = 1; n <= N; n++) {
  const paramRng = E.mulberry32(n * 2654435761 + 1);
  const [, tonicPc] = E.choice(paramRng, E.KEYS);
  const mode = paramRng() < 0.45 ? 'minor' : 'major';
  const nP = E.choice(paramRng, [2, 3, 3, 4]);
  const { pitches, fermatas, form } = barformMelody(tonicPc, mode, nP, E.mulberry32(n * 1000 + 13));
  tunes++; span += Math.max(...pitches) - Math.min(...pitches);
  // the distinct phrases only (the repeat and reprise add copies)
  const S = form.S, starts = [0, ...fermatas.slice(0, -1)];
  const distinct = new Set([...Array(S).keys(), ...Array.from({ length: fermatas.length - 2 * S }, (_, i) => 2 * S + i)]);
  if (form.reprise) distinct.delete(fermatas.length - 1);
  for (const pi of distinct) {
    const a0 = starts[pi], L = fermatas[pi] - a0, F = L - 3;
    const ph = pitches.slice(a0, a0 + L);
    phrases++; lens += L;
    for (let j = 1; j < L; j++) {
      const a = Math.abs(ph[j] - ph[j - 1]);
      add('all inside', a);
      add(j === 1 ? '1 first interval' : j < F ? '2 free' : j === F ? '3 into the formula' : '4 inside the formula', a);
    }
  }
  // the whole tune, every chord to chord, folded to the nearest interval as the oracle counts Bach
  for (let i = 1; i < pitches.length; i++) { const d = Math.abs(pitches[i] - pitches[i - 1]) % 12; add('6 whole tune, folded', Math.min(d, 12 - d)); }
  // boundaries
  for (let k = 1; k < fermatas.length; k++) add('5 phrase to phrase', Math.abs(pitches[fermatas[k - 1]] - pitches[fermatas[k - 1] - 1]));
}
const pct = (h, k) => (100 * (h[k] || 0) / h.n).toFixed(1).padStart(5);
console.log(`N=${N} opts ${JSON.stringify(BARFORM_OPTS)}: ${(performance.now() - t0) / N | 0} ms/tune, mean span ${(span / tunes).toFixed(1)} st, ` +
  `phrase length ${(lens / phrases).toFixed(2)}, restarts/tune ${(BARFORM_STATS.restarts / BARFORM_STATS.tunes).toFixed(2)}, phrase retries/tune ${(BARFORM_STATS.phraseRetries / BARFORM_STATS.tunes).toFixed(2)}`);
console.log('                        step   rep third fourth fifth sixth      n');
for (const k of Object.keys(H).sort()) {
  const h = H[k];
  console.log(`  ${k.padEnd(21)} ${pct(h, 'step')} ${pct(h, 'rep')} ${pct(h, 'third')} ${pct(h, 'fourth')} ${pct(h, 'fifth')} ${pct(h, 'sixth')} ${String(h.n).padStart(6)}`);
}
// Bach, from the corpus tables (inside phrases, from the third note on)
const T = E.MELODY.transitions; const b = { n: 0 };
for (const t of Object.values(T)) for (const [iv, c] of Object.entries(t)) { const k = cat(Math.abs(+iv)); b[k] = (b[k] || 0) + c; b.n += c; }
console.log('  Bach (oracle, folded)   70.3  15.4   7.7    6.6   (5ths folded into 4ths, 6ths into 3rds)');
console.log(`  ${'Bach (corpus tables)'.padEnd(21)} ${pct(b, 'step')} ${pct(b, 'rep')} ${pct(b, 'third')} ${pct(b, 'fourth')} ${pct(b, 'fifth')} ${pct(b, 'sixth')} ${String(b.n).padStart(6)}`);
