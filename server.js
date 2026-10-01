// Vinyl Digitizer: records a side of a record from the TimesGate controller's turntable stream and
// saves it, untouched, as a FLAC file. Stage 1: record, check the level, listen back.
// Zero dependencies; needs Node 20+ and ffmpeg.  Run:  node server.js   (PORT env var optional)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { makeMeter, RATE, BLOCK_S } = require('./meter');

const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONF_FILE = path.join(DATA_DIR, 'settings.json');
const WIN = process.platform === 'win32';
const FRAME = 4;   // bytes in one stereo frame (16-bit left, 16-bit right)

// source: the TimesGate controller. outDir: where recordings go. autoStop: stop when the arm lifts,
// which is quietS seconds below quietDb after music has been heard.
let conf = { source: 'http://192.168.1.128:8080', outDir: 'G:\\VinylDigitizer', autoStop: true, quietDb: -65, quietS: 8 };
try { conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) }; } catch {}
const saveConf = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2)); };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const rawDir = () => path.join(conf.outDir, 'raw');

function findFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const exe = WIN ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, exe);
    if (dir && fs.existsSync(f)) return f;
  }
  if (WIN) {  // installed by winget (not on PATH until the next logon)
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter(d => /ffmpeg/i.test(d)))
        for (const sub of fs.readdirSync(path.join(pk, d))) {
          const f = path.join(pk, d, sub, 'bin', 'ffmpeg.exe');
          if (fs.existsSync(f)) return f;
        }
    } catch {}
  }
  return null;
}
const FFMPEG = findFfmpeg();

// ---------- live updates to the page (server-sent events) ----------
const watchers = new Set();
function tell(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of watchers) res.write(msg);
}

// ---------- recording ----------
let rec = null;   // the recording in progress

const pad = n => String(n).padStart(2, '0');
function fileBase(name) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return safe ? `${stamp} ${safe}` : stamp;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

async function startRecording(name) {
  if (rec) throw fail(409, 'A recording is already running.');
  if (!FFMPEG) throw fail(500, 'ffmpeg wasn\'t found on this computer.');
  if (!fs.existsSync(conf.outDir)) throw fail(400, `The recordings folder ${conf.outDir} isn't there. Is the drive plugged in?`);
  fs.mkdirSync(rawDir(), { recursive: true });

  const abort = new AbortController();
  let res;
  try { res = await fetch(conf.source + '/api/mic/stream?hq&keep', { signal: abort.signal }); }
  catch (e) { throw fail(502, `Couldn't reach the TimesGate controller at ${conf.source} (${e.cause?.code || e.message}).`); }
  if (!res.ok) {
    let why = `it answered ${res.status}`;
    try { why = (await res.json()).error || why; } catch {}
    throw fail(502, `The controller wouldn't start the stream: ${why}`);
  }

  const base = fileBase(name), file = path.join(rawDir(), base + '.flac');
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'flac', '-compression_level', '5', file], { windowsHide: true });
  let ffErr = '';
  ff.stderr.on('data', d => { ffErr = (ffErr + d).slice(-500); });
  ff.stdin.on('error', () => {});   // reported through the close code instead

  const r = rec = { id: base, name: String(name || '').trim(), file, started: Date.now(), abort, ff, levels: [],
    heardMusic: false, loud: 0, quiet: 0, stopping: null };
  const meter = makeMeter(b => {
    r.levels.push([Math.round(b.peak * 1000) / 1000, b.db]);
    tell('level', { t: r.levels.length * BLOCK_S, peak: b.peak, db: b.db });
    // Music has started after 3 s of steady sound; the side has ended after quietS seconds of silence.
    r.loud = b.db > -45 ? r.loud + 1 : 0;
    if (r.loud >= 3 / BLOCK_S) r.heardMusic = true;
    r.quiet = b.db < conf.quietDb ? r.quiet + 1 : 0;
    if (conf.autoStop && r.heardMusic && !r.stopping && r.quiet >= conf.quietS / BLOCK_S) stopRecording('The arm lifted (silence).');
  });
  log(`Recording "${base}".`);
  tell('state', state());

  // Read the stream: skip its 44-byte WAV header, then pass whole frames to ffmpeg and the meter.
  (async () => {
    let skip = 44, rest = Buffer.alloc(0), why = null;
    try {
      for await (const chunk of res.body) {
        let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (skip) { const s = Math.min(skip, buf.length); skip -= s; buf = buf.subarray(s); }
        if (rest.length) buf = Buffer.concat([rest, buf]);
        const whole = buf.length - (buf.length % FRAME);
        rest = Buffer.from(buf.subarray(whole));
        if (!whole) continue;
        buf = buf.subarray(0, whole);
        meter.feed(buf);
        if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
      }
      if (!r.stopping) why = 'The controller ended the stream.';
    } catch (e) {
      if (!r.stopping) why = `The stream from the controller broke (${e.cause?.code || e.message}).`;
    }
    // Finish the file, then write its notes beside it.
    ff.stdin.end();
    const [code] = ff.exitCode != null ? [ff.exitCode] : await once(ff, 'close');
    const info = { id: r.id, name: r.name, file: path.basename(r.file), started: new Date(r.started).toISOString(),
      rate: RATE, channels: 2, bits: 16, ...meter.summary(), stopped: r.stopping || why, cutShort: !!why,
      error: code ? (ffErr.trim() || `ffmpeg stopped with code ${code}`) : null, blockSeconds: BLOCK_S, levels: r.levels };
    try { info.bytes = fs.statSync(r.file).size; } catch {}
    fs.writeFileSync(path.join(rawDir(), r.id + '.json'), JSON.stringify(info));
    log(`Finished "${r.id}": ${Math.round(info.seconds)} s. ${info.stopped}`);
    rec = null;
    tell('state', state());
  })();
}

function stopRecording(why = 'Stopped by you.') {
  if (!rec || rec.stopping) return;
  rec.stopping = why;
  rec.abort.abort();
  tell('state', state());
}

// The finished recordings, newest first (without their level traces).
function recordings() {
  let files = [];
  try { files = fs.readdirSync(rawDir()).filter(f => f.endsWith('.json')); } catch {}
  return files.map(f => {
    try { const { levels, ...info } = JSON.parse(fs.readFileSync(path.join(rawDir(), f), 'utf8')); return info; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.started.localeCompare(a.started));
}

function state() {
  return { conf, ffmpeg: !!FFMPEG, outOk: fs.existsSync(conf.outDir),
    recording: rec && { id: rec.id, name: rec.name, started: rec.started, heardMusic: rec.heardMusic, stopping: rec.stopping } };
}

// What the controller says about its input (so the page can show whether it's reachable).
async function sourceStatus() {
  try {
    const r = await fetch(conf.source + '/api/mic', { signal: AbortSignal.timeout(3000) });
    const s = await r.json();
    return { ok: true, device: s.device, shared: s.shared, local: s.local, users: s.users, error: s.error };
  } catch (e) { return { ok: false, error: e.cause?.code || e.message }; }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 1e6) { reject(fail(413, 'Too much data')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// A recording's id is its file name without the extension: never a path.
const safeId = id => (id && !/[\\/]|\.\./.test(id) ? id : null);

// A file with support for byte ranges, so the browser's player can seek.
function sendFile(req, res, file, type) {
  let size;
  try { size = fs.statSync(file).size; } catch { return sendJson(res, 404, { error: 'Not found' }); }
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, { ...state(), levels: rec ? rec.levels : [] });
    if (req.method === 'GET' && url.pathname === '/api/source') return sendJson(res, 200, await sourceStatus());
    if (req.method === 'GET' && url.pathname === '/api/recordings') return sendJson(res, 200, recordings());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      watchers.add(res);
      return req.on('close', () => watchers.delete(res));
    }
    if (req.method === 'POST' && url.pathname === '/api/record') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      await startRecording(body.name);
      return sendJson(res, 200, state());
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') { stopRecording(); return sendJson(res, 200, state()); }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (rec && ('source' in b || 'outDir' in b)) throw fail(409, 'Stop the recording before changing where it comes from or goes.');
      if (typeof b.source === 'string' && /^https?:\/\/[^/]+$/.test(b.source.trim().replace(/\/+$/, ''))) conf.source = b.source.trim().replace(/\/+$/, '');
      if (typeof b.outDir === 'string' && b.outDir.trim()) conf.outDir = b.outDir.trim();
      if (typeof b.autoStop === 'boolean') conf.autoStop = b.autoStop;
      if (Number.isFinite(b.quietDb)) conf.quietDb = Math.max(-90, Math.min(-40, b.quietDb));
      if (Number.isFinite(b.quietS)) conf.quietS = Math.max(3, Math.min(60, b.quietS));
      saveConf();
      return sendJson(res, 200, state());
    }
    // A finished recording: its sound, and its level trace for the waveform.
    let m = /^\/audio\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const id = safeId(decodeURIComponent(m[1]));
      return id ? sendFile(req, res, path.join(rawDir(), id + '.flac'), 'audio/flac') : sendJson(res, 400, { error: 'Bad name' });
    }
    m = /^\/api\/recordings\/(.+)\/levels$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const id = safeId(decodeURIComponent(m[1]));
      try { return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(rawDir(), id + '.json'), 'utf8')).levels || []); }
      catch { return sendJson(res, 404, { error: 'Not found' }); }
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) log('Error:', e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
  }
});

// This computer only: the page starts recordings and names files on its disk.
server.listen(PORT, '127.0.0.1', () => log(`Vinyl Digitizer: http://127.0.0.1:${PORT}  (recordings in ${conf.outDir}, sound from ${conf.source})`));
