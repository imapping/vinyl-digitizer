// Proposes where a recorded side's tracks start and end, from its level trace (one reading every
// tenth of a second) and the track lengths Discogs gives. Quiet gaps alone are fooled by quiet
// passages and by tracks that run together, so the lengths say roughly where each cut should be,
// and the nearest quiet moment says exactly where.
// All times are seconds into the raw recording (at the speed the deck actually played).

const MUSIC_DB = -45;      // steady sound above this is music
const ARM_UP_DB = -65;     // below this the needle isn't on the record
const GAP_DB = -42;       // a moment this quiet (averaged over a second) can be a gap between tracks
const NEAR_S = 12, FAR_S = 25;   // how far from the expected place to look for the gap

// The level averaged over about a second, in dB, centred on each reading.
function smooth(db, half) {
  const out = new Array(db.length);
  let sum = 0, n = 0;
  for (let i = 0; i < Math.min(half, db.length); i++) { sum += db[i]; n++; }
  for (let i = 0; i < db.length; i++) {
    if (i + half < db.length) { sum += db[i + half]; n++; }
    if (i - half - 1 >= 0) { sum -= db[i - half - 1]; n--; }
    out[i] = sum / n;
  }
  return out;
}

// Where the music starts and ends: the first and last 3 seconds that are nearly all above MUSIC_DB.
function musicSpan(db, per) {
  const win = Math.round(3 * per), need = Math.round(win * 0.9);
  let loud = 0, first = -1, last = -1;
  for (let i = 0; i < db.length; i++) {
    if (db[i] > MUSIC_DB) loud++;
    if (i >= win && db[i - win] > MUSIC_DB) loud--;
    if (i >= win - 1 && loud >= need) { if (first < 0) first = i - win + 1; last = i; }
  }
  if (first < 0) return null;
  // A quiet opening or a fade-out belongs to the music: carry on outwards until a full second of quiet.
  // But not back into the needle landing: the thump in the second after the arm-up silence (below ARM_UP_DB).
  const sec = Math.round(per);
  let landed = first;
  while (landed >= 0 && db[landed] >= ARM_UP_DB) landed--;
  for (let i = first - 1, quiet = 0; i > landed + sec && quiet < sec; i--) { if (db[i] > MUSIC_DB) { first = i; quiet = 0; } else quiet++; }
  for (let i = last + 1, quiet = 0; i < db.length && quiet < sec; i++) { if (db[i] > MUSIC_DB) { last = i; quiet = 0; } else quiet++; }
  while (first < db.length && db[first] <= MUSIC_DB) first++;       // to the first loud reading
  while (last > first && db[last] <= MUSIC_DB) last--;
  return { first, last };
}

// The quietest moment near `at` (readings), preferring nearer ones: { cut, found }.
function gapNear(sm, at, lo, hi, per) {
  for (const reach of [NEAR_S, FAR_S]) {
    const a = Math.max(lo, Math.round(at - reach * per)), b = Math.min(hi, Math.round(at + reach * per));
    let best = -1, bestScore = Infinity;
    for (let i = a; i <= b; i++) {
      const score = sm[i] + 0.5 * Math.abs(i - at) / per;   // half a dB a second for being further away
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0 && sm[best] < GAP_DB) {
      // The middle of the quiet stretch around it.
      let l = best, r = best;
      while (l > a && sm[l - 1] < sm[best] + 4) l--;
      while (r < b && sm[r + 1] < sm[best] + 4) r++;
      return { cut: Math.round((l + r) / 2), found: true };
    }
  }
  return { cut: Math.round(at), found: false };
}

// With no track lengths: the longest quiet stretches inside the music, as many as are needed.
function longestGaps(sm, lo, hi, want, per) {
  const avg = sm.slice(lo, hi).reduce((a, b) => a + b, 0) / Math.max(1, hi - lo);
  const limit = Math.min(MUSIC_DB, avg - 12), runs = [];
  for (let i = lo, s = -1; i <= hi; i++) {
    const q = i < hi && sm[i] < limit;
    if (q && s < 0) s = i;
    if (!q && s >= 0) { if (i - s >= 1.2 * per) runs.push({ cut: Math.round((s + i) / 2), len: i - s }); s = -1; }
  }
  return runs.sort((a, b) => b.len - a.len).slice(0, want).map(r => r.cut).sort((a, b) => a - b);
}

// levels: [[peak, db], …] every blockS seconds. durs: each track's length in seconds (null if unknown).
// Returns { start, end, cuts: [seconds, one between each pair of tracks], sure: [whether a gap was
// found at each cut], rpm: the deck's speed the track lengths suggest (or null), note }.
function propose(levels, blockS, durs) {
  const per = 1 / blockS, db = levels.map(l => l[1]), n = durs.length;
  const span = musicSpan(db, per);
  if (!span || n < 1) return null;
  const sm = smooth(db, Math.round(per / 2));
  const first = Math.max(0, span.first - Math.round(0.3 * per));              // a breath before the first note
  const last = Math.min(db.length, span.last + Math.round(2 * per));          // room for the last note to die away
  const edge = Math.round(15 * per);                                          // no track is shorter than this
  const cuts = [], sure = [];
  let note = '', rpm = null;

  if (durs.every(d => d > 0)) {
    const total = durs.reduce((a, b) => a + b, 0);
    rpm = Math.round(100 / 3 * total / ((span.last - span.first) * blockS) * 100) / 100;
    let from = first, left = total;
    for (let i = 0; i < n - 1; i++) {
      const at = from + (last - from) * durs[i] / left;   // the rest of the side, shared out by length
      const g = gapNear(sm, at, from + edge, last - edge * (n - 1 - i), per);
      cuts.push(g.cut); sure.push(g.found);
      from = g.cut; left -= durs[i];
    }
    if (sure.includes(false)) note = 'No quiet gap was found at some cuts (the tracks may run together), so those are placed by track length alone. Check them.';
  } else {
    const found = longestGaps(sm, first + edge, last - edge, n - 1, per);
    for (const c of found) { cuts.push(c); sure.push(true); }
    // Not enough gaps: halve the longest stretch until there are enough cuts.
    while (cuts.length < n - 1) {
      const pts = [first, ...cuts, last];
      let k = 0;
      for (let i = 1; i < pts.length - 1; i++) if (pts[i + 1] - pts[i] > pts[k + 1] - pts[k]) k = i;
      cuts.splice(k, 0, Math.round((pts[k] + pts[k + 1]) / 2)); sure.splice(k, 0, false);
    }
    note = 'Discogs has no track lengths for this side, so the cuts are the longest quiet gaps' + (sure.includes(false) ? ', and some are only guesses' : '') + '. Check them.';
  }
  const s = i => Math.round(i * blockS * 10) / 10;
  return { start: s(first), end: s(last), cuts: cuts.map(s), sure, rpm, note };
}

module.exports = { propose };
