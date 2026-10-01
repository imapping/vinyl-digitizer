// The track editor: choose the record and side a recording is of, check where it's cut into
// tracks, and save them. Opened from a recording in the list (Editor.open); uses $, api, clock
// and css from the page.
const Editor = (() => {
  const NOMINAL = 100 / 3, SPAN = 15;   // SPAN: seconds either side of a cut in the close-up
  const root = () => $('editor');
  let rec, levels, per;                 // the recording, its level trace, and readings per second
  let album, tracks, marks;             // marks: the start, each cut, and the end (seconds): tracks.length + 1 of them
  let rpm, correct, rpmGuess, note, sel, centre, records, saved, busy, error;
  let audio, stopAt = null;

  const h = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    if (props.style) e.style.cssText = props.style;
    e.append(...kids.flat().filter(k => k != null && k !== false));
    return e;
  };
  const tm = s => { const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
  const ratio = () => (correct ? rpm / NOMINAL : 1);

  // ---------- drawing ----------
  // The recording between a and b (seconds), with the cuts as lines and what's outside the side shaded.
  function wave(canvas, a, b) {
    const w = canvas.clientWidth, ht = canvas.clientHeight, dpr = devicePixelRatio || 1;
    if (!w) return;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = ht * dpr; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, ht);
    const x = t => (t - a) / (b - a) * w;
    g.fillStyle = css('--wave');
    for (let px = 0; px < w; px++) {
      const i0 = Math.floor((a + (b - a) * px / w) * per), i1 = Math.max(i0 + 1, Math.ceil((a + (b - a) * (px + 1) / w) * per));
      let p = 0;
      for (let i = Math.max(0, i0); i < Math.min(levels.length, i1); i++) if (levels[i][0] > p) p = levels[i][0];
      if (i1 <= 0 || i0 >= levels.length) continue;
      const d = p > 0 ? 20 * Math.log10(p) : -99, bar = Math.max(1, (Math.max(-60, d) + 60) / 60 * (ht - 16));
      g.fillRect(px, (ht - bar) / 2 + 6, 1, bar);
    }
    g.fillStyle = 'rgba(128,128,128,.35)';
    g.fillRect(0, 0, Math.max(0, x(marks[0])), ht);
    g.fillRect(x(marks[marks.length - 1]), 0, w, ht);
    g.font = '11px system-ui'; g.textBaseline = 'top';
    marks.forEach((m, i) => {
      const px = x(m);
      if (px < -40 || px > w + 40) return;
      g.fillStyle = i === sel ? css('--accent') : css('--ink');
      g.fillRect(Math.round(px) - (i === sel ? 1 : 0), 0, i === sel ? 3 : 1, ht);
      if (i < tracks.length) g.fillText(String(tracks[i].number), px + 4, 1);
    });
    if (audio && !audio.paused) { g.fillStyle = css('--good'); g.fillRect(x(audio.currentTime), 0, 1, ht); }
  }
  function redraw() {
    const o = $('edOver'), d = $('edNear');
    if (o) wave(o, 0, rec.seconds);
    if (d) wave(d, centre - SPAN, centre + SPAN);
  }

  // ---------- moving the cuts ----------
  function move(i, t) {
    const lo = i ? marks[i - 1] + 1 : 0, hi = i < marks.length - 1 ? marks[i + 1] - 1 : rec.seconds;
    marks[i] = Math.round(Math.max(lo, Math.min(hi, t)) * 10) / 10;
  }
  function select(i) { sel = i; centre = marks[i]; }
  function drag(canvas, range) {
    canvas.onpointerdown = e => {
      const [a, b] = range(), w = canvas.clientWidth, at = px => a + (b - a) * px / w;
      const t = at(e.offsetX);
      let near = 0;
      marks.forEach((m, i) => { if (Math.abs(m - t) < Math.abs(marks[near] - t)) near = i; });
      const grabbed = Math.abs((marks[near] - a) / (b - a) * w - e.offsetX) < 10;
      sel = near;
      if (canvas.id === 'edOver') centre = marks[sel];
      canvas.setPointerCapture(e.pointerId);
      canvas.onpointermove = grabbed ? ev => { move(sel, at(ev.offsetX)); if (canvas.id === 'edOver') centre = marks[sel]; redraw(); } : null;
      canvas.onpointerup = () => { canvas.onpointermove = canvas.onpointerup = null; centre = marks[sel]; render(); };
      redraw();
    };
  }
  function play(from, to) {
    audio.currentTime = Math.max(0, from); stopAt = Math.min(rec.seconds, to);
    audio.play().catch(() => {});
  }

  // ---------- the screens ----------
  function picker() {
    const box = h('div');
    const q = h('input', { type: 'text', placeholder: 'Find the record: artist or album', value: rec.name || '' });
    const list = h('div', { style: 'margin-top:10px; max-height:320px; overflow:auto' });
    const fill = () => {
      const words = q.value.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !/^(side|[a-h])$/.test(w));
      const hits = (records || []).map(r => ({ r, n: words.filter(w => (r.artist + ' ' + r.title).toLowerCase().includes(w)).length }))
        .filter(x => !words.length || x.n).sort((x, y) => y.n - x.n).slice(0, 40);
      list.replaceChildren(...(hits.length ? hits.map(({ r }) => h('div', { className: 'row', style: 'padding:5px 0; border-top:1px solid var(--line)' },
        h('span', { style: 'flex:1 1 240px' }, `${r.artist} – ${r.title}` + (r.year ? ` (${r.year})` : '')),
        r.sides.map(s => h('button', { className: 'plain', onclick: () => choose(r.id, s.side), title: s.tracks + ' tracks' }, s.side ? 'Side ' + s.side : 'All tracks'))))
        : [h('div', { className: 'dim' }, records ? 'No record matches.' : 'Loading your collection…')]));
    };
    q.oninput = fill;
    if (!records) api('/api/collection').then(r => { records = r; fill(); }).catch(e => { list.replaceChildren(h('div', { className: 'bad' }, e.message)); });
    fill();
    box.append(h('div', { className: 'row' }, q), list);
    return box;
  }
  async function choose(id, side) {
    error = '';
    try {
      const p = await api('/api/recordings/' + encodeURIComponent(rec.id) + '/propose', { id, side });
      album = p.album; rpm = p.rpm; rpmGuess = p.rpmFromLengths; note = p.note; saved = null;
      correct = Math.abs(rpm / NOMINAL - 1) > 0.002;
      tracks = p.tracks.map(t => ({ pos: t.pos, number: t.number, title: t.title, artist: t.artist, dur: t.dur, sure: t.sure }));
      marks = [...p.tracks.map(t => t.start), p.tracks[p.tracks.length - 1].end];
      select(0);
    } catch (e) { error = e.message; }
    render();
  }

  function review() {
    const first = tracks[0].number;
    tracks.forEach((t, i) => { t.number = first + i; });
    const field = (label, key, width) => h('label', {}, label, h('input', { type: 'text', value: album[key] ?? '', style: `flex:0 1 ${width}px; width:${width}px`, oninput: e => { album[key] = e.target.value; } }));
    const nudge = d => h('button', { className: 'plain', onclick: () => { move(sel, marks[sel] + d); centre = marks[sel]; render(); } }, (d > 0 ? '+' : '−') + Math.abs(d) + ' s');
    const what = sel === 0 ? 'The start of the side' : sel === tracks.length ? 'The end of the side' : `The cut between tracks ${tracks[sel - 1].number} and ${tracks[sel].number}`;
    const rows = tracks.map((t, i) => {
      const len = (marks[i + 1] - marks[i]) * ratio(), diff = t.dur ? len - t.dur : null;
      return h('tr', { className: i === sel ? 'on' : '' },
        h('td', {}, h('button', { className: 'plain', title: 'Show this track\'s start', onclick: () => { select(i); render(); } }, t.pos || String(t.number))),
        h('td', { style: 'width:100%' }, h('input', { type: 'text', value: t.title, style: 'width:100%', oninput: e => { t.title = e.target.value; } }),
          t.sure === false ? h('div', { className: 'warn', style: 'font-size:.85rem' }, 'No gap found at its start: check it') : null),
        h('td', {}, tm(marks[i])),
        h('td', {}, clock(len), t.dur ? h('div', { className: Math.abs(diff) > 6 ? 'warn' : 'dim', style: 'font-size:.85rem' }, `Discogs ${clock(t.dur)} (${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(0)} s)`) : null),
        h('td', { style: 'white-space:nowrap' },
          h('button', { className: 'plain', title: 'Play its first 10 seconds', onclick: () => play(marks[i], marks[i] + 10) }, '▶'), ' ',
          h('button', { className: 'plain', title: 'Split this track in two', onclick: () => { marks.splice(i + 1, 0, Math.round((marks[i] + marks[i + 1]) * 5) / 10); tracks.splice(i + 1, 0, { pos: '', title: '', artist: album.artist, dur: null, number: 0 }); select(i + 1); render(); } }, '+'), ' ',
          tracks.length > 1 ? h('button', { className: 'plain', title: 'Remove this track (its sound joins the one before)', onclick: () => { marks.splice(i ? i : 1, 1); tracks.splice(i, 1); tracks[0].number = first; select(Math.min(i, tracks.length)); render(); } }, '×') : null));
    });
    const total = tracks.reduce((n, t) => n + (t.dur || 0), 0), allDur = tracks.every(t => t.dur);
    const played = (marks[marks.length - 1] - marks[0]) * ratio();
    return h('div', {},
      h('div', { className: 'row', style: 'align-items:flex-start' },
        album.cover ? h('img', { src: album.cover, alt: '', style: 'width:84px; height:84px; object-fit:cover; border-radius:6px', referrerPolicy: 'no-referrer' }) : null,
        h('div', { style: 'flex:1 1 300px; display:grid; gap:6px' },
          h('div', { className: 'row' }, field('Artist', 'artist', 220), field('Album', 'album', 240), field('Year', 'year', 60)),
          h('div', { className: 'dim' }, (album.side ? `Side ${album.side}` : 'All tracks') + (album.discs > 1 ? ` · disc ${album.disc} of ${album.discs}` : '') + ' · ',
            album.link ? h('a', { href: album.link, target: '_blank', rel: 'noopener' }, 'Discogs entry') : null, ' · ',
            h('a', { href: '#', onclick: e => { e.preventDefault(); album = null; render(); } }, 'Choose a different record')))),
      note ? h('div', { className: 'warn', style: 'margin-top:8px' }, note) : null,
      h('canvas', { id: 'edOver', style: 'height:80px; cursor:pointer; touch-action:none' }),
      h('div', { className: 'row', style: 'margin-top:10px; justify-content:space-between' },
        h('span', {}, h('b', {}, what), ' at ' + tm(marks[sel])),
        h('span', { className: 'row' }, nudge(-1), nudge(-0.1), nudge(0.1), nudge(1),
          h('button', { onclick: () => (sel === 0 ? play(marks[0], marks[0] + 8) : sel === tracks.length ? play(marks[sel] - 8, marks[sel]) : play(marks[sel] - 5, marks[sel] + 5)) }, '▶ Play across it'))),
      h('canvas', { id: 'edNear', style: 'height:110px; cursor:ew-resize; touch-action:none' }),
      h('div', { className: 'dim' }, `The close-up shows ${SPAN} seconds either side. Drag a line on either picture, or use the buttons.`),
      h('table', { className: 'tracks' }, h('thead', {}, h('tr', {}, ...['', 'Title', 'Starts', 'Length', ''].map(t => h('th', {}, t)))), h('tbody', {}, rows)),
      h('div', { className: 'row', style: 'margin-top:12px' },
        h('label', {}, 'Deck speed', h('input', { type: 'text', value: rpm, style: 'flex:0 0 70px; width:70px', onchange: e => { const v = Number(e.target.value); if (v >= 30 && v <= 37) { rpm = Math.round(v * 100) / 100; api('/api/settings', { rpm }).catch(() => {}); } render(); } }), 'RPM'),
        h('label', {}, h('input', { type: 'checkbox', checked: correct, onchange: e => { correct = e.target.checked; render(); } }), 'Correct the speed when saving')),
      h('div', { className: 'dim', style: 'margin-top:4px' },
        allDur ? `The side plays for ${clock(played)}${correct ? ' once corrected' : ''}; Discogs' track lengths add up to ${clock(total)}. ` : '',
        rpmGuess ? `Going by those lengths the deck ran at about ${rpmGuess.toFixed(1)} RPM (a rough figure: it counts the gaps between tracks as music).` : ''),
      h('div', { className: 'row', style: 'margin-top:14px' },
        h('button', { disabled: !!busy, onclick: save }, busy || (saved ? 'Save the tracks again' : 'Save the tracks')),
        h('button', { className: 'plain', onclick: close }, 'Close')),
      saved ? h('div', { className: 'ok', style: 'margin-top:8px' }, `Saved ${saved.files.length} tracks in ${saved.dir}` + (saved.corrected ? `, speed-corrected from ${saved.rpm} RPM.` : ', not speed-corrected.') + (saved.cover ? '' : ' (No cover picture was available.)')) : null);
  }

  async function save() {
    error = ''; busy = 'Saving…'; render();
    try {
      saved = await api('/api/recordings/' + encodeURIComponent(rec.id) + '/save', { album, rpm, correct,
        tracks: tracks.map((t, i) => ({ pos: t.pos, number: t.number, title: t.title.trim() || 'Track ' + t.number, artist: t.artist, dur: t.dur, start: marks[i], end: marks[i + 1] })) });
      if (typeof list === 'function') list();
    } catch (e) { error = e.message; }
    busy = null; render();
  }

  function render() {
    const el = root();
    el.hidden = !rec;
    if (!rec) return;
    el.replaceChildren(
      h('h2', {}, 'Split into tracks: ' + (rec.name || rec.id)),
      album ? review() : picker(),
      error ? h('div', { className: 'bad', style: 'margin-top:8px' }, error) : null,
      album ? null : h('div', { className: 'row', style: 'margin-top:12px' }, h('button', { className: 'plain', onclick: close }, 'Close')));
    if (album) {
      drag($('edOver'), () => [0, rec.seconds]);
      drag($('edNear'), () => [centre - SPAN, centre + SPAN]);
      redraw();
    }
  }
  function close() { if (audio) audio.pause(); rec = album = null; render(); }

  async function open(r) {
    rec = r; album = null; error = ''; saved = null; busy = null; note = ''; rpmGuess = null;
    per = 1 / (r.blockSeconds || 0.1);
    if (audio) audio.pause();
    audio = new Audio('/audio/' + encodeURIComponent(r.id));
    audio.preload = 'metadata';
    audio.ontimeupdate = () => { if (stopAt != null && audio.currentTime >= stopAt) { audio.pause(); stopAt = null; } redraw(); };
    audio.onpause = redraw;
    try {
      [levels, { edit: saved, rpm }] = await Promise.all([api('/api/recordings/' + encodeURIComponent(r.id) + '/levels'), api('/api/recordings/' + encodeURIComponent(r.id) + '/edit')]);
      if (saved) {   // carry on from what was saved last time
        album = saved.album; tracks = saved.tracks.map(t => ({ ...t })); marks = [...saved.tracks.map(t => t.start), saved.tracks[saved.tracks.length - 1].end];
        rpm = saved.rpm || rpm; correct = saved.corrected; select(0);
      }
    } catch (e) { error = e.message; }
    render();
    root().scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  addEventListener('resize', () => { if (rec && album) redraw(); });
  return { open, progress: p => { if (rec && p.id === rec.id && busy) { busy = p.done < p.of ? `Saving ${p.done + 1} of ${p.of}…` : 'Finishing…'; render(); } } };
})();
