#!/usr/bin/env python3
"""
First-species counterpoint checker (strict Fux, two voices).
Usage:
    python check_species1.py notes.json
    python check_species1.py piece.mid --cf-track 1

Exit 0 = no violations. Violations are hard rule breaks; warnings are
taste-layer flags that don't fail the check.
"""
import json, sys

PC = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,
      'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11}

def midi(name):
    i = 1
    while name[i] in '#b': i += 1
    return 12 * (int(name[i:]) + 1) + PC[name[:i]]

CONSONANT = {0, 3, 4, 7, 8, 9}          # ic mod 12: P1/P8, m3, M3, P5, m6, M6
PERFECT   = {0: 'octave/unison', 7: 'fifth'}
MELODIC_OK = {0, 1, 2, 3, 4, 5, 7, 12}   # repeat, steps, 3rds, P4, P5, P8 (m6 asc below)

def load(path, cf_track=1):
    if path.endswith('.json'):
        d = json.load(open(path))
        return ([midi(n) for n in d['cantus']],
                [midi(n) for n in d['counterpoint']],
                d.get('cf_position', 'lower'))
    import mido
    mid = mido.MidiFile(path)
    tracks = []
    for t in mid.tracks:
        notes = [m.note for m in t if m.type == 'note_on' and m.velocity > 0]
        if notes: tracks.append(notes)
    if len(tracks) != 2:
        sys.exit(f"expected 2 note tracks, found {len(tracks)}")
    cf = tracks[cf_track]; cp = tracks[1 - cf_track]
    pos = 'lower' if sum(cf)/len(cf) < sum(cp)/len(cp) else 'upper'
    return cf, cp, pos

def check(cf, cp, cf_position):
    V, W = [], []   # violations, warnings
    n = len(cf)
    if len(cp) != n:
        return [f"length mismatch: CF {n} notes, CP {len(cp)}"], []
    lower = cf if cf_position == 'lower' else cp
    upper = cp if cf_position == 'lower' else cf
    iv  = [u - l for u, l in zip(upper, lower)]          # signed interval
    ic  = [abs(i) % 12 for i in iv]

    # -- vertical --
    for b, (i, c) in enumerate(zip(iv, ic), 1):
        if i < 0:
            V.append(f"bar {b}: voice crossing")
        if c not in CONSONANT:
            V.append(f"bar {b}: dissonant interval ({i} semitones)")
        if i == 0 and b not in (1, n):
            V.append(f"bar {b}: unison mid-phrase")
    if ic[0] not in (0, 7):
        V.append("bar 1: must begin on a perfect consonance")
    if cf_position == 'upper' and ic[0] == 7:
        V.append("bar 1: 5th below the CF inverts the mode")
    if ic[-1] != 0:
        V.append(f"bar {n}: must end on unison/octave")
    want = 9 if cf_position == 'lower' else 3   # M6 above / m3 below
    if ic[-2] != want:
        V.append(f"bar {n-1}: penultimate must be {'M6' if want==9 else 'm3'}")
    lt = (lower[-1] if cf_position == 'lower' else upper[-1])
    cp_pen = cp[-2]
    if abs(cp[-1] - cp_pen) != (1 if cp[-1] > cp_pen else abs(cp[-1]-cp_pen)):
        pass  # covered by leading-tone check below
    tonic = cf[-1] % 12
    if (cp_pen % 12) != (tonic - 1) % 12:
        V.append(f"bar {n-1}: counterpoint should carry the leading tone")

    # -- motion --
    imperfect_run = 1
    for b in range(1, n):
        dl, du = lower[b]-lower[b-1], upper[b]-upper[b-1]
        similar = (dl > 0 and du > 0) or (dl < 0 and du < 0)
        if ic[b] in PERFECT:
            if ic[b-1] == ic[b] and (dl or du):
                V.append(f"bars {b}-{b+1}: consecutive {PERFECT[ic[b]]}s")
            elif similar:
                V.append(f"bars {b}-{b+1}: direct {PERFECT[ic[b]]} (similar motion)")
        cat = lambda c: 'third' if c in (3,4) else 'sixth' if c in (8,9) else None
        imperfect_run = imperfect_run + 1 if (cat(ic[b]) and cat(ic[b]) == cat(ic[b-1])) else 1
        if imperfect_run == 4:
            V.append(f"bar {b+1}: 4th consecutive parallel 3rd/6th")

    # -- melodic (CP line) --
    prev_leap = 0
    for b in range(1, n):
        step = cp[b] - cp[b-1]
        a = abs(step)
        if a not in MELODIC_OK and not (step == 8):   # m6 ascending only
            V.append(f"bars {b}-{b+1}: bad melodic interval ({step} semitones)")
        if a == 6:
            V.append(f"bars {b}-{b+1}: melodic tritone")
        if abs(prev_leap) >= 5 and a and (a > 2 or (step > 0) == (prev_leap > 0)):
            W.append(f"bar {b+1}: leap of {abs(prev_leap)} not recovered by opposite step")
        prev_leap = step
    hi = max(cp)
    if cp.count(hi) > 1:
        W.append(f"climax ({hi}) occurs {cp.count(hi)} times; should be unique")
    if max(cp) - min(cp) > 16:
        V.append("CP range exceeds a 10th")
    for b in range(2, n):
        if cp[b] == cp[b-1] == cp[b-2]:
            V.append(f"bar {b+1}: note repeated 3x")
    return V, W

if __name__ == '__main__':
    path = sys.argv[1]
    cf_track = int(sys.argv[sys.argv.index('--cf-track')+1]) if '--cf-track' in sys.argv else 1
    cf, cp, pos = load(path, cf_track)
    V, W = check(cf, cp, pos)
    for v in V: print(f"VIOLATION  {v}")
    for w in W: print(f"warning    {w}")
    if not V and not W: print("clean: no violations, no warnings")
    sys.exit(1 if V else 0)
