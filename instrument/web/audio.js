// The choir: a WebAudio port of the auto_compose perform.py synthesizer.
// Four additive voices (custom PeriodicWave harmonics), per-voice detune,
// pan and brightness, delayed vibrato, soft envelopes, fermata swells,
// and a generated-impulse reverb. Notes are position-driven: the machine
// starts and stops them; nothing here knows about tempo.

const VOICE_PARAMS = {
  s: { pan: -0.35, detune: +2.5, vibHz: 5.3, bright: 1.00, gain: 0.95 },
  a: { pan: +0.35, detune: -2.0, vibHz: 4.9, bright: 0.80, gain: 0.90 },
  t: { pan: +0.15, detune: +1.5, vibHz: 5.1, bright: 0.70, gain: 0.95 },
  b: { pan: -0.10, detune: -3.0, vibHz: 4.6, bright: 0.55, gain: 1.10 },
};
const ATTACK = 0.07, RELEASE = 0.14;

function makeImpulse(ctx, seconds = 1.9, decay = 3.2) {
  const rate = ctx.sampleRate, len = Math.floor(seconds * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      lp = lp * 0.7 + white * 0.3;                 // soften the top end
      d[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export class Choir {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.35;
    this.reverb.connect(this.wet);
    this.wet.connect(this.master);

    this.voices = {};
    for (const [vn, p] of Object.entries(VOICE_PARAMS)) {
      const g = ctx.createGain();
      g.gain.value = p.gain * 0.22;
      const pan = ctx.createStereoPanner();
      pan.pan.value = p.pan;
      g.connect(pan);
      pan.connect(this.master);
      pan.connect(this.reverb);
      const real = new Float32Array(9), imag = new Float32Array(9);
      for (let h = 1; h <= 8; h++)
        imag[h] = Math.pow(h, -1.6) * Math.pow(p.bright, h - 1);
      this.voices[vn] = { out: g, wave: ctx.createPeriodicWave(real, imag), params: p };
    }
    this.active = new Set();
  }

  noteOn(vn, midi, { swell = false } = {}) {
    const ctx = this.ctx, v = this.voices[vn], now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(v.wave);
    const drift = (Math.random() - 0.5) * 2.4;      // slow per-note pitch drift, cents
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    osc.detune.value = v.params.detune + drift;

    const vib = ctx.createOscillator();
    vib.frequency.value = v.params.vibHz + (Math.random() - 0.5) * 0.3;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, now);
    vibDepth.gain.linearRampToValueAtTime(6, now + 0.8);   // cents, fades in
    vib.connect(vibDepth);
    vibDepth.connect(osc.detune);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + ATTACK);
    if (swell) {
      env.gain.linearRampToValueAtTime(1.18, now + 0.9);
      env.gain.linearRampToValueAtTime(0.9, now + 1.8);
    }
    osc.connect(env);
    env.connect(v.out);
    osc.start(now);
    vib.start(now);
    const handle = { osc, vib, env, vn, midi, off: false };
    this.active.add(handle);
    return handle;
  }

  noteOff(handle, release = RELEASE) {
    if (handle.off) return;
    handle.off = true;
    const now = this.ctx.currentTime;
    handle.env.gain.cancelScheduledValues(now);
    handle.env.gain.setValueAtTime(handle.env.gain.value, now);
    handle.env.gain.linearRampToValueAtTime(0, now + release);
    handle.osc.stop(now + release + 0.02);
    handle.vib.stop(now + release + 0.02);
    this.active.delete(handle);
  }

  releaseAll(release = 0.4) {
    for (const h of [...this.active]) this.noteOff(h, release);
  }
}
