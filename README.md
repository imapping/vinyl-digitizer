# Vinyl Digitizer

Turns a record collection into tagged, per-track digital files. Play a side, and the app records
it, splits it into tracks, names and tags them from your Discogs collection, and saves them as
FLAC (with MP3 copies if you want them).

It's a companion to the [TimesGate controller](https://github.com/imapping/timesgate-controller):
the turntable is plugged into the computer running the controller (a Raspberry Pi here), and this
app records from the controller's stereo stream and uses its Vinyl plugin for the Discogs
collection. The app itself runs on your PC and saves to its disk.

## What it does

- **Records a side** to an untouched FLAC file, with a level meter and waveform, and stops by
  itself when the arm lifts. Each recording is checked for clipping and mains hum.
- **Splits it into tracks.** Choose the record and side from your Discogs collection; the track
  lengths say roughly where each cut should be and the nearest quiet moment says exactly where.
  Drag or nudge the cuts, play across them, rename tracks, then save.
- **Corrects the deck's speed** (optional). A deck that runs fast makes every file sharp and
  short; give the measured speed and the tracks are resampled to the right pitch and length. The
  raw recording is never changed, so tracks can be saved again with a better measurement.
- **Saves tagged files**: `FLAC/Artist/Album (Year)/1-01 Title.flac` with the cover embedded, and
  the same under `MP3/`.
- **Keeps track of the collection**: every record, and which sides are recorded, split and saved.

## Running it

Needs [Node.js](https://nodejs.org) 20 or later (24.5 or later if antivirus scans your web
traffic), [ffmpeg](https://ffmpeg.org) with libsoxr and libmp3lame, and a TimesGate controller
with its Vinyl plugin's Discogs collection set up. There are no other dependencies.

```
node server.js
```

Then open http://127.0.0.1:8090 (the page is only served to the computer it runs on). The
controller's address and the recordings folder are in `data/settings.json`, created with
defaults on first use: `{ "source": "http://<controller>:8080", "outDir": "<folder>" }`.

To try it without a turntable, `node test/fake-turntable.js` is a pretend controller on port 8089
that plays a short made-up side; point `source` at it.

## Files

- `server.js`: the web server; recording, saving tracks, the catalogue.
- `meter.js`: levels, clipping and hum, measured as a side is recorded.
- `split.js`: proposes where the tracks start and end.
- `public/`: the page (`index.html`), the track editor (`editor.js`), the collection (`catalogue.js`).
- `PLAN.md`: the planning notes and what was learned along the way.
