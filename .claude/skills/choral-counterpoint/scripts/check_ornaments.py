#!/usr/bin/env python3
"""
Surface checker for ornamented chorales (event format).

Usage: python check_ornaments.py piece.json

The event JSON must carry its structural skeleton (ornament.py emits it):
    "skeleton": {"soprano": [...], "alto": [...], "tenor": [...], "bass": [...],
                 "fermatas": [...]}          # slot format, 1-indexed fermatas

Three layers:
1. The skeleton itself passes check_chorale (the note-against-note laws).
2. The surface states the skeleton faithfully: in every slot each voice
   sounds its structural tone on the beat — or, for a suspension, sounds the
   PREPARED previous tone on the beat and resolves DOWN BY STEP to the
   structural tone on the offbeat. Every offbeat non-chord tone is a passing
   tone, neighbor, or anticipation (approached/left by step or restating the
   next beat). Surface melodic laws hold (no aug 2nds, no 7th leaps).
3. Eighth-adjacent perfect parallels and simultaneous clashing NCTs: warnings
   (Bach tolerates a few at ornamental subdivisions; the skeleton layer is
   where parallels are hard errors).

Exit 0 = no violations.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_io
import check_chorale

VOICES = score_io.VOICES

def surface_grid(voices, total):
    grid = {}
    for name in VOICES:
        g = [None] * total
        for m, s, ln in voices[name]:
            for k in range(s, min(s + ln, total)):
                g[k] = m
        grid[name] = g
    return grid

def check_surface(voices, skel, tonic, mode, ferm_slots):
    V, W = [], []
    total = max(s + ln for evs in voices.values() for _, s, ln in evs)
    if total % 2:
        return [f"total length {total} eighths is odd — slots must be whole quarters"], []
    n_slots = total // 2
    for name in VOICES:
        if len(skel[name]) != n_slots:
            return [f"skeleton/{name}: {len(skel[name])} slots but surface spans {n_slots}"], []
    grid = surface_grid(voices, total)
    for name in VOICES:
        if any(p is None for p in grid[name]):
            return [f"{name}: gap in surface (events do not tile the timeline)"], []

    # layer 1: skeleton legality
    V1, W1 = check_chorale.check(skel, tonic, mode, ferm_slots)
    V += [f"[skeleton] {v}" for v in V1]
    W += [f"[skeleton] {w}" for w in W1]

    # layer 2: surface states the skeleton correctly
    tpc = score_io.PC[tonic]
    for name in VOICES:
        g, sk = grid[name], skel[name]
        for i in range(n_slots):
            on, off = g[2*i], g[2*i + 1]
            slot_pcs = {skel[v][i] % 12 for v in VOICES}
            if on == sk[i]:
                if off != sk[i] and off % 12 not in slot_pcs:
                    nxt = g[2*i + 2] if 2*i + 2 < total else off
                    if not (off == nxt or (abs(off - on) <= 2 and abs(nxt - off) <= 2)):
                        V.append(f"{name}, slot {i+1}: offbeat non-chord tone "
                                 f"approached or left by leap")
            elif off == sk[i]:
                prev = g[2*i - 1] if i > 0 else None
                if prev != on:
                    V.append(f"{name}, slot {i+1}: on-beat dissonance is unprepared "
                             f"(not held from the previous tone)")
                if not 1 <= on - off <= 2:
                    V.append(f"{name}, slot {i+1}: on-beat dissonance does not "
                             f"resolve down by step")
            else:
                V.append(f"{name}, slot {i+1}: surface never states the structural tone")
        # surface melodic laws
        line = [m for m, s, ln in voices[name]]
        for j in range(1, len(line)):
            step = abs(line[j] - line[j-1])
            if step > 12:
                V.append(f"{name}: surface leap beyond an octave (event {j+1})")
            elif step in (10, 11):
                V.append(f"{name}: surface leap of a seventh (event {j+1})")
            if step == 3 and mode == 'minor':
                pcs = {(line[j-1] - tpc) % 12, (line[j] - tpc) % 12}
                if pcs == {8, 11}:
                    V.append(f"{name}: augmented second at the surface (event {j+1})")

    # layer 3: surface-adjacency warnings
    for a_i, a in enumerate(VOICES):
        for b in VOICES[a_i+1:]:
            ga, gb = grid[a], grid[b]
            for k in range(1, total):
                ic0, ic1 = (ga[k-1] - gb[k-1]) % 12, (ga[k] - gb[k]) % 12
                if ic1 in (0, 7) and ic0 == ic1 and ga[k] != ga[k-1] and gb[k] != gb[k-1] \
                        and (ga[k] > ga[k-1]) == (gb[k] > gb[k-1]):
                    W.append(f"surface parallel {'octaves' if ic1 == 0 else 'fifths'} "
                             f"({a}/{b}, eighths {k}-{k+1})")
    for i in range(n_slots):
        k = 2*i + 1
        slot_pcs = {skel[v][i] % 12 for v in VOICES}
        ncts = [v for v in VOICES if grid[v][k] % 12 not in slot_pcs]
        for x_i, x in enumerate(ncts):
            for y in ncts[x_i+1:]:
                if (grid[x][k] - grid[y][k]) % 12 in (1, 2, 6, 10, 11):
                    W.append(f"simultaneous non-chord tones clash ({x}/{y}, slot {i+1})")
    return V, W

def load_with_skeleton(d):
    voices, ferm_eighths, total = score_io.load(d)
    sk = d['skeleton']
    skel = {v: [score_io.midi_num(p) for p in sk[v]] for v in VOICES}
    return voices, skel, sk.get('fermatas', [f // 2 + 1 for f in ferm_eighths])

if __name__ == '__main__':
    d = json.load(open(sys.argv[1]))
    if 'skeleton' not in d:
        sys.exit("this checker needs the 'skeleton' block that ornament.py emits")
    voices, skel, ferm_slots = load_with_skeleton(d)
    V, W = check_surface(voices, skel, d['tonic'], d.get('mode', 'major'), ferm_slots)
    for x in V: print(f"VIOLATION  {x}")
    for x in W: print(f"warning    {x}")
    if not V and not W:
        print("clean: no violations, no warnings")
    sys.exit(1 if V else 0)
