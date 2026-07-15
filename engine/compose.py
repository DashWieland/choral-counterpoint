#!/usr/bin/env python3
"""
The composition engine: fully automatic verified chorale generation.

    python engine/compose.py --tonic D --mode minor --phrases 3 --seed 11 \
        --out out/engine_piece.json [--density 1.0] [--plain] [--melody m.json]

Pipeline (each stage governed the way the skill prescribes):
  1. melody()    — phrase-planned soprano (skipped when --melody supplies one:
                   the given tune is law and is never altered)
  2. bass_line() — beam search over the outer-voice oracle; zero-support
                   moves excluded (hard corpus veto), every proposed dyad
                   must be harmonizable by the chord vocabulary, line shape
                   scored against the greedy root-position seesaw
  3. harmonize() — alto/tenor/chord beam search: voice-leading laws as hard
                   constraints, tendency tones (leading tones up, sevenths
                   down, never doubled), chromatic chords must reach their
                   tonicization target, false relations penalized
  4. check_chorale — the final gate; failures are discarded and recomposed
  5. ornament()  — corpus-rate figuration (unless --plain)

Deterministic for a given (params, seed): retry attempts anneal the bass
search with rising temperature so each attempt explores a different line.
"""
import json, math, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_io
import check_chorale
import ornament as ornament_mod
import chords as chordlib

PC = score_io.PC
ORACLE = json.load(open(SCRIPTS.parent / 'data' / 'outer_voice_table.json'))
MELODY = json.load(open(SCRIPTS.parent / 'data' / 'melody_table.json'))

def iv_bucket(iv):
    if iv == 0: return 'rep'
    return ('u' if iv > 0 else 'd') + \
           ('1' if abs(iv) <= 2 else '2' if abs(iv) <= 4 else '3')

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
    inter_targets = [2, 7, 4] if mode == 'major' else [2, 7, 3]
    plan = [rng.choice(inter_targets) for _ in range(n_phrases - 1)] + [0]
    phrase_lens = [rng.choice([4, 5, 6]) for _ in range(n_phrases)]
    total = sum(phrase_lens)
    climax_pos = int(total * rng.uniform(0.55, 0.75))

    # cadence formulas: Bach's actual last-three-degree shapes, by frequency
    def pick_formula(target_deg):
        pool = [(tuple(int(x) for x in k.split(',')), c)
                for k, c in MELODY['cadences'].get(mode, {}).items()
                if int(k.split(',')[-1]) == target_deg and c >= 5]
        if not pool:
            return None
        ks, ws = zip(*pool)
        return list(rng.choices(ks, ws)[0])

    trans = MELODY['transitions']
    pitches = []
    cur = rng.choice([m for m in window if deg(m) in (0, 4, 3, 7)][:4])
    for pi, (plen, target_deg) in enumerate(zip(phrase_lens, plan)):
        formula = pick_formula(target_deg) if plen >= 4 else None
        free = plen - (3 if formula else 1)
        for k in range(free if pitches or not formula else free):
            pos = len(pitches)
            if pos == 0:
                pitches.append(cur)
                continue
            prev = pitches[-1]
            steps_left = free - k
            cands = [m for m in window
                     if 0 < abs(m - prev) <= 7 and abs(m - prev) != 6]
            if len(pitches) >= 2 and abs(prev - pitches[-2]) > 2:
                back = [m for m in cands if abs(m - prev) <= 2
                        and (m - prev) * (prev - pitches[-2]) < 0]
                cands = back or cands
            # drift toward where the cadence formula will begin
            goal_deg = formula[0] if formula else target_deg
            tgt = [m for m in window if deg(m) == goal_deg]
            goal = min(tgt, key=lambda m: abs(m - prev)) if tgt else prev
            if steps_left <= 3:
                cands = [m for m in cands
                         if abs(m - goal) <= 2 * (steps_left - 1) + 2] or cands
            if not cands:
                cands = [m for m in window if 0 < abs(m - prev) <= 4]
            prev_iv = pitches[-1] - pitches[-2] if len(pitches) >= 2 else 0
            frac = (k + 1) / max(plen, 1)
            posb = 'early' if frac < 0.4 else 'mid' if frac < 0.8 else 'late'
            table = trans.get(f"{mode}|{iv_bucket(prev_iv)}|{posb}", {})
            weights = []
            for m in cands:
                iv = max(-7, min(7, m - prev))
                w = table.get(str(iv), 0) + 0.5           # corpus-weighted steps
                w *= 1.6 if (pos == climax_pos) == (m == max(window)) else 1.0
                if m == max(pitches, default=0) and pos != climax_pos:
                    w *= 0.35
                weights.append(w)
            pitches.append(rng.choices(cands, weights)[0])
        if formula:
            for fdeg in formula:
                prev = pitches[-1]
                opts = [m for m in range(prev - 6, prev + 7)
                        if (m - tonic_pc) % 12 == fdeg and m >= 58]
                pitches.append(min(opts, key=lambda m: abs(m - prev)) if opts
                               else prev)
        else:
            prev = pitches[-1]
            tgt = [m for m in window if deg(m) == target_deg
                   and abs(m - prev) <= 5]
            pitches.append(min(tgt, key=lambda m: abs(m - prev)) if tgt else prev)
    fermatas, acc = [], 0
    for plen in phrase_lens:
        acc += plen
        fermatas.append(acc)
    if mode == 'minor' and (pitches[-2] - tonic_pc) % 12 == 10:
        pitches[-2] += 1                              # cadential leading tone
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
    cands = [m for m in range(lo, hi + 1) if m % 12 == pc and abs(m - prev_pitch) <= 12]
    return sorted(cands, key=lambda m: (abs(m - prev_pitch), abs(m - 48)))

def bass_line(sop, fermatas, tonic_pc, mode, rng, beam_width=10, temp=0.0):
    n = len(sop)
    ferm = set(fermatas)
    rel = lambda m: (m - tonic_pc) % 12
    pairs = chordlib.harmonizable_pairs(mode)
    scale = chordlib.scale(mode)
    opens = ORACLE['openings'].get(f"{mode}|{rel(sop[0])}", {'0': 1})
    beams = []
    for p, c in sorted(opens.items(), key=lambda kv: -kv[1])[:6]:
        if (rel(sop[0]), int(p)) not in pairs:
            continue
        pc = (int(p) + tonic_pc) % 12
        for b0 in concretize(pc, 45)[:2]:
            beams.append((math.log1p(c) + rng.uniform(0, temp), [b0]))
    for i in range(1, n):
        cad = 1 if (i + 1) in ferm or i == n - 1 else 0
        nxt = []
        for score, line in beams:
            prev = line[-1]
            moves = oracle_moves(mode, rel(sop[i-1]), rel(sop[i]), cad, rel(prev))
            for t_pc, cnt in moves.items():
                if (rel(sop[i]), t_pc) not in pairs:
                    continue                           # no chord explains this dyad
                abs_pc = (t_pc + tonic_pc) % 12
                for cand in concretize(abs_pc, prev)[:2]:
                    s = score + math.log1p(cnt) + rng.uniform(0, temp)
                    dm, ds = cand - prev, sop[i] - sop[i-1]
                    if dm == 0 and ds == 0:
                        s -= 0.2       # repeated chord: fine under a repeated note
                    if (dm < 0 < ds) or (ds < 0 < dm):
                        s += 0.6
                    elif dm == 0 or ds == 0:
                        s += 0.2
                    a = abs(dm)
                    if a in (10, 11):
                        continue                       # seventh leap: checker kills it
                    if a == 6:
                        s -= 1.0                       # tritone leap: warning tier
                    s += 0.5 if a in (1, 2) else (0.2 if a <= 4 else
                                                  0.05 if a <= 7 else -0.5)
                    if t_pc not in scale:
                        # rarity is already priced by oracle support; only
                        # augmented-second shapes need an extra guard
                        if a == 3:
                            s -= 2.0
                    if rel(prev) not in scale and dm != 1:
                        s -= 2.0       # a chromatic bass tone resolves up a semitone
                    pcs = [x % 12 for x in line[-3:]] + [cand % 12]
                    if len(pcs) >= 4 and pcs[-1] == pcs[-3] and pcs[-2] == pcs[-4] \
                            and pcs[-1] != pcs[-2]:
                        s -= 1.4
                    if pcs.count(cand % 12) >= 3:
                        s -= 0.8
                    if not 40 <= cand <= 60:
                        s -= 0.3
                    ic = (sop[i] - cand) % 12
                    if ic in (1, 2, 11):
                        s -= 2.5
                    if i == n - 1 and (cand % 12) != tonic_pc:
                        s -= 3.0
                    nxt.append((s, line + [cand]))
        nxt.sort(key=lambda x: -x[0])
        beams = nxt[:beam_width]
        if not beams:
            return None
    return beams[0][1]

# ------------------------------------------------------------ harmonize --

def voicings(chord, s, b, tonic_pc):
    """Legal alto/tenor fillings. Tendency tones are never doubled."""
    pcs = {(p + tonic_pc) % 12 for p in chord['pcs']}
    forbid_double = {(p + tonic_pc) % 12 for p in (chord['lt'], chord['seventh'])
                     if p is not None}
    out = []
    for a in range(53, 75):
        if a % 12 not in pcs or a > s or s - a > 12:
            continue
        for t in range(48, 70):
            if t % 12 not in pcs or t > a or a - t > 12 or t < b:
                continue
            quad_pcs = [s % 12, a % 12, t % 12, b % 12]
            if any(quad_pcs.count(f) > 1 for f in forbid_double):
                continue
            missing = len(pcs - set(quad_pcs))
            out.append((a, t, missing))
    return out

def pair_parallel(p1a, p1b, p2a, p2b):
    ic1, ic2 = (p1a - p1b) % 12, (p2a - p2b) % 12
    return (ic2 in (0, 7) and ic1 == ic2
            and p2a != p1a and p2b != p1b
            and (p2a > p1a) == (p2b > p1b))

def harmonize(sop, bass, fermatas, tonic_pc, mode, beam_width=14):
    n = len(sop)
    vocab = chordlib.vocabulary(mode)
    scale = chordlib.scale(mode)
    abspc = lambda rel: (rel + tonic_pc) % 12
    ferm_set = set(fermatas)
    slots = []
    for i in range(n):
        opts = []
        for ci, ch in enumerate(vocab):
            pcs = {abspc(p) for p in ch['pcs']}
            if sop[i] % 12 not in pcs or bass[i] % 12 not in pcs:
                continue
            cost = 0.5 if len(ch['pcs']) == 4 else 0.0
            if chordlib.is_chromatic(ch, mode):
                # a secondary dominant is offered where the bass line walks
                # to its target next (payoff known up front, no beam gamble) —
                # or where the melody/bass note is itself chromatic and some
                # chord must explain it
                forced = (sop[i] - tonic_pc) % 12 not in chordlib.scale(mode) \
                    or (bass[i] - tonic_pc) % 12 not in chordlib.scale(mode)
                arrives = ch['target'] is not None and i + 1 < n \
                    and bass[i + 1] % 12 == abspc(ch['target'])
                if not (forced or arrives):
                    continue
                if arrives and (i + 2 in ferm_set or i + 1 == n - 1):
                    cost -= 0.8                        # V/x into a cadence: Bach's move
            for a, t, missing in voicings(ch, sop[i], bass[i], tonic_pc):
                opts.append((a, t, ci, missing + cost))
        if not opts:
            return None
        slots.append(opts)
    beams = [(-c, [(a, t, ci)]) for a, t, ci, c in
             sorted(slots[0], key=lambda x: x[3])[:beam_width]]
    for i in range(1, n):
        nxt = []
        for score, line in beams:
            pa, pt, pci = line[-1]
            pch = vocab[pci]
            plt = abspc(pch['lt']) if pch['lt'] is not None else None
            psev = abspc(pch['seventh']) if pch['seventh'] is not None else None
            ptarget = abspc(pch['target']) if pch['target'] is not None else None
            for a, t, ci, cost in slots[i]:
                ch = vocab[ci]
                cur_pcs = {abspc(p) for p in ch['pcs']}
                # tonicization should arrive: V/x resolving anywhere but a
                # chord containing x is heavily penalized (not killed — a
                # forced-chromatic melody can strand a beam otherwise)
                target_missed = ptarget is not None and ptarget not in cur_pcs
                # hard rejects — stricter than the checker (even across fermatas)
                quad_prev = {'s': sop[i-1], 'a': pa, 't': pt, 'b': bass[i-1]}
                quad_cur = {'s': sop[i], 'a': a, 't': t, 'b': bass[i]}
                names = ['s', 'a', 't', 'b']
                bad = False
                for x_i, x in enumerate(names):
                    for y in names[x_i+1:]:
                        if pair_parallel(quad_prev[x], quad_prev[y],
                                         quad_cur[x], quad_cur[y]):
                            bad = True
                if not bad:
                    for prev_p, cur_p in ((pa, a), (pt, t)):
                        step = abs(cur_p - prev_p)
                        if step == 3:
                            pcs2 = {prev_p % 12, cur_p % 12}
                            # augmented second: any 3-semitone move where one
                            # end is chromatic, or the classic minor b6/7 pair
                            rel2 = {(p - tonic_pc) % 12 for p in pcs2}
                            if rel2 == {8, 11} or any((p - tonic_pc) % 12 not in scale
                                                      for p in pcs2):
                                bad = True
                if bad:
                    continue
                s = score - cost
                if target_missed:
                    s -= 3.0
                s -= 0.25 * (abs(a - pa) + abs(t - pt))
                if a == pa: s += 0.3
                if t == pt: s += 0.3
                if abs(a - pa) > 7 or abs(t - pt) > 7: s -= 1.0
                if a > sop[i-1] or t > pa or t < bass[i-1]:
                    s -= 1.2
                if ptarget is not None and bass[i] % 12 == ptarget:
                    s += 1.5                           # tonicized root in the bass
                # tendency resolutions in the inner voices
                for prev_p, cur_p in ((pa, a), (pt, t)):
                    if plt is not None and prev_p % 12 == plt:
                        s += 0.8 if cur_p - prev_p == 1 else -2.0
                    if psev is not None and prev_p % 12 == psev:
                        s += 0.5 if -2 <= cur_p - prev_p <= -1 else -2.5
                # tendency tones in the fixed voices constrain the chord CHOICE
                if plt is not None and bass[i-1] % 12 == plt \
                        and bass[i] - bass[i-1] != 1:
                    s -= 2.0
                if psev is not None and bass[i-1] % 12 == psev \
                        and not -2 <= bass[i] - bass[i-1] <= -1:
                    s -= 2.5
                if plt is not None and sop[i-1] % 12 == plt \
                        and sop[i] - sop[i-1] != 1:
                    s -= 1.5
                # false relation: a chromatic tone in one voice right after
                # its natural form sounded in a different voice
                prev_quad = [sop[i-1], pa, pt, bass[i-1]]
                cur_quad = [sop[i], a, t, bass[i]]
                for vi, cp in enumerate(cur_quad):
                    crel = (cp - tonic_pc) % 12
                    if crel in scale:
                        continue
                    for nat in ((cp - 1), (cp + 1)):
                        if (nat - tonic_pc) % 12 in scale:
                            for vj, pp in enumerate(prev_quad):
                                if vj != vi and pp % 12 == nat % 12:
                                    s -= 1.5
                nxt.append((s, line + [(a, t, ci)]))
        nxt.sort(key=lambda x: -x[0])
        beams = nxt[:beam_width]
        if not beams:
            return None
    return [(a, t) for a, t, _ in beams[0][1]]

# -------------------------------------------------------------- pipeline --

def compose(tonic='D', mode='minor', phrases=3, seed=7, density=1.0, plain=False,
            given_melody=None):
    """given_melody: {'soprano': [...names or midi...], 'fermatas': [...]} —
    harmonize-only mode; the soprano is taken as law and never altered."""
    tonic_pc = PC[tonic]
    for attempt in range(40):
        rng = random.Random(seed * 1000 + attempt)
        if given_melody is not None:
            sop = [score_io.midi_num(p) if isinstance(p, str) else p
                   for p in given_melody['soprano']]
            ferm = list(given_melody.get('fermatas', [len(sop)]))
        else:
            sop, ferm = melody(tonic_pc, mode, phrases, rng)
        bass = bass_line(sop, ferm, tonic_pc, mode, rng, temp=0.15 * attempt)
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
            continue
        piece['_meta'] = {'seed': seed, 'attempt': attempt, 'warnings': len(W)}
        if plain:
            return piece
        return ornament_mod.ornament(piece, density=density, seed=seed)
    return None

if __name__ == '__main__':
    args = sys.argv
    get = lambda k, d: args[args.index(k) + 1] if k in args else d
    given = None
    tonic, mode = get('--tonic', 'D'), get('--mode', 'minor')
    if '--melody' in args:
        given = json.load(open(get('--melody', '')))
        tonic, mode = given.get('tonic', tonic), given.get('mode', mode)
    piece = compose(tonic=tonic, mode=mode,
                    phrases=int(get('--phrases', 3)), seed=int(get('--seed', 7)),
                    density=float(get('--density', 1.0)), plain='--plain' in args,
                    given_melody=given)
    if piece is None:
        sys.exit("failed to compose a clean piece in 40 attempts")
    out = get('--out', 'out/engine_piece.json')
    json.dump(piece, open(out, 'w'), indent=1)
    print(f"wrote {out}")
