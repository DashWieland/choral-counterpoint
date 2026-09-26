// LAB COPY of instrument/web/engine.js for the 2026-09 engine review.
// With every flag off, composePieceLab(n, {}) must reproduce the shipped
// composePiece(n) exactly (verify.mjs checks this). Each proposed change is
// a flag, so every number in the review is a measured counterfactual:
//
//   sbParallel   bass search rejects soprano/bass parallel 5ths/8ves
//   bassAug2     bass search rejects minor-key augmented seconds (b6<->#7)
//   seamFix      melody steers into a cadence formula's real first note
//                (incl. the raised 7th) and never enters it by a tritone
//                or augmented second
//   formulaFit   cadence formulas are placed as a unit inside the soprano
//                range (no MIDI-58 clamp, no climb out of the window)
//   register     one soprano band (D4-F#5) for every key
//   exactInner   inner voices by exact Viterbi over the same scoring
//                (the shipped beam of 14 is an approximation of it)
//   bassFallback a failed tune tries the next bass lines from the beam
//                before the tune itself is thrown away
//   tonicEnd     the last bass note must be the tonic (the shipped search
//                only scores it -3.0, so ~0.6% of pieces end on V, IV or ii)
//   bassSpace    the bass never comes within a minor third of the soprano
//   innerRules   the inner voices never leap a seventh or more than an octave,
//                nor move by an augmented second, at fermatas too (the JS
//                harmonizer wrote what its own surface gate then rejected)
//   splitmixSeed Edition 2's seeding: key, mode and phrase count from
//                splitmix64(n*64), draft a from splitmix64(n*64 + 1 + a)
//   literalRepeat with a bar-form planner (flags.melodyFn returning a form),
//                the Stollen's repeat copies its first statement: inside the
//                repeat the bass and inner-voice searches may only repeat
//                what each line wrote there, and ornaments are mirrored; at the
//                Stollen's last chord a line must be able to start over
//   joinFree     with literalRepeat, the move from the Stollen's end back to
//                its start needs no precedent in the oracle (a repeat starts
//                over after a breath), only the hard rules within an octave
//   endLookahead at the next-to-last chord a bass line must be able to reach
//                a tonic the search may write (tonicEnd made the beam die there)
//   bassWidth, innerWidth  beam widths (10 and 14 when unset)
//
// The engine itself is untouched; nothing here changes a live ?piece=N.

// Edition 1's tables: tables-ed1.js once editions exist, tables.js before
const { TABLES } = await import('../../instrument/web/tables-ed1.js')
  .catch(() => import('../../instrument/web/tables.js'));

let FL = {};                      // active flags for the current composePieceLab
let TRACE = null;                 // per-attempt stage log when tracing
let REP = 0;                      // literalRepeat: chords in the Stollen (0 = off)
let DIED_AT = -1;                 // the chord where the last bass or inner beam emptied
// counters for diagnostics (why a line could not return to the Stollen, ...)
export const LAB_STATS = { joinWhy: {}, endWhy: {} };
const tally = (h, k) => { h[k] = (h[k] || 0) + 1; };

const ORACLE = TABLES.outer_voice_table;
const MELODY = TABLES.melody_table;
const ORN = TABLES.ornament_table;

// ----------------------------------------------------------------- prng --

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uniform = (rng, a, b) => a + rng() * (b - a);
const choice = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function weightedChoice(rng, items, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const mod12 = x => ((x % 12) + 12) % 12;

// ----------------------------------------------------------------- chords --

const _c = (name, pcs, lt = null, seventh = null, target = null) =>
  ({ name, pcs, lt, seventh, target });

const CHORDS = {
  major: [
    _c('I', [0, 4, 7]), _c('ii', [2, 5, 9]), _c('iii', [4, 7, 11]),
    _c('IV', [5, 9, 0]), _c('V', [7, 11, 2], 11), _c('vi', [9, 0, 4]),
    _c('viio', [11, 2, 5], 11),
    _c('V7', [7, 11, 2, 5], 11, 5), _c('ii7', [2, 5, 9, 0], null, 0),
    _c('V/V', [2, 6, 9], 6, null, 7), _c('V7/V', [2, 6, 9, 0], 6, 0, 7),
    _c('viio/V', [6, 9, 0], 6, null, 7), _c('V/ii', [9, 1, 4], 1, null, 2),
    _c('V/vi', [4, 8, 11], 8, null, 9), _c('V7/vi', [4, 8, 11, 2], 8, 2, 9),
    _c('V7/IV', [0, 4, 7, 10], null, 10, 5),
  ],
  minor: [
    _c('i', [0, 3, 7]), _c('iio', [2, 5, 8]), _c('III', [3, 7, 10]),
    _c('iv', [5, 8, 0]), _c('v', [7, 10, 2]), _c('V', [7, 11, 2], 11),
    _c('VI', [8, 0, 3]), _c('bVII', [10, 2, 5]), _c('viio', [11, 2, 5], 11),
    _c('V7', [7, 11, 2, 5], 11, 5), _c('viio7', [11, 2, 5, 8], 11, 8),
    _c('iio7', [2, 5, 8, 0], null, 0),
    _c('V/V', [2, 6, 9], 6, null, 7), _c('V7/V', [2, 6, 9, 0], 6, 0, 7),
    _c('viio/V', [6, 9, 0], 6, null, 7),
    _c('V/iv', [0, 4, 7], 4, null, 5), _c('V7/iv', [0, 4, 7, 10], 4, 10, 5),
  ],
};
const SCALES = {
  major: new Set([0, 2, 4, 5, 7, 9, 11]),
  minor: new Set([0, 2, 3, 5, 7, 8, 10, 11]),
};
const isChromatic = (ch, mode) => ch.pcs.some(p => !SCALES[mode].has(p));

function harmonizablePairs(mode) {
  const pairs = new Set();
  for (const ch of CHORDS[mode])
    for (const a of ch.pcs) for (const b of ch.pcs) pairs.add(a * 12 + b);
  return pairs;
}
const PAIRS = { major: harmonizablePairs('major'), minor: harmonizablePairs('minor') };

// ------------------------------------------------------------ check_chorale --

const VOICES = ['s', 'a', 't', 'b'];
const RANGES = { s: [60, 81], a: [53, 74], t: [48, 69], b: [36, 62] };

// Faithful port of check_chorale.check(): returns {violations, warnings} counts
// and messages. v = {s:[], a:[], t:[], b:[]} midi arrays.
export function checkChorale(v, tonicPc, mode, fermatas) {
  const V = [], W = [];
  const n = v.s.length;
  const lt = mod12(tonicPc - 1);
  const ferm = new Set(fermatas);
  const domFamily = new Set([2, 5, 7, 8, 11]);

  for (let b = 0; b < n; b++) {
    const [s, a, t, bs] = [v.s[b], v.a[b], v.t[b], v.b[b]];
    if (!(s >= a && a >= t && t >= bs)) W.push(`chord ${b + 1}: voice crossing`);
    if (s - a > 12) W.push(`chord ${b + 1}: soprano-alto spacing`);
    if (a - t > 12) W.push(`chord ${b + 1}: alto-tenor spacing`);
    for (const name of VOICES) {
      const [lo, hi] = RANGES[name];
      if (v[name][b] < lo || v[name][b] > hi)
        W.push(`chord ${b + 1}: ${name} out of range`);
    }
    const pcs = [s, a, t, bs].map(p => mod12(p - tonicPc));
    if (pcs.filter(p => p === 11).length > 1)
      W.push(`chord ${b + 1}: doubled leading tone`);
  }

  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const hi = v[VOICES[i]], lo = v[VOICES[j]];
    for (let b = 1; b < n; b++) {
      const ic0 = mod12(hi[b - 1] - lo[b - 1]), ic1 = mod12(hi[b] - lo[b]);
      if (ic1 !== 0 && ic1 !== 7) continue;
      const dh = hi[b] - hi[b - 1], dl = lo[b] - lo[b - 1];
      const boundary = ferm.has(b);
      if (ic0 === ic1 && dh && dl) {
        if ((dh > 0) === (dl > 0))
          (boundary ? W : V).push(
            `parallel ${ic1 ? 'fifths' : 'octaves'} (${VOICES[i]}/${VOICES[j]}, chords ${b}-${b + 1})`);
        else W.push(`antiparallel (${VOICES[i]}/${VOICES[j]}, ${b})`);
      } else if (i === 0 && j === 3) {
        if (((dh > 0 && dl > 0) || (dh < 0 && dl < 0)) && Math.abs(dh) > 2)
          W.push(`direct ${ic1 ? 'fifths' : 'octaves'} (chords ${b}-${b + 1})`);
      }
    }
  }

  for (const name of VOICES) {
    const line = v[name];
    for (let b = 1; b < n; b++) {
      const step = line[b] - line[b - 1], a = Math.abs(step);
      const sink = ferm.has(b) ? W : V;
      if (a > 12) sink.push(`${name}: leap > octave (${b})`);
      else if (a === 10 || a === 11) sink.push(`${name}: seventh leap (${b})`);
      else if (a === 6) W.push(`${name}: melodic tritone (${b})`);
      if (a === 3 && mode === 'minor') {
        const rel = new Set([mod12(line[b - 1] - tonicPc), mod12(line[b] - tonicPc)]);
        if (rel.has(8) && rel.has(11))
          (ferm.has(b) ? W : V).push(`${name}: augmented second (${b})`);
      }
    }
  }
  return { V, W };
}

// ----------------------------------------------------- surface (ornaments) --

function surfaceGrid(events, total) {
  // events: {s:[[midi,len],...],...} -> per-eighth sounding pitch
  const grid = {};
  for (const name of VOICES) {
    const g = new Array(total).fill(null);
    let t = 0;
    for (const [m, ln] of events[name]) {
      for (let k = t; k < Math.min(t + ln, total); k++) g[k] = m;
      t += ln;
    }
    grid[name] = g;
  }
  return grid;
}

// Trimmed port of check_ornaments.check_surface: violations + the noise
// count (surface parallels + simultaneous NCT clashes) used as the gate.
function checkSurface(events, skel, tonicPc, mode, fermSlots) {
  const V = [];
  let total = 0;
  for (const name of VOICES) {
    let t = 0;
    for (const [, ln] of events[name]) t += ln;
    total = Math.max(total, t);
  }
  if (total % 2) return { V: ['odd length'], noise: 0 };
  const nSlots = total / 2;
  const grid = surfaceGrid(events, total);
  for (const name of VOICES)
    if (grid[name].some(p => p === null)) return { V: [`${name}: gap`], noise: 0 };

  const skelCheck = checkChorale(skel, tonicPc, mode, fermSlots);
  V.push(...skelCheck.V);

  for (const name of VOICES) {
    const g = grid[name], sk = skel[name];
    for (let i = 0; i < nSlots; i++) {
      const on = g[2 * i], off = g[2 * i + 1];
      const slotPcs = new Set(VOICES.map(vn => mod12(skel[vn][i])));
      if (on === sk[i]) {
        if (off !== sk[i] && !slotPcs.has(mod12(off))) {
          const nxt = 2 * i + 2 < total ? g[2 * i + 2] : off;
          if (!(off === nxt || (Math.abs(off - on) <= 2 && Math.abs(nxt - off) <= 2)))
            V.push(`${name} slot ${i + 1}: NCT by leap`);
        }
      } else if (off === sk[i]) {
        const prev = i > 0 ? g[2 * i - 1] : null;
        if (prev !== on) V.push(`${name} slot ${i + 1}: unprepared suspension`);
        if (!(on - off >= 1 && on - off <= 2)) V.push(`${name} slot ${i + 1}: bad resolution`);
      } else V.push(`${name} slot ${i + 1}: skeleton never stated`);
    }
    const line = events[name].map(e => e[0]);
    for (let j = 1; j < line.length; j++) {
      const step = Math.abs(line[j] - line[j - 1]);
      if (step > 12) V.push(`${name}: surface leap > octave`);
      else if (step === 10 || step === 11) V.push(`${name}: surface 7th leap`);
      if (step === 3 && mode === 'minor') {
        const rel = new Set([mod12(line[j - 1] - tonicPc), mod12(line[j] - tonicPc)]);
        if (rel.has(8) && rel.has(11)) V.push(`${name}: surface aug 2nd`);
      }
    }
  }

  let noise = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const ga = grid[VOICES[i]], gb = grid[VOICES[j]];
    for (let k = 1; k < total; k++) {
      const ic0 = mod12(ga[k - 1] - gb[k - 1]), ic1 = mod12(ga[k] - gb[k]);
      if ((ic1 === 0 || ic1 === 7) && ic0 === ic1 && ga[k] !== ga[k - 1] &&
          gb[k] !== gb[k - 1] && (ga[k] > ga[k - 1]) === (gb[k] > gb[k - 1]))
        noise++;
    }
  }
  for (let i = 0; i < nSlots; i++) {
    const k = 2 * i + 1;
    const slotPcs = new Set(VOICES.map(vn => mod12(skel[vn][i])));
    const ncts = VOICES.filter(vn => !slotPcs.has(mod12(grid[vn][k])));
    for (let x = 0; x < ncts.length; x++) for (let y = x + 1; y < ncts.length; y++) {
      const ic = mod12(grid[ncts[x]][k] - grid[ncts[y]][k]);
      if ([1, 2, 6, 10, 11].includes(ic)) noise++;
    }
  }
  return { V, noise };
}

// ----------------------------------------------------------------- melody --

const ivBucket = iv => iv === 0 ? 'rep'
  : (iv > 0 ? 'u' : 'd') + (Math.abs(iv) <= 2 ? '1' : Math.abs(iv) <= 4 ? '2' : '3');

function melody(tonicPc, mode, nPhrases, rng) {
  const scale = new Set([...(mode === 'major' ? [0, 2, 4, 5, 7, 9, 11]
                                              : [0, 2, 3, 5, 7, 8, 10])].map(d => mod12(tonicPc + d)));
  const tonic4 = 60 + tonicPc;
  const window = [];
  const [wLo, wHi] = FL.register ? [62, 79]
    : [Math.max(60, tonic4 - 5), Math.min(79, tonic4 + 14)];
  for (let m = wLo; m < wHi; m++)
    if (scale.has(mod12(m))) window.push(m);
  const deg = m => mod12(m - tonicPc);
  // formulaFit: a cadence formula is placed as a unit, every note inside the
  // soprano range, instead of note-by-note with the MIDI-58 clamp
  const placeFormula = (start, formula) => {
    const out = [start];
    for (let j = 1; j < formula.length; j++) {
      const prev = out[out.length - 1];
      let best = null;
      for (let m = prev - 6; m <= prev + 6; m++)
        if (mod12(m - tonicPc) === formula[j] &&
            (best === null || Math.abs(m - prev) <= Math.abs(best - prev))) best = m;
      out.push(best);
    }
    return out.every(m => m >= 60 && m <= 81) ? out : null;
  };
  const RANGE = [];
  for (let m = 60; m <= 81; m++) RANGE.push(m);
  const interTargets = mode === 'major' ? [2, 7, 4] : [2, 7, 3];
  const plan = [];
  for (let i = 0; i < nPhrases - 1; i++) plan.push(choice(rng, interTargets));
  plan.push(0);
  const phraseLens = plan.map(() => choice(rng, [4, 5, 6]));
  const totalLen = phraseLens.reduce((a, b) => a + b, 0);
  const climaxPos = Math.floor(totalLen * uniform(rng, 0.55, 0.75));
  const winMax = Math.max(...window);

  const pickFormula = targetDeg => {
    const pool = [];
    for (const [k, c] of Object.entries(MELODY.cadences[mode] || {})) {
      const degs = k.split(',').map(Number);
      if (degs[2] === targetDeg && c >= 5) pool.push([degs, c]);
    }
    if (!pool.length) return null;
    return weightedChoice(rng, pool.map(p => p[0]), pool.map(p => p[1]));
  };

  const trans = MELODY.transitions;
  const pitches = [];
  const openings = window.filter(m => [0, 4, 3, 7].includes(deg(m))).slice(0, 4);
  let cur = choice(rng, openings);
  for (let pi = 0; pi < nPhrases; pi++) {
    const plen = phraseLens[pi], targetDeg = plan[pi];
    const formula = plen >= 4 ? pickFormula(targetDeg) : null;
    const free = plen - (formula ? 3 : 1);
    for (let k = 0; k < free; k++) {
      const pos = pitches.length;
      if (pos === 0) { pitches.push(cur); continue; }
      const prev = pitches[pitches.length - 1];
      const stepsLeft = free - k;
      let cands = window.filter(m => {
        const a = Math.abs(m - prev);
        return a > 0 && a <= 7 && a !== 6;
      });
      if (pitches.length >= 2 && Math.abs(prev - pitches[pitches.length - 2]) > 2) {
        const back = cands.filter(m => Math.abs(m - prev) <= 2 &&
          (m - prev) * (prev - pitches[pitches.length - 2]) < 0);
        if (back.length) cands = back;
      }
      const goalDeg = formula ? formula[0] : targetDeg;
      // seamFix/formulaFit: steer toward where the formula can really start
      // (the shipped code looks only in the natural-minor window, so a
      // formula opening on the raised 7th has no target and no steering)
      const tgt = (formula && (FL.seamFix || FL.formulaFit))
        ? RANGE.filter(m => deg(m) === goalDeg && (!FL.formulaFit || placeFormula(m, formula)))
        : window.filter(m => deg(m) === goalDeg);
      const goal = tgt.length
        ? tgt.reduce((a, b) => Math.abs(a - prev) < Math.abs(b - prev) ? a : b) : prev;
      if (stepsLeft <= 3) {
        const near = cands.filter(m => Math.abs(m - goal) <= 2 * (stepsLeft - 1) + 2);
        if (near.length) cands = near;
      }
      if (FL.seamFix && formula && stepsLeft === 1) {
        // never enter the formula by a tritone or an augmented second
        const entry = m => {
          let best = null;
          for (let x = m - 6; x <= m + 6; x++)
            if (mod12(x - tonicPc) === formula[0] &&
                (best === null || Math.abs(x - m) <= Math.abs(best - m))) best = x;
          return best;
        };
        const ok = cands.filter(m => {
          const e = entry(m), d = Math.abs(e - m);
          const aug2 = d === 3 && mode === 'minor' &&
            new Set([deg(m), mod12(e - tonicPc)]).has(8) && new Set([deg(m), mod12(e - tonicPc)]).has(11);
          return d !== 6 && !aug2;
        });
        if (ok.length) cands = ok;
      }
      if (!cands.length)
        cands = window.filter(m => Math.abs(m - prev) > 0 && Math.abs(m - prev) <= 4);
      if (!cands.length && FL.formulaFit)          // the shipped code pushes undefined here
        cands = [window.reduce((a, b) => Math.abs(a - prev) <= Math.abs(b - prev) ? a : b)];
      const prevIv = pitches.length >= 2
        ? pitches[pitches.length - 1] - pitches[pitches.length - 2] : 0;
      const frac = (k + 1) / Math.max(plen, 1);
      const posb = frac < 0.4 ? 'early' : frac < 0.8 ? 'mid' : 'late';
      const table = trans[`${mode}|${ivBucket(prevIv)}|${posb}`] || {};
      const weights = cands.map(m => {
        const iv = Math.max(-7, Math.min(7, m - prev));
        let w = (table[String(iv)] || 0) + 0.5;
        if ((pos === climaxPos) === (m === winMax)) w *= 1.6;
        if (pitches.length && m === Math.max(...pitches) && pos !== climaxPos) w *= 0.35;
        return w;
      });
      pitches.push(weightedChoice(rng, cands, weights));
    }
    let placed = null;
    if (formula && FL.formulaFit) {
      const prev = pitches[pitches.length - 1];
      // nearest start of formula f within `span` that fits the range and
      // doesn't enter by a forbidden leap
      const startFor = (f, span, forbid) => {
        let best = null;
        for (let m = prev - span; m <= prev + span; m++) {
          if (mod12(m - tonicPc) !== f[0] || !placeFormula(m, f)) continue;
          if (forbid.includes(Math.abs(m - prev))) continue;
          if (best === null || Math.abs(m - prev) <= Math.abs(best - prev)) best = m;
        }
        return best;
      };
      const near = FL.seamFix ? [6] : [];
      const far = [6, 10, 11];                    // never a tritone or 7th into a cadence
      let f = formula, best = startFor(f, 7, near);
      if (best === null) best = startFor(f, 12, far);
      if (best === null) {
        // the drawn formula can't be reached: Bach's other formulas for the
        // same cadence, most common first (no rng, so the stream is unchanged)
        const pool = Object.entries(MELODY.cadences[mode] || {})
          .map(([k, c]) => [k.split(',').map(Number), c])
          .filter(([d, c]) => d[2] === targetDeg && c >= 5)
          .sort((x, y) => y[1] - x[1]);
        for (const [g] of pool) {
          const s = startFor(g, 7, near) ?? startFor(g, 12, far);
          if (s !== null) { f = g; best = s; break; }
        }
      }
      if (best !== null) placed = placeFormula(best, f);
      if (FL._dbg) FL._dbg.push({ phrase: pi, formula: f, prev, placed });
    }
    if (placed) {
      pitches.push(...placed);
    } else if (formula) {
      for (const fdeg of formula) {
        const prev = pitches[pitches.length - 1];
        const opts = [];
        for (let m = prev - 6; m <= prev + 6; m++)
          if (mod12(m - tonicPc) === fdeg && m >= 58) opts.push(m);
        pitches.push(opts.length
          ? opts.reduce((a, b) => Math.abs(a - prev) < Math.abs(b - prev) ? a : b) : prev);
      }
    } else {
      const prev = pitches[pitches.length - 1];
      const tgt = window.filter(m => deg(m) === targetDeg && Math.abs(m - prev) <= 5);
      pitches.push(tgt.length
        ? tgt.reduce((a, b) => Math.abs(a - prev) < Math.abs(b - prev) ? a : b) : prev);
    }
  }
  const fermatas = [];
  let acc = 0;
  for (const plen of phraseLens) { acc += plen; fermatas.push(acc); }
  if (mode === 'minor' && mod12(pitches[pitches.length - 2] - tonicPc) === 10)
    pitches[pitches.length - 2] += 1;
  return { pitches, fermatas };
}

// -------------------------------------------------------------- bass line --

function oracleMoves(mode, sFrom, sTo, cad, bFrom) {
  const table = ORACLE.transitions[`${mode}|${sFrom}>${sTo}|${cad}`] || {};
  const out = {};
  for (const [k, c] of Object.entries(table)) {
    const [f, t] = k.split('>').map(Number);
    if (f === bFrom) out[t] = (out[t] || 0) + c;
  }
  if (!Object.keys(out).length) {
    const arr = ORACLE.arrivals[`${mode}|${sTo}|${cad}`] || {};
    for (const [p, c] of Object.entries(arr)) out[p] = c;
  }
  return out;
}

function concretize(pc, prev, lo = 38, hi = 62) {
  const cands = [];
  for (let m = lo; m <= hi; m++)
    if (mod12(m) === pc && Math.abs(m - prev) <= 12) cands.push(m);
  return cands.sort((a, b) =>
    (Math.abs(a - prev) - Math.abs(b - prev)) || (Math.abs(a - 48) - Math.abs(b - 48)));
}

function bassLine(sop, fermatas, tonicPc, mode, rng, beamWidth = 10, temp = 0) {
  const n = sop.length;
  const ferm = new Set(fermatas);
  const rel = m => mod12(m - tonicPc);
  const pairs = PAIRS[mode];
  const scale = SCALES[mode];
  const opens = ORACLE.openings[`${mode}|${rel(sop[0])}`] || { '0': 1 };
  // what the inner-voice search and the checker would reject anyway, refused
  // where the notes are written: bass note cand at chord i after prev
  const legal = (i, prev, cand, tPc) => {
    const a = Math.abs(cand - prev);
    if (a === 10 || a === 11) return false;
    // (lab) checked after the rng draw so the random stream stays aligned
    // with the shipped engine
    if (FL.sbParallel && pairParallel(sop[i - 1], prev, sop[i], cand)) return false;
    if (FL.tonicEnd && i === n - 1 && mod12(cand) !== tonicPc) return false;
    // bassSpace: never within a minor third of the soprano (the range lets
    // the bass climb to D4 while the soprano can sit on C4, and a bass that
    // close leaves no room for alto and tenor)
    if (FL.bassSpace && sop[i] - cand <= 3) return false;
    if (FL.bassAug2 && mode === 'minor' && a === 3 && !ferm.has(i)) {
      const r2 = new Set([rel(prev), tPc]);
      if (r2.has(8) && r2.has(11)) return false;
    }
    return true;
  };
  // (lab) literalRepeat: can a Stollen ending on bass note last go back to
  // the first bass note b0? The search will have to write that move.
  const returns = (last, b0) => {
    const i = REP, tPc = rel(b0), W = LAB_STATS.joinWhy;
    if (!FL.joinFree) {
      const moves = oracleMoves(mode, rel(sop[i - 1]), rel(sop[i]), ferm.has(i + 1) || i === n - 1 ? 1 : 0, rel(last));
      if (moves[tPc] === undefined) { tally(W, 'oracle'); return false; }
      if (!concretize(mod12(b0), last).slice(0, 2).includes(b0)) { tally(W, 'octave'); return false; }
    } else if (Math.abs(b0 - last) > 12) { tally(W, 'beyond an octave'); return false; }
    if (!legal(i, last, b0, tPc)) { tally(W, 'rules'); return false; }
    return true;
  };
  // (lab) endLookahead: can a line at the penultimate chord still reach a
  // tonic the search is allowed to write?
  const reachesTonic = prev => {
    const i = n - 1, W = LAB_STATS.endWhy;
    const moves = oracleMoves(mode, rel(sop[i - 1]), rel(sop[i]), 1, rel(prev));
    if (moves[0] === undefined || !pairs.has(rel(sop[i]) * 12)) { tally(W, 'oracle'); return false; }
    for (const cand of concretize(tonicPc, prev).slice(0, 2)) if (legal(i, prev, cand, 0)) return true;
    tally(W, 'rules');
    return false;
  };
  let beams = [];
  for (const [p, c] of Object.entries(opens).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    if (!pairs.has(rel(sop[0]) * 12 + Number(p))) continue;
    const pc = mod12(Number(p) + tonicPc);
    for (const b0 of concretize(pc, 45).slice(0, 2))
      beams.push([Math.log1p(c) + uniform(rng, 0, temp), [b0]]);
  }
  for (let i = 1; i < n; i++) {
    const cad = ferm.has(i + 1) || i === n - 1 ? 1 : 0;
    const nxt = [];
    for (const [score, line] of beams) {
      const prev = line[line.length - 1];
      // (lab) literalRepeat: inside the Stollen's repeat a line repeats itself
      const fixed = REP && i >= REP && i < 2 * REP ? line[i - REP] : null;
      if (fixed !== null && i === REP && FL.joinFree) {
        // (lab) joinFree: the repeat starts over; its first bass note is
        // written as it stands, under the hard rules only
        if (Math.abs(fixed - prev) <= 12 && legal(i, prev, fixed, rel(fixed)))
          nxt.push([score + uniform(rng, 0, temp), line.concat([fixed])]);
        continue;
      }
      const moves = oracleMoves(mode, rel(sop[i - 1]), rel(sop[i]), cad, rel(prev));
      for (const [tPcS, cnt] of Object.entries(moves)) {
        const tPc = Number(tPcS);
        if (!pairs.has(rel(sop[i]) * 12 + tPc)) continue;
        const absPc = mod12(tPc + tonicPc);
        for (const cand of concretize(absPc, prev).slice(0, 2)) {
          if (fixed !== null && cand !== fixed) continue;
          let s = score + Math.log1p(cnt) + uniform(rng, 0, temp);
          const dm = cand - prev, ds = sop[i] - sop[i - 1];
          if (dm === 0 && ds === 0) s -= 0.2;
          if ((dm < 0 && ds > 0) || (ds < 0 && dm > 0)) s += 0.6;
          else if (dm === 0 || ds === 0) s += 0.2;
          const a = Math.abs(dm);
          if (!legal(i, prev, cand, tPc)) continue;
          if (REP && i === REP - 1 && !returns(cand, line[0])) continue;
          if (FL.endLookahead && i === n - 2 && !reachesTonic(cand)) continue;
          if (a === 6) s -= 1.0;
          s += (a === 1 || a === 2) ? 0.5 : a <= 4 ? 0.2 : a <= 7 ? 0.05 : -0.5;
          if (!scale.has(tPc) && a === 3) s -= 2.0;
          if (!scale.has(rel(prev)) && dm !== 1) s -= 2.0;
          const pcs = line.slice(-3).map(x => mod12(x)).concat([mod12(cand)]);
          if (pcs.length >= 4 && pcs[3] === pcs[1] && pcs[2] === pcs[0] && pcs[3] !== pcs[2])
            s -= 1.4;
          if (pcs.filter(p => p === mod12(cand)).length >= 3) s -= 0.8;
          if (cand < 40 || cand > 60) s -= 0.3;
          const ic = mod12(sop[i] - cand);
          if (ic === 1 || ic === 2 || ic === 11) s -= 2.5;
          if (i === n - 1 && mod12(cand) !== tonicPc) s -= 3.0;
          nxt.push([s, line.concat([cand])]);
        }
      }
    }
    nxt.sort((a, b) => b[0] - a[0]);
    beams = nxt.slice(0, beamWidth);
    if (!beams.length) { DIED_AT = i; return null; }
  }
  return FL._allBeams ? beams.map(b => b[1]) : beams[0][1];
}

// -------------------------------------------------------------- harmonize --

function voicings(chord, s, b, tonicPc) {
  const pcs = new Set(chord.pcs.map(p => mod12(p + tonicPc)));
  const forbid = new Set(
    [chord.lt, chord.seventh].filter(x => x !== null).map(p => mod12(p + tonicPc)));
  const out = [];
  for (let a = 53; a < 75; a++) {
    if (!pcs.has(mod12(a)) || a > s || s - a > 12) continue;
    for (let t = 48; t < 70; t++) {
      if (!pcs.has(mod12(t)) || t > a || a - t > 12 || t < b) continue;
      const quad = [mod12(s), mod12(a), mod12(t), mod12(b)];
      let bad = false;
      for (const f of forbid)
        if (quad.filter(p => p === f).length > 1) bad = true;
      if (bad) continue;
      let missing = 0;
      for (const p of pcs) if (!quad.includes(p)) missing++;
      out.push([a, t, missing]);
    }
  }
  return out;
}

const pairParallel = (p1a, p1b, p2a, p2b) => {
  const ic1 = mod12(p1a - p1b), ic2 = mod12(p2a - p2b);
  return (ic2 === 0 || ic2 === 7) && ic1 === ic2 && p2a !== p1a && p2b !== p1b &&
         (p2a > p1a) === (p2b > p1b);
};

function harmonize(sop, bass, fermatas, tonicPc, mode, beamWidth = 14) {
  const n = sop.length;
  const vocab = CHORDS[mode];
  const scale = SCALES[mode];
  const abspc = r => mod12(r + tonicPc);
  const fermSet = new Set(fermatas);
  const slots = [];
  for (let i = 0; i < n; i++) {
    const opts = [];
    for (let ci = 0; ci < vocab.length; ci++) {
      const ch = vocab[ci];
      const pcs = new Set(ch.pcs.map(abspc));
      if (!pcs.has(mod12(sop[i])) || !pcs.has(mod12(bass[i]))) continue;
      let cost = ch.pcs.length === 4 ? 0.5 : 0.0;
      if (isChromatic(ch, mode)) {
        const forced = !scale.has(mod12(sop[i] - tonicPc)) || !scale.has(mod12(bass[i] - tonicPc));
        const arrives = ch.target !== null && i + 1 < n &&
                        mod12(bass[i + 1]) === abspc(ch.target);
        if (!(forced || arrives)) continue;
        if (arrives && (fermSet.has(i + 2) || i + 1 === n - 1)) cost -= 0.8;
      }
      for (const [a, t, missing] of voicings(ch, sop[i], bass[i], tonicPc))
        opts.push([a, t, ci, missing + cost]);
    }
    if (!opts.length) return null;
    slots.push(opts);
  }
  // may alto and tenor move from pa, pt to a, t into chord i? (the hard rules)
  const legal = (i, pa, pt, a, t) => {
    const qp = [sop[i - 1], pa, pt, bass[i - 1]], qc = [sop[i], a, t, bass[i]];
    for (let x = 0; x < 4; x++)
      for (let y = x + 1; y < 4; y++)
        if (pairParallel(qp[x], qp[y], qc[x], qc[y])) return false;
    if (FL.innerRules) {
      // (lab) one rule for the inner voices, everywhere (fermatas too):
      // no leap of a seventh or more than an octave (the checker's rule)
      // and no augmented second (Python's rule: b6/#7, or a chromatic end)
      for (const [pp, cp] of [[pa, a], [pt, t]]) {
        const d = Math.abs(cp - pp);
        if (d === 10 || d === 11 || d > 12) return false;
        if (d === 3) {
          const r1 = mod12(pp - tonicPc), r2 = mod12(cp - tonicPc);
          if ((r1 === 8 && r2 === 11) || (r1 === 11 && r2 === 8) || !scale.has(r1) || !scale.has(r2)) return false;
        }
      }
    } else if (mode === 'minor' && !fermSet.has(i)) {
      for (const [pp, cp] of [[pa, a], [pt, t]]) {
        if (Math.abs(cp - pp) === 3) {
          const rel2 = new Set([mod12(pp - tonicPc), mod12(cp - tonicPc)]);
          if (rel2.has(8) && rel2.has(11)) return false;
        }
      }
    }
    return true;
  };
  let beams = slots[0].slice().sort((x, y) => x[3] - y[3]).slice(0, beamWidth)
    .map(([a, t, ci, c]) => [-c, [[a, t, ci]]]);
  for (let i = 1; i < n; i++) {
    const nxt = [];
    for (const [score, line] of beams) {
      const [pa, pt, pci] = line[line.length - 1];
      const pch = vocab[pci];
      const plt = pch.lt !== null ? abspc(pch.lt) : null;
      const psev = pch.seventh !== null ? abspc(pch.seventh) : null;
      const ptarget = pch.target !== null ? abspc(pch.target) : null;
      // (lab) literalRepeat: inside the Stollen's repeat a line repeats itself
      const fixed = REP && i >= REP && i < 2 * REP ? line[i - REP] : null;
      for (const [a, t, ci, cost] of slots[i]) {
        if (fixed && (a !== fixed[0] || t !== fixed[1] || ci !== fixed[2])) continue;
        const ch = vocab[ci];
        const curPcs = new Set(ch.pcs.map(abspc));
        const targetMissed = ptarget !== null && !curPcs.has(ptarget);
        const qp = [sop[i - 1], pa, pt, bass[i - 1]], qc = [sop[i], a, t, bass[i]];
        if (!legal(i, pa, pt, a, t)) continue;
        if (REP && i === REP - 1 && !legal(REP, a, t, line[0][0], line[0][1])) continue;
        let s = score - cost;
        if (targetMissed) s -= 3.0;
        s -= 0.25 * (Math.abs(a - pa) + Math.abs(t - pt));
        if (a === pa) s += 0.3;
        if (t === pt) s += 0.3;
        if (Math.abs(a - pa) > 7 || Math.abs(t - pt) > 7) s -= 1.0;
        if (a > sop[i - 1] || t > pa || t < bass[i - 1]) s -= 1.2;
        if (ptarget !== null && mod12(bass[i]) === ptarget) s += 1.5;
        for (const [pp, cp] of [[pa, a], [pt, t]]) {
          if (plt !== null && mod12(pp) === plt) s += cp - pp === 1 ? 0.8 : -2.0;
          if (psev !== null && mod12(pp) === psev)
            s += (cp - pp <= -1 && cp - pp >= -2) ? 0.5 : -2.5;
        }
        if (plt !== null && mod12(bass[i - 1]) === plt && bass[i] - bass[i - 1] !== 1) s -= 2.0;
        if (psev !== null && mod12(bass[i - 1]) === psev &&
            !(bass[i] - bass[i - 1] <= -1 && bass[i] - bass[i - 1] >= -2)) s -= 2.5;
        if (plt !== null && mod12(sop[i - 1]) === plt && sop[i] - sop[i - 1] !== 1) s -= 1.5;
        // false relation
        for (let vi = 0; vi < 4; vi++) {
          const crel = mod12(qc[vi] - tonicPc);
          if (scale.has(crel)) continue;
          for (const nat of [qc[vi] - 1, qc[vi] + 1]) {
            if (!scale.has(mod12(nat - tonicPc))) continue;
            for (let vj = 0; vj < 4; vj++)
              if (vj !== vi && mod12(qp[vj]) === mod12(nat)) s -= 1.5;
          }
        }
        nxt.push([s, line.concat([[a, t, ci]])]);
      }
    }
    nxt.sort((a, b) => b[0] - a[0]);
    beams = nxt.slice(0, beamWidth);
    if (!beams.length) { DIED_AT = i; return null; }
  }
  return beams[0][1].map(([a, t]) => [a, t]);
}

// (lab) exactInner: the same hard rejects and the same per-step scoring as
// harmonize(), maximized exactly by Viterbi instead of a width-14 beam. The
// score only depends on the previous and current (alto, tenor, chord) state,
// so dynamic programming finds the true best path, or proves none exists.
function harmonizeExact(sop, bass, fermatas, tonicPc, mode) {
  if (REP) throw new Error('exactInner cannot copy the Stollen: the copy depends on the path');
  const n = sop.length;
  const vocab = CHORDS[mode];
  const scale = SCALES[mode];
  const abspc = r => mod12(r + tonicPc);
  const fermSet = new Set(fermatas);
  const slots = [];
  for (let i = 0; i < n; i++) {
    const opts = [];
    for (let ci = 0; ci < vocab.length; ci++) {
      const ch = vocab[ci];
      const pcs = new Set(ch.pcs.map(abspc));
      if (!pcs.has(mod12(sop[i])) || !pcs.has(mod12(bass[i]))) continue;
      let cost = ch.pcs.length === 4 ? 0.5 : 0.0;
      if (isChromatic(ch, mode)) {
        const forced = !scale.has(mod12(sop[i] - tonicPc)) || !scale.has(mod12(bass[i] - tonicPc));
        const arrives = ch.target !== null && i + 1 < n &&
                        mod12(bass[i + 1]) === abspc(ch.target);
        if (!(forced || arrives)) continue;
        if (arrives && (fermSet.has(i + 2) || i + 1 === n - 1)) cost -= 0.8;
      }
      for (const [a, t, missing] of voicings(ch, sop[i], bass[i], tonicPc))
        opts.push([a, t, ci, missing + cost]);
    }
    if (!opts.length) return null;
    slots.push(opts);
  }
  let score = slots[0].map(o => -o[3]);
  const back = [null];
  for (let i = 1; i < n; i++) {
    const cur = new Array(slots[i].length).fill(-Infinity);
    const bp = new Array(slots[i].length).fill(-1);
    for (let k = 0; k < slots[i - 1].length; k++) {
      if (score[k] === -Infinity) continue;
      const [pa, pt, pci] = slots[i - 1][k];
      const pch = vocab[pci];
      const plt = pch.lt !== null ? abspc(pch.lt) : null;
      const psev = pch.seventh !== null ? abspc(pch.seventh) : null;
      const ptarget = pch.target !== null ? abspc(pch.target) : null;
      for (let j = 0; j < slots[i].length; j++) {
        const [a, t, ci, cost] = slots[i][j];
        const ch = vocab[ci];
        const curPcs = new Set(ch.pcs.map(abspc));
        const targetMissed = ptarget !== null && !curPcs.has(ptarget);
        let bad = false;
        const qp = [sop[i - 1], pa, pt, bass[i - 1]], qc = [sop[i], a, t, bass[i]];
        for (let x = 0; x < 4 && !bad; x++)
          for (let y = x + 1; y < 4; y++)
            if (pairParallel(qp[x], qp[y], qc[x], qc[y])) { bad = true; break; }
        if (!bad && FL.innerRules) {
          // (lab) one rule for the inner voices, everywhere (fermatas too):
          // no leap of a seventh or more than an octave (the checker's rule)
          // and no augmented second (Python's rule: b6/#7, or a chromatic end)
          for (const [pp, cp] of [[pa, a], [pt, t]]) {
            const d = Math.abs(cp - pp);
            if (d === 10 || d === 11 || d > 12) bad = true;
            if (d === 3) {
              const r1 = mod12(pp - tonicPc), r2 = mod12(cp - tonicPc);
              if ((r1 === 8 && r2 === 11) || (r1 === 11 && r2 === 8) || !scale.has(r1) || !scale.has(r2)) bad = true;
            }
          }
        } else if (!bad && mode === 'minor' && !fermSet.has(i)) {
          for (const [pp, cp] of [[pa, a], [pt, t]]) {
            if (Math.abs(cp - pp) === 3) {
              const rel2 = new Set([mod12(pp - tonicPc), mod12(cp - tonicPc)]);
              if (rel2.has(8) && rel2.has(11)) bad = true;
            }
          }
        }
        if (bad) continue;
        let s = score[k] - cost;
        if (targetMissed) s -= 3.0;
        s -= 0.25 * (Math.abs(a - pa) + Math.abs(t - pt));
        if (a === pa) s += 0.3;
        if (t === pt) s += 0.3;
        if (Math.abs(a - pa) > 7 || Math.abs(t - pt) > 7) s -= 1.0;
        if (a > sop[i - 1] || t > pa || t < bass[i - 1]) s -= 1.2;
        if (ptarget !== null && mod12(bass[i]) === ptarget) s += 1.5;
        for (const [pp, cp] of [[pa, a], [pt, t]]) {
          if (plt !== null && mod12(pp) === plt) s += cp - pp === 1 ? 0.8 : -2.0;
          if (psev !== null && mod12(pp) === psev)
            s += (cp - pp <= -1 && cp - pp >= -2) ? 0.5 : -2.5;
        }
        if (plt !== null && mod12(bass[i - 1]) === plt && bass[i] - bass[i - 1] !== 1) s -= 2.0;
        if (psev !== null && mod12(bass[i - 1]) === psev &&
            !(bass[i] - bass[i - 1] <= -1 && bass[i] - bass[i - 1] >= -2)) s -= 2.5;
        if (plt !== null && mod12(sop[i - 1]) === plt && sop[i] - sop[i - 1] !== 1) s -= 1.5;
        for (let vi = 0; vi < 4; vi++) {
          const crel = mod12(qc[vi] - tonicPc);
          if (scale.has(crel)) continue;
          for (const nat of [qc[vi] - 1, qc[vi] + 1]) {
            if (!scale.has(mod12(nat - tonicPc))) continue;
            for (let vj = 0; vj < 4; vj++)
              if (vj !== vi && mod12(qp[vj]) === mod12(nat)) s -= 1.5;
          }
        }
        if (s > cur[j]) { cur[j] = s; bp[j] = k; }
      }
    }
    if (cur.every(x => x === -Infinity)) return null;
    score = cur;
    back.push(bp);
  }
  let j = 0;
  for (let x = 1; x < score.length; x++) if (score[x] > score[j]) j = x;
  if (score[j] === -Infinity) return null;
  const path = [];
  for (let i = n - 1; i >= 0; i--) {
    path.push([slots[i][j][0], slots[i][j][1]]);
    if (i > 0) j = back[i][j];
  }
  return path.reverse();
}

// -------------------------------------------------------------- ornament --

function rate(section, voiceName, keyYes, keyNo) {
  const c = ORN[section][voiceName] || {};
  const yes = c[keyYes] || 0, no = c[keyNo] || 0;
  return yes / Math.max(yes + no, 1);
}
const ORN_VOICE = { s: 'soprano', a: 'alto', t: 'tenor', b: 'bass' };

function diatonicBetween(x, z, scale) {
  const lo = Math.min(x, z), hi = Math.max(x, z);
  const cands = [];
  for (let m = lo + 1; m < hi; m++)
    if (scale.has(mod12(m)) && m - lo >= 1 && m - lo <= 2 && hi - m >= 1 && hi - m <= 2)
      cands.push(m);
  return cands.length === 1 ? cands[0] : (cands.length ? cands[cands.length - 1] : null);
}
function diatonicBelow(x, scale) {
  for (const d of [1, 2]) if (scale.has(mod12(x - d))) return x - d;
  return null;
}

function ornament(skel, tonicPc, mode, fermatas, density, rng) {
  const scaleAbs = new Set([...SCALES[mode]].map(d => mod12(tonicPc + d)));
  const n = skel.s.length;
  const fermSet = new Set(fermatas);
  const events = {};
  for (const vn of VOICES) events[vn] = skel[vn].map(m => [[m, 2]]);
  const claimed = {};
  for (const vn of VOICES) claimed[vn] = new Array(n).fill(false);

  const build = () => {
    const out = {};
    for (const vn of VOICES) out[vn] = events[vn].flat().map(e => [e[0], e[1]]);
    return out;
  };
  const noiseOf = ev => {
    const { V, noise } = checkSurface(ev, skel, tonicPc, mode, fermatas);
    return { V, noise };
  };

  // (lab) literalRepeat: an ornament in the Stollen is written into its
  // repeat too, and the repeat's own slots are never drawn for
  const mirror = i => REP && i >= REP && i < 2 * REP;
  const tryApply = (vn, slotIdx, newSlot) => {
    const twin = REP && slotIdx < REP ? slotIdx + REP : -1;
    const old = events[vn][slotIdx], oldTwin = twin >= 0 ? events[vn][twin] : null;
    const before = noiseOf(build()).noise;
    events[vn][slotIdx] = newSlot;
    if (twin >= 0) events[vn][twin] = newSlot;
    const { V, noise } = noiseOf(build());
    if (V.length || noise > before) {
      events[vn][slotIdx] = old;
      if (twin >= 0) events[vn][twin] = oldTwin;
      return false;
    }
    claimed[vn][slotIdx] = true;
    if (twin >= 0) claimed[vn][twin] = true;
    return true;
  };

  // suspensions (S, A, T)
  for (const vn of ['s', 'a', 't']) {
    const p = rate('suspensions', ORN_VOICE[vn], 'sus', 'opportunity');
    for (let i = 1; i < n; i++) {
      if (claimed[vn][i] || claimed[vn][i - 1] || fermSet.has(i + 1) || mirror(i)) continue;
      const prev = skel[vn][i - 1], cur = skel[vn][i];
      if (!(prev - cur >= 1 && prev - cur <= 2)) continue;
      const iv = mod12(prev - skel.b[i]);
      if (![1, 2, 5, 10, 11].includes(iv)) continue;
      if (rng() < Math.min(1, p * density * 4))
        tryApply(vn, i, [[prev, 1], [cur, 1]]);
    }
  }
  // passing tones
  for (const vn of ['b', 't', 'a', 's']) {
    for (let i = 0; i < n - 1; i++) {
      if (claimed[vn][i] || fermSet.has(i + 1) || mirror(i)) continue;
      const x = skel[vn][i], z = skel[vn][i + 1];
      if (Math.abs(z - x) !== 3 && Math.abs(z - x) !== 4) continue;
      const mid = diatonicBetween(x, z, scaleAbs);
      if (mid === null) continue;
      const key = z > x ? 'third_up' : 'third_down';
      const p = rate('fills', ORN_VOICE[vn], `${key}_filled`, `${key}_plain`);
      if (rng() < Math.min(1, p * density))
        tryApply(vn, i, [[x, 1], [mid, 1]]);
    }
  }
  // lower neighbors
  for (const vn of ['b', 'a', 't', 's']) {
    const p = rate('neighbors', ORN_VOICE[vn], 'neighbor', 'plain');
    for (let i = 0; i < n - 1; i++) {
      if (claimed[vn][i] || fermSet.has(i + 1) || mirror(i)) continue;
      if (skel[vn][i] !== skel[vn][i + 1]) continue;
      const nb = diatonicBelow(skel[vn][i], scaleAbs);
      if (nb === null) continue;
      if (rng() < Math.min(1, p * density))
        tryApply(vn, i, [[skel[vn][i], 1], [nb, 1]]);
    }
  }
  // soprano anticipation into cadences
  const pAnt = rate('anticipations', 'soprano', 'ant', 'plain');
  for (const f of fermatas) {
    const i = f - 2;
    if (i < 0 || claimed.s[i] || mirror(i)) continue;
    const x = skel.s[i], z = skel.s[i + 1];
    if (Math.abs(x - z) >= 1 && Math.abs(x - z) <= 2 && rng() < Math.min(1, pAnt * density * 4))
      tryApply('s', i, [[x, 1], [z, 1]]);
  }
  return build();
}

// -------------------------------------------------------------- compose --

const KEYS = [
  ['C', 0], ['D', 2], ['Eb', 3], ['F', 5], ['G', 7], ['A', 9], ['Bb', 10],
];

// composePiece(n): the plate number is the seed. Deterministic forever.
export function composePiece(pieceNumber, density = 1.0) {
  const paramRng = mulberry32(pieceNumber * 2654435761 + 1);
  const [tonicName, tonicPc] = choice(paramRng, KEYS);
  const mode = paramRng() < 0.45 ? 'minor' : 'major';
  const phrases = choice(paramRng, [2, 3, 3, 4]);

  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = mulberry32(pieceNumber * 1000 + attempt * 7 + 13);
    const { pitches: sop, fermatas } = melody(tonicPc, mode, phrases, rng);
    const bass = bassLine(sop, fermatas, tonicPc, mode, rng, 10, 0.15 * attempt);
    if (!bass) continue;
    const inner = harmonize(sop, bass, fermatas, tonicPc, mode);
    if (!inner) continue;
    const skel = {
      s: sop, a: inner.map(x => x[0]), t: inner.map(x => x[1]), b: bass,
    };
    const { V, W } = checkChorale(skel, tonicPc, mode, fermatas);
    if (V.length) continue;
    const events = ornament(skel, tonicPc, mode, fermatas, density, rng);
    const surface = checkSurface(events, skel, tonicPc, mode, fermatas);
    if (surface.V.length) continue;
    let total = 0;
    for (const [, ln] of events.s) total += ln;
    return {
      number: pieceNumber,
      key: `${tonicName} ${mode}`,
      tonicPc, mode, phrases,
      events,                       // {s,a,t,b}: [[midi, eighths], ...]
      skeleton: skel,
      fermataEighths: fermatas.map(f => 2 * (f - 1)),
      totalEighths: total,
      violations: 0,
      warnings: W.length,
      attempt,
    };
  }
  return null;                      // caller advances to the next number
}

// ------------------------------------------------------------------ lab --

// (lab) splitmixSeed: Edition 2's seeds, an integer hash of the address
const M64 = (1n << 64n) - 1n;
function splitmix64(x) {
  x = (x + 0x9E3779B97F4A7C15n) & M64;
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return z ^ (z >> 31n);
}
const seedOf = (n, stream) =>
  Number(splitmix64(BigInt(Math.floor(n)) * 64n + BigInt(stream)) & 0xFFFFFFFFn);

// composePieceLab(n, flags, trace): composePiece with the review's flags.
// trace (optional array) receives one record per draft:
//   { attempt, bassTry, stage: 'bass'|'inner'|'checker'|'surface'|'kept', V? }
export function composePieceLab(pieceNumber, flags = {}, trace = null, density = 1.0) {
  FL = flags;
  try {
    const paramRng = mulberry32(flags.splitmixSeed ? seedOf(pieceNumber, 0) : pieceNumber * 2654435761 + 1);
    const [tonicName, tonicPc] = choice(paramRng, KEYS);
    const mode = paramRng() < 0.45 ? 'minor' : 'major';
    const phrases = choice(paramRng, [2, 3, 3, 4]);
    const melodyFn = flags.melodyFn || melody;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rng = mulberry32(flags.splitmixSeed ? seedOf(pieceNumber, attempt + 1)
        : pieceNumber * 1000 + attempt * 7 + 13);
      const mel = melodyFn(tonicPc, mode, phrases, rng);
      if (!mel) { if (trace) trace.push({ attempt, bassTry: 0, stage: 'melody' }); continue; }
      const { pitches: sop, fermatas } = mel;
      REP = flags.literalRepeat && mel.form ? mel.form.stollenChords : 0;
      if (sop.some(x => x === undefined)) {       // the shipped planner can emit these
        if (trace) trace.push({ attempt, bassTry: 0, stage: 'bass', undef: true });
        continue;
      }
      let basses;
      if (flags.bassFallback) {
        FL = { ...flags, _allBeams: true };
        basses = bassLine(sop, fermatas, tonicPc, mode, rng, flags.bassWidth || 10, 0.15 * attempt);
        FL = flags;
      } else {
        const b = bassLine(sop, fermatas, tonicPc, mode, rng, flags.bassWidth || 10, 0.15 * attempt);
        basses = b ? [b] : null;
      }
      if (!basses) {
        if (trace) trace.push({ attempt, bassTry: 0, stage: 'bass', at: DIED_AT, rep: REP, fermatas });
        continue;
      }
      for (let bi = 0; bi < basses.length; bi++) {
        const bass = basses[bi];
        const inner = flags.exactInner
          ? harmonizeExact(sop, bass, fermatas, tonicPc, mode)
          : harmonize(sop, bass, fermatas, tonicPc, mode, flags.innerWidth || 14);
        if (!inner) {
          if (trace) trace.push({ attempt, bassTry: bi, stage: 'inner', at: DIED_AT, rep: REP, fermatas });
          continue;
        }
        const skel = { s: sop, a: inner.map(x => x[0]), t: inner.map(x => x[1]), b: bass };
        const { V, W } = checkChorale(skel, tonicPc, mode, fermatas);
        if (V.length) { if (trace) trace.push({ attempt, bassTry: bi, stage: 'checker', V }); continue; }
        const events = ornament(skel, tonicPc, mode, fermatas, density, rng);
        const surface = checkSurface(events, skel, tonicPc, mode, fermatas);
        if (surface.V.length) {
          if (trace) trace.push({ attempt, bassTry: bi, stage: 'surface', V: surface.V });
          continue;
        }
        let total = 0;
        for (const [, ln] of events.s) total += ln;
        if (trace) trace.push({ attempt, bassTry: bi, stage: 'kept' });
        return {
          number: pieceNumber, key: `${tonicName} ${mode}`, tonicPc, mode, phrases,
          events, skeleton: skel, fermatas,
          fermataEighths: fermatas.map(f => 2 * (f - 1)),
          totalEighths: total, violations: 0, warnings: W.length, W, attempt, bassTry: bi,
          form: mel.form,
        };
      }
    }
    return null;
  } finally {
    FL = {};
    REP = 0;
  }
}

export { melody, bassLine, harmonize, harmonizeExact, ornament, checkSurface,
         mulberry32, choice, weightedChoice, uniform, KEYS, CHORDS, SCALES,
         pairParallel, voicings, MELODY, ORACLE };

// run fn with the lab flags active (for experiments that call internals)
export function withLabFlags(flags, fn) {
  const prev = FL; FL = flags;
  try { return fn(); } finally { FL = prev; }
}
