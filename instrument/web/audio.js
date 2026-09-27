// The organ: a small church barrel organ, the crank-turned instrument that
// played hymns in English village churches for two centuries. Two stops are
// drawn: a Stopped Diapason 8' (a stopped flute, its third partial ~18 dB
// down) and a Flute 4' (nearly pure, an octave up). Every pipe has its own
// slightly uneven partials and a cent or so of mistuning, speaks with a puff
// of band-passed noise (the chiff), and stops when its valve closes. Tuned in
// Werckmeister III, as organs were in Bach's day, so each key has its own
// colour. The pipes stand in two towers (C side, C-sharp side); the case takes
// the top off (5 kHz) and the bass stays lean (60 Hz); the room is a stone
// church, a generated impulse response. Chosen by ear from rendered sketches
// (registration E, September 2026).
//
// Notes are position-driven: the machine starts and stops them; nothing here
// knows about tempo. noteOn/noteOff take an optional time (for offline
// rendering); by default they act now.

// cents from equal temperament per pitch class, C first, with A kept at 440
const WERCKMEISTER3 = [0, -9.775, -7.82, -5.865, -9.775, -1.955, -11.73, -3.91, -7.82, -11.73, -3.91, -7.82]
  .map(c => c + 11.73);

// mult: 1 sounds at pitch (8'), 2 an octave up (4'); spread: the pipes'
// mistuning, in cents; speech: how fast the pipe comes on; chiff: the speech
// noise (at x the pipe's pitch, capped), its width, length and level
const STOPS = [
  { mult: 1, level: 1, spread: 2.4, speech: 1,
    partials: { 1: 1, 2: 0.05, 3: 0.12, 4: 0.012, 5: 0.03, 6: 0.005, 7: 0.009, 9: 0.003 },
    chiff: { at: 3, cap: 3000, q: 2, tau: 0.02, level: 0.045 } },
  { mult: 2, level: 0.22, spread: 3, speech: 0.8,
    partials: { 1: 1, 2: 0.03, 3: 0.05, 5: 0.008 },
    chiff: { at: 2, cap: 3000, q: 2, tau: 0.018, level: 0.03 } },
];
const RELEASE = 0.14;               // the machine's default note-off; the valve closes in ~18 ms
const VALVE = 0.018 / RELEASE;      // release -> the pipe's decay time constant

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The church: low, middle and high bands of noise decaying over 2.6, 2.3 and
// 1.2 s, five early reflections, an 18 ms pre-delay, the lowest octaves taken
// out so the tail doesn't muddy small speakers. Seeded, so it is the same
// church every time; energy-normalized, so the wet gain is the wet level.
function churchImpulse(ctx) {
  const rate = ctx.sampleRate, len = Math.floor(3.4 * rate), pd = Math.floor(0.018 * rate);
  const buf = ctx.createBuffer(2, len, rate);
  const early = [[7, 0.5], [13, 0.35], [21, 0.3], [29, 0.22], [41, 0.16]];
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(7 + ch * 7919), d = buf.getChannelData(ch);
    let lo = 0, hiState = 0, prev = 0;
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / rate, w = rng() * 2 - 1;
      lo += 0.02 * (w - lo);
      const hi = w - prev + 0.6 * hiState; prev = w; hiState = hi;
      const decay = rt => Math.exp(-6.91 * t / rt);
      d[i] = lo * 3 * decay(2.6) + (w - lo) * 0.8 * decay(2.3) + hi * 0.25 * decay(1.2);
    }
    for (const [ms, g] of early) {
      const k = pd + Math.floor(ms / 1000 * rate) + (ch ? 37 : 0);
      if (k < len) d[k] += g * (rng() < 0.5 ? -1 : 1);
    }
    const k = Math.exp(-2 * Math.PI * 120 / rate);   // one-pole high-pass at 120 Hz
    let xp = 0, yp = 0, e = 0;
    for (let i = 0; i < len; i++) { const y = k * (yp + d[i] - xp); xp = d[i]; yp = y; d[i] = y; e += y * y; }
    const s = 1 / Math.sqrt(e);
    for (let i = 0; i < len; i++) d[i] *= s;
  }
  return buf;
}

export class Organ {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();       // a guard, rarely touched
    comp.threshold.value = -8;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // the case: every pipe into one bus, lean at the bottom, soft at the top
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.11;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 60; hp.Q.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000; lp.Q.value = Math.SQRT1_2;
    this.bus.connect(hp); hp.connect(lp);
    lp.connect(this.master);
    const room = ctx.createConvolver();
    room.normalize = false;
    room.buffer = churchImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.38;
    lp.connect(room); room.connect(wet); wet.connect(this.master);

    // one second of white noise for the chiff, read from a random place each time
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noise.getChannelData(0), nr = mulberry32(1685);
    for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;
    this.pipes = new Map();          // `${stop}:${midi}` -> { wave, freq }
    this.active = new Set();
  }

  // a pipe is voiced once, the same way every time it is drawn
  pipe(si, midi) {
    const key = `${si}:${midi}`;
    let p = this.pipes.get(key);
    if (!p) {
      const stop = STOPS[si];
      const rng = mulberry32(Math.imul(midi + 1, 2654435761) ^ (si + 1));
      const cents = WERCKMEISTER3[((midi % 12) + 12) % 12] + (rng() - 0.5) * stop.spread;
      const freq = 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200) * stop.mult;
      const n = Math.max(...Object.keys(stop.partials).map(Number));
      const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
      for (const [h, a] of Object.entries(stop.partials))
        if (freq * h < 9000) imag[h] = h === 1 ? a : a * (0.85 + 0.3 * rng());   // regulated: even speech, varied colour
      p = { wave: this.ctx.createPeriodicWave(real, imag, { disableNormalization: true }), freq };
      this.pipes.set(key, p);
    }
    return p;
  }

  noteOn(vn, midi, { at } = {}) {
    const ctx = this.ctx, now = at ?? ctx.currentTime;
    // two towers: C side and C-sharp side, the treble a little wider
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (midi % 2 ? 0.32 : -0.32) + (midi - 60) / 48 * 0.18));
    pan.connect(this.bus);
    const handle = { vn, midi, nodes: [], envs: [], off: false };
    STOPS.forEach((stop, si) => {
      const { wave, freq } = this.pipe(si, midi);
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = freq;
      // speech: small pipes come on faster than large ones
      const speech = Math.min(0.07, Math.max(0.012, 0.035 * Math.pow(262 / freq, 0.35))) * stop.speech;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.setTargetAtTime(stop.level, now, speech);
      osc.connect(env); env.connect(pan);
      osc.start(now);
      // the chiff: a puff of band-passed wind as the pipe speaks
      const puff = ctx.createBufferSource();
      puff.buffer = this.noise; puff.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = Math.min(stop.chiff.cap, Math.max(500, stop.chiff.at * freq));
      band.Q.value = stop.chiff.q;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0, now);
      pg.gain.linearRampToValueAtTime(3 * stop.chiff.level * stop.level, now + 0.002);
      pg.gain.setTargetAtTime(0, now + 0.002, stop.chiff.tau);
      puff.connect(band); band.connect(pg); pg.connect(pan);
      puff.start(now, Math.random() * 0.9);
      puff.stop(now + 0.002 + 6 * stop.chiff.tau);
      handle.nodes.push(osc);
      handle.envs.push(env);
    });
    this.active.add(handle);
    return handle;
  }

  // the valve closes; a longer release (the machine's elision into the next
  // piece, or the wind running out) closes it more slowly
  noteOff(handle, release = RELEASE, at) {
    if (handle.off) return;
    handle.off = true;
    const now = at ?? this.ctx.currentTime, tau = release * VALVE;
    for (const env of handle.envs) {
      env.gain.cancelScheduledValues(now);
      if (at === undefined) env.gain.setValueAtTime(env.gain.value, now);
      env.gain.setTargetAtTime(0, now, tau);
    }
    for (const osc of handle.nodes) osc.stop(now + 8 * tau + 0.02);
    this.active.delete(handle);
  }

  releaseAll(release = 0.4) {
    for (const h of [...this.active]) this.noteOff(h, release);
  }
}
