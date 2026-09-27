// The organ: a small church barrel organ, the crank-turned instrument that
// played hymns in English village churches for two centuries. Two stops are
// drawn: a Stopped Diapason 8' (a stopped flute, its third partial ~18 dB
// down) and a Flute 4' (nearly pure, an octave up). Every pipe has its own
// slightly uneven partials and a cent or so of mistuning, speaks with a puff
// of band-passed noise (the chiff), and stops when its valve closes. Tuned in
// Werckmeister III, as organs were in Bach's day, so each key has its own
// colour. The pipes stand in two towers (C side, C-sharp side) in a wooden
// case, which colours them and takes the top off (5 kHz); the bass stays lean
// (60 Hz). It is heard from the nave of a stone church (a generated impulse
// response), mechanism and all: the bellows rush while the crank turns, and
// each key's valve knocks. Chosen by ear from rendered sketches and rooms
// (registration E, the far nave; September 2026).
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

// A room with a place in it. The early reflections (the first echoes, which
// tell the ear how big the room is and how far off the organ stands) are built
// apart from the tail and given a set share of the energy; each ear gets its
// own. The diffuse tail swells in as they thin out and dies highs first. The
// lowest octaves come out so the tail doesn't muddy small speakers. Seeded:
// the same room every time; energy-normalized: the wet gain is the wet level.
function roomImpulse(ctx, { seconds, predelay, rt, taps, earlyEnd, earlyShare, fadeIn, hp, seed, lows }) {
  const rate = ctx.sampleRate, len = Math.floor(seconds * rate), pd = Math.floor(predelay * rate);
  const buf = ctx.createBuffer(2, len, rate);
  const energy = a => { let e = 0; for (const v of a) e += v * v; return e; };
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(seed + ch * 7919);
    const early = new Float32Array(len), tail = new Float32Array(len);
    for (let k = 0; k < taps; k++) {                  // later reflections arrive softer
      const t = 0.003 + rng() * (earlyEnd - 0.003), i = pd + Math.floor(t * rate);
      if (i < len) early[i] += (0.4 + 0.6 * rng()) * Math.exp(-t / (0.6 * earlyEnd)) * (rng() < 0.5 ? -1 : 1);
    }
    let lp = 0;                                       // walls take the sparkle off each reflection
    for (let i = 0; i < len; i++) { lp += 0.45 * (early[i] - lp); early[i] = lp; }
    let lo = 0, hiState = 0, prev = 0;
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / rate, w = rng() * 2 - 1;
      lo += 0.02 * (w - lo);
      const hi = w - prev + 0.6 * hiState; prev = w; hiState = hi;
      const decay = r => Math.exp(-6.91 * t / r);
      tail[i] = Math.min(1, t / fadeIn) * (lo * lows * decay(rt[0]) + (w - lo) * 0.8 * decay(rt[1]) + hi * 0.25 * decay(rt[2]));
    }
    const ge = Math.sqrt(earlyShare / energy(early)), gt = Math.sqrt((1 - earlyShare) / energy(tail));
    const d = buf.getChannelData(ch);
    const k = Math.exp(-2 * Math.PI * hp / rate);
    let xp = 0, yp = 0;
    for (let i = 0; i < len; i++) {
      const x = early[i] * ge + tail[i] * gt, y = k * (yp + x - xp);
      xp = x; yp = y; d[i] = y;
    }
    const s = 1 / Math.sqrt(energy(d));
    for (let i = 0; i < len; i++) d[i] *= s;
  }
  return buf;
}

// The case: the pipes stand in a wooden box, which colours them. A direct
// path plus 60 ms of dense, fast-dying, band-limited reflections.
function caseImpulse(ctx) {
  const rate = ctx.sampleRate, len = Math.floor(0.06 * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(31 + ch), d = buf.getChannelData(ch);
    let lo = 0, prev = 0, e = 0;
    const box = new Float32Array(len);
    for (let i = 1; i < len; i++) {
      const w = rng() * 2 - 1;
      lo += 0.25 * (w - lo);                          // wood: nothing much above 2 kHz
      box[i] = (lo - prev * 0.9) * Math.exp(-i / (0.008 * rate));
      prev = lo;
      e += box[i] * box[i];
    }
    const g = Math.sqrt(0.18 / e);                    // the box carries ~15% of the sound
    d[0] = 1;
    for (let i = 1; i < len; i++) d[i] = box[i] * g;
  }
  return buf;
}

// Where the organ stands: far down the nave, where the room outweighs the
// organ. DRY and AIR: the direct sound, darkened by the distance; WET: the
// room. From so far off, a tail that leans on the low middle muddies every
// chord, so this one keeps its low end lean (lows, hp). Chosen by ear, as the
// registration was.
const ROOM = { seconds: 4, predelay: 0.024, rt: [3.0, 2.6, 1.3], taps: 32, earlyEnd: 0.1,
  earlyShare: 0.3, fadeIn: 0.07, lows: 1, hp: 280, seed: 7 };
const DRY = 0.72, AIR = 3800, WET = 0.8;

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

    // every pipe into one bus, lean at the bottom, soft at the top, as loud as
    // the choir the organ replaced (-11.7 LUFS on No. 9)
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.21;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 60; hp.Q.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000; lp.Q.value = Math.SQRT1_2;
    const box = ctx.createConvolver();                 // the case
    box.normalize = false;
    box.buffer = caseImpulse(ctx);
    this.bus.connect(hp); hp.connect(lp); lp.connect(box);
    const air = ctx.createBiquadFilter();              // the direct sound, from the nave
    air.type = 'lowpass'; air.frequency.value = AIR; air.Q.value = Math.SQRT1_2;
    const dry = ctx.createGain();
    dry.gain.value = DRY;
    box.connect(air); air.connect(dry); dry.connect(this.master);
    const room = ctx.createConvolver();                // the room
    room.normalize = false;
    room.buffer = roomImpulse(ctx, ROOM);
    const wet = ctx.createGain();
    wet.gain.value = WET;
    box.connect(room); room.connect(wet); wet.connect(this.master);

    // one second of white noise for the chiff, the knocks and the wind, read
    // from a random place each time
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noise.getChannelData(0), nr = mulberry32(1685);
    for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;
    const src = ctx.createBufferSource();              // the bellows' rush, while the organ has wind
    src.buffer = this.noise; src.loop = true;
    const lo = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
    hi.type = 'highpass'; hi.frequency.value = 180;
    lo.type = 'lowpass'; lo.frequency.value = 1400;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(hi); hi.connect(lo); lo.connect(this.windGain); this.windGain.connect(this.bus);
    src.start();
    this.pipes = new Map();          // `${stop}:${midi}` -> { wave, freq }
    this.active = new Set();
  }

  // the bellows: 0 (no wind) to 1 (full), eased over a quarter second
  wind(level, at) {
    this.windGain.gain.setTargetAtTime(0.12 * level, at ?? this.ctx.currentTime, 0.25);
  }

  // the knock of a key's valve opening (or, softer, closing)
  knock(pan, now, level) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass'; band.frequency.value = 380; band.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level, now + 0.001);
    g.gain.setTargetAtTime(0, now + 0.001, 0.006);
    src.connect(band); band.connect(g); g.connect(pan);
    src.start(now, Math.random() * 0.9);
    src.stop(now + 0.05);
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
    this.knock(pan, now, 0.8);
    const handle = { vn, midi, nodes: [], envs: [], pan, off: false };
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
    this.knock(handle.pan, now, 0.35);
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
