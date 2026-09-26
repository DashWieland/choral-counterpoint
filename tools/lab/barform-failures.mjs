// Where do bar-form drafts fail? The lab's trace records the chord where a
// bass or inner beam emptied; map it onto the form.
//   node --no-warnings barform-failures.mjs [N=3000] [extra,flags]
// e.g. literalRepeat,joinFree,endLookahead (Edition 2's rules and seeding are always on)
const E = await import('./engine.lab.mjs');
const { barformMelody } = await import('./barform.mjs');
const N = Number(process.argv[2] || 3000);
const extra = (process.argv[3] || '').split(',').filter(Boolean);
const ED2 = ['sbParallel', 'bassAug2', 'bassSpace', 'tonicEnd', 'formulaFit', 'seamFix', 'register', 'innerRules', 'splitmixSeed'];
const flags = Object.fromEntries([...ED2, ...extra].map(f => {
  const [k, v] = f.split('=');
  return [k, v === undefined ? true : Number(v)];
}));
flags.melodyFn = barformMelody;

const where = { bass: {}, inner: {} };
const pos = { bass: {}, inner: {} };
let drafts = 0, firstKept = 0, checker = 0, surface = 0, nulls = 0, warns = 0, chords = 0;
const bump = (h, k) => { h[k] = (h[k] || 0) + 1; };
const t0 = performance.now();
for (let n = 1; n <= N; n++) {
  const trace = [];
  const p = E.composePieceLab(n, flags, trace);
  if (!p) nulls++; else { warns += p.W.length; chords += p.skeleton.s.length; }
  drafts += trace.length;
  if (trace.length === 1) firstKept++;
  for (const t of trace) {
    if (t.stage === 'checker') { checker++; continue; }
    if (t.stage === 'surface') { surface++; continue; }
    if (t.stage !== 'bass' && t.stage !== 'inner') continue;
    const i = t.at, L = t.rep, fe = new Set(t.fermatas), last = t.fermatas[t.fermatas.length - 1] - 1;
    const region = !L ? (i === last ? 'last chord' : 'n/a') : i < L - 1 ? 'Stollen' : i === L - 1 ? 'Stollen end' : i === L ? 'join'
      : i < 2 * L ? 'repeat' : i === 2 * L ? 'into Abgesang' : i === last ? 'last chord' : 'Abgesang';
    bump(where[t.stage], region);
    bump(pos[t.stage], fe.has(i + 1) ? 'cadence chord' : fe.has(i) ? 'phrase start' : fe.has(i + 2) ? 'pre-cadence' : 'inside');
  }
}
console.log(`[${extra.join(',')}] N=${N}: first draft kept ${(100 * firstKept / N).toFixed(1)}%, ${(drafts / N).toFixed(3)} drafts/address, ` +
  `nulls ${nulls}, warnings per 10 chords ${(10 * warns / chords).toFixed(3)}, ${((performance.now() - t0) / N).toFixed(1)} ms/address`);
console.log('  bass emptied in :', JSON.stringify(where.bass), JSON.stringify(pos.bass));
console.log('  inner emptied in:', JSON.stringify(where.inner), JSON.stringify(pos.inner));
console.log('  checker', checker, 'surface', surface, '| join refusals', JSON.stringify(E.LAB_STATS.joinWhy), '| end refusals', JSON.stringify(E.LAB_STATS.endWhy));
