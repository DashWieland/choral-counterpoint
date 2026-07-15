#!/usr/bin/env python3
"""
Perform a chorale JSON as audio: a small choir-ish synthesizer.

Usage: python tools/perform.py piece.json out.wav [--bpm 66]

Accepts slot-format and event-format scores (see scripts/score_io.py).
Not a soundfont render — a performance: per-voice detune and drift,
delayed vibrato, legato within phrases, breath after fermatas, a swell
on fermata chords, final ritardando, SATB stereo spread, Schroeder reverb.
Requires: numpy
"""
import json, sys, wave
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts'))
import score_io

SR = 44100
BREATH = 0.28

# voice: (pan, detune_cents, vibrato_hz, brightness, gain)
VOICES = {
    'soprano': (-0.35, +2.5, 5.3, 1.00, 0.95),
    'alto':    (+0.35, -2.0, 4.9, 0.80, 0.90),
    'tenor':   (+0.15, +1.5, 5.1, 0.70, 0.95),
    'bass':    (-0.10, -3.0, 4.6, 0.55, 1.10),
}

def timeline(total, ferm, bpm):
    """(start_sec[i], dur_sec[i]) per eighth position, with fermata stretch,
    ritardando over the last 4 positions, and a breath after each fermata."""
    eighth = 60.0 / bpm / 2
    mult = score_io.eighth_multipliers(total, ferm)
    for k, r in zip(range(total - 4, total), (1.0, 1.06, 1.12, 1.25)):
        if 0 <= k < total:
            mult[k] *= r
    dur = [eighth * m for m in mult]
    breath_after = {f + 1 for f in ferm if f + 2 < total}
    start, t = [], 0.0
    for i in range(total):
        start.append(t)
        t += dur[i] + (BREATH if i in breath_after else 0.0)
    return start, dur

def synth_voice(events, start, dur, ferm, detune, vib_hz, bright, rng, total_sec):
    n = int(total_sec * SR) + SR * 4
    out = np.zeros(n)
    ferm_set = set(ferm)
    for m, s, ln in events:
        t0 = start[s]
        d = sum(dur[s:s + ln])
        length = int(d * SR)
        if length <= 0:
            continue
        t = np.arange(length) / SR
        f0 = 440.0 * 2 ** ((m - 69) / 12) * 2 ** (detune / 1200)
        drift = 2 ** (rng.normal(0, 1.2) / 1200)
        vib_depth = 0.006 * np.clip((t - 0.25) / 0.5, 0, 1)
        phase = np.cumsum(1 + vib_depth * np.sin(2*np.pi*vib_hz*t + rng.uniform(0, 6))) / SR
        sig = np.zeros(length)
        for h in range(1, 9):
            sig += h ** -1.6 * (bright ** (h - 1)) * np.sin(2*np.pi*f0*drift*h*phase)
        env = np.ones(length)
        a = min(int(0.07 * SR), length // 3)
        r = min(int(0.10 * SR), length // 3)
        env[:a] = np.linspace(0, 1, a) ** 1.5
        env[-r:] *= np.linspace(1, 0.25, r)
        if any(f <= s < f + 2 or s <= f < s + ln for f in ferm_set):     # fermata swell
            env *= 0.85 + 0.3 * np.sin(np.pi * np.clip(t / d, 0, 1)) ** 2
            fade = min(int(0.25 * SR), length)
            env[-fade:] *= np.linspace(1, 0.0, fade)
        sig *= env * (1 + 0.04 * np.sin(2*np.pi*0.7*t + rng.uniform(0, 6)))
        i0 = int(t0 * SR)
        out[i0:i0 + length] += sig
    return out

def reverb(x, wet=0.26):
    combs = [(1557, .84), (1617, .82), (1491, .86), (1422, .81), (1277, .80), (1356, .79)]
    y = np.zeros_like(x)
    for d, g in combs:
        buf = np.copy(x)
        for i in range(d, len(buf)):
            buf[i] += g * buf[i - d]
        y += buf
    y /= len(combs)
    for d, g in [(225, .7), (556, .7), (441, .7)]:      # allpass chain
        out = np.zeros_like(y)
        buf = np.zeros(d)
        for i in range(len(y)):
            v = y[i] + g * buf[i % d]
            out[i] = buf[i % d] - g * v
            buf[i % d] = v
        y = out
    return x * (1 - wet) + y * wet

def main():
    src, dst = sys.argv[1], sys.argv[2]
    bpm = int(sys.argv[sys.argv.index('--bpm') + 1]) if '--bpm' in sys.argv else 66
    d = json.load(open(src))
    voices, ferm, total = score_io.load(d)
    start, dur = timeline(total, ferm, bpm)
    total_sec = start[-1] + dur[-1]
    rng = np.random.default_rng(1685)               # J.S.B.'s birth year
    L = R = None
    for name, (pan, det, vib, bright, gain) in VOICES.items():
        v = synth_voice(voices[name], start, dur, ferm, det, vib, bright, rng, total_sec) * gain
        l, r = v * np.sqrt((1 - pan) / 2), v * np.sqrt((1 + pan) / 2)
        L = l if L is None else L + l
        R = r if R is None else R + r
    L, R = reverb(L), reverb(R)
    peak = max(np.abs(L).max(), np.abs(R).max())
    L, R = L / peak * 0.85, R / peak * 0.85
    stereo = np.empty(2 * len(L), dtype=np.int16)
    stereo[0::2] = (L * 32767).astype(np.int16)
    stereo[1::2] = (R * 32767).astype(np.int16)
    with wave.open(dst, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(stereo.tobytes())
    print(f"wrote {dst}: {len(L)/SR:.1f}s at {bpm} bpm")

if __name__ == '__main__':
    main()
