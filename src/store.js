'use strict';

// Persistent state: a single JSON file in %APPDATA%\Givre, written atomically
// (temp file + rename) with the previous version kept as a .bak. Writes are
// throttled, not debounced: while typing, the file is rewritten every 150 ms.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  alwaysOnTop: true,
  pinned: false,
  ghost: false,
  opacity: 1,
  frost: 0.42,
  theme: 'system',
  fontSize: 15,
  highlight: 'yellow',
  discreet: false,
  restOpacity: 0.35,
  showInTaskbar: false,
  launchAtLogin: false,
  shortcut: 'Control+Alt+N',
};

const SETTING_RULES = {
  alwaysOnTop: 'bool',
  pinned: 'bool',
  ghost: 'bool',
  discreet: 'bool',
  showInTaskbar: 'bool',
  launchAtLogin: 'bool',
  opacity: [0.25, 1],
  restOpacity: [0.08, 0.9],
  frost: [0, 0.92],
  fontSize: [12, 22],
  theme: ['system', 'light', 'dark'],
  highlight: ['yellow', 'green', 'pink', 'blue', 'orange'],
  shortcut: 'string',
};

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_CONTENT = 2_000_000;

let file = null;
let timer = null;
let onWrite = null;
const data = {
  settings: { ...DEFAULT_SETTINGS },
  bounds: null,
  compact: false,
  activeTabId: null,
  tabs: [],
};

const uid = () => crypto.randomBytes(6).toString('hex');

function welcomeTabs() {
  const memo = {
    id: uid(),
    title: 'Mémo',
    color: '#5AC8FA',
    content:
      '<div class="h">Bienvenue dans Givre</div>' +
      '<div>Ton aide-mémoire, toujours à portée d’œil.</div>' +
      '<div class="todo" data-checked="true">Taper [ ] puis espace pour une case à cocher</div>' +
      '<div class="todo" data-checked="false">Clic droit sur un onglet pour changer sa couleur</div>' +
      '<div class="todo" data-checked="false">Ctrl + Alt + N pour afficher ou masquer Givre</div>' +
      '<div class="bullet">La punaise en haut épingle la note : elle ne bouge plus</div>' +
      '<div class="bullet">« - » puis espace pour une liste, « # » pour un titre</div>' +
      '<div class="bullet">Réglages ⚙ pour l’opacité, le givrage et le thème</div>',
  };
  return [
    memo,
    { id: uid(), title: 'À faire', color: '#F472B6', content: '' },
    { id: uid(), title: 'Idées', color: '#34D399', content: '' },
  ];
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try { fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`); } catch {}
    }
    return null;
  }
}

function cleanSetting(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule) return undefined;
  if (rule === 'bool') return typeof value === 'boolean' ? value : undefined;
  if (rule === 'string') return typeof value === 'string' && value.length < 64 ? value : undefined;
  if (typeof rule[0] === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(rule[1], Math.max(rule[0], n)) : undefined;
  }
  return rule.includes(value) ? value : undefined;
}

const cleanBounds = (b) => (b && [b.x, b.y, b.width, b.height].every(Number.isFinite)
  ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
  : null);

// A tab with `detached` bounds lives in its own note window instead of the main one.
function cleanTabs(list, { keepDetached = false } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const tabs = [];
  for (const t of list) {
    if (!t || typeof t.id !== 'string' || seen.has(t.id)) continue;
    seen.add(t.id);
    const tab = {
      id: t.id.slice(0, 32),
      title: String(t.title ?? '').slice(0, 40),
      color: COLOR_RE.test(t.color) ? t.color : '#5AC8FA',
      content: typeof t.content === 'string' ? t.content.slice(0, MAX_CONTENT) : '',
    };
    const detached = keepDetached && cleanBounds(t.detached);
    if (detached) tab.detached = detached;
    tabs.push(tab);
  }
  return tabs;
}

function load(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'notes.json');
  const raw = readJson(file) ?? readJson(`${file}.bak`) ?? {};

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = cleanSetting(key, raw.settings?.[key]);
    if (v !== undefined) data.settings[key] = v;
  }
  data.bounds = cleanBounds(raw.bounds);
  data.compact = raw.compact === true;
  data.tabs = cleanTabs(raw.tabs, { keepDetached: true });
  if (!data.tabs.length) data.tabs = welcomeTabs();
  // The main window always keeps at least one tab.
  if (!mainTabs().length) delete data.tabs[0].detached;
  data.activeTabId = mainTabs().some((t) => t.id === raw.activeTabId) ? raw.activeTabId : mainTabs()[0].id;
  return data;
}

function writeNow() {
  clearTimeout(timer);
  timer = null;
  if (!file) return;
  const tmp = `${file}.tmp`;
  let ok = true;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
  } catch (err) {
    ok = false;
    console.error('[givre] save failed:', err);
  }
  onWrite?.(ok);
}

function save() {
  if (!timer) timer = setTimeout(writeNow, 150);
}

function setOnWrite(fn) {
  onWrite = fn;
}

function flush() {
  if (timer) writeNow();
}

const tab = (id) => data.tabs.find((t) => t.id === id) ?? null;
const mainTabs = () => data.tabs.filter((t) => !t.detached);

// The main window owns the order and content of its tabs; detached tabs are
// kept as they are (a late save from the main window can't swallow them).
function setMainTabs(payload) {
  const detached = data.tabs.filter((t) => t.detached);
  const detachedIds = new Set(detached.map((t) => t.id));
  const incoming = cleanTabs(payload?.tabs).filter((t) => !detachedIds.has(t.id));
  if (!incoming.length) return;
  data.tabs = [...incoming, ...detached];
  if (incoming.some((t) => t.id === payload.activeTabId)) data.activeTabId = payload.activeTabId;
  save();
}

function updateTab(id, fields) {
  const target = tab(id);
  const [clean] = cleanTabs([{ ...fields, id }]);
  if (!target || !clean) return;
  Object.assign(target, { title: clean.title, color: clean.color, content: clean.content });
  save();
}

function setDetached(id, bounds) {
  const target = tab(id);
  if (!target) return;
  const clean = cleanBounds(bounds);
  if (clean) target.detached = clean;
  else delete target.detached;
  save();
}

module.exports = { data, load, save, flush, setOnWrite, cleanSetting, tab, mainTabs, setMainTabs, updateTab, setDetached };
