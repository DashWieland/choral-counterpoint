// MIDI export for lab pieces — the same bytes as instrument/web/machine.js
// midiBytes (format 1, 480 ppq, fermata eighths held double, one channel
// per voice), plus a choir program change so a desktop player sounds sung.
import { writeFileSync } from 'node:fs';

export function midiBytes(piece, bpm = 72, program = 52) {
  const w = [];
  const str = s => [...s].map(c => c.charCodeAt(0));
  const u32 = x => [x >>> 24 & 255, x >>> 16 & 255, x >>> 8 & 255, x & 255];
  const u16 = x => [x >>> 8 & 255, x & 255];
  const vlq = x => { const out = [x & 127]; while ((x >>= 7)) out.unshift(x & 127 | 128); return out; };
  const ferm = new Set(piece.fermataEighths);
  const tickOf = pos => {
    let t = 0;
    for (let k = 0; k < pos; k++) t += (ferm.has(k) || ferm.has(k - 1)) ? 480 : 240;
    return t;
  };
  const tracks = [];
  const tempo = Math.round(60000000 / bpm);
  tracks.push([0, 255, 81, 3, tempo >> 16 & 255, tempo >> 8 & 255, tempo & 255, 0, 255, 47, 0]);
  Object.entries(piece.events).forEach(([, evs], ch) => {
    const tr = [0, 0xC0 | ch, program];
    let cursor = 0, pos = 0;
    for (const [m, ln] of evs) {
      const on = tickOf(pos), off = tickOf(pos + ln);
      tr.push(...vlq(on - cursor), 0x90 | ch, m, 72);
      tr.push(...vlq(off - on), 0x80 | ch, m, 0);
      cursor = off; pos += ln;
    }
    tr.push(0, 255, 47, 0);
    tracks.push(tr);
  });
  w.push(...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(480));
  for (const tr of tracks) w.push(...str('MTrk'), ...u32(tr.length), ...tr);
  return new Uint8Array(w);
}

export function writeMidi(path, piece, bpm = 72) {
  writeFileSync(path, midiBytes(piece, bpm));
}

// events (skeleton only) for a four-voice skeleton, when no ornaments exist
export function skeletonEvents(skel) {
  const ev = {};
  for (const v of ['s', 'a', 't', 'b']) ev[v] = skel[v].map(m => [m, 2]);
  return ev;
}
