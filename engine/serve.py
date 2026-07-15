#!/usr/bin/env python3
"""
The composition server: verified chorales over HTTP, composed ahead of demand.

    python engine/serve.py [--port 8763]

Endpoints (all GET, CORS-open, params optional):
  /compose?tonic=D&mode=minor&phrases=3&seed=7&density=1.0&plain=0
      -> event-format JSON (application/json)
  /compose.mid?...&bpm=66
      -> standard MIDI file (audio/midi)
  /next?tonic=D&mode=minor&phrases=3&bpm=66
      -> like /compose but stateful: each call returns the NEXT piece for
         those params (auto-incrementing seed), served instantly from a
         one-piece-ahead buffer. This is the instrument endpoint: a crank,
         a web page, or a Pd patch polls /next and never waits.

Composition takes ~30 ms per piece; a piece plays for ~40 s. The buffer
exists so even that 30 ms never lands between phrases.
"""
import io, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.claude' / 'skills'
                       / 'choral-counterpoint' / 'scripts'))
import compose as engine
import score_io
import mido

_buffers = {}                 # param-key -> {'seed': next_seed, 'piece': precomposed}
_lock = threading.Lock()

def params_of(qs):
    g = lambda k, d: qs.get(k, [d])[0]
    return {
        'tonic': g('tonic', 'D'), 'mode': g('mode', 'minor'),
        'phrases': int(g('phrases', 3)), 'seed': int(g('seed', 7)),
        'density': float(g('density', 1.0)), 'plain': g('plain', '0') == '1',
    }

def to_midi_bytes(piece, bpm):
    voices, ferm, total = score_io.load(piece)
    mult = score_io.eighth_multipliers(total, ferm)
    tick_at = [0]
    for m in mult:
        tick_at.append(tick_at[-1] + int(240 * m))
    mid = mido.MidiFile(ticks_per_beat=480)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm), time=0))
    mid.tracks.append(meta)
    for ch, name in enumerate(score_io.VOICES):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage('track_name', name=name, time=0))
        tr.append(mido.Message('program_change', program=52, channel=ch, time=0))
        cursor = 0
        for n, start, length in voices[name]:
            on, off = tick_at[start], tick_at[min(start + length, total)]
            tr.append(mido.Message('note_on', note=n, velocity=72, channel=ch, time=on - cursor))
            tr.append(mido.Message('note_off', note=n, velocity=0, channel=ch, time=off - on))
            cursor = off
        mid.tracks.append(tr)
    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()

def next_piece(p):
    """Stateful compose-ahead: return buffered piece, start composing the next."""
    key = (p['tonic'], p['mode'], p['phrases'], p['density'], p['plain'])
    with _lock:
        state = _buffers.setdefault(key, {'seed': 1, 'piece': None})
        piece = state['piece']
        seed = state['seed']
    if piece is None:
        piece = engine.compose(tonic=p['tonic'], mode=p['mode'], phrases=p['phrases'],
                               seed=seed, density=p['density'], plain=p['plain'])
        seed += 1
    def precompose(seed):
        nxt = engine.compose(tonic=p['tonic'], mode=p['mode'], phrases=p['phrases'],
                             seed=seed, density=p['density'], plain=p['plain'])
        with _lock:
            _buffers[key] = {'seed': seed + 1, 'piece': nxt}
    threading.Thread(target=precompose, args=(seed,), daemon=True).start()
    return piece

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {self.path}")

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        """POST /harmonize with a melody JSON body:
        {"tonic":"F","mode":"major","soprano":[...],"fermatas":[...],
         "seed":7,"density":1.0,"plain":false}  -> event-format JSON"""
        url = urlparse(self.path)
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if url.path != '/harmonize':
                self.send(404, b'{"error": "unknown endpoint"}', 'application/json')
                return
            piece = engine.compose(
                tonic=body.get('tonic', 'D'), mode=body.get('mode', 'minor'),
                seed=int(body.get('seed', 7)), density=float(body.get('density', 1.0)),
                plain=bool(body.get('plain', False)),
                given_melody={'soprano': body['soprano'],
                              'fermatas': body.get('fermatas', [])})
            if piece is None:
                self.send(422, b'{"error": "could not harmonize this melody cleanly"}',
                          'application/json')
            else:
                self.send(200, json.dumps(piece).encode(), 'application/json')
        except Exception as e:
            self.send(500, json.dumps({'error': str(e)}).encode(), 'application/json')

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        p = params_of(qs)
        bpm = int(qs.get('bpm', ['66'])[0])
        try:
            if url.path == '/compose':
                piece = engine.compose(**p)
                self.send(200, json.dumps(piece).encode(), 'application/json')
            elif url.path == '/compose.mid':
                piece = engine.compose(**p)
                self.send(200, to_midi_bytes(piece, bpm), 'audio/midi')
            elif url.path == '/next':
                piece = next_piece(p)
                self.send(200, json.dumps(piece).encode(), 'application/json')
            elif url.path == '/next.mid':
                piece = next_piece(p)
                self.send(200, to_midi_bytes(piece, bpm), 'audio/midi')
            else:
                self.send(404, b'{"error": "unknown endpoint"}', 'application/json')
        except Exception as e:
            self.send(500, json.dumps({'error': str(e)}).encode(), 'application/json')

if __name__ == '__main__':
    port = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 8763
    print(f"composition engine listening on http://127.0.0.1:{port}")
    print("  /compose  /compose.mid  /next  /next.mid")
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
