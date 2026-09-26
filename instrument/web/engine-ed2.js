// EDITION 2, FROZEN (released 2026-09-26). This is the engine every ?ed=2
// address plays, byte for byte as it shipped (with its own frozen
// tables-ed2.js). Never edit it: golden.mjs checks pieces 1..20,000 against
// golden-ed2.json. New work goes in engine.js, which becomes the next edition.
//
// The composition engine, ported from the auto_compose Python engine.
// Composes a verified four-voice chorale from a seed in ~milliseconds:
// bar-form melody planner -> bass beam search over the outer-voice oracle ->
// inner-voice beam search under the voice-leading laws -> checker gate ->
// corpus-rate ornamentation (with its own surface checker as the gate).
// Deterministic: piece N is the same piece for everyone, forever
// (golden.mjs guards it; log1p.js keeps it true in every browser).

import { TABLES } from './tables-ed2.js';
import { log1p } from './log1p.js';

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
//
// Bar form (AAB), as Lutheran chorale tunes are: a Stollen of one or two
// phrases, sung twice, then an Abgesang of new phrases. The address's phrase
// count (2, 3, 3, 4) sets the size of the form:
//   2 -> Stollen of 1 phrase,  Abgesang of 2 new phrases: A A B C
//   3 -> Stollen of 2 phrases, Abgesang of 2 new phrases: A B A B C D
//   4 -> Stollen of 2 phrases, Abgesang of 3 new phrases: A B A B C D E
// When the Stollen closes on the tonic, 40% of tunes are Reprisenbar: the
// Abgesang ends with the Stollen's closing phrase again (A A B C A, ...),
// which then is the final cadence. So a tune has 4-8 phrases. The repeat is
// literal down to the ornaments (bassLine, harmonize and ornament copy it);
// the reprise is harmonized anew, so the ending still moves.
//
// Phrases take hymn-meter lengths (8.7, 7.6, 8.8.7, 8, 7 or 6 notes a line)
// and end in one of Bach's cadence formulas (MELODY.cadences, count >= 5),
// placed as a unit and never entered by a tritone or an augmented second.
// The free notes before the formula follow the corpus transition weights
// (MELODY.transitions) times Bach's soprano degree profile, pulled toward
// the phrase's contour (an arch, a descent or an ascent): every legal
// completion is enumerated (at most four free notes) and one is drawn in
// proportion to the product of those weights. The tune's one highest note
// is placed once, at the peak of an Abgesang phrase. Eb and F tunes are
// authentic, G, A and Bb plagal, and C and D end on the upper tonic (C5,
// D5), so every tune sits inside D4-G5.
//
// Compared with Edition 1's planner it allows what chorale tunes do:
// repeated notes, triadic motion (C-E-G), a leap of up to a sixth into a
// phrase, and a tonic cadence at the end of the Stollen. It still forbids
// the melodic tritone and augmented second, sixths inside a phrase,
// sevenths and octaves anywhere, unrecovered leaps, three leaps in a row,
// two-note oscillation (x y x y), and free notes outside the scale.
// Deterministic given rng: every random choice goes through it.
//
// The design record, with measurements: docs/engine-review/ (in the review's
// pull request), tools/lab/barform.mjs.

const bucketOf = iv => iv === 0 ? 'rep'
  : (iv > 0 ? 'u' : 'd') + (Math.abs(iv) <= 2 ? '1' : Math.abs(iv) <= 4 ? '2' : '3');

// the weight of an opening or a peak that leaves d semitones for the free
// notes to cover in k intervals: past 1.2 a note, a phrase stops being
// walkable mostly by step, and its free notes turn to thirds
const TRAVEL = 1.2;
const travelW = (d, k) => {
  const excess = Math.max(0, d - TRAVEL * k);
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
  const frame = T4 <= 62 ? 'high' : T4 >= 67 ? 'plagal' : 'authentic';
  const T = frame === 'high' ? T4 + 12 : T4;       // the final: Eb4..Bb4, C5, D5
  const [lo, hi] = frame === 'high' ? [T - 8, T + 4] : frame === 'plagal' ? [T - 5, T + 7] : [T, T + 12];
  const floor = Math.max(62, lo - 2);
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
const CADENCE_FLOOR = 63;          // no fermata on C4-D4
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
      if (notes[2] < CADENCE_FLOOR) continue;
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

  const tonics = [[T, 2], [T + 12, 1]].filter(([m]) => m < Cx && m >= CADENCE_FLOOR && m <= K.hi + 2);
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

function melody(tonicPc, mode, nPhrases, rng) {
  const K = makeKey(tonicPc, mode);
  const nP = Math.max(2, Math.min(4, nPhrases));
  // restarts are geometric (a median of none), so 200 is never reached in
  // practice; if it were, the draft is abandoned and the next one tries
  for (let restart = 0; restart < 200; restart++) {
    const tune = tryTune(K, nP, rng);
    if (tune) return tune;
  }
  return null;
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

// rep: chords in the Stollen, sung again right after it. Inside the repeat
// each line may only repeat what it wrote the first time, so the search
// chooses a Stollen it can sing twice.
function bassLine(sop, fermatas, tonicPc, mode, rng, beamWidth = 10, temp = 0, rep = 0) {
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
    if (pairParallel(sop[i - 1], prev, sop[i], cand)) return false;    // the sixth pair
    if (i === n - 1 && mod12(cand) !== tonicPc) return false;           // end on the tonic
    if (sop[i] - cand <= 3) return false;              // leave room for alto and tenor
    if (mode === 'minor' && a === 3 && !ferm.has(i)) {
      const r2 = new Set([rel(prev), tPc]);
      if (r2.has(8) && r2.has(11)) return false;                        // augmented second
    }
    return true;
  };
  // can a Stollen ending on bass note last start over on b0? The repeat
  // begins again after a breath, so the move needs no precedent in the
  // oracle, only the hard rules and at most an octave
  const returns = (last, b0) => Math.abs(b0 - last) <= 12 && legal(rep, last, b0, rel(b0));
  // can a line at the next-to-last chord still reach a tonic the search is
  // allowed to write? (otherwise the whole beam can die on the last chord)
  const reachesTonic = prev => {
    const i = n - 1;
    const moves = oracleMoves(mode, rel(sop[i - 1]), rel(sop[i]), 1, rel(prev));
    if (moves[0] === undefined || !pairs.has(rel(sop[i]) * 12)) return false;
    for (const cand of concretize(tonicPc, prev).slice(0, 2)) if (legal(i, prev, cand, 0)) return true;
    return false;
  };
  let beams = [];
  for (const [p, c] of Object.entries(opens).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    if (!pairs.has(rel(sop[0]) * 12 + Number(p))) continue;
    const pc = mod12(Number(p) + tonicPc);
    for (const b0 of concretize(pc, 45).slice(0, 2))
      beams.push([log1p(c) + uniform(rng, 0, temp), [b0]]);
  }
  for (let i = 1; i < n; i++) {
    const cad = ferm.has(i + 1) || i === n - 1 ? 1 : 0;
    const nxt = [];
    for (const [score, line] of beams) {
      const prev = line[line.length - 1];
      const fixed = rep && i >= rep && i < 2 * rep ? line[i - rep] : null;
      if (fixed !== null && i === rep) {
        // the repeat starts over: its first bass note is written as it stands
        if (returns(prev, fixed)) nxt.push([score + uniform(rng, 0, temp), line.concat([fixed])]);
        continue;
      }
      const moves = oracleMoves(mode, rel(sop[i - 1]), rel(sop[i]), cad, rel(prev));
      for (const [tPcS, cnt] of Object.entries(moves)) {
        const tPc = Number(tPcS);
        if (!pairs.has(rel(sop[i]) * 12 + tPc)) continue;
        const absPc = mod12(tPc + tonicPc);
        for (const cand of concretize(absPc, prev).slice(0, 2)) {
          if (fixed !== null && cand !== fixed) continue;
          let s = score + log1p(cnt) + uniform(rng, 0, temp);
          const dm = cand - prev, ds = sop[i] - sop[i - 1];
          if (dm === 0 && ds === 0) s -= 0.2;
          if ((dm < 0 && ds > 0) || (ds < 0 && dm > 0)) s += 0.6;
          else if (dm === 0 || ds === 0) s += 0.2;
          const a = Math.abs(dm);
          // (checked after the random draw so the stream matches the lab)
          if (!legal(i, prev, cand, tPc)) continue;
          if (rep && i === rep - 1 && !returns(cand, line[0])) continue;
          if (i === n - 2 && !reachesTonic(cand)) continue;
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
    if (!beams.length) return null;
  }
  return beams[0][1];
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

// rep: as in bassLine, the Stollen's repeat copies alto, tenor and chord
function harmonize(sop, bass, fermatas, tonicPc, mode, beamWidth = 14, rep = 0) {
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
  // may alto and tenor move from pa, pt to a, t into chord i? No parallel
  // fifths or octaves between any two voices, and one rule for the inner
  // voices, fermatas included (the surface gate has no fermata exemption,
  // so Edition 1 wrote leaps here that its own gate then rejected): no leap
  // of a seventh or more than an octave, and no augmented second (b6/#7, or
  // a chromatic end, as compose.py's harmonize has always required)
  const legal = (i, pa, pt, a, t) => {
    const qp = [sop[i - 1], pa, pt, bass[i - 1]], qc = [sop[i], a, t, bass[i]];
    for (let x = 0; x < 4; x++)
      for (let y = x + 1; y < 4; y++)
        if (pairParallel(qp[x], qp[y], qc[x], qc[y])) return false;
    for (const [pp, cp] of [[pa, a], [pt, t]]) {
      const d = Math.abs(cp - pp);
      if (d === 10 || d === 11 || d > 12) return false;
      if (d === 3) {
        const r1 = mod12(pp - tonicPc), r2 = mod12(cp - tonicPc);
        if ((r1 === 8 && r2 === 11) || (r1 === 11 && r2 === 8) ||
            !scale.has(r1) || !scale.has(r2)) return false;
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
      const fixed = rep && i >= rep && i < 2 * rep ? line[i - rep] : null;
      for (const [a, t, ci, cost] of slots[i]) {
        if (fixed && (a !== fixed[0] || t !== fixed[1] || ci !== fixed[2])) continue;
        const ch = vocab[ci];
        const curPcs = new Set(ch.pcs.map(abspc));
        const targetMissed = ptarget !== null && !curPcs.has(ptarget);
        const qp = [sop[i - 1], pa, pt, bass[i - 1]], qc = [sop[i], a, t, bass[i]];
        if (!legal(i, pa, pt, a, t)) continue;
        // the Stollen's last chord must be able to start the repeat
        if (rep && i === rep - 1 && !legal(rep, a, t, line[0][0], line[0][1])) continue;
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
    if (!beams.length) return null;
  }
  return beams[0][1].map(([a, t]) => [a, t]);
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

// rep: an ornament in the Stollen is written into its repeat too, and the
// repeat's own slots are never drawn for
function ornament(skel, tonicPc, mode, fermatas, density, rng, rep = 0) {
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

  const mirror = i => rep && i >= rep && i < 2 * rep;
  const tryApply = (vn, slotIdx, newSlot) => {
    const twin = rep && slotIdx < rep ? slotIdx + rep : -1;
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

// Seeds are an integer hash of the address (splitmix64 over BigInt), exact
// for every address up to 2^53 and with no structure. Edition 1 used
// n*2654435761 and n*1000 + 7a + 13 in floating point: its compose streams
// repeated every 2^29 addresses (No. 536,870,922 is No. 10 again), its key
// choice lost precision past No. 3,393,263, and near the top every piece was
// D minor and some addresses could not compose at all.
const M64 = (1n << 64n) - 1n;
function splitmix64(x) {
  x = (x + 0x9E3779B97F4A7C15n) & M64;
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return z ^ (z >> 31n);
}
// stream 0 picks key, mode and phrase count; stream 1 + a drives draft a
const seedOf = (n, stream) =>
  Number(splitmix64(BigInt(Math.floor(n)) * 64n + BigInt(stream)) & 0xFFFFFFFFn);

// composePiece(n): the plate number is the seed. Deterministic forever.
export function composePiece(pieceNumber, density = 1.0) {
  const paramRng = mulberry32(seedOf(pieceNumber, 0));
  const [tonicName, tonicPc] = choice(paramRng, KEYS);
  const mode = paramRng() < 0.45 ? 'minor' : 'major';
  const phrases = choice(paramRng, [2, 3, 3, 4]);

  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = mulberry32(seedOf(pieceNumber, attempt + 1));
    const tune = melody(tonicPc, mode, phrases, rng);
    if (!tune) continue;
    const { pitches: sop, fermatas, form } = tune;
    const rep = form.stollenChords;
    const bass = bassLine(sop, fermatas, tonicPc, mode, rng, 10, 0.15 * attempt, rep);
    if (!bass) continue;
    const inner = harmonize(sop, bass, fermatas, tonicPc, mode, 14, rep);
    if (!inner) continue;
    const skel = {
      s: sop, a: inner.map(x => x[0]), t: inner.map(x => x[1]), b: bass,
    };
    const { V, W } = checkChorale(skel, tonicPc, mode, fermatas);
    if (V.length) continue;
    const events = ornament(skel, tonicPc, mode, fermatas, density, rng, rep);
    const surface = checkSurface(events, skel, tonicPc, mode, fermatas);
    if (surface.V.length) continue;
    let total = 0;
    for (const [, ln] of events.s) total += ln;
    return {
      number: pieceNumber,
      key: `${tonicName} ${mode}`,
      tonicPc, mode,
      phrases: fermatas.length,     // the plate's count: Stollen twice, then the Abgesang
      form: { labels: form.labels, stollenChords: rep, reprise: form.reprise },
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
