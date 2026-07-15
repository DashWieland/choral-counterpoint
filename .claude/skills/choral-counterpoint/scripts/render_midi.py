#!/usr/bin/env python3
"""
Render a composition JSON (species or chorale format) to MIDI.

Usage:
    python render_midi.py piece.json out.mid [--bpm 72] [--program 52]

Species format:  {"cantus": [...], "counterpoint": [...]}          (whole-note feel)
Chorale format:  {"soprano": [...], "alto": [...], "tenor": [...],
                  "bass": [...], "fermatas": [4, 8]}               (quarter-note feel)

Each list entry is one harmonic slot. Fermata slots are held twice as long.
Requires: mido
"""
import json, sys
import mido

PC = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'E#':5,'Fb':4,'F':5,'F#':6,
      'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'B#':0,'Cb':11}

def midi_num(name):
    i = 1
    while i < len(name) and name[i] in '#b':
        i += 1
    return 12 * (int(name[i:]) + 1) + PC[name[:i]]

def main():
    src, dst = sys.argv[1], sys.argv[2]
    bpm = int(sys.argv[sys.argv.index('--bpm') + 1]) if '--bpm' in sys.argv else 72
    prog = int(sys.argv[sys.argv.index('--program') + 1]) if '--program' in sys.argv else 52
    d = json.load(open(src))
    if 'soprano' in d:
        names = ['soprano', 'alto', 'tenor', 'bass']
        slot = 480                        # quarter note per chord
    else:
        names = ['counterpoint', 'cantus']
        slot = 480 * 4                    # whole note per bar
    fermatas = set(d.get('fermatas', ()))
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm), time=0))
    mid.tracks.append(meta)
    for ch, name in enumerate(names):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage('track_name', name=name, time=0))
        tr.append(mido.Message('program_change', program=prog, channel=ch, time=0))
        for i, note in enumerate(d[name]):
            n = midi_num(note)
            dur = slot * 2 if (i + 1) in fermatas else slot
            tr.append(mido.Message('note_on', note=n, velocity=72, channel=ch, time=0))
            tr.append(mido.Message('note_off', note=n, velocity=0, channel=ch, time=dur))
        mid.tracks.append(tr)
    mid.save(dst)
    print(f"wrote {dst}: {len(names)} voices, {len(d[names[0]])} slots, {bpm} bpm")

if __name__ == '__main__':
    main()
