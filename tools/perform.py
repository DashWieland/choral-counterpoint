#!/usr/bin/env python3
"""
Perform a chorale JSON as audio: a small choir-ish synthesizer.

Usage: python tools/perform.py piece.json out.wav [--bpm 66]

Not a soundfont render — a performance: per-voice detune and drift,
delayed vibrato, legato within phrases, breath after fermatas, a swell
on fermata chords, final ritardando, SATB stereo spread, Schroeder reverb.
Requires: numpy
"""
import json, sys, wave
import numpy as np

SR = 44100
PC = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'E#':5,'Fb':4,'F':5,'F#':6,
      'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'B#':0,'Cb':11}

def midi_num(name):
    i = 1
    while i < len(name) and name[i] in '#b':
        i += 1
    return 12 * (int(name[i:]) + 1) + PC[name[:i]]

# voice: (pan, detune_cents, vibrato_hz, brightness, gain)
VOICES = {
    'soprano': (-0.35, +2.5, 5.3, 1.00, 0.95),
    'alto':    (+0.35, -2.0, 4.9, 0.80, 0.90),
    'tenor':   (+0.15, +1.5, 5.1, 0.70, 0.95),
    'bass':    (-0.10, -3.0, 4.6, 0.55, 1.10),
}

def synth_voice(notes, durs, gaps, swells, detune, vib_hz, bright, rng):
    """One legato line. gaps[i]: silence inserted BEFORE note i (breath)."""
    total = sum(durs) + sum(gaps)
    n = int(total * SR) + SR * 4
    out = np.zeros(n)
    t_cursor = 0.0
    for i, (m, dur) in enumerate(zip(notes, durs)):
        t_cursor += gaps[i]
        start = int(t_cursor * SR)
        length = int(dur * SR)
        t = np.arange(length) / SR
        f0 = 440.0 * 2 ** ((m - 69) / 12) * 2 ** (detune / 1200)
        # slow pitch drift + vibrato that fades in after ~0.25 s
        drift = 2 ** (rng.normal(0, 1.2) / 1200)
        vib_depth = 0.006 * np.clip((t - 0.25) / 0.5, 0, 1)
        phase_mod = np.cumsum(1 + vib_depth * np.sin(2*np.pi*vib_hz*t + rng.uniform(0, 6))) / SR
        sig = np.zeros(length)
        for h in range(1, 9):
            amp = h ** -1.6 * (bright ** (h - 1))
            sig += amp * np.sin(2*np.pi*f0*drift*h*phase_mod)
        # envelope: soft attack, legato sustain, gentle release inside the slot
        env = np.ones(length)
        a = min(int(0.07*SR), length//3)
        r = min(int(0.10*SR), length//3)
        env[:a] = np.linspace(0, 1, a) ** 1.5
        env[-r:] *= np.linspace(1, 0.25, r)
        if swells[i]:                          # fermata swell-and-fade
            env *= 0.85 + 0.3*np.sin(np.pi * np.clip(t/dur, 0, 1)) ** 2
            env[-int(0.25*SR):] *= np.linspace(1, 0.0, int(0.25*SR))
        sig *= env * (1 + 0.04*np.sin(2*np.pi*0.7*t + rng.uniform(0, 6)))   # slow breath sway
        out[start:start+length] += sig
        t_cursor += dur
    return out

def reverb(x, wet=0.26):
    combs = [(1557, .84), (1617, .82), (1491, .86), (1422, .81), (1277, .80), (1356, .79)]
    y = np.zeros_like(x)
    for d, g in combs:
        buf = np.copy(x)
        for i in range(d, len(buf)):
            buf[i] += g * buf[i-d]
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
    return x * (1-wet) + y * wet

def main():
    src, dst = sys.argv[1], sys.argv[2]
    bpm = int(sys.argv[sys.argv.index('--bpm')+1]) if '--bpm' in sys.argv else 66
    d = json.load(open(src))
    ferm = set(d.get('fermatas', ()))
    n_slots = len(d['soprano'])
    slot = 60.0 / bpm
    durs, gaps, swells = [], [], []
    for i in range(1, n_slots + 1):
        rit = 1.0
        if i == n_slots - 1: rit = 1.12          # final ritardando
        if i == n_slots:     rit = 1.25
        durs.append(slot * (2.0 if i in ferm else 1.0) * rit)
        gaps.append(0.28 if (i - 1) in ferm else 0.0)   # breath after a fermata
        swells.append(i in ferm)
    rng = np.random.default_rng(1685)            # J.S.B.'s birth year
    L = R = None
    for name, (pan, det, vib, bright, gain) in VOICES.items():
        notes = [midi_num(p) for p in d[name]]
        v = synth_voice(notes, durs, gaps, swells, det, vib, bright, rng) * gain
        l, r = v * np.sqrt((1-pan)/2), v * np.sqrt((1+pan)/2)
        L = l if L is None else L + l
        R = r if R is None else R + r
    L, R = reverb(L), reverb(R)
    peak = max(np.abs(L).max(), np.abs(R).max())
    L, R = L/peak*0.85, R/peak*0.85
    stereo = np.empty(2*len(L), dtype=np.int16)
    stereo[0::2] = (L*32767).astype(np.int16)
    stereo[1::2] = (R*32767).astype(np.int16)
    with wave.open(dst, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(stereo.tobytes())
    print(f"wrote {dst}: {len(L)/SR:.1f}s at {bpm} bpm")

if __name__ == '__main__':
    main()
