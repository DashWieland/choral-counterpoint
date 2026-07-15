#!/usr/bin/env python3
"""
Shared score loading/timing for the choral-counterpoint scripts.

Two JSON formats:

v1 "slots" (one note per harmonic slot, quarter-note feel):
    {"tonic","mode","soprano":[...],"alto":[...],"tenor":[...],"bass":[...],
     "fermatas":[4,8]}                       # 1-indexed slot positions

v2 "events" (sub-beat rhythm, produced by ornament.py / the engine):
    {"format":"events","tonic","mode",
     "voices":{"soprano":[["F4",2],...],...},  # [pitch, length-in-eighths]
     "fermata_eighths":[14,30]}                # 0-based eighth offsets of
                                               # fermata-chord onsets

Both normalize to: voices = {name: [(midi, start_eighth, len_eighths)]},
plus fermata_eighths. Fermata timing: the two eighth positions starting at a
fermata onset are performed at 2x length (all voices stretch together).
"""
PC = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'E#':5,'Fb':4,'F':5,'F#':6,
      'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'B#':0,'Cb':11}
NAMES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
NAMES_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']
VOICES = ['soprano', 'alto', 'tenor', 'bass']

def midi_num(name):
    i = 1
    while i < len(name) and name[i] in '#b':
        i += 1
    return 12 * (int(name[i:]) + 1) + PC[name[:i]]

def pitch_name(m, flats=True):
    return (NAMES_FLAT if flats else NAMES_SHARP)[m % 12] + str(m // 12 - 1)

def load(d):
    """Normalize a score dict -> (voices, fermata_eighths, total_eighths)."""
    if d.get('format') == 'events' or 'voices' in d:
        voices = {}
        total = 0
        for name in VOICES:
            t = 0
            out = []
            for p, ln in d['voices'][name]:
                out.append((midi_num(p) if isinstance(p, str) else p, t, ln))
                t += ln
            voices[name] = out
            total = max(total, t)
        return voices, sorted(d.get('fermata_eighths', [])), total
    # v1 slots
    n = len(d['soprano'])
    voices = {name: [(midi_num(p), 2 * i, 2) for i, p in enumerate(d[name])]
              for name in VOICES}
    ferm = [2 * (f - 1) for f in d.get('fermatas', [])]
    return voices, ferm, 2 * n

def eighth_multipliers(total, fermata_eighths, stretch=2.0):
    """Per-eighth-position time multiplier (fermata chords held 2x)."""
    mult = [1.0] * total
    for f in fermata_eighths:
        for k in (f, f + 1):
            if 0 <= k < total:
                mult[k] = stretch
    return mult

def event_seconds(start, length, mult, eighth_sec):
    return sum(mult[start:start + length]) * eighth_sec, \
           sum(mult[:start]) * eighth_sec
