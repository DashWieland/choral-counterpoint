// Full pipeline per key: first draft kept, warnings, soprano register.
//   node --no-warnings barform-keys.mjs [N=3000] [flag,flag,...] [opt=value,...]
// e.g. the C/D register test: ... <Edition 2 flags>,literalRepeat,joinFree,endLookahead lowCD=true
const E = await import('./engine.lab.mjs');
const { barformMelody, BARFORM_OPTS } = await import('./barform.mjs');
const N = Number(process.argv[2] || 3000);
const flags = {};
for (const f of (process.argv[3] || '').split(',').filter(Boolean)) flags[f] = true;
for (const kv of (process.argv[4] || '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  BARFORM_OPTS[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
}
flags.melodyFn = barformMelody;
const by = {};
const t0 = performance.now();
for (let n = 1; n <= N; n++) {
  const trace = [];
  const p = E.composePieceLab(n, flags, trace);
  if (!p) continue;
  const tonic = p.key.split(' ')[0];
  const g = by[tonic] || (by[tonic] = { n: 0, first: 0, warn: 0, chords: 0, mean: 0, lo: 99, fin: {}, crowd: 0 });
  g.n++; if (trace.length === 1) g.first++;
  g.warn += p.W.length; g.chords += p.skeleton.s.length;
  const s = p.skeleton.s;
  g.mean += s.reduce((a, b) => a + b, 0) / s.length;
  g.lo = Math.min(g.lo, ...s);
  const f = s[s.length - 1]; g.fin[f] = (g.fin[f] || 0) + 1;
  // the choir's mean pitch, all four voices (how low the texture sits)
  g.crowd += ['s', 'a', 't', 'b'].reduce((a, v) => a + p.skeleton[v].reduce((x, y) => x + y, 0), 0) / (4 * s.length);
}
const all = { n: 0, first: 0 };
console.log(`flags [${Object.keys(flags).filter(k => k !== 'melodyFn').join(',')}] opts ${JSON.stringify(BARFORM_OPTS)} | ${((performance.now() - t0) / N).toFixed(1)} ms/address`);
for (const [k, g] of Object.entries(by).sort()) {
  all.n += g.n; all.first += g.first;
  console.log(`  ${k.padEnd(3)} ${String(g.n).padStart(4)} pieces: first draft ${(100 * g.first / g.n).toFixed(1).padStart(5)}%, ` +
    `warnings/10 chords ${(10 * g.warn / g.chords).toFixed(2)}, soprano mean ${(g.mean / g.n).toFixed(1)} (lowest ${g.lo}), ` +
    `choir mean ${(g.crowd / g.n).toFixed(1)}, finals ${JSON.stringify(g.fin)}`);
}
console.log(`  all: first draft ${(100 * all.first / all.n).toFixed(1)}%`);
