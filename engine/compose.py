#!/usr/bin/env python3
"""
The composition engine: fully automatic verified chorale generation.

    python engine/compose.py --tonic D --mode minor --phrases 3 --seed 11 \
        --out out/engine_piece.json [--density 1.0] [--plain]

Pipeline (each stage governed the way the skill prescribes):
  1. melody()    — phrase-planned soprano: cadence targets, single climax,
                   mostly stepwise, leap recovery
  2. bass_line() — beam search over the outer-voice oracle; zero-support
                   moves are excluded outright (hard corpus veto), line
                   shape scored to avoid the greedy root-position seesaw
  3. harmonize() — alto/tenor beam search under the voice-leading laws as
                   hard constraints (all six pairs, doubling, spacing)
  4. check_chorale — the final gate; a piece that fails is discarded and
                   recomposed with a new sub-seed (belt and braces)
  5. ornament()  — corpus-rate figuration (unless --plain)

Everything is deterministic for a given (params, seed).
"""
import json, math, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import score_io
import check_chorale
import ornament as ornament_mod

PC = score_io.PC
ORACLE = json.load(open(SCRIPTS.parent / 'data' / 'outer_voice_table.json'))

MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]          # natural; LT handled at cadences

def scale_pcs(tonic_pc, mode):
    base = MAJOR if mode == 'major' else MINOR
    return [(tonic_pc + d) % 12 for d in base]

# ---------------------------------------------------------------- melody --

def melody(tonic_pc, mode, n_phrases, rng):
    """Phrase-planned soprano in slot format. Returns (pitches, fermatas)."""
    scale = scale_pcs(tonic_pc, mode)
    tonic4 = 60 + tonic_pc                            # tonic in the C4..B4 octave
    window = [m for m in range(max(60, tonic4 - 5), min(79, tonic4 + 14))
              if m % 12 in scale]
    deg = lambda m: (m % 12 - tonic_pc) % 12
    # cadence plan: intermediate phrases end on 2 or 5 (half-ish), or 3;
    # the final phrase ends 2->1 or 7->1.
    inter_targets = [2, 7, 4] if mode == 'major' else [2, 7, 3]
    plan = [rng.choice(inter_targets) for _ in range(n_phrases - 1)] + [0]
    phrase_lens = [rng.choice([4, 5, 6]) for _ in range(n_phrases)]
    total = sum(phrase_lens)
    climax_pos = int(total * rng.uniform(0.55, 0.75))

    pitches = []
    cur = rng.choice([m for m in window if deg(m) in (0, 4, 3, 7)][:4])
    for pi, (plen, target_deg) in enumerate(zip(phrase_lens, plan)):
        for k in range(plen):
            pos = len(pitches)
            is_last_of_piece = (pi == n_phrases - 1 and k == plen - 1)
            is_cad = (k == plen - 1)
            if pos == 0:
                pitches.append(cur)
                continue
            prev = pitches[-1]
            if is_cad:
                cands = [m for m in window if deg(m) == target_deg
                         and abs(m - prev) <= 5]
                if is_last_of_piece:
                    cands = [m for m in cands if abs(m - prev) <= 2] or cands
            else:
                steps_left = plen - k
                cands = [m for m in window
                         if 0 < abs(m - prev) <= 7 and abs(m - prev) != 6]
                # leap recovery: after a leap, step back the other way
                if len(pitches) >= 2 and abs(prev - pitches[-2]) > 2:
                    back = [m for m in cands if abs(m - prev) <= 2
                            and (m - prev) * (prev - pitches[-2]) < 0]
                    cands = back or cands
                # drift toward the cadence target as the phrase ends
                tgt = [m for m in window if deg(m) == target_deg]
                goal = min(tgt, key=lambda m: abs(m - prev)) if tgt else prev
                if steps_left <= 3:
                    cands = [m for m in cands
                             if abs(m - goal) <= 2 * (steps_left - 1) + 1] or cands
            if not cands:
                cands = [m for m in window if 0 < abs(m - prev) <= 4]
            weights = []
            for m in cands:
                iv = abs(m - prev)
                w = 4.0 if iv <= 2 else (1.2 if iv <= 4 else 0.5)
                w *= 1.6 if (pos == climax_pos) == (m == max(window)) else 1.0
                if m == max(pitches, default=0) and pos != climax_pos:
                    w *= 0.35                          # keep the climax unique
                weights.append(w)
            pitches.append(rng.choices(cands, weights)[0])
    fermatas, acc = [], 0
    for plen in phrase_lens:
        acc += plen
        fermatas.append(acc)
    # minor: raise the 7th when the melody approaches the final tonic from below
    if mode == 'minor' and deg(pitches[-2]) == 10:
        pitches[-2] += 1
    return pitches, fermatas

# ------------------------------------------------------------- bass line --

def oracle_moves(mode, s_from_pc, s_to_pc, cad, b_from_pc):
    key = f"{mode}|{s_from_pc}>{s_to_pc}|{cad}"
    table = ORACLE['transitions'].get(key, {})
    out = {}
    for k, c in table.items():
        f, t = (int(x) for x in k.split('>'))
        if f == b_from_pc:
            out[t] = out.get(t, 0) + c
    if not out:                                        # arrivals fallback
        akey = f"{mode}|{s_to_pc}|{cad}"
        out = {int(p): c for p, c in ORACLE['arrivals'].get(akey, {}).items()}
    return out

def concretize(pc, prev_pitch, lo=38, hi=62):
    """Octave placement: nearest realization of pc to the previous bass note."""
    cands = [m for m in range(lo, hi + 1) if m % 12 == pc and abs(m - prev_pitch) <= 12]
    return sorted(cands, key=lambda m: (abs(m - prev_pitch), abs(m - 48)))

def bass_line(sop, fermatas, tonic_pc, mode, rng, beam_width=10):
    n = len(sop)
    ferm = set(fermatas)
    rel = lambda m: (m - tonic_pc) % 12
    opens = ORACLE['openings'].get(f"{mode}|{rel(sop[0])}", {'0': 1})
    beams = []                                          # (score, [pitches])
    for p, c in sorted(opens.items(), key=lambda kv: -kv[1])[:4]:
        pc = (int(p) + tonic_pc) % 12
        for b0 in concretize(pc, 45)[:2]:
            beams.append((math.log1p(c), [b0]))
    for i in range(1, n):
        cad = 1 if (i + 1) in ferm or i == n - 1 else 0
        nxt = []
        for score, line in beams:
            prev = line[-1]
            moves = oracle_moves(mode, rel(sop[i-1]), rel(sop[i]), cad, rel(prev))
            for t_pc, cnt in moves.items():
                abs_pc = (t_pc + tonic_pc) % 12
                for cand in concretize(abs_pc, prev)[:2]:
                    s = score + math.log1p(cnt)
                    dm, ds = cand - prev, sop[i] - sop[i-1]
                    if dm == 0 and ds == 0:
                        continue
                    if (dm < 0 < ds) or (ds < 0 < dm):
                        s += 0.6                        # contrary motion
                    elif dm == 0 or ds == 0:
                        s += 0.2
                    a = abs(dm)
                    s += 0.5 if a in (1, 2) else (0.2 if a <= 4 else
                                                  0.05 if a <= 7 else -0.5)
                    pcs = [x % 12 for x in line[-3:]] + [cand % 12]
                    if len(pcs) >= 4 and pcs[-1] == pcs[-3] and pcs[-2] == pcs[-4] \
                            and pcs[-1] != pcs[-2]:
                        s -= 1.4                        # seesaw
                    if pcs.count(cand % 12) >= 3:
                        s -= 0.8
                    if not 40 <= cand <= 60:
                        s -= 0.3
                    # interval sanity vs soprano (consonance preferred at slots)
                    ic = (sop[i] - cand) % 12
                    if ic in (1, 2, 11):
                        s -= 2.5
                    if i == n - 1 and (cand % 12) != tonic_pc:
                        s -= 3.0                        # end on the tonic
                    nxt.append((s + rng.uniform(0, 1e-6), line + [cand]))
        nxt.sort(key=lambda x: -x[0])
        beams = nxt[:beam_width]
        if not beams:
            return None
    return beams[0][1]

# ------------------------------------------------------------ harmonize --

def chord_options(tonic_pc, mode):
    """pc-sets of usable chords, relative to tonic then made absolute."""
    if mode == 'major':
        triads = [(0, 4, 7), (2, 5, 9), (4, 7, 11), (5, 9, 0),
                  (7, 11, 2), (9, 0, 4), (11, 2, 5)]
        sevenths = [(7, 11, 2, 5), (2, 5, 9, 0)]
    else:
        triads = [(0, 3, 7), (2, 5, 8), (3, 7, 10), (5, 8, 0),
                  (7, 11, 2), (8, 0, 3), (10, 2, 5), (11, 2, 5), (7, 10, 2)]
        sevenths = [(7, 11, 2, 5), (2, 5, 8, 0)]
    return [tuple((p + tonic_pc) % 12 for p in ch) for ch in triads + sevenths]

def voicings(chord, s, b, tonic_pc):
    """All legal alto/tenor fillings for this chord over outer voices s, b."""
    pcs = set(chord)
    lt = (tonic_pc + 11) % 12
    out = []
    for a in range(53, 75):
        if a % 12 not in pcs or a > s or s - a > 12:
            continue
        for t in range(48, 70):
            if t % 12 not in pcs or t > a or a - t > 12 or t < b:
                continue
            got = {s % 12, a % 12, t % 12, b % 12}
            n_lt = [x % 12 for x in (s, a, t, b)].count(lt)
            if n_lt > 1:
                continue
            missing = len(pcs - got)
            # doubling preference: root best, LT never (enforced), 7th never
            if len(chord) == 4 and [x % 12 for x in (s, a, t, b)].count(chord[3]) > 1:
                continue
            out.append((a, t, missing))
    return out

def pair_parallel(p1a, p1b, p2a, p2b):
    ic1, ic2 = (p1a - p1b) % 12, (p2a - p2b) % 12
    return (ic2 in (0, 7) and ic1 == ic2
            and p2a != p1a and p2b != p1b
            and (p2a > p1a) == (p2b > p1b))

def harmonize(sop, bass, fermatas, tonic_pc, mode, beam_width=14):
    n = len(sop)
    ferm = set(fermatas)
    chords = chord_options(tonic_pc, mode)
    lt = (tonic_pc + 11) % 12
    slots = []
    for i in range(n):
        opts = []
        for ch in chords:
            if sop[i] % 12 in ch and bass[i] % 12 in ch:
                for a, t, missing in voicings(ch, sop[i], bass[i], tonic_pc):
                    opts.append((a, t, missing + (0.5 if len(ch) == 4 else 0)))
        if not opts:
            return None
        slots.append(opts)
    beams = [(-m, [(a, t)]) for a, t, m in
             sorted(slots[0], key=lambda x: x[2])[:beam_width]]
    for i in range(1, n):
        nxt = []
        boundary = i in ferm                      # transition out of a fermata
        for score, line in beams:
            pa, pt = line[-1]
            for a, t, missing in slots[i]:
                # hard rejects — stricter than the checker: parallels are
                # rejected even across fermatas (the checker would only warn)
                quad_prev = {'s': sop[i-1], 'a': pa, 't': pt, 'b': bass[i-1]}
                quad_cur = {'s': sop[i], 'a': a, 't': t, 'b': bass[i]}
                names = ['s', 'a', 't', 'b']
                bad = False
                for x_i, x in enumerate(names):
                    for y in names[x_i+1:]:
                        if pair_parallel(quad_prev[x], quad_prev[y],
                                         quad_cur[x], quad_cur[y]):
                            bad = True
                if not bad and mode == 'minor' and not boundary:
                    for prev_p, cur_p in ((pa, a), (pt, t)):
                        if abs(cur_p - prev_p) == 3 and \
                                {(prev_p - tonic_pc) % 12, (cur_p - tonic_pc) % 12} == {8, 11}:
                            bad = True
                if bad:
                    continue
                s = score - missing
                s -= 0.25 * (abs(a - pa) + abs(t - pt))            # smooth voices
                if a == pa: s += 0.3                               # common tones
                if t == pt: s += 0.3
                if pa % 12 == lt and a - pa == 1: s += 0.6         # LT resolves up
                if abs(a - pa) > 7 or abs(t - pt) > 7: s -= 1.0
                if a > sop[i-1] or t > pa or t < bass[i-1]:         # overlap
                    s -= 1.2
                nxt.append((s, line + [(a, t)]))
        nxt.sort(key=lambda x: -x[0])
        beams = nxt[:beam_width]
        if not beams:
            return None
    return beams[0][1]

# -------------------------------------------------------------- pipeline --

def compose(tonic='D', mode='minor', phrases=3, seed=7, density=1.0, plain=False):
    tonic_pc = PC[tonic]
    for attempt in range(40):
        rng = random.Random(seed * 1000 + attempt)
        sop, ferm = melody(tonic_pc, mode, phrases, rng)
        bass = bass_line(sop, ferm, tonic_pc, mode, rng)
        if bass is None:
            continue
        inner = harmonize(sop, bass, ferm, tonic_pc, mode)
        if inner is None:
            continue
        piece = {
            'tonic': tonic, 'mode': mode,
            'soprano': [score_io.pitch_name(m) for m in sop],
            'alto':    [score_io.pitch_name(a) for a, _ in inner],
            'tenor':   [score_io.pitch_name(t) for _, t in inner],
            'bass':    [score_io.pitch_name(m) for m in bass],
            'fermatas': ferm,
        }
        voices = {v: [score_io.midi_num(p) for p in piece[v]] for v in score_io.VOICES}
        V, W = check_chorale.check(voices, tonic, mode, ferm)
        if V:
            continue                                   # discard, recompose
        piece['_meta'] = {'seed': seed, 'attempt': attempt, 'warnings': len(W)}
        if plain:
            return piece
        return ornament_mod.ornament(piece, density=density, seed=seed)
    return None

if __name__ == '__main__':
    args = sys.argv
    get = lambda k, d: args[args.index(k) + 1] if k in args else d
    piece = compose(tonic=get('--tonic', 'D'), mode=get('--mode', 'minor'),
                    phrases=int(get('--phrases', 3)), seed=int(get('--seed', 7)),
                    density=float(get('--density', 1.0)), plain='--plain' in args)
    if piece is None:
        sys.exit("failed to compose a clean piece in 40 attempts")
    out = get('--out', 'out/engine_piece.json')
    json.dump(piece, open(out, 'w'), indent=1)
    meta = piece.get('_meta', piece.get('skeleton', {}))
    print(f"wrote {out}")
