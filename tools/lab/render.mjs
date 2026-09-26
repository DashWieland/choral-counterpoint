// A Node port of tools/perform.py, the choir that rendered the FABE chorale,
// so pieces can be heard without numpy: additive voices (8 harmonics) with
// per-voice pan, detune and brightness, delayed vibrato, a swell and fade on
// fermata chords, a breath after each fermata, a final ritardando, and the
// same Schroeder reverb. Seeded, so a piece always renders the same.
//
//   import { renderWav } from './render.mjs';
//   renderWav(path, { events: {s,a,t,b: [[midi, eighths], ...]}, fermataEighths }, 66);
import { writeFileSync } from 'node:fs';

const SR = 44100, BREATH = 0.28;
// voice: pan, detune (cents), vibrato Hz, brightness, gain (perform.py VOICES)
const VOICES = {
  s: [-0.35, 2.5, 5.3, 1.00, 0.95],
  a: [0.35, -2.0, 4.9, 0.80, 0.90],
  t: [0.15, 1.5, 5.1, 0.70, 0.95],
  b: [-0.10, -3.0, 4.6, 0.55, 1.10],
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = rng => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

// start and duration (seconds) of every eighth position
function timeline(total, ferm, bpm) {
  const eighth = 60 / bpm / 2;
  const mult = new Array(total).fill(1);
  for (const f of ferm) for (const k of [f, f + 1]) if (k >= 0 && k < total) mult[k] = 2;
  [1.0, 1.06, 1.12, 1.25].forEach((r, j) => { const k = total - 4 + j; if (k >= 0) mult[k] *= r; });
  const dur = mult.map(m => eighth * m);
  const breathAfter = new Set(ferm.filter(f => f + 2 < total).map(f => f + 1));
  const start = [];
  let t = 0;
  for (let i = 0; i < total; i++) { start.push(t); t += dur[i] + (breathAfter.has(i) ? BREATH : 0); }
  return { start, dur };
}

const eighthsIn = piece => Math.max(...Object.values(piece.events).map(ev => ev.reduce((t, [, ln]) => t + ln, 0)));

// seconds from the start of a render to eighth position pos
export function secondsAt(piece, pos, bpm = 66) {
  return timeline(eighthsIn(piece), piece.fermataEighths, bpm).start[pos];
}

export function render(piece, bpm = 66) {
  const ferm = piece.fermataEighths;
  const voices = {};
  for (const vn of ['s', 'a', 't', 'b']) {
    let t = 0;
    voices[vn] = piece.events[vn].map(([m, ln]) => { const e = [m, t, ln]; t += ln; return e; });
  }
  const total = eighthsIn(piece);
  const { start, dur } = timeline(total, ferm, bpm);
  const totalSec = start[total - 1] + dur[total - 1];
  const n = Math.ceil(totalSec * SR) + SR * 4;
  const L = new Float64Array(n), R = new Float64Array(n);
  const rng = mulberry32(1685);                       // J.S.B.'s birth year, as in perform.py
  for (const [vn, [pan, detune, vibHz, bright, gain]] of Object.entries(VOICES)) {
    const amps = [];
    for (let h = 1; h <= 8; h++) amps.push(Math.pow(h, -1.6) * Math.pow(bright, h - 1));
    const gl = gain * Math.sqrt((1 - pan) / 2), gr = gain * Math.sqrt((1 + pan) / 2);
    for (const [m, s, ln] of voices[vn]) {
      const t0 = start[s];
      let d = 0;
      for (let k = s; k < s + ln; k++) d += dur[k];
      const length = Math.floor(d * SR);
      if (length <= 0) continue;
      const f0 = 440 * Math.pow(2, (m - 69) / 12) * Math.pow(2, detune / 1200);
      const drift = Math.pow(2, gauss(rng) * 1.2 / 1200);
      const vibPh = rng() * 6, tremPh = rng() * 6;
      const swell = ferm.some(f => (f <= s && s < f + 2) || (s <= f && f < s + ln));
      const a = Math.min(Math.floor(0.07 * SR), Math.floor(length / 3));
      const r = Math.min(Math.floor(0.10 * SR), Math.floor(length / 3));
      const fade = Math.min(Math.floor(0.25 * SR), length);
      const i0 = Math.floor(t0 * SR);
      const w = 2 * Math.PI * f0 * drift;
      let phase = 0;
      for (let i = 0; i < length; i++) {
        const t = i / SR;
        const vibDepth = 0.006 * Math.min(1, Math.max(0, (t - 0.25) / 0.5));
        phase += (1 + vibDepth * Math.sin(2 * Math.PI * vibHz * t + vibPh)) / SR;
        let sig = 0;
        for (let h = 1; h <= 8; h++) sig += amps[h - 1] * Math.sin(w * h * phase);
        let env = 1;
        if (i < a) env = Math.pow(i / Math.max(a - 1, 1), 1.5);
        if (i >= length - r) env *= 1 - 0.75 * ((i - (length - r)) / Math.max(r - 1, 1));
        if (swell) {
          env *= 0.85 + 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, t / d)), 2);
          if (i >= length - fade) env *= 1 - (i - (length - fade)) / Math.max(fade - 1, 1);
        }
        const v = sig * env * (1 + 0.04 * Math.sin(2 * Math.PI * 0.7 * t + tremPh));
        L[i0 + i] += v * gl; R[i0 + i] += v * gr;
      }
    }
  }
  return { L: reverb(L), R: reverb(R) };
}

function reverb(x, wet = 0.26) {
  const y = new Float64Array(x.length);
  const combs = [[1557, 0.84], [1617, 0.82], [1491, 0.86], [1422, 0.81], [1277, 0.80], [1356, 0.79]];
  for (const [d, g] of combs) {
    const buf = Float64Array.from(x);
    for (let i = d; i < buf.length; i++) buf[i] += g * buf[i - d];
    for (let i = 0; i < y.length; i++) y[i] += buf[i] / combs.length;
  }
  let cur = y;
  for (const [d, g] of [[225, 0.7], [556, 0.7], [441, 0.7]]) {
    const out = new Float64Array(cur.length), buf = new Float64Array(d);
    for (let i = 0; i < cur.length; i++) {
      const v = cur[i] + g * buf[i % d];
      out[i] = buf[i % d] - g * v;
      buf[i % d] = v;
    }
    cur = out;
  }
  const res = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) res[i] = x[i] * (1 - wet) + cur[i] * wet;
  return res;
}

export function renderWav(path, piece, bpm = 66) {
  const { L, R } = render(piece, bpm);
  let peak = 1e-9;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = 0.85 / peak, n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * k)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * k)) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
  return n / SR;
}
