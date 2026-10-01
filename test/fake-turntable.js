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
