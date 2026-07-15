#!/usr/bin/env python3
"""
Render a composition JSON to MIDI.

Usage:
    python render_midi.py piece.json out.mid [--bpm 72] [--program 52]

Accepts all three formats:
  species  {"cantus": [...], "counterpoint": [...]}            whole notes
  slots    {"soprano": [...], ..., "fermatas": [4, 8]}          quarters
  events   {"format": "events", "voices": {...},
            "fermata_eighths": [...]}                           sub-beat

Fermata chords are held twice as long. Requires: mido
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mido
import score_io

TPQ = 480          # ticks per quarter; an eighth is 240

def main():
    src, dst = sys.argv[1], sys.argv[2]
    bpm = int(sys.argv[sys.argv.index('--bpm') + 1]) if '--bpm' in sys.argv else 72
    prog = int(sys.argv[sys.argv.index('--program') + 1]) if '--program' in sys.argv else 52
    d = json.load(open(src))
    mid = mido.MidiFile(ticks_per_beat=TPQ)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm), time=0))
    mid.tracks.append(meta)

    if 'cantus' in d:                                # species: whole notes
        for ch, name in enumerate(['counterpoint', 'cantus']):
            tr = mido.MidiTrack()
            tr.append(mido.MetaMessage('track_name', name=name, time=0))
            tr.append(mido.Message('program_change', program=prog, channel=ch, time=0))
            for p in d[name]:
                n = score_io.midi_num(p)
                tr.append(mido.Message('note_on', note=n, velocity=72, channel=ch, time=0))
                tr.append(mido.Message('note_off', note=n, velocity=0, channel=ch, time=TPQ * 4))
            mid.tracks.append(tr)
        mid.save(dst)
        print(f"wrote {dst}: 2 voices, {len(d['cantus'])} bars, {bpm} bpm")
        return

    voices, ferm, total = score_io.load(d)
    mult = score_io.eighth_multipliers(total, ferm)
    tick_at = [0]
    for m in mult:
        tick_at.append(tick_at[-1] + int(240 * m))
    for ch, name in enumerate(score_io.VOICES):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage('track_name', name=name, time=0))
        tr.append(mido.Message('program_change', program=prog, channel=ch, time=0))
        cursor = 0
        for n, start, length in voices[name]:
            on, off = tick_at[start], tick_at[min(start + length, total)]
            tr.append(mido.Message('note_on', note=n, velocity=72, channel=ch, time=on - cursor))
            tr.append(mido.Message('note_off', note=n, velocity=0, channel=ch, time=off - on))
            cursor = off
        mid.tracks.append(tr)
    mid.save(dst)
    print(f"wrote {dst}: 4 voices, {total} eighths, {bpm} bpm")

if __name__ == '__main__':
    main()
