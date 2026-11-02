// The Theme screen: pick a preset or one of your saved themes, then tweak any color,
// the brightness and the paper texture. Changes apply live; the game behind the panel
// shows a moving preview so you can judge it in play.

import { themes, PRESETS } from './themes.js';

const $ = (sel) => document.querySelector(sel);

const COLORS = [
  { group: 'Screen', items: [
    ['bg', 'Background'], ['surface', 'Highway'], ['cap', 'Keys & panels'],
    ['ink', 'Text & lines'], ['accent', 'Accent'], ['missed', 'Missed notes'],
  ] },
  { group: 'Highway lanes', items: [0, 1, 2, 3, 4].map((i) => [`lanes.${i}`, 'DFJKL'[i]]) },
  { group: 'Drum', items: [['don', 'Don (center)'], ['ka', 'Ka (rim)'], ['roll', 'Drumroll'], ['wood', 'Drum body']] },
];

const get = (t, key) => (key.startsWith('lanes.') ? t.lanes[+key.slice(6)] : t[key]);
function set(t, key, v) {
  if (key.startsWith('lanes.')) { t.lanes = [...t.lanes]; t.lanes[+key.slice(6)] = v; } else t[key] = v;
}

export function initThemePanel(game) {
  const list = $('#theme-list');
  const colors = $('#theme-colors');
  const bright = $('#t-brightness'), grain = $('#t-grain');

  // Editing a preset turns it into an unsaved custom theme (the preset itself never changes).
  const edit = (fn) => {
    const t = { ...themes.current, lanes: [...themes.current.lanes] };
    fn(t);
    if (!t.id.startsWith('custom')) { t.id = 'custom'; t.name = `${themes.current.name} (edited)`; }
    themes.use(t);
  };

  // Color inputs fire on every drag step; apply at most once per frame.
  let pending = null;
  const editSoon = (fn) => {
    const first = !pending;
    pending = fn;
    if (first) requestAnimationFrame(() => { const f = pending; pending = null; edit(f); });
  };

  // ---- color pickers ----
  for (const { group, items } of COLORS) {
    const h = document.createElement('h3');
    h.textContent = group;
    colors.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'swatches' + (group === 'Highway lanes' ? ' lanes' : '');
    for (const [key, label] of items) {
      const lab = document.createElement('label');
      lab.className = 'swatch';
      const input = document.createElement('input');
      input.type = 'color';
      input.dataset.key = key;
      input.addEventListener('input', () => editSoon((t) => set(t, key, input.value)));
      const span = document.createElement('span');
      span.textContent = label;
      lab.append(input, span);
      grid.appendChild(lab);
    }
    colors.appendChild(grid);
  }

  bright.addEventListener('input', () => editSoon((t) => { t.brightness = bright.value / 100; }));
  const scenBtn = $('#t-scenery'), scenStrength = $('#t-scenery-strength');
  scenBtn.addEventListener('click', () => themes.setScenery({ on: !themes.scenery.on }));
  scenStrength.addEventListener('input', () => themes.setScenery({ on: true, strength: scenStrength.value / 100 }));
  grain.addEventListener('input', () => editSoon((t) => { t.grain = grain.value / 100; }));

  // ---- preset / saved list ----
  const renderList = () => {
    list.innerHTML = '';
    const cur = themes.current;
    const all = [...themes.all()];
    if (cur.id === 'custom') all.push(cur); // unsaved edits show as their own card
    for (const t of all) {
      const card = document.createElement('button');
      card.className = 'theme-card' + (t.id === cur.id ? ' active' : '');
      card.style.setProperty('--c-bg', t.bg);
      card.style.setProperty('--c-surface', t.surface);
      card.style.setProperty('--c-ink', t.ink);
      card.style.setProperty('--c-accent', t.accent);
      card.innerHTML = '<span class="tc-preview"><span class="tc-lanes"></span></span><span class="tc-name"></span>';
      const lanes = card.querySelector('.tc-lanes');
      for (const c of t.lanes) {
        const dot = document.createElement('i');
        dot.style.background = c;
        lanes.appendChild(dot);
      }
      card.querySelector('.tc-name').textContent = t.name;
      card.title = PRESETS.find((p) => p.id === t.id)?.note || (t.id === 'custom' ? 'Not saved yet' : 'Your theme');
      card.addEventListener('click', () => themes.use(t));
      if (t.id.startsWith('custom-')) {
        const x = document.createElement('span');
        x.className = 'tc-remove';
        x.textContent = '×';
        x.title = 'Delete this theme';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Delete the theme "${t.name}"?`)) return;
          themes.remove(t.id);
          if (cur.id === t.id) themes.use({ ...cur, id: 'custom' });
          else renderList();
        });
        card.appendChild(x);
      }
      list.appendChild(card);
    }
  };

  // Keep the controls in step with whatever theme is active.
  const sync = () => {
    const t = themes.current;
    for (const input of colors.querySelectorAll('input[type="color"]')) input.value = get(t, input.dataset.key);
    bright.value = Math.round(t.brightness * 100);
    grain.value = Math.round(t.grain * 100);
    $('#t-brightness-label').textContent = `${bright.value}%`;
    $('#t-grain-label').textContent = `${grain.value}%`;
    const sc = themes.scenery;
    scenBtn.textContent = sc.on ? 'On' : 'Off';
    scenBtn.setAttribute('aria-pressed', String(sc.on));
    scenStrength.value = Math.round(sc.strength * 100);
    scenStrength.disabled = !sc.on;
    $('#t-scenery-label').textContent = sc.on ? `${scenStrength.value}%` : 'off';
    $('#theme-label').textContent = t.name;
    $('#t-save').textContent = t.id === 'custom' ? 'Save this theme' : 'Save a copy';
    renderList();
  };
  themes.onChange(sync);
  sync();

  // ---- buttons ----
  $('#open-theme').addEventListener('click', () => game.openThemes());
  $('#t-done').addEventListener('click', () => game.closeThemes());
  for (const b of document.querySelectorAll('#t-preview button')) {
    b.addEventListener('click', () => $(`#modes button[data-mode="${b.dataset.mode}"]`).click());
  }
  $('#t-save').addEventListener('click', () => {
    const base = themes.current.name.replace(/ \(edited\)$/, '');
    const name = prompt('Name this theme:', themes.current.id === 'custom' ? `My ${base}` : `${base} copy`);
    if (name != null) themes.saveAs(name);
  });
  $('#t-export').addEventListener('click', async () => {
    const { id, ...data } = themes.current;
    const code = JSON.stringify(data);
    try {
      await navigator.clipboard.writeText(code);
      flash('Theme code copied. Paste it into Import on any browser.');
    } catch {
      prompt('Copy this theme code:', code);
    }
  });
  $('#t-import').addEventListener('click', () => {
    const code = prompt('Paste a theme code:');
    if (!code) return;
    try {
      const t = JSON.parse(code);
      if (!t || typeof t !== 'object' || !t.bg) throw new Error('not a theme');
      themes.use({ ...t, id: 'custom', name: t.name ? `${t.name}` : 'Imported theme' });
      flash('Theme imported. Save it to keep it in your list.');
    } catch {
      flash("That doesn't look like a KySync theme code.");
    }
  });

  let flashTimer = 0;
  function flash(text) {
    const el = $('#t-status');
    el.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }
}
