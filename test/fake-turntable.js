// A pretend TimesGate controller for testing, so the real one and the turntable aren't touched.
// It plays a made-up side in real time: 1 s of groove noise, 6 s of music (two tones), a 2 s gap,
// 5 s more music, then silence as if the arm had lifted. A faint 50 Hz hum runs under the grooves.
//   node test/fake-turntable.js   (PORT env var, default 8089; CUT=seconds ends the stream early)

const http = require('http');
const PORT = Number(process.env.PORT) || 8089, CUT = Number(process.env.CUT) || 0;
const RATE = 44100;

function header() {
  const h = Buffer.alloc(44), n = 0xFFFFFFFF - 36;
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  return h;
}
// The sample at frame i: [left, right], each -1..1.
function sample(i) {
  const t = i / RATE;
  if (t >= 14) return [0, 0];                                            // the arm has lifted
  const hum = 0.0006 * Math.sin(2 * Math.PI * 50 * t), noise = () => (Math.random() - 0.5) * 0.002;
  const music = (t >= 1 && t < 7) || (t >= 9 && t < 14);
  if (!music) return [hum + noise(), hum + noise()];
  return [hum + noise() + 0.25 * Math.sin(2 * Math.PI * 440 * t), hum + noise() + 0.25 * Math.sin(2 * Math.PI * 660 * t)];
}

http.createServer((req, res) => {
  if (req.url === '/api/mic') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ running: true, error: null, device: 'pretend turntable', users: [], shared: true, local: false }));
  }
  // The Vinyl plugin's collection: one record, whose side A matches the real Queen test recording.
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/api/vinyl/state') return json(200, { rpm: 34.1 });
  if (req.url === '/api/vinyl/records') return json(200, { records: [
    { id: 9371072, title: 'Greatest Hits', artist: 'Queen', year: 2016, sides: [{ side: 'A', tracks: 4 }, { side: 'B', tracks: 4 }, { side: 'C', tracks: 4 }, { side: 'D', tracks: 5 }] },
    { id: 2, title: 'Test Tones', artist: 'The Oscillators', year: 2026, sides: [{ side: 'A', tracks: 2 }] }] });
  if (req.url.startsWith('/api/vinyl/side')) {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('id') === '9371072' && q.get('side') === 'A') return json(200, { id: 9371072, album: 'Greatest Hits', artist: 'Queen', year: 2016, cover: null, link: 'https://www.discogs.com/release/9371072', side: 'A',
      tracks: [['A1', 'Bohemian Rhapsody', 355], ['A2', 'Another One Bites The Dust', 216], ['A3', 'Killer Queen', 177], ['A4', 'Fat Bottomed Girls', 202]].map(([pos, title, dur]) => ({ pos, where: '', title, artist: 'Queen', dur })) });
    if (q.get('id') === '2') return json(200, { id: 2, album: 'Test Tones', artist: 'The Oscillators', year: 2026, cover: null, link: null, side: 'A',
      tracks: [{ pos: 'A1', title: 'Low Tone', artist: 'The Oscillators', dur: null }, { pos: 'A2', title: 'Same Again', artist: 'The Oscillators', dur: null }] });
    return json(404, { error: 'That record or side isn\'t in the saved collection.' });
  }
  if (req.url.startsWith('/api/mic/stream')) {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write(header());
    let i = 0;
    const began = Date.now();
    const timer = setInterval(() => {
      const upTo = Math.floor((Date.now() - began) / 1000 * RATE);
      const buf = Buffer.alloc((upTo - i) * 4);
      for (let o = 0; i < upTo; i++, o += 4) {
        const [l, r] = sample(i);
        buf.writeInt16LE(Math.round(l * 32767), o); buf.writeInt16LE(Math.round(r * 32767), o + 2);
      }
      res.write(buf);
      if (CUT && i >= CUT * RATE) { clearInterval(timer); res.destroy(); }
    }, 50);
    return req.on('close', () => clearInterval(timer));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`Pretend turntable on http://127.0.0.1:${PORT}`));
