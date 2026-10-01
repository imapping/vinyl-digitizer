// Measures 16-bit stereo sound as it's recorded: the level every tenth of a second (for the meter,
// the waveform and the end-of-side check), and totals for the whole recording (peak, average,
// clipping, and mains hum in the quiet parts). It never changes the sound.

const RATE = 44100;
const BLOCK_S = 0.1, BLOCK = RATE * BLOCK_S;   // frames per level reading
const FULL = 32768;
const HUM_HZ = [47, 48, 49, 50, 51, 52];       // mains hum sits about here (measured over whole seconds)
const HUM_COEFF = HUM_HZ.map(f => 2 * Math.cos(2 * Math.PI * f / RATE));
const QUIET_DB = -45;                           // a second below this counts as "between tracks"...
const SILENT_DB = -75;                          // ...unless it's below this: the arm is up, no groove

const db = meanSquare => (meanSquare > 0 ? Math.max(-99, 10 * Math.log10(meanSquare / (FULL * FULL))) : -99);

// onBlock({ peak 0..1, db }) is called for every tenth of a second fed in.
function makeMeter(onBlock) {
  let n = 0, peak = 0, sumSq = 0;                 // the current tenth of a second
  let frames = 0, allPeak = 0, allSq = 0, clipped = 0;
  // The current second, for the hum: a Goertzel filter per frequency on the mono mix.
  let sn = 0, sSq = 0;
  const s1 = HUM_HZ.map(() => 0), s2 = HUM_HZ.map(() => 0);
  let humE = 0, quietE = 0, quietN = 0;

  function feed(buf) {
    for (let o = 0; o + 3 < buf.length; o += 4) {
      const l = buf.readInt16LE(o), r = buf.readInt16LE(o + 2);
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r, a = al > ar ? al : ar;
      if (a > peak) peak = a;
      if (al >= 32767) clipped++;
      if (ar >= 32767) clipped++;
      sumSq += l * l + r * r;
      const mono = (l + r) / 2;
      sSq += mono * mono;
      for (let k = 0; k < HUM_COEFF.length; k++) { const s0 = mono + HUM_COEFF[k] * s1[k] - s2[k]; s2[k] = s1[k]; s1[k] = s0; }
      if (++sn === RATE) {
        const secDb = db(sSq / RATE);
        if (secDb < QUIET_DB && secDb > SILENT_DB) {
          let tone = 0;
          for (let k = 0; k < HUM_COEFF.length; k++) tone += 2 * (s1[k] * s1[k] + s2[k] * s2[k] - HUM_COEFF[k] * s1[k] * s2[k]) / RATE;
          humE += Math.min(tone, sSq); quietE += sSq; quietN += RATE;
        }
        sn = 0; sSq = 0; s1.fill(0); s2.fill(0);
      }
      if (++n === BLOCK) {
        frames += n; allSq += sumSq; if (peak > allPeak) allPeak = peak;
        onBlock({ peak: peak / FULL, db: Math.round(db(sumSq / (2 * n)) * 10) / 10 });
        n = 0; peak = 0; sumSq = 0;
      }
    }
  }

  // The whole recording so far. hum is null if there was no quiet second to measure it in.
  function summary() {
    const total = frames + n, sq = allSq + sumSq, pk = Math.max(allPeak, peak);
    const r1 = x => Math.round(x * 10) / 10;
    return {
      seconds: total / RATE,
      peakDb: r1(db(pk * pk)),
      averageDb: r1(db(total ? sq / (2 * total) : 0)),
      clipped,
      hum: quietN ? { db: r1(db(humE / quietN)), share: Math.round(1000 * humE / quietE) / 1000, quietDb: r1(db(quietE / quietN)), seconds: quietN / RATE } : null,
    };
  }
  return { feed, summary };
}

module.exports = { makeMeter, RATE, BLOCK_S };
