#!/usr/bin/env python3
"""
Four-voice (SATB) chorale voice-leading checker, Bach style.

Usage:
    python check_chorale.py chorale.json

Input JSON:
{
  "tonic": "F", "mode": "major",
  "soprano": ["F4", ...], "alto": [...], "tenor": [...], "bass": [...],
  "fermatas": [4, 8]            # optional, 1-indexed chord positions (phrase-final chords)
}

All four lists must be the same length: one note per harmonic slot.
Exit 0 = no violations. Warnings never fail the check.

Calibration (tools/validate_checker.py runs this on the Bach corpus; rules Bach
himself trips at material rates are warnings, not violations):
- VIOLATIONS: parallel 5ths/8ves (both voices moving, within a phrase),
  augmented 2nd, leaps > octave or of a 7th within a phrase.
- WARNINGS: crossing, spacing, ranges, antiparallels, direct 5ths/8ves in the
  outer voices, overlap, melodic tritone, anything across a fermata boundary,
  doubled leading tone (cannot be a hard rule without local-key tracking:
  V-of-tonic is pc-identical to I-of-dominant), unresolved cadential LT.
Residual rates on the corpus itself (the checker is deliberately a bit stricter
than Bach): surface parallels ~0.13/chorale (many at ornamental subdivisions),
big leaps ~0.1/chorale. Zero would mean the checker is too loose.
"""
import json, sys

PC = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'E#':5,'Fb':4,'F':5,'F#':6,
      'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'B#':0,'Cb':11}

def midi(name):
    i = 1
    while i < len(name) and name[i] in '#b':
        i += 1
    return 12 * (int(name[i:]) + 1) + PC[name[:i]]

VOICES = ['soprano', 'alto', 'tenor', 'bass']
PAIRS = [(a, b) for i, a in enumerate(VOICES) for b in VOICES[i+1:]]
PERFECT = {0: 'octave/unison', 7: 'fifth'}
RANGES = {'soprano': (60, 81), 'alto': (53, 74), 'tenor': (48, 69), 'bass': (36, 62)}
DOMINANT_FAMILY = {2, 5, 7, 8, 11}   # pcs of V, V7, viio, viio7 relative to tonic

def check(v, tonic, mode, fermatas=()):
    V, W = [], []
    n = len(v['soprano'])
    for name in VOICES:
        if len(v[name]) != n:
            return [f"length mismatch: soprano {n}, {name} {len(v[name])}"], []
    tonic_pc = PC[tonic]
    lt = (tonic_pc - 1) % 12
    fermata_set = set(fermatas)
    # transition b (0-based: chord b-1 -> chord b) crosses a phrase boundary
    # when chord b-1 is a fermata chord, i.e. b is in fermata_set (1-indexed).
    boundary = lambda b: b in fermata_set

    # -- verticalities --
    for b in range(n):
        s, a, t, bs = (v[x][b] for x in VOICES)
        if not (s >= a >= t >= bs):
            W.append(f"chord {b+1}: voice crossing")
        if s - a > 12:
            W.append(f"chord {b+1}: soprano-alto spacing exceeds an octave")
        if a - t > 12:
            W.append(f"chord {b+1}: alto-tenor spacing exceeds an octave")
        for name in VOICES:
            lo, hi = RANGES[name]
            if not lo <= v[name][b] <= hi:
                W.append(f"chord {b+1}: {name} out of range ({v[name][b]})")
        pcs = [(p - tonic_pc) % 12 for p in (s, a, t, bs)]
        if pcs.count(11) > 1:
            ctx = "dominant chord" if set(pcs) <= DOMINANT_FAMILY else "non-dominant context"
            W.append(f"chord {b+1}: doubled leading tone ({ctx}) — genuine error unless "
                     f"the music has modulated and this pc is not the LOCAL leading tone")

    # -- pairwise motion --
    for hi_name, lo_name in PAIRS:
        hi, lo = v[hi_name], v[lo_name]
        ics = [(h - l) % 12 for h, l in zip(hi, lo)]
        for b in range(1, n):
            dh, dl = hi[b] - hi[b-1], lo[b] - lo[b-1]
            if ics[b] not in PERFECT:
                continue
            label = f"{PERFECT[ics[b]]}s ({hi_name}/{lo_name}, chords {b}-{b+1})"
            suffix = " [across fermata]" if boundary(b) else ""
            if ics[b-1] == ics[b] and dh and dl:
                if (dh > 0) == (dl > 0):
                    (W if boundary(b) else V).append(f"parallel {label}{suffix}")
                else:
                    W.append(f"antiparallel {label}{suffix}")
            elif (hi_name, lo_name) == ('soprano', 'bass'):
                similar = (dh > 0 and dl > 0) or (dh < 0 and dl < 0)
                if similar and abs(dh) > 2:
                    W.append(f"direct {label}: similar motion, soprano leap{suffix}")

    # -- overlap (adjacent voices) --
    for up, dn in zip(VOICES, VOICES[1:]):
        for b in range(1, n):
            if boundary(b):
                continue
            if v[dn][b] > v[up][b-1] or v[up][b] < v[dn][b-1]:
                W.append(f"chords {b}-{b+1}: {up}/{dn} overlap")

    # -- melodic lines --
    for name in VOICES:
        line = v[name]
        for b in range(1, n):
            step = line[b] - line[b-1]
            aiv = abs(step)
            suffix = " [across fermata]" if boundary(b) else ""
            sink = W if boundary(b) else V
            if aiv > 12:
                sink.append(f"{name}, chords {b}-{b+1}: leap larger than an octave{suffix}")
            elif aiv in (10, 11):
                sink.append(f"{name}, chords {b}-{b+1}: leap of a seventh{suffix}")
            elif aiv == 6:
                W.append(f"{name}, chords {b}-{b+1}: melodic tritone{suffix}")
            if aiv == 3 and mode == 'minor':
                pcs = {(line[b-1] - tonic_pc) % 12, (line[b] - tonic_pc) % 12}
                if pcs == {8, 11}:
                    (W if boundary(b) else V).append(
                        f"{name}, chords {b}-{b+1}: augmented second{suffix}")

    # -- leading tone resolution (outer voices, into cadence chords) --
    for name in ('soprano', 'bass'):
        line = v[name]
        for b in range(1, n):
            if line[b-1] % 12 == lt and (b + 1 in fermata_set or b == n - 1):
                if line[b] - line[b-1] != 1:
                    W.append(f"{name}, chords {b}-{b+1}: leading tone not resolved up at cadence")
    return V, W

if __name__ == '__main__':
    d = json.load(open(sys.argv[1]))
    voices = {name: [midi(p) for p in d[name]] for name in VOICES}
    V, W = check(voices, d['tonic'], d.get('mode', 'major'), d.get('fermatas', ()))
    for x in V: print(f"VIOLATION  {x}")
    for x in W: print(f"warning    {x}")
    if not V and not W:
        print("clean: no violations, no warnings")
    sys.exit(1 if V else 0)
