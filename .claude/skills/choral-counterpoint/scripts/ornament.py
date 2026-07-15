#!/usr/bin/env python3
"""
Ornament a verified chorale skeleton the way Bach ornaments his:
eighth-note passing tones, neighbors, suspensions, cadential anticipations,
applied at the rates mined from the corpus (data/ornament_table.json).

Usage:
    python ornament.py skeleton.json out.json [--density 1.0] [--seed 7]

The input must be a slot-format chorale that already passes check_chorale —
ornament a broken skeleton and you get a decorated broken skeleton.

Output is event-format JSON carrying its skeleton, pre-verified against
check_ornaments: every candidate ornament that would create a violation is
simply not applied (propose → verify → keep only survivors).
"""
import json, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_io
import check_chorale
import check_ornaments

VOICES = score_io.VOICES
TABLE = json.load(open(Path(__file__).resolve().parent.parent / 'data' / 'ornament_table.json'))

def rate(section, voice, key_yes, key_no):
    c = TABLE[section].get(voice, {})
    yes, no = c.get(key_yes, 0), c.get(key_no, 0)
    return yes / max(yes + no, 1)

def scale_set(tonic_pc, mode):
    if mode == 'major':
        degs = {0, 2, 4, 5, 7, 9, 11}
    else:
        degs = {0, 2, 3, 5, 7, 8, 10, 11}       # natural minor + raised 7th
    return {(tonic_pc + d) % 12 for d in degs}

def diatonic_between(x, z, scale):
    """The stepwise pitch between two tones a third apart, if one exists."""
    lo, hi = min(x, z), max(x, z)
    cands = [m for m in range(lo + 1, hi) if m % 12 in scale
             and 1 <= m - lo <= 2 and 1 <= hi - m <= 2]
    return cands[0] if len(cands) == 1 else (cands[-1] if cands else None)

def diatonic_below(x, scale):
    for d in (1, 2):
        if (x - d) % 12 in scale:
            return x - d
    return None

def ornament(d, density=1.0, seed=7):
    rng = random.Random(seed)
    tonic, mode = d['tonic'], d.get('mode', 'major')
    tpc = score_io.PC[tonic]
    scale = scale_set(tpc, mode)
    skel = {v: [score_io.midi_num(p) for p in d[v]] for v in VOICES}
    ferm = sorted(d.get('fermatas', ()))
    n = len(skel['soprano'])
    ferm_set = set(ferm)
    # events[v][i] = list of (midi, eighths) for slot i
    events = {v: [[(skel[v][i], 2)] for i in range(n)] for v in VOICES}
    claimed = {v: [False] * n for v in VOICES}     # slot already reshaped

    def surface_noise(piece):
        voices, sk, fs = check_ornaments.load_with_skeleton(piece)
        V, W = check_ornaments.check_surface(voices, sk, tonic, mode, fs)
        return V, sum(1 for w in W if w.startswith('surface parallel')
                      or w.startswith('simultaneous'))

    def try_apply(voice, slot, new_events, claim_slots):
        """Tentatively apply; keep only if no violations AND no new surface
        parallels/clashes appear (stricter than the checker: Bach tolerates a
        few ornamental parallels, but we don't get to write new ones)."""
        old = [events[voice][s] for s in claim_slots]
        _, noise_before = surface_noise(build(events, skel, ferm, tonic, mode))
        for s, ev in zip(claim_slots, new_events):
            events[voice][s] = ev
        V, noise_after = surface_noise(build(events, skel, ferm, tonic, mode))
        if V or noise_after > noise_before:
            for s, ev in zip(claim_slots, old):
                events[voice][s] = ev
            return False
        for s in claim_slots:
            claimed[voice][s] = True
        return True

    # 1. suspensions first (they claim the slot AND need the previous slot plain)
    for v in VOICES[:3]:                                    # S, A, T (bass suspensions: later)
        p = rate('suspensions', v, 'sus', 'opportunity')
        for i in range(1, n):
            if claimed[v][i] or claimed[v][i-1] or i + 1 in ferm_set:
                continue
            prev, cur = skel[v][i-1], skel[v][i]
            if not 1 <= prev - cur <= 2:
                continue
            # classic dissonance against the bass at the moment of suspension
            iv = (prev - skel['bass'][i]) % 12
            if iv not in (1, 2, 5, 10, 11):                 # 9-, 4-, 7-type
                continue
            if rng.random() < min(1.0, p * density * 4):    # boosted: sites are rare
                try_apply(v, i, [[(prev, 1), (cur, 1)]], [i])

    # 2. passing tones (fill thirds), most active voice first
    for v in ['bass', 'tenor', 'alto', 'soprano']:
        for i in range(n - 1):
            if claimed[v][i] or i + 1 in ferm_set:      # never subdivide a fermata chord
                continue
            x, z = skel[v][i], skel[v][i+1]
            if abs(z - x) not in (3, 4):
                continue
            mid = diatonic_between(x, z, scale)
            if mid is None:
                continue
            key = 'third_up' if z > x else 'third_down'
            p = rate('fills', v, f'{key}_filled', f'{key}_plain')
            if rng.random() < min(1.0, p * density):
                try_apply(v, i, [[(x, 1), (mid, 1)]], [i])

    # 3. lower neighbors on repeated tones
    for v in ['bass', 'alto', 'tenor', 'soprano']:
        p = rate('neighbors', v, 'neighbor', 'plain')
        for i in range(n - 1):
            if claimed[v][i] or i + 1 in ferm_set:
                continue
            x, z = skel[v][i], skel[v][i+1]
            if x != z:
                continue
            nb = diatonic_below(x, scale)
            if nb is None:
                continue
            if rng.random() < min(1.0, p * density):
                try_apply(v, i, [[(x, 1), (nb, 1)]], [i])

    # 4. soprano anticipation into a cadence
    p_ant = rate('anticipations', 'soprano', 'ant', 'plain')
    for f in ferm:
        i = f - 2                                           # slot before the cadence chord
        if i < 0 or claimed['soprano'][i]:
            continue
        x, z = skel['soprano'][i], skel['soprano'][i+1]
        if 1 <= abs(x - z) <= 2 and rng.random() < min(1.0, p_ant * density * 4):
            try_apply('soprano', i, [[(x, 1), (z, 1)]], [i])

    return build(events, skel, ferm, tonic, mode)

def build(events, skel, ferm, tonic, mode):
    voices_out = {}
    for v in VOICES:
        flat = []
        for slot in events[v]:
            for m, ln in slot:
                # merge repeated pitches across the slot boundary? No — chorale
                # restrikes repeated tones; keep events as written.
                flat.append([score_io.pitch_name(m), ln])
        voices_out[v] = flat
    return {
        'format': 'events', 'tonic': tonic, 'mode': mode,
        'voices': voices_out,
        'fermata_eighths': [2 * (f - 1) for f in ferm],
        'skeleton': {**{v: [score_io.pitch_name(m) for m in skel[v]] for v in VOICES},
                     'fermatas': list(ferm)},
    }

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    density = float(sys.argv[sys.argv.index('--density') + 1]) if '--density' in sys.argv else 1.0
    seed = int(sys.argv[sys.argv.index('--seed') + 1]) if '--seed' in sys.argv else 7
    d = json.load(open(src))
    V, _ = check_chorale.check({v: [score_io.midi_num(p) for p in d[v]] for v in VOICES},
                               d['tonic'], d.get('mode', 'major'), d.get('fermatas', ()))
    if V:
        sys.exit("input skeleton has violations — fix it before ornamenting:\n  " + "\n  ".join(V))
    out = ornament(d, density, seed)
    json.dump(out, open(dst, 'w'), indent=1)
    n_ev = sum(len(v) for v in out['voices'].values())
    n_slots = len(d['soprano']) * 4
    print(f"wrote {dst}: {n_ev} events over {n_slots} structural tones "
          f"({n_ev - n_slots} ornaments)")
