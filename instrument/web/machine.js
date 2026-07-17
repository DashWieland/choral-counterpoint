// The Choral Hurdy-Gurdy: crank, tape, plate, motor.
// mountHurdyGurdy(container) builds the machine and runs it.
//
// The master clock is tape position (in eighths). The crank's angular
// velocity sets how fast position advances; notes start and stop as the
// playhead crosses them, in either direction. The engine composes piece
// No. N from seed N — same piece for everyone, forever.

import { composePiece } from './engine.js';
import { Choir } from './audio.js';

const EW = 26;                 // px per eighth at design scale
const MOTOR_BPM = 66;
const MAX_BPM = 140, MIN_AUDIBLE_BPM = 5;

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function perfTotalOf(p) {
  const ferm = new Set(p.fermataEighths);
  let t = 0;
  for (let k = 0; k < p.totalEighths; k++) t += (ferm.has(k) || ferm.has(k - 1)) ? 2 : 1;
  return t;
}

function pieceOrNext(n, dir = 1) {
  for (let k = n; ; k += dir) {
    if (k < 1) return { piece: composePiece(1) || null, number: 1 };
    const p = composePiece(k);
    if (p) return { piece: p, number: k };
  }
}

// ------------------------------------------------------------- midi export --

function midiBytes(piece, bpm = 72) {
  const w = [];
  const str = s => [...s].map(c => c.charCodeAt(0));
  const u32 = x => [x >>> 24 & 255, x >>> 16 & 255, x >>> 8 & 255, x & 255];
  const u16 = x => [x >>> 8 & 255, x & 255];
  const vlq = x => { const out = [x & 127]; while ((x >>= 7)) out.unshift(x & 127 | 128); return out; };
  const ferm = new Set(piece.fermataEighths);
  const tickOf = pos => {                  // fermata eighths take double time
    let t = 0;
    for (let k = 0; k < pos; k++) t += (ferm.has(k) || ferm.has(k - 1)) ? 480 : 240;
    return t;
  };
  const tracks = [];
  const tempo = Math.round(60000000 / bpm);
  tracks.push([0, 255, 81, 3, tempo >> 16 & 255, tempo >> 8 & 255, tempo & 255,
               0, 255, 47, 0]);
  Object.entries(piece.events).forEach(([vn, evs], ch) => {
    const tr = [];
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

// ----------------------------------------------------------------- machine --

export function mountHurdyGurdy(container, opts = {}) {
  const initialNumber = Math.max(1,
    opts.piece || Number(new URLSearchParams(location.search).get('piece')) || 1);

  container.innerHTML = `
  <div class="hg" style="position:relative; user-select:none; touch-action:none;">
    <div class="hg-title">CHORAL HURDY-GURDY</div>
    <div class="hg-cabinet">
      <div class="hg-tapeframe"><canvas class="hg-tape"></canvas></div>
      <div class="hg-panel">
        <div class="hg-plate">
          <div class="hg-plate-no">No. 0001</div>
          <div class="hg-plate-info">—</div>
        </div>
        <div class="hg-controls">
          <button class="hg-motor" type="button">&#9656; MOTOR</button>
          <div class="hg-bpm">000 BPM</div>
        </div>
        <div class="hg-crankunit">
          <svg class="hg-crank" viewBox="0 0 120 132" aria-hidden="true">
            <circle cx="60" cy="60" r="46" fill="none" class="hg-swing"/>
            <circle cx="60" cy="60" r="14" class="hg-hatch"/>
            <circle cx="60" cy="60" r="14" fill="none" class="hg-ink" stroke-width="1.4"/>
            <circle cx="49.5" cy="60" r="1.5" class="hg-ink-fill"/>
            <circle cx="70.5" cy="60" r="1.5" class="hg-ink-fill"/>
            <circle cx="60" cy="49.5" r="1.5" class="hg-ink-fill"/>
            <circle cx="60" cy="70.5" r="1.5" class="hg-ink-fill"/>
            <g class="hg-crank-rot">
              <line x1="60" y1="60" x2="60" y2="21" class="hg-ink" stroke-width="5"/>
              <circle cx="60" cy="17" r="11" class="hg-grip"/>
              <circle cx="60" cy="17" r="4" fill="none" class="hg-ink" stroke-width="1"/>
            </g>
            <circle cx="60" cy="60" r="5" class="hg-ink-fill"/>
          </svg>
          <div class="hg-hint">scroll to turn</div>
        </div>
      </div>
      <a class="hg-export" href="#" download>SAVE THIS PIECE (.MID) &#8595;</a>
    </div>
  </div>`;

  const root = container.querySelector('.hg');
  if (matchMedia('(pointer: coarse)').matches)
    root.querySelector('.hg-hint').textContent = 'drag to turn';
  const canvas = root.querySelector('.hg-tape');
  const plateNo = root.querySelector('.hg-plate-no');
  const plateInfo = root.querySelector('.hg-plate-info');
  const bpmEl = root.querySelector('.hg-bpm');
  const motorBtn = root.querySelector('.hg-motor');
  const exportA = root.querySelector('.hg-export');
  const crankRot = root.querySelector('.hg-crank-rot');
  const ctx2d = canvas.getContext('2d');

  // ---- state ----
  let { piece, number } = pieceOrNext(initialNumber);
  let pos = -2;                  // performance eighths; small lead-in
  let bpm = 0;                   // signed: negative = retrograde
  let bpmTarget = 0;
  let motorOn = false;
  let lastUserInput = -1e9;
  let crankAngle = 2.4;            // at rest the arm hangs low, as cranks do
  let choir = null, audioCtx = null;
  const sounding = new Map();    // eventKey -> handle
  let colors = null;

  const fermSet = () => new Set(piece.fermataEighths);

  function refreshColors() {
    colors = {
      border: cssVar('--color-border'), surface: cssVar('--color-surface'),
      bg: cssVar('--color-bg'), txt: cssVar('--color-text-primary'),
      sub: cssVar('--color-text-secondary'), signal: cssVar('--color-signal'),
      rose: cssVar('--color-accent-6'),
      voice: { s: cssVar('--color-accent-1'), a: cssVar('--color-accent-2'),
               t: cssVar('--color-accent-3'), b: cssVar('--color-signal') },
    };
  }
  refreshColors();
  new MutationObserver(refreshColors)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  let flat = [];
  let perfAt = [];                 // source eighth -> performance eighth
  let perfTotal = 0;
  function reflatten() {
    const ferm = fermSet();
    perfAt = [0];
    for (let k = 0; k < piece.totalEighths; k++)
      perfAt.push(perfAt[k] + ((ferm.has(k) || ferm.has(k - 1)) ? 2 : 1));
    perfTotal = perfAt[piece.totalEighths];
    flat = [];
    for (const vn of ['s', 'a', 't', 'b']) {
      let t = 0;
      for (const [m, ln] of piece.events[vn]) {
        flat.push({ vn, m, start: perfAt[t], end: perfAt[t + ln],
                    ferm: ferm.has(t), key: `${vn}:${t}` });
        t += ln;
      }
    }
  }

  function setPiece(p, n, startPos, elide = false) {
    for (const h of sounding.values()) choir && choir.noteOff(h, elide ? 1.4 : 0.14);
    sounding.clear();
    piece = p; number = n; pos = startPos;
    reflatten();
    plateNo.textContent = `No. ${String(n).padStart(4, '0')}`;
    plateInfo.textContent = `${p.key.toUpperCase()} · ${p.phrases} PHRASES`;
    const bytes = midiBytes(p);
    exportA.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    exportA.download = `chorale-${String(n).padStart(4, '0')}.mid`;
    try {
      const u = new URL(location.href);
      u.searchParams.set('piece', n);
      history.replaceState(null, '', u);
    } catch { /* embedded contexts may forbid this */ }
  }
  setPiece(piece, number, -2);

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      choir = new Choir(audioCtx);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  // ---- physics + transport ----
  function tick(dt) {
    const idle = performance.now() / 1000 - lastUserInput > 1.2;
    if (motorOn && idle) bpmTarget += (MOTOR_BPM - bpmTarget) * Math.min(1, dt * 2.5);
    else bpmTarget *= Math.exp(-dt / 1.4);
    bpmTarget = Math.max(-MAX_BPM, Math.min(MAX_BPM, bpmTarget));
    bpm += (bpmTarget - bpm) * Math.min(1, dt * 6);   // smooths wheel-tick pulses
    const audible = Math.abs(bpm) >= MIN_AUDIBLE_BPM;
    if (!audible && choir && sounding.size) {
      for (const h of sounding.values()) choir.noteOff(h, 0.5);
      sounding.clear();
    }
    if (audible) pos += (bpm / 60) * 2 * dt;
    crankAngle += (bpm / 60) * 2 * Math.PI * dt * 0.5;
    crankRot.style.transform = `rotate(${crankAngle}rad)`;
    crankRot.style.transformOrigin = '60px 60px';

    // piece transitions (with a breath of silence either side)
    if (pos >= perfTotal) {
      const nx = pieceOrNext(number + 1);
      setPiece(nx.piece, nx.number, 0, true);     // last chord rings into the next piece
    } else if (pos < 0 && bpm < -MIN_AUDIBLE_BPM) {
      const pv = pieceOrNext(Math.max(1, number - 1), -1);
      setPiece(pv.piece, pv.number, perfTotalOf(pv.piece) - 0.01, true);
    }

    // declarative sounding set: works forward, backward, and through seeks
    if (choir && audible) {
      for (const ev of flat) {
        const should = ev.start <= pos && pos < ev.end;
        const has = sounding.has(ev.key);
        if (should && !has)
          sounding.set(ev.key, choir.noteOn(ev.vn, ev.m, { swell: ev.ferm }));
        else if (!should && has) {
          choir.noteOff(sounding.get(ev.key));
          sounding.delete(ev.key);
        }
      }
    }
    bpmEl.textContent = `${String(Math.min(999, Math.round(Math.abs(bpm)))).padStart(3, '0')} BPM`;
    const retro = bpm < -MIN_AUDIBLE_BPM;
    plateNo.style.color = retro ? colors.rose : '';
    plateNo.textContent = retro ? 'RETROGRADE' : `No. ${String(number).padStart(4, '0')}`;
  }

  // ---- tape drawing ----
  function draw() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }
    const W = rect.width, H = rect.height;
    const g = ctx2d;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = colors.surface;
    g.fillRect(0, 0, W, H);

    const scale = Math.min(1, W / 640);
    const ew = EW * scale;
    const PH = W * 0.32;
    const originX = PH - pos * ew;
    const ferm = fermSet();

    // sprockets
    g.strokeStyle = colors.sub;
    g.lineWidth = 0.8;
    const sprocketPhase = -((pos * ew) % 16);
    for (let x = sprocketPhase; x < W + 16; x += 16) {
      for (const y of [8, H - 8]) {
        g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.stroke();
      }
    }
    // pitch rules
    g.strokeStyle = colors.border;
    g.lineWidth = 0.5;
    g.setLineDash([2, 6]);
    for (let i = 1; i <= 4; i++) {
      const y = 18 + i * (H - 36) / 5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.setLineDash([]);
    // beat ruling + perforations
    for (let e = 0; e <= piece.totalEighths; e += 2) {
      const x = originX + perfAt[e] * ew;
      if (x < -4 || x > W + 4) continue;
      g.strokeStyle = colors.border;
      g.globalAlpha = 0.55;
      g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x, H - 14); g.stroke();
      g.globalAlpha = 1;
    }
    for (const f of piece.fermataEighths) {
      const x = originX + perfAt[Math.min(f + 2, piece.totalEighths)] * ew;
      if (x < -4 || x > W + 4) continue;
      g.strokeStyle = colors.border;
      g.lineWidth = 1;
      g.setLineDash([1, 4]);
      g.beginPath(); g.moveTo(x, 4); g.lineTo(x, H - 4); g.stroke();
      g.setLineDash([]);
    }

    // holes
    const midiLo = 34, midiHi = 82;
    const pitchY = m => 14 + (H - 28) * (1 - (m - midiLo) / (midiHi - midiLo));
    for (const ev of flat) {
      const xm = originX + (ev.start + (ev.end - ev.start) / 2) * ew;
      if (xm < -30 || xm > W + 30) continue;
      const y = pitchY(ev.m);
      const c = colors.voice[ev.vn];
      const soundingNow = ev.start <= pos && pos < ev.end;
      const passed = ev.end <= pos;
      const r = (ev.end - ev.start >= 2 ? 6 : 3.6) * Math.max(scale, 0.8);
      g.globalAlpha = passed ? 0.45 : 1;
      if (ev.ferm) {
        const x0 = originX + ev.start * ew + 6 * scale;
        const wdt = (ev.end - ev.start) * ew - 12 * scale;
        g.strokeStyle = c; g.fillStyle = c; g.lineWidth = 1.2;
        roundRect(g, x0, y - 3.5, wdt, 7, 3.5);
        if (soundingNow || passed) g.fill(); else g.stroke();
      } else {
        g.strokeStyle = c; g.fillStyle = c;
        if (soundingNow) {
          g.beginPath(); g.arc(xm, y, r + 2.4, 0, 7); g.lineWidth = 1; g.stroke();
          g.beginPath(); g.arc(xm, y, r, 0, 7); g.fill();
        } else if (passed) {
          g.beginPath(); g.arc(xm, y, r, 0, 7); g.fill();
        } else {
          g.lineWidth = 1.4;
          g.beginPath(); g.arc(xm, y, r, 0, 7); g.stroke();
        }
      }
      g.globalAlpha = 1;
    }
    // playhead
    g.strokeStyle = colors.signal;
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(PH, 0); g.lineTo(PH, H); g.stroke();
    g.setLineDash([]);
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ---- input ----
  function impulse(delta) {
    ensureAudio();
    lastUserInput = performance.now() / 1000;
    bpmTarget = Math.max(-MAX_BPM, Math.min(MAX_BPM, bpmTarget + delta));
  }
  root.addEventListener('wheel', e => {
    e.preventDefault();
    impulse(-e.deltaY * 0.12);
  }, { passive: false });
  let dragY = null;
  root.addEventListener('pointerdown', e => {
    if (e.target.closest('button, a')) return;   // don't steal control clicks
    dragY = e.clientY;
    root.setPointerCapture(e.pointerId);
    ensureAudio();
  });
  root.addEventListener('pointermove', e => {
    if (dragY === null) return;
    impulse((dragY - e.clientY) * 0.5);
    dragY = e.clientY;
  });
  root.addEventListener('pointerup', () => { dragY = null; });
  motorBtn.addEventListener('click', () => {
    ensureAudio();
    motorOn = !motorOn;
    lastUserInput = -1e9;
    motorBtn.classList.toggle('hg-motor-on', motorOn);
    if (motorOn && Math.abs(bpmTarget) < MIN_AUDIBLE_BPM) bpmTarget = MIN_AUDIBLE_BPM + 1;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      bpm = 0; bpmTarget = 0;
      if (choir) { choir.releaseAll(0.2); sounding.clear(); }
    }
  });

  // ---- loop ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
