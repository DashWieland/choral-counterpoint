// Bar-form (AAB) chorale-tune planner for the 2026-09 engine review.
//
// A drop-in replacement for engine.lab.mjs melody(): pass it as
// flags.melodyFn. Same signature, barformMelody(tonicPc, mode, nPhrases, rng),
// same return shape { pitches, fermatas } plus a `form` record that the
// measurement scripts read (the engine ignores it).
//
// FORM. The address's phrase count (2, 3, 3, 4) sets the size of the form:
//   nPhrases 2 -> Stollen of 1 phrase,  Abgesang of 2 new phrases: A A B C
//   nPhrases 3 -> Stollen of 2 phrases, Abgesang of 2 new phrases: A B A B C D
//   nPhrases 4 -> Stollen of 2 phrases, Abgesang of 3 new phrases: A B A B C D E
// The Stollen is repeated literally. When the Stollen closes on the tonic,
// 40% of tunes are Reprisenbar: the Abgesang ends with the Stollen's closing
// phrase again (A A B C A, A B A B C D B, A B A B C D E B), which then is the
// final cadence. So a tune has 4-8 phrases; the Stollen and its repeat are
// the first 2*S phrases.
//
// PHRASES. Lengths come from a hymn meter (8.7, 7.6, 8.8.7, 8, 7 or 6
// notes per line) so every phrase has 6-8 notes and the lengths recur the
// way a strophic text's lines do. Every phrase ends in one of Bach's cadence
// formulas (MELODY.cadences, count >= 5), placed as a unit inside the tune's
// ambitus and never entered by a tritone or an augmented second. The notes
// before the formula are drawn from the corpus transition weights
// (MELODY.transitions, which include the repeated note; the interval into
// the formula is weighted too), times Bach's soprano degree profile
// (ORACLE.arrivals), pulled toward the phrase's contour: an arch (a peak
// inside the phrase), a descent from the opening, or an ascent into the
// cadence. Every legal completion of the free notes is enumerated (a phrase
// has at most four) and one is drawn in proportion to the product of those
// weights, so every hard rule below holds by construction. The prototype
// filled them by a depth-first search instead, which fell back on whatever
// was left after a dead end, mostly thirds and leaps: its tunes moved by a
// third 14% of the time, against about 8% in Bach's (counted chord to chord
// in the oracle's corpus); drawn this way, 11%. The opening note and an
// arch's peak are also weighted by the distance they leave the free notes
// to cover, so a phrase can mostly be walked by step.
//
// ONE CLIMAX. The tune's highest note is chosen first (the upper tonic,
// ninth or tenth in an authentic tune; the upper fifth, sixth or octave in a
// plagal one; the third, fourth or fifth above the final in C and D) and
// placed exactly once, at the peak of an Abgesang phrase.
// Every other note of the tune lies below it, so the repeated Stollen never
// reaches it.
//
// AMBITUS. Eb and F are authentic (tonic to tonic, a step below allowed);
// G, A and Bb are plagal (the dominant below to the dominant above). C and D
// end on the upper tonic (C5, D5) inside a frame from the sixth below it to
// the third above. No cadence note lies below Eb4 and no note below D4, so
// every tune sits inside D4-G5. Ending C and D tunes on C4 and D4 instead
// (BARFORM_OPTS.lowCD, measured with the bass kept a third below the
// soprano) loses first drafts in those keys (C 97% to 93%, D 98% to 94%)
// and sets the whole choir about three semitones lower.
//
// REGISTER. Each phrase aims its cadence at a register: the Stollen starts
// low, the climax phrase cadences a fourth or so under the climax, the last
// new phrase comes back to the middle, and the final lands on the tonic.
//
// WHAT IT ALLOWS THAT THE SHIPPED PLANNER FORBIDS
//   - repeated notes, weighted by the corpus (one per phrase line, plus any
//     the cadence formula has; never three in a row, also across a fermata)
//   - a third followed by a step in the same direction (C-E-F)
//   - two leaps in the same direction when all three notes belong to the
//     tonic or dominant triad and span at most a sixth (C-E-G, G-B-D, G-C-E)
//   - a leap of up to a sixth into the first note of a phrase (after a
//     fermata); the next note then steps back
//   - the rising fourth from the dominant to the tonic continuing upward by
//     step (G-C-D)
//   - a tonic cadence at the end of the Stollen (and on its first phrase)
// WHAT IT STILL FORBIDS
//   - the melodic tritone and the augmented second, everywhere (inside
//     phrases, into formulas, across fermatas)
//   - sixths inside a phrase, sevenths and octaves anywhere
//   - after a fourth or fifth, continuing the same way (except the triad and
//     5-1-2 cases above), also when a repeated note intervenes; after a
//     sixth, anything but a step back
//   - three leaps in a row; after two same-way leaps, anything but a step
//   - more than two leaps in a phrase line, or more than one of a fourth
//     or more; a phrase spanning less than a major third
//   - two-note oscillation (x y x y)
//   - free notes outside the diatonic scale (natural minor); chromatic notes
//     enter only through Bach's formulas, as in the shipped planner, and the
//     two notes before such a formula avoid its diatonic twin (no Bb A B)
//   - Bach's one static formula, minor 0,0,0
//
// Deterministic given rng: every random choice goes through it.

import { MELODY, ORACLE, weightedChoice } from './engine.lab.mjs';

const mod12 = x => ((x % 12) + 12) % 12;
const bucketOf = iv => iv === 0 ? 'rep'
  : (iv > 0 ? 'u' : 'd') + (Math.abs(iv) <= 2 ? '1' : Math.abs(iv) <= 4 ? '2' : '3');

// counters for the measurement scripts (never read by the planner itself)
export const BARFORM_STATS = { tunes: 0, phraseRetries: 0, restarts: 0, paths: 0 };
// experiment knobs for the measurement scripts (the defaults are the planner)
//   travel  semitones per interval a phrase's free notes may cover before the
//           opening or peak that asks for more is weighted down (0 = off)
//   lowCD   C and D tunes end on C4 and D4 (measured and not adopted)
export const BARFORM_OPTS = { travel: 1.2, lowCD: false };
// the weight of a choice that leaves d semitones to cover in k intervals
const travelW = (d, k) => {
  if (!BARFORM_OPTS.travel) return 1;
  const excess = Math.max(0, d - BARFORM_OPTS.travel * k);
  return Math.exp(-excess * excess / 2);
};

const pickW = (rng, pairs) => {
  const ok = pairs.filter(p => p[1] > 0);
  return weightedChoice(rng, ok.map(p => p[0]), ok.map(p => p[1]));
};

const METERS = [
  [[8, 7], 3],       // 8.7.8.7
  [[7, 6], 3],       // 7.6.7.6
  [[8, 8, 7], 2],    // 8.8.7
  [[8], 2],          // long metre lines
  [[7], 2],
  [[6], 1],
];

// ------------------------------------------------------------------- key --

function makeKey(tonicPc, mode) {
  const major = mode === 'major';
  const DEG = major ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const deg = m => mod12(m - tonicPc);
  const T4 = 60 + tonicPc;
  const frame = T4 <= 62 ? (BARFORM_OPTS.lowCD ? 'authentic' : 'high') : T4 >= 67 ? 'plagal' : 'authentic';
  const T = frame === 'high' ? T4 + 12 : T4;       // the final: Eb4..Bb4, C5, D5
  const [lo, hi] = frame === 'high' ? [T - 8, T + 4] : frame === 'plagal' ? [T - 5, T + 7] : [T, T + 12];
  const floor = Math.max(BARFORM_OPTS.lowCD ? 60 : 62, lo - 2);
  const window = [];
  for (let m = floor; m <= 79; m++) if (DEG.includes(deg(m))) window.push(m);
  const triads = major ? [[0, 4, 7], [7, 11, 2]] : [[0, 3, 7], [7, 11, 2], [7, 10, 2]];
  const tonicTriad = major ? [0, 4, 7] : [0, 3, 7];
  const formulas = {};
  for (const [k, c] of Object.entries(MELODY.cadences[mode] || {})) {
    if (c < 5) continue;
    const degs = k.split(',').map(Number);
    if (degs[0] === degs[1] && degs[1] === degs[2]) continue;    // a static cadence (minor 0,0,0)
    (formulas[degs[2]] = formulas[degs[2]] || []).push({ degs, count: c });
  }
  const openings = MELODY.phrase_openings[mode] || {};
  return {
    mode, major, tonicPc, deg, T, frame, lo, hi, floor, window, formulas,
    mid: (lo + hi) / 2,
    inTonicTriad: m => tonicTriad.includes(deg(m)),
    oneTriad: (...ms) => triads.some(t => ms.every(m => t.includes(deg(m)))),
    aug2: (a, b) => !major && Math.abs(a - b) === 3 &&
      ((deg(a) === 8 && deg(b) === 11) || (deg(a) === 11 && deg(b) === 8)),
    opening: m => (openings[String(deg(m))] || 0) + 5,
  };
}

// ------------------------------------------------------- melodic grammar --

// a phrase-boundary interval (last note of a phrase -> first note of the next)
function boundaryOK(K, a, b) {
  const d = Math.abs(b - a);
  return d <= 9 && d !== 6 && !K.aug2(a, b);
}
// an interval inside a phrase: unison to fourth, or a fifth
function innerOK(K, a, b) {
  const d = Math.abs(b - a);
  return (d <= 5 || d === 7) && !K.aug2(a, b);
}
const cadenceFloor = () => BARFORM_OPTS.lowCD ? 60 : 63;   // no fermata on C4-D4 (see AMBITUS)
const BOUNDARY_W = { 0: 4, 1: 4, 2: 4, 3: 2.2, 4: 2.2, 5: 1.5, 7: 1, 8: 0.5, 9: 0.5 };

// chromatic degree -> the diatonic degree with the same letter
const TWIN = {
  major: { 1: 0, 3: 4, 6: 5, 8: 7, 10: 11 },
  minor: { 11: 10, 9: 8, 4: 3, 6: 5, 1: 2 },
};

// corpus weight of interval iv at phrase position j (of L) after interval p.
// The second note of a phrase has no interval before it inside the phrase
// (the corpus counts from the third note on), so it gets the early-phrase
// distribution summed over every context.
const EARLY_ANY = {};
for (const mode of ['major', 'minor']) {
  const acc = {};
  for (const [k, t] of Object.entries(MELODY.transitions))
    if (k.startsWith(mode + '|') && k.endsWith('|early'))
      for (const [iv, c] of Object.entries(t)) acc[iv] = (acc[iv] || 0) + c;
  EARLY_ANY[mode] = acc;
}
function corpusW(mode, j, L, p, iv) {
  let table;
  if (j <= 1 || p === null) table = EARLY_ANY[mode];
  else {
    const frac = j / L;
    const posb = frac < 0.4 ? 'early' : frac < 0.8 ? 'mid' : 'late';
    table = MELODY.transitions[`${mode}|${bucketOf(Math.max(-7, Math.min(7, p)))}|${posb}`] || {};
  }
  let tot = TOTALS.get(table);
  if (tot === undefined) {
    tot = 0;
    for (const c of Object.values(table)) tot += c;
    TOTALS.set(table, tot);
  }
  return ((table[String(Math.max(-7, Math.min(7, iv)))] || 0) + 0.5) / (tot + 7.5);
}
const TOTALS = new Map();

// Bach's soprano pitch profile: how often each scale degree carries a
// soprano onset (ORACLE.arrivals), relative to an even spread over the seven
// scale degrees. The interval tables know nothing about degrees, so without
// this the free notes over-use the leading tone and under-use the fourth.
const DEGREE_PRIOR = {};
for (const mode of ['major', 'minor']) {
  const c = {};
  let tot = 0;
  for (const [k, v] of Object.entries(ORACLE.arrivals)) {
    const [m, d] = k.split('|');
    if (m !== mode) continue;
    for (const n of Object.values(v)) { c[d] = (c[d] || 0) + n; tot += n; }
  }
  DEGREE_PRIOR[mode] = Object.fromEntries(Object.entries(c).map(([d, n]) => [d, 7 * n / tot]));
}

// may note c follow b, given the previous interval p = b - a and the one
// before it, pp? (a and the intervals may be null at the start of the tune)
function legalMotion(K, a, b, c, p, pp) {
  if (p === null || p === undefined) return true;
  const q = c - b, aq = Math.abs(q), ap = Math.abs(p);
  if (p === 0 && pp !== null && pp !== undefined && Math.abs(pp) >= 5) {
    // a fourth or more, then a repeated note: the recovery is still owed
    const back = pp * q < 0;
    if (Math.abs(pp) >= 8) return back && aq <= 2;           // after a sixth: step back
    return aq <= 2 || (back && aq <= 4);                     // a step, or a third back
  }
  const same = p * q > 0, opp = p * q < 0;
  const ppLeap = pp !== null && pp !== undefined && Math.abs(pp) >= 3;
  if (ppLeap && ap >= 3 && aq >= 3) return false;           // three leaps in a row
  if (ppLeap && ap >= 3 && pp * p > 0)                       // after an arpeggio: a step,
    return aq <= 2 && (Math.abs(pp + p) < 8 || opp);         //   turning back if it spans a sixth
  // two same-way leaps (thirds or fourths) inside one tonic or dominant
  // triad, spanning at most a sixth: C-E-G, G-B-D, E-G-C, G-C-E
  const arpeggio = same && ap >= 3 && ap <= 5 && aq >= 3 && aq <= 5 &&
    K.oneTriad(a, b, c) && Math.abs(c - a) <= 9;
  if (ap >= 8) return opp && aq <= 2;                        // after a sixth: step back
  if (ap >= 5) {                                             // after a fourth or fifth
    if (opp) return aq <= 4;
    if (q === 0 || arpeggio) return true;
    return same && aq <= 2 && p === 5 && K.deg(a) === 7 && K.deg(b) === 0;   // 5-1-2
  }
  if (ap >= 3) {                                             // after a third
    if (!same) return aq <= 5;
    return aq <= 2 || arpeggio;
  }
  return true;
}

// can a phrase ending ...e1, e be followed by the (already written) phrase `nxt`?
function connectOK(K, e1, e, nxt) {
  if (!boundaryOK(K, e, nxt[0])) return false;
  if (e === nxt[0] && (e1 === e || nxt[1] === e)) return false;      // three in a row
  const p = nxt[0] - e;
  return legalMotion(K, e, nxt[0], nxt[1], p, null) &&
         legalMotion(K, nxt[0], nxt[1], nxt[2], nxt[1] - nxt[0], p);
}

// -------------------------------------------------------------- formulas --

function placeNearest(K, e0, degs) {
  const out = [e0];
  for (let j = 1; j < degs.length; j++) {
    const prev = out[j - 1];
    let best = null;
    for (let m = prev - 6; m <= prev + 6; m++)
      if (K.deg(m) === degs[j] && (best === null || Math.abs(m - prev) <= Math.abs(best - prev))) best = m;
    out.push(best);
  }
  return out;
}

function placements(K, spec) {
  const out = [];
  const limit = spec.ceil;
  for (const { degs, count } of K.formulas[spec.target] || []) {
    for (let e0 = K.floor; e0 <= limit; e0++) {
      if (K.deg(e0) !== degs[0]) continue;
      const notes = placeNearest(K, e0, degs);
      if (notes.some(m => m === null || m < K.floor || m > limit)) continue;
      let ok = true;
      for (let j = 1; j < 3; j++) {
        const d = Math.abs(notes[j] - notes[j - 1]);
        if (d === 6 || d > 7 || K.aug2(notes[j - 1], notes[j])) ok = false;
      }
      if (!ok) continue;
      if (notes[2] < cadenceFloor()) continue;
      if (spec.finalSet && !spec.finalSet.some(([m]) => m === notes[2])) continue;
      if (spec.next && spec.next !== 'self' && !connectOK(K, notes[1], notes[2], spec.next)) continue;
      let w = count * Math.exp(-Math.abs(e0 - spec.center) / 5);
      if (spec.finalSet) w *= spec.finalSet.find(([m]) => m === notes[2])[1];
      out.push([{ notes, degs }, w]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- phrase --

// spec: { L, target, prevLast, prevPrev, ceil, climax, contourW, first, finalSet,
//         next ('self' | notes of the phrase that follows | null), center }
function composePhrase(K, spec, rng) {
  const L = spec.L, F = L - 3;                 // free notes at 0..F-1, formula at F..L-1
  const places = placements(K, spec);
  if (!places.length) return null;
  for (let t = 0; t < 30; t++) {
    if (t) BARFORM_STATS.phraseRetries++;
    const contour = spec.climax !== null ? 'arch' : pickW(rng, Object.entries(spec.contourW));
    const { notes: [e0, e1, e2] } = pickW(rng, places);
    const fmax = Math.max(e0, e1, e2);
    const top = spec.climax !== null ? spec.climax : spec.ceil;
    // a chromatic formula note (the raised 6th or 7th, #4, b7 in major...)
    // must not be preceded closely by its diatonic twin (Bb A B-natural)
    const twins = new Set([e0, e1, e2].map(m => TWIN[K.mode][K.deg(m)]).filter(d => d !== undefined));

    // the opening note (within reach of the cadence mostly by step)
    let s0c = K.window.filter(m => m <= spec.ceil && Math.abs(m - e0) <= 2 * F + 1);
    if (spec.first) s0c = s0c.filter(m => K.inTonicTriad(m) && m <= K.lo + 9);
    else s0c = s0c.filter(m => boundaryOK(K, spec.prevLast, m) &&
      !(m === spec.prevLast && spec.prevPrev === m));
    if (spec.next === 'self') s0c = s0c.filter(m => boundaryOK(K, e2, m));
    if (contour === 'descend') s0c = s0c.filter(m => m >= e0 + 3 && m >= fmax);
    else if (contour === 'ascend') s0c = s0c.filter(m => m <= e0 - 3);
    else s0c = s0c.filter(m => m <= top - 2);
    if (!s0c.length) continue;
    const s0 = pickW(rng, s0c.map(m => [m, K.opening(m) *
      (spec.first ? (m <= K.lo + 7 ? 1 : 0.5) : BOUNDARY_W[Math.abs(m - spec.prevLast)]) *
      travelW(Math.abs(m - e0), F)]));

    // the peak of an arch
    let kp = null, P = null;
    if (contour === 'arch') {
      const peaks = spec.climax !== null ? [spec.climax]
        : K.window.filter(m => m >= s0 + 2 && m >= fmax && m >= e0 + 2 && m <= spec.ceil);
      // reachable by steps (the climax may be taken by one leap, and left
      // by one third)
      const up = spec.climax !== null ? 3 : 1, down = spec.climax !== null ? 1 : 0;
      const opts = [];
      for (const pk of peaks) for (let k = 1; k <= F - 1; k++) {
        if (pk - s0 > 2 * k + up || pk - e0 > 2 * (F - k) + down) continue;
        if (k >= F - 2 && twins.has(K.deg(pk))) continue;
        const rise = pk - Math.max(s0, e0);
        const w = (spec.climax !== null ? 1 : Math.exp(-((rise - 3) ** 2) / 4)) *
                  (k === Math.round(F / 2) || k === Math.round((F - 1) / 2) ? 2 : 1) *
                  travelW(pk - s0, k) * travelW(pk - e0, F - k);
        opts.push([[pk, k], w]);
      }
      if (!opts.length) continue;
      [P, kp] = pickW(rng, opts);
    }

    const notes = new Array(L).fill(null);
    notes[0] = s0; notes[F] = e0; notes[F + 1] = e1; notes[F + 2] = e2;
    const ceilFree = Math.min(spec.ceil,
      contour === 'arch' ? P : contour === 'descend' ? s0 : Math.max(fmax, s0 + 2));
    const strictBelow = spec.climax;           // only the peak may touch the climax
    const pts = contour === 'arch' ? [[0, s0], [kp, P], [F, e0]] : [[0, s0], [F, e0]];
    const curve = j => {
      for (let i = 1; i < pts.length; i++) if (j <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + (y1 - y0) * (j - x0) / (x1 - x0);
      }
      return e0;
    };
    if (!fill(K, spec, notes, F, kp, P, ceilFree, strictBelow, twins, curve, rng)) continue;
    if (Math.max(...notes) - Math.min(...notes) < 4) continue;
    if (spec.next === 'self' && !connectOK(K, e1, e2, notes)) continue;
    return notes;
  }
  return null;
}

// The free notes: every completion that passes the checks, drawn in
// proportion to the product of the weights. A phrase has at most four free
// notes, so this is a few thousand paths at most.
function fill(K, spec, notes, F, kp, P, ceilFree, strictBelow, twins, curve, rng) {
  const L = notes.length;
  const seq = k => k >= 0 ? notes[k] : (k === -1 ? spec.prevLast : null);
  const ivInto = k => {
    const a = seq(k - 1), b = seq(k);
    return a === null || a === undefined || b === null || b === undefined ? null : b - a;
  };
  const repeatsBefore = j => {
    let r = 0;
    for (let k = 1; k < j; k++) if (notes[k] === notes[k - 1]) r++;
    return r;
  };
  const ok = (j, m) => {
    const b = notes[j - 1];
    if (!innerOK(K, b, m)) return false;
    if (m === b) {
      if (seq(j - 2) === m) return false;
      if (repeatsBefore(j) >= 1) return false;
    }
    if (j >= 3 && m === notes[j - 2] && b === notes[j - 3] && m !== b) return false;
    if (Math.abs(m - b) >= 3) {
      let leaps = 0, big = 0;
      for (let k = 1; k < j; k++) {
        const d = Math.abs(notes[k] - notes[k - 1]);
        if (d >= 3) leaps++;
        if (d >= 5) big++;
      }
      if (leaps >= 2 || (Math.abs(m - b) >= 5 && big >= 1)) return false;
    }
    return legalMotion(K, seq(j - 2), b, m, ivInto(j - 1), ivInto(j - 2));
  };
  const seamOK = () => {
    const e0 = notes[F], e1 = notes[F + 1], e2 = notes[F + 2];
    if (!ok(F, e0)) return false;
    if (notes[F - 1] === e0 && e0 === e1) return false;
    if (e1 === notes[F - 1] && e0 === notes[F - 2] && e0 !== e1) return false;
    if (e2 === e0 && e1 === notes[F - 1] && e1 !== e2) return false;
    let reps = 0;
    for (let k = 1; k < L; k++) if (notes[k] === notes[k - 1]) reps++;
    if (reps > 2) return false;
    return legalMotion(K, notes[F - 1], e0, e1, e0 - notes[F - 1], ivInto(F - 1)) &&
           legalMotion(K, e0, e1, e2, e1 - e0, e0 - notes[F - 1]);
  };
  const found = [], ws = [];
  const rec = (j, w) => {
    if (j === F) {
      if (seamOK()) { found.push(notes.slice(1, F)); ws.push(w); }
      return;
    }
    if (j === kp) {
      if (!ok(j, P)) return;
      notes[j] = P;
      rec(j + 1, w);
      notes[j] = null;
      return;
    }
    const nextFixed = kp !== null && j < kp ? kp : F;
    const goal = nextFixed === kp ? P : notes[F];
    const p = ivInto(j - 1);
    const nearCadence = j >= F - 2;
    for (const m of K.window) {
      if (Math.abs(m - notes[j - 1]) > 7 || m > ceilFree) continue;
      if (nearCadence && twins.has(K.deg(m))) continue;
      if (strictBelow !== null && m >= strictBelow) continue;
      if (Math.abs(goal - m) > 4 * (nextFixed - j)) continue;
      if (!ok(j, m)) continue;
      const iv = m - notes[j - 1];
      const dev = m - curve(j);
      let wm = corpusW(K.mode, j, L, p, iv) * Math.exp(-(dev * dev) / 24.5) *
        (DEGREE_PRIOR[K.mode][K.deg(m)] || 0.1);
      // the interval into a fixed note (the peak, or the cadence formula)
      // is part of the line too: weight it by the corpus as well
      if (nextFixed === j + 1) wm *= corpusW(K.mode, j + 1, L, iv, goal - m);
      notes[j] = m;
      rec(j + 1, w * wm);
      notes[j] = null;
    }
  };
  rec(1, 1);
  BARFORM_STATS.paths += found.length;
  if (!found.length) return false;
  const pick = weightedChoice(rng, found, ws);
  for (let j = 1; j < F; j++) notes[j] = pick[j - 1];
  return true;
}

// ------------------------------------------------------------------ tune --

const STOLLEN_T = {
  major: { single: { 0: 4, 7: 3, 4: 2, 2: 1 }, first: { 7: 3, 4: 3, 2: 2, 0: 1 }, close: { 0: 6, 7: 2, 4: 1, 2: 1 } },
  minor: { single: { 0: 4, 7: 3, 3: 2, 2: 1 }, first: { 7: 3, 3: 3, 2: 2, 0: 1 }, close: { 0: 6, 7: 2, 3: 2, 2: 1 } },
};
const ABGESANG_T = { major: { 7: 4, 9: 2, 2: 2, 4: 2, 11: 1, 5: 1 }, minor: { 3: 4, 7: 3, 10: 2, 2: 2, 5: 1 } };
const LETTERS = 'ABCDEFGH';

function tryTune(K, nPhrases, rng) {
  const S = nPhrases >= 3 ? 2 : 1;
  const nNew = nPhrases >= 4 ? 3 : 2;
  const mode = K.mode;
  const pickT = (table, not = []) => Number(pickW(rng, Object.entries(table)
    .filter(([d]) => !not.includes(Number(d)))));

  // the climax: the tune's one highest note
  const T = K.T;
  const cxOpts = K.frame === 'plagal' ? [[T + 7, 3], [T + (K.major ? 9 : 8), 3], [T + 12, 2]]
    : K.frame === 'high' ? [[T + (K.major ? 4 : 3), 3], [T + 5, 3], [T + 7, 2]]
    : [[T + 12, 4], [T + 14, 3], [T + (K.major ? 16 : 15), 2]];
  const Cx = pickW(rng, cxOpts.filter(([m]) => m <= 79));

  // the cadence plan
  const stT = S === 1 ? [pickT(STOLLEN_T[mode].single)] : [pickT(STOLLEN_T[mode].first)];
  if (S === 2) stT.push(pickT(STOLLEN_T[mode].close, [stT[0]]));
  const reprise = stT[S - 1] === 0 && rng() < 0.4;
  const abT = [];
  for (let i = 0; i < nNew; i++) {
    const prev = i === 0 ? stT[S - 1] : abT[i - 1];
    abT.push(!reprise && i === nNew - 1 ? 0 : pickT(ABGESANG_T[mode], [prev]));
  }

  // hymn meter -> phrase lengths
  const meter = pickW(rng, METERS);
  const stL = Array.from({ length: S }, (_, i) => meter[i % meter.length]);
  const abL = Array.from({ length: nNew }, (_, i) => meter[i % meter.length]);

  // where the climax falls: an Abgesang phrase, most often its first
  const cw = nNew === 3 ? [5, 4, reprise ? 2 : 1] : (reprise ? [6, 4] : [8, 2]);
  const climaxAt = pickW(rng, cw.map((w, i) => [i, w]));

  const tonics = [[T, 2], [T + 12, 1]].filter(([m]) => m < Cx && m >= cadenceFloor() && m <= K.hi + 2);
  const below = Cx - 1;

  // the Stollen
  const stollen = [];
  let prevLast = null, prevPrev = null;
  for (let i = 0; i < S; i++) {
    const closing = i === S - 1;
    const spec = {
      L: stL[i], target: stT[i], prevLast, prevPrev, ceil: below, climax: null, first: i === 0,
      contourW: i === 0 && S === 2 ? { arch: 5, ascend: 3, descend: 2 } : { arch: 4, descend: 4, ascend: 2 },
      finalSet: stT[i] === 0 && closing ? tonics : null,
      next: closing ? (S === 1 ? 'self' : stollen[0]) : null,
      center: S === 2 && i === 0 ? K.lo + 4 : K.mid - 1,          // the Stollen starts low
    };
    const ph = composePhrase(K, spec, rng);
    if (!ph) return null;
    stollen.push(ph);
    prevLast = ph[ph.length - 1]; prevPrev = ph[ph.length - 2];
  }

  // the Abgesang
  const abgesang = [];
  for (let i = 0; i < nNew; i++) {
    const final = !reprise && i === nNew - 1;
    const climax = i === climaxAt ? Cx : null;
    const spec = {
      L: abL[i], target: abT[i], prevLast, prevPrev, ceil: below, climax, first: false,
      contourW: final ? { descend: 6, arch: 4 } : { arch: 4, descend: 4, ascend: 2 },
      finalSet: final ? tonics : null,
      next: reprise && i === nNew - 1 ? stollen[S - 1] : null,
      center: climax !== null ? Cx - 5 : i === nNew - 1 ? K.mid - 1 : K.mid + 2,
    };
    const ph = composePhrase(K, spec, rng);
    if (!ph) return null;
    const key = ph.join(',');
    if (stollen.concat(abgesang).some(q => q.join(',') === key)) return null;
    abgesang.push(ph);
    prevLast = ph[ph.length - 1]; prevPrev = ph[ph.length - 2];
  }

  // assemble: Stollen, Stollen again, Abgesang (+ reprise)
  const phrases = [...stollen, ...stollen, ...abgesang];
  const labels = [...stollen.map((_, i) => LETTERS[i]), ...stollen.map((_, i) => LETTERS[i]),
    ...abgesang.map((_, i) => LETTERS[S + i])];
  const targets = [...stT, ...stT, ...abT];
  if (reprise) { phrases.push(stollen[S - 1]); labels.push(LETTERS[S - 1]); targets.push(stT[S - 1]); }
  const pitches = phrases.flat();
  const fermatas = [];
  let acc = 0;
  for (const ph of phrases) { acc += ph.length; fermatas.push(acc); }
  const stollenChords = stollen.reduce((a, ph) => a + ph.length, 0);
  return {
    pitches, fermatas,
    form: {
      labels, S, nNew, reprise, targets, meter, lengths: phrases.map(p => p.length),
      climax: Cx, climaxPhrase: 2 * S + climaxAt, stollenChords,
      ambitus: K.frame,
    },
  };
}

export function barformMelody(tonicPc, mode, nPhrases, rng) {
  BARFORM_STATS.tunes++;
  const K = makeKey(tonicPc, mode);
  const nP = Math.max(2, Math.min(4, nPhrases));
  // restarts are geometric (a median of none), so 200 is never reached in
  // practice; if it were, the draft is abandoned and the next one tries
  for (let restart = 0; restart < 200; restart++) {
    const tune = tryTune(K, nP, rng);
    if (tune) return tune;
    BARFORM_STATS.restarts++;
  }
  return null;
}

// note names for listings
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLATNAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export function noteName(m, flats = false) {
  return (flats ? FLATNAMES : NAMES)[mod12(m)] + (Math.floor(m / 12) - 1);
}
