// The collection: every record on Discogs and how far each side has got, so the whole collection
// can be worked through and a half-done album picked up again. Uses $, api, recById, chooseSide
// and Editor from the page.
const Catalogue = (() => {
  let data = null, error = '', q = '', filter = 'all', all = false;
  const FIRST = 40;   // rows shown before "Show all"
  const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat().filter(k => k != null && k !== false)); return e; };
  const SAY = { none: 'Not recorded yet: click to record it', recorded: 'Recorded, not yet split into tracks: click to split it',
    draft: 'Cuts chosen, tracks not saved: click to carry on', saved: 'Tracks saved: click to edit them' };
  const MARK = { none: '', recorded: ' ●', draft: ' ●', saved: ' ✓' };

  function click(r, s) {
    if (s.state === 'none') return chooseSide(r, s.side);
    const rec = recById(s.recording);
    if (rec) Editor.open(rec);
  }
  function rows() {
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hits = data.records.filter(r => (filter === 'all' || r.state === filter) && words.every(w => (r.artist + ' ' + r.title).toLowerCase().includes(w)));
    const list = hits.slice(0, all ? hits.length : FIRST).map(r => h('div', { className: 'row catrow' },
      h('span', { className: 'name' + (r.state === 'done' ? ' ok' : '') }, `${r.artist} – ${r.title}` + (r.year ? ` (${r.year})` : '')),
      h('span', { className: 'chips' }, r.sides.map(s => h('button', { className: 'chip ' + s.state, title: SAY[s.state] + ` (${s.tracks} tracks)`, onclick: () => click(r, s) }, (s.side || 'All') + MARK[s.state])))));
    if (!hits.length) list.push(h('div', { className: 'dim' }, 'No record matches.'));
    if (hits.length > FIRST && !all) list.push(h('div', { style: 'margin-top:8px' }, h('button', { className: 'plain', onclick: () => { all = true; fill(); } }, `Show all ${hits.length}`)));
    return list;
  }
  function fill() { if (data) $('catList').replaceChildren(...rows()); }

  function render() {
    const el = $('cat');
    if (!data) { el.replaceChildren(h('div', { className: error ? 'bad' : 'dim' }, error || 'Loading your collection…')); return; }
    const t = data.totals;
    el.replaceChildren(
      h('div', {}, h('b', {}, `${t.done} of ${t.records} records finished`), ` · ${t.sidesSaved} of ${t.sides} sides saved` + (t.sidesWaiting ? ` · ${t.sidesWaiting} recorded and waiting to be split` : '')),
      h('div', { className: 'meter', style: 'margin-top:8px' }, h('div', { style: `width:${t.sides ? t.sidesSaved / t.sides * 100 : 0}%` })),
      h('div', { className: 'row', style: 'margin-top:12px' },
        h('input', { type: 'text', placeholder: 'Find a record: artist or album', value: q, oninput: e => { q = e.target.value; all = false; fill(); } }),
        h('select', { onchange: e => { filter = e.target.value; all = false; fill(); } },
          ...[['all', 'All records'], ['todo', 'Not started'], ['started', 'Part done'], ['done', 'Finished']].map(([v, text]) => h('option', { value: v, selected: v === filter }, text)))),
      h('div', { className: 'dim', style: 'margin-top:6px' }, 'Click a side: a plain one sets it up to record, ● opens it for splitting, ✓ is saved.'),
      h('div', { id: 'catList', style: 'margin-top:8px' }));
    fill();
  }
  async function load() {
    try { data = await api('/api/catalogue'); error = ''; } catch (e) { if (!data) error = e.message; }
    render();
  }
  // The next side of a record that hasn't been recorded, after `side` (or null).
  function nextSide(id, side) {
    const r = data && data.records.find(x => x.id === id);
    if (!r) return null;
    const k = r.sides.findIndex(s => s.side === side), s = r.sides.slice(k + 1).find(x => x.state === 'none');
    return s ? { record: r, side: s.side } : null;
  }
  return { load, nextSide };
})();
