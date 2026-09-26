// Build a listening folder for the engine review's examples: WAV renders
// (render.mjs, the perform.py choir) at the machine's 66 bpm, named in
// listening order, the MIDI files, and a page that plays the pairs side by
// side, with a switch that jumps to the other version at the same moment.
//   node --no-warnings listening.mjs "<output folder>"
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePiece } from './shipped.mjs';
import { composePieceLab } from './engine.lab.mjs';
import { barformMelody } from './barform.mjs';
import { skeletonEvents } from './midi.mjs';
import { renderWav, secondsAt } from './render.mjs';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node listening.mjs "<output folder>"'); process.exit(1); }
mkdirSync(join(OUT, 'MIDI'), { recursive: true });
const EXAMPLES = fileURLToPath(new URL('../../docs/engine-review/examples/', import.meta.url));
const BPM = 66;
const ED2 = ['sbParallel', 'bassAug2', 'bassSpace', 'tonicEnd', 'formulaFit', 'seamFix', 'register', 'innerRules'];

let form = null;
const flags = Object.fromEntries(ED2.map(f => [f, true]));
flags.melodyFn = (...a) => { const r = barformMelody(...a); form = r.form; return r; };
const plain = (skel, fermatas) => ({ events: skeletonEvents(skel), fermataEighths: fermatas.map(f => 2 * (f - 1)) });
const mod12 = x => ((x % 12) + 12) % 12;
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const keyName = k => k.replace(/^([A-G])b/, '$1♭').replace(/^([A-G])#/, '$1♯');

// read back a skeleton MIDI written by midi.mjs: a conductor track, then one
// track per voice (s a t b) of quarter notes; a fermata chord lasts 960 ticks
function readSkeletonMidi(path) {
  const b = readFileSync(path);
  const tracks = [];
  for (let p = 14; p < b.length; p += 8 + b.readUInt32BE(p + 4))
    tracks.push(b.subarray(p + 8, p + 8 + b.readUInt32BE(p + 4)));
  const [s, a, t, bs] = tracks.slice(1).map(tr => {
    const notes = [];
    let i = 0, tick = 0, on = null;
    const vlq = () => { let v = 0, c; do { c = tr[i++]; v = (v << 7) | (c & 127); } while (c & 128); return v; };
    while (i < tr.length) {
      tick += vlq();
      const st = tr[i++];
      if (st === 0xFF) { i++; i += vlq(); continue; }
      if ((st & 0xF0) === 0xC0) { i++; continue; }
      const note = tr[i]; i += 2;
      if ((st & 0xF0) === 0x90) on = { note, tick };
      else if (on) { notes.push({ m: on.note, dur: tick - on.tick }); on = null; }
    }
    return notes;
  });
  const skel = { s: s.map(n => n.m), a: a.map(n => n.m), t: t.map(n => n.m), b: bs.map(n => n.m) };
  const fermatas = s.map((n, j) => n.dur >= 960 ? j + 1 : 0).filter(Boolean);
  return { skel, fermatas };
}

const sets = [];                          // { group, caption, swap, jump, rows: [{ file, label, sec }] }
const put = (row, file, piece) => {
  row.sec = renderWav(join(OUT, file), piece, BPM);
  row.file = file;
  console.log(`${file}  ${row.sec.toFixed(0)} s`);
};

for (let n = 1; n <= 4; n++) {
  const id = String(n).padStart(4, '0');
  const today = composePiece(n);
  const bf = composePieceLab(n, flags);
  const L = form.stollenChords, sk = bf.skeleton;
  const lit = { s: sk.s.slice(), a: sk.a.slice(), t: sk.t.slice(), b: sk.b.slice() };
  for (let i = L; i < 2 * L; i++) for (const v of ['a', 't', 'b']) lit[v][i] = sk[v][i - L];
  let differ = 0;
  for (let i = L; i < 2 * L; i++) if (['a', 't', 'b'].some(v => sk[v][i] !== lit[v][i])) differ++;
  const back = secondsAt(plain(sk, bf.fermatas), 2 * L, BPM);

  const A = { group: 'A', caption: `No. ${n}, ${keyName(today.key)}`, rows: [
    { label: `as it plays today · ${today.fermataEighths.length} phrases` },
    { label: `in bar form · ${form.labels.join(' ')} · the opening returns at ${clock(back)}` }] };
  put(A.rows[0], `A${n}-1 No. ${id} today.wav`, today);
  put(A.rows[1], `A${n}-2 No. ${id} bar form.wav`, { events: bf.events, fermataEighths: bf.fermataEighths });
  sets.push(A);

  const B = { group: 'B', swap: true,
    caption: `No. ${n} · the repeat starts at ${clock(back)} · ${differ} of its ${L} chords differ`,
    jump: secondsAt(plain(sk, bf.fermatas), 2 * (L - 1), BPM),
    rows: [{ label: 'the repeat re-harmonized' }, { label: 'the repeat copied' }] };
  put(B.rows[0], `B${n}-1 No. ${id} repeat re-harmonized.wav`, plain(sk, bf.fermatas));
  put(B.rows[1], `B${n}-2 No. ${id} repeat copied.wav`, plain(lit, bf.fermatas));
  sets.push(B);
}

const settings = [1, 2, 3].map(k => readSkeletonMidi(join(EXAMPLES, `settings-0006-${k}.mid`)));
const bassDiff = (x, y) => x.skel.b.filter((m, i) => mod12(m) !== mod12(y.skel.b[i])).length;
const chordAt = (x, i) => [...new Set(['s', 'a', 't', 'b'].map(v => mod12(x.skel[v][i])))].sort().join();
const chordDiff = (x, y) => x.skel.s.filter((_, i) => chordAt(x, i) !== chordAt(y, i)).length;
const against = (x, y) => `a different chord on ${chordDiff(x, y)}, a different bass on ${bassDiff(x, y)}`;
const N = settings[0].skel.s.length;
const C = { group: 'C', swap: true, caption: `One G-major tune (address 6), ${N} chords`, rows: [
  { label: 'setting 1 · the best-scoring bass' },
  { label: `setting 2 · against setting 1, ${against(settings[1], settings[0])}` },
  { label: `setting 3 · against setting 1, ${against(settings[2], settings[0])}; against setting 2, ${against(settings[2], settings[1])}` }] };
settings.forEach((st, k) => put(C.rows[k], `C-${k + 1} one tune, setting ${k + 1}.wav`, plain(st.skel, st.fermatas)));
sets.push(C);

for (const f of ['shipped', 'barform', 'plain-varied', 'plain-literal'])
  for (let n = 1; n <= 4; n++) copyFileSync(join(EXAMPLES, `${f}-000${n}.mid`), join(OUT, 'MIDI', `${f}-000${n}.mid`));
for (let k = 1; k <= 3; k++) copyFileSync(join(EXAMPLES, `settings-0006-${k}.mid`), join(OUT, 'MIDI', `settings-0006-${k}.mid`));
copyFileSync(join(EXAMPLES, 'barform-sopranos.txt'), join(OUT, 'barform-sopranos.txt'));

const groups = {
  A: ['Today against bar form',
    'For: whether to hold Edition 2 for bar form, and whether its length suits the crank (a median of 46 seconds, against 16 today).',
    'Addresses 1 to 4, not cherry-picked: each as it plays today, then with the bar-form planner under Edition 2’s rules.'],
  B: ['The repeat: re-harmonized or copied',
    'For: whether the repeated opening keeps its first harmony or is harmonized again.',
    'The same four bar-form pieces as plain chords, without ornaments, so the harmony of the repeat is the only difference. “From the repeat” starts at the cadence before it; “switch to this” carries on in the other version from the same moment.'],
  C: ['One tune, three settings',
    'For: whether the machine should offer a tune’s other settings (“No. 214, setting 2”).',
    'Plain chords. Setting 1 is the best-scoring bass; settings 2 and 3 are the valid basses that differ most from those already chosen. Its chords change about as often as a typical tune’s; its bass changes less than most.'],
};
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const setHtml = st => `<div class="set"${st.swap ? ' data-swap' : ''}>
<div class="cap">${esc(st.caption)}${st.jump != null ? ` <button class="jump" data-t="${st.jump.toFixed(2)}">from the repeat</button>` : ''}</div>
${st.rows.map(r => `<div class="row"><span class="label">${esc(r.label)}</span><audio controls preload="metadata" src="${encodeURI(r.file)}"></audio><span class="len">${clock(r.sec)}</span>${st.swap ? '<button class="switch">switch to this</button>' : ''}</div>`).join('\n')}
</div>`;

writeFileSync(join(OUT, 'Listening guide.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hurdy-Gurdy listening</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600&family=IM+Fell+English:ital@0;1&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
<style>
:root { --bg:#e9dfcb; --sunken:#d4c6ab; --ink:#1a1813; --sub:#48433a; --line:#baac92; --accent:#9d2e1b;
  --display:'Cinzel', Georgia, serif; --body:'IM Fell English', Georgia, serif; --mono:'IBM Plex Mono', monospace; }
body { background:var(--bg); color:var(--ink); font:18px/1.5 var(--body); margin:0; padding:48px 24px 96px; }
main { max-width:820px; }
h1 { font:600 22px/1.2 var(--display); letter-spacing:.12em; margin:0 0 12px; }
h2 { font:600 17px/1.3 var(--display); letter-spacing:.08em; margin:48px 0 6px; }
p { color:var(--sub); margin:0 0 12px; }
p.for { color:var(--ink); font-style:italic; }
.set { margin:24px 0 0; border-top:1px solid var(--line); }
.cap { font:13px/1.4 var(--mono); color:var(--sub); padding:12px 0 6px; display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; }
.row { display:grid; grid-template-columns:1fr 300px 42px 120px; gap:12px; align-items:center; padding:6px 0; }
.set:not([data-swap]) .row { grid-template-columns:1fr 300px 42px; }
.len { font:13px var(--mono); color:var(--sub); text-align:right; }
audio { width:300px; height:36px; }
button { font:13px var(--mono); color:var(--accent); background:transparent; border:1px solid var(--line); border-radius:2px; padding:4px 10px; cursor:pointer; }
button:hover, button:focus-visible { border-color:var(--accent); outline:none; }
.row.on .label { color:var(--accent); }
@media (max-width: 720px) { .row, .set:not([data-swap]) .row { grid-template-columns:1fr auto; } audio { width:100%; grid-column:1 / -1; } }
</style></head><body><main>
<h1>Hurdy-Gurdy listening</h1>
<p>Rendered with the project’s own choir (tools/perform.py, ported to Node as tools/lab/render.mjs) at the machine’s 66 bpm. One player sounds at a time. The decisions each group bears on are in the decision table of docs/engine-review/README.md. The MIDI files are in the MIDI folder, and barform-sopranos.txt letters the phrases of every bar-form tune.</p>
${Object.entries(groups).map(([g, [h, q, d]]) => `<h2>${esc(h)}</h2>\n<p class="for">${esc(q)}</p>\n<p>${esc(d)}</p>\n${sets.filter(s => s.group === g).map(setHtml).join('\n')}`).join('\n')}
</main>
<script>
const players = [...document.querySelectorAll('audio')];
const mark = () => players.forEach(a => a.closest('.row').classList.toggle('on', !a.paused));
document.addEventListener('play', e => { players.forEach(a => { if (a !== e.target) a.pause(); }); mark(); }, true);
document.addEventListener('pause', mark, true);
document.addEventListener('ended', mark, true);
for (const set of document.querySelectorAll('.set')) {
  const own = [...set.querySelectorAll('audio')];
  let last = own[0];
  own.forEach(a => a.addEventListener('play', () => { last = a; }));
  set.querySelectorAll('.switch').forEach((btn, i) => btn.addEventListener('click', () => {
    const to = own[i];
    if (to !== last) { to.currentTime = last.currentTime; last.pause(); }
    to.play();
  }));
  const jump = set.querySelector('.jump');
  if (jump) jump.addEventListener('click', () => { last.currentTime = Number(jump.dataset.t); last.play(); });
}
</script>
</body></html>
`);
console.log(`wrote ${sets.reduce((t, s) => t + s.rows.length, 0)} WAV files and the guide to ${OUT}`);
