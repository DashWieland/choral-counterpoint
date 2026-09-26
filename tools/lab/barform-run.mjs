// Measure a melody planner over addresses 1..N with the review's fix flags
// and write results/barform-<name>.json. Adapted from run.mjs.
//   node --no-warnings barform-run.mjs <shipped|barform> [N=3000] [workers=8] [name] [extra,flags]
// Everything downstream of the melody (bass beam search, inner voices,
// checker, ornaments, surface checker) is the lab engine, unchanged.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';

const FIXES = ['sbParallel', 'bassAug2', 'bassSpace', 'tonicEnd', 'formulaFit', 'seamFix', 'register', 'innerRules'];   // Edition 2's set
const mod12 = x => ((x % 12) + 12) % 12;
const wkey = w => w.replace(/chord \d+: /, '').replace(/\s*\([^)]*\)/g, '').replace(/\d+/g, '#').trim();
const STAGE_RANK = { bass: 0, inner: 1, checker: 2, surface: 3, kept: 4 };

if (isMainThread) {
  const [planner = 'barform', Nstr = '3000', Wstr = '8', nameArg, extraStr = ''] = process.argv.slice(2);
  const extra = extraStr.split(',').filter(Boolean);
  const N = Number(Nstr), W = Math.min(8, Number(Wstr));
  const name = nameArg || planner;
  const t0 = Date.now();
  const parts = await Promise.all(Array.from({ length: W }, (_, w) => new Promise((res, rej) => {
    const wk = new Worker(new URL(import.meta.url), { workerData: { w, W, N, planner, extra } });
    wk.on('message', res); wk.on('error', rej);
  })));
  const rows = parts.flat().sort((a, b) => a.n - b.n);
  const kept = rows.filter(r => r.ok);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const agg = {
    name, planner, flags: [...FIXES, ...extra], N,
    nulls: rows.length - kept.length,
    meanAttempts: sum(rows, r => r.attempts) / N,
    meanTries: sum(rows, r => r.tries) / N,
    firstAttemptShare: sum(rows, r => r.ok && r.attempts === 1 ? 1 : 0) / N,
    firstTryShare: sum(rows, r => r.ok && r.tries === 1 ? 1 : 0) / N,
    maxAttempts: Math.max(...rows.map(r => r.attempts)),
    meanChords: sum(kept, r => r.chords) / kept.length,
    chordsHist: {},
    stages: {}, failedAttemptStage: {}, violations: {},
    sop: { rep: 0, step: 0, third: 0, fourth: 0, fifth: 0, sixth: 0, larger: 0, n: 0 },
    meanAmbitus: sum(kept, r => r.ambitus) / kept.length,
    ambitusHist: {},
    lowest: Math.min(...kept.map(r => r.lo)), highest: Math.max(...kept.map(r => r.hi)),
    meanPitch: sum(kept, r => r.meanPitch) / kept.length,
    sopOutOfRangePieces: sum(kept, r => r.sopOut ? 1 : 0),
    warningsPerPiece: sum(kept, r => r.warnings) / kept.length,
    warningsPer10Chords: 10 * sum(kept, r => r.warnings) / sum(kept, r => r.chords),
    warnPieces: sum(kept, r => r.warnings ? 1 : 0),
    warnings: {},
    distinctSopranos: new Set(kept.map(r => r.sopKey)).size,
    distinctPieces: new Set(kept.map(r => r.pieceHash)).size,
    msPerAddress: 0,
  };
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.stages)) agg.stages[k] = (agg.stages[k] || 0) + v;
    for (const [k, v] of Object.entries(r.failedAttemptStage)) agg.failedAttemptStage[k] = (agg.failedAttemptStage[k] || 0) + v;
    for (const [k, v] of Object.entries(r.violations)) agg.violations[k] = (agg.violations[k] || 0) + v;
  }
  for (const r of kept) {
    for (const [k, v] of Object.entries(r.sop)) agg.sop[k] += v;
    for (const k of r.warnKeys) agg.warnings[k] = (agg.warnings[k] || 0) + 1;
    const cb = Math.floor(r.chords / 10) * 10;
    agg.chordsHist[cb] = (agg.chordsHist[cb] || 0) + 1;
    agg.ambitusHist[r.ambitus] = (agg.ambitusHist[r.ambitus] || 0) + 1;
  }
  const stol = kept.filter(r => r.stollen);
  if (stol.length) {
    const share = f => sum(stol, r => f(r.stollen) ? 1 : 0) / stol.length;
    agg.stollen = {
      pieces: stol.length,
      sameBass: share(s => s.sameBass),
      sameSkeleton: share(s => s.sameSkel),
      sameSkeletonAfterFirstChord: share(s => s.sameSkelTail),
      sameSurface: share(s => s.sameSurface),
      meanChordsDiffering: sum(stol, r => r.stollen.diffChords) / stol.length,
      meanStollenChords: sum(stol, r => r.stollen.len) / stol.length,
      firstDiffHist: {},
    };
    for (const r of stol) if (r.stollen.firstDiff >= 0) {
      const k = r.stollen.firstDiff;
      agg.stollen.firstDiffHist[k] = (agg.stollen.firstDiffHist[k] || 0) + 1;
    }
    const rep = kept.filter(r => r.reprise);
    agg.reprise = {
      pieces: rep.length,
      sameBass: sum(rep, r => r.reprise.sameBass ? 1 : 0) / Math.max(1, rep.length),
      sameSkeleton: sum(rep, r => r.reprise.sameSkel ? 1 : 0) / Math.max(1, rep.length),
    };
    agg.forms = {};
    for (const r of kept) agg.forms[r.form] = (agg.forms[r.form] || 0) + 1;
  }
  agg.wallSeconds = (Date.now() - t0) / 1000;
  agg.msPerAddress = sum(rows, r => r.ms) / N;
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`./results/barform-${name}.json`, import.meta.url),
    JSON.stringify({ ...agg, perAddress: rows.map(r => [r.n, r.ok ? r.attempts : 0, r.tries, r.chords || 0]) }));
  const pct = x => (100 * x).toFixed(1) + '%';
  const s = agg.sop;
  console.log(`${name}: nulls ${agg.nulls}/${N} | attempts ${agg.meanAttempts.toFixed(3)} (max ${agg.maxAttempts}), ` +
    `harmonization tries ${agg.meanTries.toFixed(3)} | first attempt kept ${pct(agg.firstAttemptShare)}, first try kept ${pct(agg.firstTryShare)}`);
  console.log(`  chords/piece ${agg.meanChords.toFixed(1)} | soprano: step ${pct(s.step / s.n)}, rep ${pct(s.rep / s.n)}, third ${pct(s.third / s.n)}, ` +
    `fourth ${pct(s.fourth / s.n)}, fifth ${pct(s.fifth / s.n)}, sixth ${pct(s.sixth / s.n)}, larger ${pct(s.larger / s.n)}`);
  console.log(`  ambitus mean ${agg.meanAmbitus.toFixed(2)} st, lowest ${agg.lowest}, highest ${agg.highest}, mean pitch ${agg.meanPitch.toFixed(1)}, ` +
    `'s out of range' pieces ${agg.sopOutOfRangePieces}`);
  console.log(`  warnings/piece ${agg.warningsPerPiece.toFixed(3)} (${agg.warningsPer10Chords.toFixed(3)} per 10 chords), pieces with any ${agg.warnPieces}`);
  console.log(`  distinct sopranos ${agg.distinctSopranos}, distinct pieces ${agg.distinctPieces} | tries by stage ${JSON.stringify(agg.stages)}`);
  console.log(`  failed attempts by furthest stage ${JSON.stringify(agg.failedAttemptStage)} | ${agg.msPerAddress.toFixed(1)} ms/address, wall ${agg.wallSeconds}s`);
  if (agg.stollen) console.log(`  Stollen repeat: same bass ${pct(agg.stollen.sameBass)}, same SATB ${pct(agg.stollen.sameSkeleton)}, ` +
    `same SATB after 1st chord ${pct(agg.stollen.sameSkeletonAfterFirstChord)}, same surface ${pct(agg.stollen.sameSurface)}, ` +
    `chords differing ${agg.stollen.meanChordsDiffering.toFixed(2)} of ${agg.stollen.meanStollenChords.toFixed(1)} | ` +
    `reprise (n=${agg.reprise.pieces}) same bass ${pct(agg.reprise.sameBass)}, same SATB ${pct(agg.reprise.sameSkeleton)}`);
} else {
  const E = await import('./engine.lab.mjs');
  const { barformMelody } = await import('./barform.mjs');
  const { w, W, N, planner, extra } = workerData;
  const flags = {};
  for (const f of [...FIXES, ...extra]) flags[f] = true;
  if (planner === 'barform') flags.melodyFn = barformMelody;
  const out = [];
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  const grid = (evs, total) => {
    const g = new Array(total).fill(null);
    let t = 0;
    for (const [m, ln] of evs) { for (let k = t; k < t + ln && k < total; k++) g[k] = m; t += ln; }
    return g;
  };
  for (let n = 1 + w; n <= N; n += W) {
    const t0 = performance.now();
    const trace = [];
    const p = E.composePieceLab(n, flags, trace);
    const ms = performance.now() - t0;
    const r = { n, ok: !!p, tries: trace.length, attempts: p ? p.attempt + 1 : 40, ms,
      stages: {}, failedAttemptStage: {}, violations: {} };
    const best = {};
    for (const t of trace) {
      r.stages[t.stage] = (r.stages[t.stage] || 0) + 1;
      best[t.attempt] = Math.max(best[t.attempt] ?? -1, STAGE_RANK[t.stage]);
      if (t.V) for (const v of new Set(t.V.map(wkey))) r.violations[v] = (r.violations[v] || 0) + 1;
    }
    for (const [, rank] of Object.entries(best)) if (rank < 4) {
      const st = Object.keys(STAGE_RANK).find(k => STAGE_RANK[k] === rank);
      r.failedAttemptStage[st] = (r.failedAttemptStage[st] || 0) + 1;
    }
    if (p) {
      const s = p.skeleton.s, ferm = new Set(p.fermatas);
      r.chords = s.length;
      r.sop = { rep: 0, step: 0, third: 0, fourth: 0, fifth: 0, sixth: 0, larger: 0, n: 0 };
      for (let i = 1; i < s.length; i++) {
        const a = Math.abs(s[i] - s[i - 1]);
        r.sop[a === 0 ? 'rep' : a <= 2 ? 'step' : a <= 4 ? 'third' : a === 5 ? 'fourth' : a === 7 ? 'fifth' : a <= 9 ? 'sixth' : 'larger']++;
        r.sop.n++;
      }
      r.lo = Math.min(...s); r.hi = Math.max(...s); r.ambitus = r.hi - r.lo;
      r.meanPitch = s.reduce((a, b) => a + b, 0) / s.length;
      r.warnings = p.W.length;
      r.warnKeys = [...new Set(p.W.map(wkey))];
      r.sopOut = p.W.some(x => /s out of range/.test(x));
      r.sopKey = p.key + '|' + s.join(',');
      r.pieceHash = fnv(p.key + JSON.stringify(p.events));
      if (planner === 'barform') {
        const rng = E.mulberry32(n * 1000 + p.attempt * 7 + 13);
        const mel = barformMelody(p.tonicPc, p.mode, p.phrases, rng);
        if (mel.pitches.join() !== s.join()) throw new Error(`No. ${n}: melody regeneration mismatch`);
        const f = mel.form, L = f.stollenChords, sk = p.skeleton;
        const same = (v, a, b, len) => { for (let i = 0; i < len; i++) if (sk[v][a + i] !== sk[v][b + i]) return false; return true; };
        let diffChords = 0, firstDiff = -1;
        for (let i = 0; i < L; i++) {
          if (['s', 'a', 't', 'b'].some(v => sk[v][i] !== sk[v][L + i])) { diffChords++; if (firstDiff < 0) firstDiff = i; }
        }
        const total = p.totalEighths;
        let sameSurface = true;
        for (const v of ['s', 'a', 't', 'b']) {
          const g = grid(p.events[v], total);
          for (let k = 0; k < 2 * L; k++) if (g[k] !== g[2 * L + k]) { sameSurface = false; break; }
        }
        r.stollen = {
          len: L, sameBass: same('b', 0, L, L), sameSkel: diffChords === 0,
          sameSkelTail: ['s', 'a', 't', 'b'].every(v => same(v, 1, L + 1, L - 1)),
          sameSurface, diffChords, firstDiff,
        };
        r.form = f.labels.join('');
        if (f.reprise) {
          const len = f.lengths[f.lengths.length - 1];
          const a = L - len, b = s.length - len;       // closing Stollen phrase vs the reprise
          r.reprise = { sameBass: same('b', a, b, len), sameSkel: ['s', 'a', 't', 'b'].every(v => same(v, a, b, len)) };
        }
      }
    }
    out.push(r);
  }
  parentPort.postMessage(out);
}
