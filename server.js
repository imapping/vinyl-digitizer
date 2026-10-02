// Vinyl Digitizer: records a side of a record from the TimesGate controller's turntable stream and
// saves it, untouched, as a FLAC file. Stage 1: record, check the level, listen back.
// Zero dependencies; needs Node 20+ and ffmpeg.  Run:  node server.js   (PORT env var optional)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { makeMeter, RATE, BLOCK_S } = require('./meter');
const { propose } = require('./split');

const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONF_FILE = path.join(DATA_DIR, 'settings.json');
const WIN = process.platform === 'win32';
const FRAME = 4;   // bytes in one stereo frame (16-bit left, 16-bit right)

// source: the TimesGate controller. outDir: where recordings go. autoStop: stop when the arm lifts,
// which is quietS seconds below quietDb after music has been heard.
let conf = { source: 'http://192.168.1.128:8080', outDir: 'G:\\VinylDigitizer', autoStop: true, quietDb: -65, quietS: 8, mp3: true };
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

// Trust the certificates this computer trusts (the Windows store), as well as Node's own list.
// Antivirus that scans web traffic (Norton here) re-signs secure connections with its own
// certificate, which Windows knows and Node doesn't, so the cover download from Discogs failed
// with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Needs Node 24.5 or later; older ones carry on as before.
try {
  const tls = require('tls');
  if (tls.setDefaultCACertificates) tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
} catch (e) { console.log('Couldn\'t load this computer\'s certificates:', e.message); }

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

// Beside each recording: <id>.json (what was measured as it was recorded, never changed afterwards)
// and, once it's been split, <id>.edit.json (the record, the cuts, and the files saved from it).
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const infoOf = id => readJson(path.join(rawDir(), id + '.json'));
const editOf = id => readJson(path.join(rawDir(), id + '.edit.json'));

// The finished recordings, newest first (without their level traces).
function recordings() {
  let files = [];
  try { files = fs.readdirSync(rawDir()).filter(f => f.endsWith('.json') && !f.endsWith('.edit.json')); } catch {}
  return files.map(f => {
    const all = readJson(path.join(rawDir(), f));
    if (!all) return null;
    const { levels, ...info } = all, e = editOf(info.id);
    if (e) info.split = { album: e.album?.album, artist: e.album?.artist, side: e.album?.side, tracks: e.tracks?.length, savedAt: e.savedAt || null, dir: e.dir || null };
    return info;
  }).filter(Boolean).sort((a, b) => b.started.localeCompare(a.started));
}

// ---------- the record collection (Discogs, through the controller's Vinyl plugin) ----------
const COLLECTION_FILE = path.join(DATA_DIR, 'collection.json');
async function fromController(pathAndQuery) {
  let r;
  try { r = await fetch(conf.source + pathAndQuery, { signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw fail(502, `Couldn't reach the TimesGate controller at ${conf.source} (${e.cause?.code || e.message}).`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(r.status === 404 ? 404 : 502, j.error || `The controller answered ${r.status}. It may need updating.`);
  return j;
}
// [{ id, title, artist, year, sides: [{ side, tracks }] }]; the last list fetched is kept for when the controller is off.
async function collection() {
  try {
    const { records } = await fromController('/api/vinyl/records');
    if (records?.length) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(COLLECTION_FILE, JSON.stringify(records)); }
    return records || [];
  } catch (e) {
    const saved = readJson(COLLECTION_FILE);
    if (saved) return saved;
    throw e;
  }
}
// The deck's measured speed: this app's own setting, or else the controller's Vinyl setting.
async function deckRpm() {
  if (conf.rpm) return conf.rpm;
  try { const s = await fromController('/api/vinyl/state'); if (s.rpm >= 30 && s.rpm <= 37) return s.rpm; } catch {}
  return NOMINAL_RPM;
}
// Where a side's tracks sit on the album: two sides to a disc (A and B are disc 1, C and D disc 2),
// numbered from 1 on each disc. Sides that aren't single letters count as one disc.
function numbering(record, side) {
  const sides = record?.sides || [], k = sides.findIndex(s => s.side === side);
  const lettered = sides.length > 0 && sides.every(s => /^[A-Z]$/.test(s.side));
  if (k < 0) return { disc: 1, discs: 1, first: 1, total: null };
  const count = (a, b) => sides.slice(a, b).reduce((n, s) => n + s.tracks, 0);
  if (!lettered) return { disc: 1, discs: 1, first: count(0, k) + 1, total: count(0, sides.length) };
  const d = Math.floor(k / 2);
  return { disc: d + 1, discs: Math.ceil(sides.length / 2), first: count(d * 2, k) + 1, total: count(d * 2, d * 2 + 2) };
}

// A side chosen for a recording: its tracks, and where they probably start and end.
async function proposeFor(id, recordId, side) {
  const info = infoOf(id);
  if (!info) throw fail(404, 'That recording isn\'t there.');
  const album = await fromController(`/api/vinyl/side?id=${encodeURIComponent(recordId)}&side=${encodeURIComponent(side)}`);
  const record = (await collection().catch(() => [])).find(r => String(r.id) === String(recordId));
  const p = propose(info.levels, info.blockSeconds, album.tracks.map(t => t.dur || null));
  if (!p) throw fail(400, 'No music was found in that recording.');
  const marks = [p.start, ...p.cuts, p.end], num = numbering(record, side);
  return {
    album: { id: album.id, album: album.album, artist: album.artist, year: album.year, cover: album.cover, link: album.link, side: album.side, disc: num.disc, discs: num.discs, total: num.total },
    tracks: album.tracks.map((t, i) => ({ pos: t.pos, number: num.first + i, title: t.title, artist: t.artist, dur: t.dur || null, start: marks[i], end: marks[i + 1], sure: i === 0 || p.sure[i - 1] })),
    rpm: await deckRpm(), rpmFromLengths: p.rpm, note: p.note,
  };
}

// ---------- saving the tracks ----------
const NOMINAL_RPM = 100 / 3;
const fileSafe = v => String(v || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Unknown';
const COVER = /^https:\/\/(i|img)\.discogs\.com\//;
let saving = null;   // the id of the recording being saved

// The record's cover, saved in the album's folder: { file } or { error: why not }. Tried twice.
async function fetchCover(url, dir) {
  if (!url) return { error: 'Discogs has no picture for this record.' };
  if (!COVER.test(url)) return { error: 'The picture\'s address isn\'t a Discogs one.' };
  let error;
  for (let go = 0; go < 2; go++) {
    if (go) await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'VinylDigitizer/0.1' }, signal: AbortSignal.timeout(20000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok) { error = `Discogs answered ${r.status} for the picture.`; continue; }
      if (!/^image\/(jpeg|png)/.test(type)) { error = `The picture came as ${type || 'an unknown type'}, which can't be embedded.`; continue; }
      const file = path.join(dir, type.includes('png') ? 'cover.png' : 'cover.jpg');
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return { file };
    } catch (e) { error = `The picture couldn't be downloaded (${e.cause?.code || e.message}).`; }
  }
  log('Cover:', error);
  return { error };
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-800); });
    p.on('error', reject);
    p.on('close', code => (code ? reject(new Error(err.trim() || `ffmpeg stopped with code ${code}`)) : resolve()));
  });
}

// body: { album: { album, artist, year, … }, tracks: [{ title, artist, pos, number, start, end }], rpm, correct, mp3 }
// Cuts each track out of the raw recording (which is never changed), corrects the speed if asked,
// and saves it tagged, in <outDir>/FLAC/<artist>/<album (year)>/, with an MP3 copy (LAME V0, about
// 245 kbit/s) under <outDir>/MP3/ if asked. Saving again replaces the earlier files.
async function saveTracks(id, body) {
  const info = infoOf(id);
  if (!info) throw fail(404, 'That recording isn\'t there.');
  if (saving) throw fail(409, 'Tracks are already being saved. Wait for that to finish.');
  if (!FFMPEG) throw fail(500, 'ffmpeg wasn\'t found on this computer.');
  const a = body.album || {}, tracks = Array.isArray(body.tracks) ? body.tracks : [];
  const rpm = Number(body.rpm), correct = !!body.correct && Math.abs(rpm / NOMINAL_RPM - 1) > 0.0005;
  if (!tracks.length) throw fail(400, 'There are no tracks to save.');
  if (body.correct && !(rpm >= 30 && rpm <= 37)) throw fail(400, 'The deck speed should be between 30 and 37 RPM.');
  let before = 0;
  for (const t of tracks) {
    if (!(Number.isFinite(t.start) && Number.isFinite(t.end) && t.start >= before && t.end > t.start && t.end <= info.seconds + 0.1)) throw fail(400, 'The cuts are out of order or outside the recording.');
    before = t.end;
  }
  const raw = path.join(rawDir(), info.file);
  if (!fs.existsSync(raw)) throw fail(404, 'The recording\'s FLAC file is missing.');

  saving = id;
  try {
    const year = /^\d{4}$/.test(String(a.year || '')) ? String(a.year) : '';
    const folder = path.join(fileSafe(a.artist), fileSafe(a.album) + (year ? ` (${year})` : ''));
    const dir = path.join(conf.outDir, 'FLAC', folder), mp3Dir = body.mp3 ? path.join(conf.outDir, 'MP3', folder) : null;
    fs.mkdirSync(dir, { recursive: true });
    if (mp3Dir) fs.mkdirSync(mp3Dir, { recursive: true });
    const { file: cover, error: coverError } = await fetchCover(a.cover, dir);
    const width = Math.max(2, ...tracks.map(t => String(t.number || 0).length));
    // Slowing a fast deck's recording down: say the samples were taken more slowly (lower pitch,
    // longer), then resample back to 44.1 kHz with the high-quality resampler.
    const fix = correct ? `,asetrate=${Math.round(info.rate * NOMINAL_RPM / rpm)},aresample=${info.rate}:resampler=soxr:precision=28:dither_method=triangular` : '';
    const files = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i], n = t.number || i + 1;
      const name = (a.discs > 1 ? `${a.disc}-` : '') + String(n).padStart(width, '0') + ' ' + fileSafe(t.title) + '.flac';
      tell('save', { id, done: i, of: tracks.length, title: t.title });
      const meta = { title: t.title, artist: t.artist || a.artist, album: a.album, album_artist: a.artist, track: a.total ? `${n}/${a.total}` : String(n),
        disc: a.discs > 1 ? `${a.disc}/${a.discs}` : '', date: year, DISCOGS_RELEASE_ID: a.id || '', VINYL_POSITION: t.pos || '',
        comment: `Digitised from vinyl${a.side ? ', side ' + a.side : ''}. ` + (correct ? `Deck speed ${rpm} RPM, corrected to 33⅓.` : `Not speed-corrected${rpm ? ` (deck speed ${rpm} RPM)` : ''}.`) };
      await runFfmpeg(['-i', raw, ...(cover ? ['-i', cover] : []), '-map', '0:a', ...(cover ? ['-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []),
        '-af', `atrim=start_sample=${Math.round(t.start * info.rate)}:end_sample=${Math.round(t.end * info.rate)},asetpts=PTS-STARTPTS${fix}`,
        '-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '8', '-map_metadata', '-1',
        ...Object.entries(meta).filter(([, v]) => v !== '' && v != null).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
        path.join(dir, name)]);
      // The MP3 copy is made from the finished FLAC, so it has the same sound, tags and cover.
      if (mp3Dir) await runFfmpeg(['-i', path.join(dir, name), '-map', '0', '-c:a', 'libmp3lame', '-q:a', '0', '-c:v', 'copy', '-id3v2_version', '3', '-map_metadata', '0',
        path.join(mp3Dir, name.replace(/.flac$/, '.mp3'))]);
      files.push(name);
    }
    const edit = { album: a, tracks, rpm: rpm || null, corrected: correct, savedAt: new Date().toISOString(), dir, mp3Dir, files, cover: cover ? path.basename(cover) : null, coverError: coverError || null };
    fs.writeFileSync(path.join(rawDir(), id + '.edit.json'), JSON.stringify(edit, null, 2));
    if (typeof body.mp3 === 'boolean' && body.mp3 !== conf.mp3) { conf.mp3 = body.mp3; saveConf(); }
    log(`Saved ${files.length} tracks from "${id}" in ${dir}${mp3Dir ? ', with MP3 copies' : ''}.`);
    tell('save', { id, done: tracks.length, of: tracks.length });
    return edit;
  } finally { saving = null; }
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
      if (Number.isFinite(b.rpm) && b.rpm >= 30 && b.rpm <= 37) conf.rpm = Math.round(b.rpm * 100) / 100;   // the deck's measured speed at 33⅓
      saveConf();
      return sendJson(res, 200, state());
    }
    // A finished recording: its sound, and its level trace for the waveform.
    let m = /^\/audio\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const id = safeId(decodeURIComponent(m[1]));
      return id ? sendFile(req, res, path.join(rawDir(), id + '.flac'), 'audio/flac') : sendJson(res, 400, { error: 'Bad name' });
    }
    m = /^\/api\/recordings\/(.+)\/(levels|edit|propose|save)$/.exec(url.pathname);
    if (m) {
      const id = safeId(decodeURIComponent(m[1])), what = m[2];
      if (!id) return sendJson(res, 400, { error: 'Bad name' });
      if (req.method === 'GET' && what === 'levels') {
        const info = infoOf(id);
        return info ? sendJson(res, 200, info.levels || []) : sendJson(res, 404, { error: 'Not found' });
      }
      // What was chosen and saved for it last time (or {}), with the deck speed to offer.
      if (req.method === 'GET' && what === 'edit') return sendJson(res, 200, { edit: editOf(id), rpm: await deckRpm(), mp3: conf.mp3 });
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (what === 'propose') return sendJson(res, 200, await proposeFor(id, body.id, String(body.side ?? '')));
        if (what === 'save') return sendJson(res, 200, await saveTracks(id, body));
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/collection') return sendJson(res, 200, await collection());

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
