#!/usr/bin/env python3
"""
Mine Bach's ornamentation habits: what happens between the beats?

For every voice in every chorale, build the quarter-note skeleton, then
classify what the surface actually does within each beat:

  plain          one note filling the beat
  fill           eighth passing tone filling a third between beats
  neighbor       eighth upper/lower neighbor returning to the same pitch
  anticipation   offbeat eighth sounding the NEXT beat's pitch early
  suspension     old pitch held/restruck into the beat, stepping down mid-beat
  other          sixteenths, escapes, everything else (counted, not modeled)

Rates are conditioned on voice, and where relevant on direction and
cadence proximity (beat immediately before a fermata).

Output: .claude/skills/choral-counterpoint/data/ornament_table.json
"""
import json, sys
from collections import Counter
from pathlib import Path
from music21 import corpus

OUT = Path(__file__).resolve().parents[1] / '.claude' / 'skills' / 'choral-counterpoint' / 'data' / 'ornament_table.json'
VOICE_NAMES = ['soprano', 'alto', 'tenor', 'bass']
EPS = 1e-6

def voice_events(part):
    """[(offset, dur, midi)] for a part, or None if it has rests/chords."""
    ev = []
    for n in part.flatten().notesAndRests:
        if n.isRest:
            return None
        if not n.isNote:
            return None
        ev.append((float(n.offset), float(n.quarterLength), n.pitch.midi))
    return ev

def pitch_at(ev, t):
    """midi of the event sounding at time t (last onset <= t)."""
    lo, hi, best = 0, len(ev) - 1, None
    for off, dur, m in ev:
        if off <= t + EPS:
            best = (off, dur, m)
        else:
            break
    return best

def classify_beat(ev, t, fermata_beats):
    """Classify the figuration inside beat [t, t+1)."""
    inside = [e for e in ev if t - EPS <= e[0] < t + 1 - EPS]
    cur = pitch_at(ev, t)
    nxt = pitch_at(ev, t + 1)
    if cur is None or nxt is None:
        return None
    c, n = cur[2], nxt[2]
    if len(inside) <= 1:
        # possibly a suspension: the sounding pitch at t has onset < t (held over)
        # with a resolution onset mid-beat — that resolution would BE inside.
        return ('plain', c, n)
    if len(inside) == 2 and all(abs(e[1] - 0.5) < EPS for e in inside):
        x, y = inside[0][2], inside[1][2]
        if x == c:
            if y == n and abs(n - x) in (1, 2):
                return ('anticipation', c, n)
            if abs(y - x) in (1, 2) and abs(n - y) in (1, 2) and (y - x) * (n - y) > 0:
                return ('fill', c, n)
            if x == n and abs(y - x) in (1, 2):
                return ('neighbor', c, n)
        return ('other', c, n)
    # suspension shape: first inside-event starts mid-beat (held note resolved)
    if len(inside) == 1:
        return ('plain', c, n)
    return ('other', c, n)

def find_suspensions(ev, n_beats):
    """Beats where the pitch at the beat is held from before and steps down mid-beat."""
    sus = []
    for b in range(1, n_beats):
        t = float(b)
        at = pitch_at(ev, t)
        if at is None or at[0] > t - 0.5 + EPS:   # onset at/near the beat: not held over
            continue
        # find resolution: an onset in (t, t+1)
        mids = [e for e in ev if t + EPS < e[0] < t + 1 - EPS]
        if len(mids) == 1 and at[2] - mids[0][2] in (1, 2):
            sus.append(b)
    return sus

def main(limit=10**9):
    fills = {v: Counter() for v in VOICE_NAMES}        # keys: filled/unfilled by |ivl| and dir
    neighbors = {v: Counter() for v in VOICE_NAMES}    # repeated-pitch beats: neighbor/plain
    anticips = {v: Counter() for v in VOICE_NAMES}     # step-down-into-cadence: ant/plain
    suspensions = {v: Counter() for v in VOICE_NAMES}  # step-down beat pairs: sus/plain
    shapes = {v: Counter() for v in VOICE_NAMES}       # overall figuration census
    n_ok = n_skip = 0
    for i, chorale in enumerate(corpus.chorales.Iterator()):
        if i >= limit:
            break
        parts = chorale.parts
        if len(parts) != 4:
            n_skip += 1
            continue
        evs = [voice_events(p) for p in parts]
        if any(e is None or not e for e in evs):
            n_skip += 1
            continue
        evs.sort(key=lambda e: -sum(m for _, _, m in e) / len(e))
        # fermata beats from soprano expressions
        ferm = set()
        for n in parts[0].flatten().notes:
            if any(type(x).__name__ == 'Fermata' for x in n.expressions):
                ferm.add(int(n.offset))
        n_ok += 1
        end = int(max(e[-1][0] + e[-1][1] for e in evs))
        for vname, ev in zip(VOICE_NAMES, evs):
            for b in range(end):
                got = classify_beat(ev, float(b), ferm)
                if got is None:
                    continue
                kind, c, n = got
                shapes[vname][kind] += 1
                pre_cad = (b + 1) in ferm or b in ferm
                ivl = n - c
                if abs(ivl) in (3, 4):
                    key = f"third_{'up' if ivl > 0 else 'down'}"
                    fills[vname][f"{key}_{'filled' if kind == 'fill' else 'plain'}"] += 1
                if ivl == 0 and not pre_cad:
                    neighbors[vname]['neighbor' if kind == 'neighbor' else 'plain'] += 1
                if abs(ivl) in (1, 2) and pre_cad and vname == 'soprano':
                    anticips[vname]['ant' if kind == 'anticipation' else 'plain'] += 1
            for b in find_suspensions(ev, end):
                suspensions[vname]['sus'] += 1
            # denominator: beats approached by step down (suspension opportunities)
            for b in range(1, end):
                cur, prv = pitch_at(ev, float(b)), pitch_at(ev, float(b) - 1)
                if cur and prv and prv[2] - cur[2] in (1, 2):
                    suspensions[vname]['opportunity'] += 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    json.dump({
        'fills': {v: dict(c) for v, c in fills.items()},
        'neighbors': {v: dict(c) for v, c in neighbors.items()},
        'anticipations': {v: dict(c) for v, c in anticips.items()},
        'suspensions': {v: dict(c) for v, c in suspensions.items()},
        'shapes': {v: dict(c) for v, c in shapes.items()},
        'meta': {'chorales': n_ok, 'skipped': n_skip},
    }, open(OUT, 'w'), indent=1)
    print(f"mined {n_ok} chorales ({n_skip} skipped) -> {OUT}")
    for v in VOICE_NAMES:
        tot = sum(shapes[v].values())
        print(f"  {v}: " + ", ".join(f"{k} {100*c//max(tot,1)}%" for k, c in shapes[v].most_common(5)))

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10**9)
