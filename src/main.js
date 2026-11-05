'use strict';

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const glass = require('./glass');
const images = require('./images');
const installer = require('./installer');
const share = require('./share');
const store = require('./store');

const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');
const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;
const COMPACT_HEIGHT = 84;
const DEFAULT_SIZE = { width: 340, height: 480 };
const NOTE_SIZE = { width: 320, height: 380 };
const GHOST_SHORTCUT = 'Control+Alt+G';
// Where the tab chip sits inside a note window, so a torn-off tab stays under the cursor.
const NOTE_CHIP = { x: 12, y: 44 };
// Dropping a note window over the top of the main window (title bar + tabs) re-attaches it.
const ATTACH_ZONE = 92;

app.setPath('userData', process.env.GIVRE_DATA_DIR || path.join(app.getPath('appData'), 'Givre'));
app.setAppUserModelId('fr.givre.app');
images.registerScheme();
// Notes keep painting even when Windows reports them as covered (a fullscreen game, the
// lock screen…): Chromium would otherwise stop drawing them, and could bring them back empty.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win = null; // the main window, with every tab that is not detached
const notes = new Map(); // tab id → detached note window
let tray = null;
let quitting = false;
let hoverTimer = null;
let registeredShortcut = null;
let heightAnim = null;
let tearing = null; // { id, dx, dy } while a tab is being dragged out of the main window
let allHidden = false; // set by "masquer tout" (shortcut / tray), cleared by reveal()
let mainReady = false; // the main renderer has finished init and can take imported notes
const pendingImports = [];
let ownShareCode = null; // last code this Givre copied: never offered back to itself
let offeredShareCode = null; // last clipboard code already offered for import

const allWindows = () => [win, ...notes.values()].filter((w) => w && !w.isDestroyed());
const broadcast = (channel, ...args) => allWindows().forEach((w) => w.webContents.send(channel, ...args));
const plainTab = ({ id, title, color, content }) => ({ id, title, color, content });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--uninstall')) return runUninstall(argv.includes('--quiet'));
    const file = noteFileArg(argv);
    if (file) importFile(file);
    else reveal();
  });
  app.whenReady().then(boot);
}

async function boot() {
  store.load(app.getPath('userData'));
  images.init(app.getPath('userData'));

  // "Installed apps" → Désinstaller runs `Givre.exe --uninstall [--quiet]`.
  if (process.argv.includes('--uninstall')) {
    await installer.uninstall({ quiet: process.argv.includes('--quiet') });
    return quit();
  }
  if (process.argv.includes('--install') && app.isPackaged) {
    try {
      installer.install();
      return relaunchInstalled();
    } catch (err) {
      dialog.showErrorBox('Givre', `Installation impossible : ${err.message}`);
      return quit();
    }
  }

  images.prune(store.data.tabs);
  store.setOnWrite((ok) => broadcast('saved', ok));
  nativeTheme.themeSource = store.data.settings.theme;
  createWindow();
  for (const tab of store.data.tabs) if (tab.detached) createNoteWindow(tab.id, noteBounds(tab.detached));
  createTray();
  registerShortcut(store.data.settings.shortcut);
  try { globalShortcut.register(GHOST_SHORTCUT, toggleGhost); } catch {}
  if (app.isPackaged && store.data.settings.launchAtLogin) syncLoginItem();
  watchHover();
  // Double-clicking a .givre file starts Givre with its path.
  const file = noteFileArg(process.argv);
  if (file) importFile(file);
}

// ─── Shared notes ──────────────────────────────────────────────────────────

const noteFileArg = (argv) => argv.find((a) => /\.givre$/i.test(a) && fs.existsSync(a));

// Hands a received note to the main window, which adds it as a new tab.
function deliverImport(note) {
  if (!note || !win) return false;
  if (!mainReady) {
    pendingImports.push(note); // still starting up: the window shows itself when ready
    return true;
  }
  win.webContents.send('note-imported', note);
  reveal();
  return true;
}

function importFile(file) {
  try {
    if (fs.statSync(file).size > 80 * 1024 * 1024) return false;
    return deliverImport(share.parse(fs.readFileSync(file, 'utf8'), images.save));
  } catch {
    return false;
  }
}

const sharedTab = (t) => ({
  title: String(t?.title ?? '').slice(0, 40),
  color: String(t?.color ?? '#5AC8FA'),
  content: String(t?.content ?? ''),
});

// ─── Windows ───────────────────────────────────────────────────────────────

function intersectsDisplay(b) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 80 && h > 40;
  });
}

function clampToDisplay(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  return {
    ...b,
    x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width)),
    y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height)),
  };
}

function initialBounds() {
  const saved = store.data.bounds;
  const height = store.data.compact ? COMPACT_HEIGHT : null;
  if (saved && intersectsDisplay(saved)) {
    return {
      x: saved.x,
      y: saved.y,
      width: Math.max(MIN_WIDTH, saved.width),
      height: height ?? Math.max(MIN_HEIGHT, saved.height),
    };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - DEFAULT_SIZE.width - 32,
    y: wa.y + 32,
    width: DEFAULT_SIZE.width,
    height: height ?? DEFAULT_SIZE.height,
  };
}

// Shared setup for the main window and note windows: acrylic glass, pin lock, guards.
function buildWindow(bounds, { query, minHeight = MIN_HEIGHT } = {}) {
  const s = store.data.settings;
  const w = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight,
    show: false,
    title: 'Givre',
    icon: ICON,
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: !s.showInTaskbar,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  w.givre = { hovering: false, opacity: 1, fade: null, leave: null, preview: null, previewTimer: null, over: false, closing: false, hang: null };
  w.removeMenu();
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'), query ? { query } : undefined);

  w.on('blur', () => {
    glass.keepActive(w);
    applyOpacity(w);
  });
  w.on('focus', () => applyOpacity(w));
  w.on('show', () => glass.keepActive(w));
  // Pinned: notes stay exactly where they are (only user drags fire these events).
  w.on('will-move', (e) => store.data.settings.pinned && e.preventDefault());
  w.on('will-resize', (e) => store.data.settings.pinned && e.preventDefault());

  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // A note whose page died shows an empty pane forever: replace it (notes are already saved).
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') setImmediate(() => rebuildWindow(w));
  });
  // "Afficher le bureau" (Win + D) would minimise a note that has no taskbar button, with
  // no obvious way back: an always-on-top note simply comes straight back.
  w.on('minimize', () => {
    if (!store.data.settings.alwaysOnTop || quitting) return;
    setTimeout(() => {
      if (w.isDestroyed()) return;
      w.restore();
      glass.keepActive(w);
    }, 60);
  });
  w.webContents.on('unresponsive', () => {
    clearTimeout(w.givre.hang);
    w.givre.hang = setTimeout(() => !w.isDestroyed() && w.webContents.forcefullyCrashRenderer(), 8000);
  });
  w.webContents.on('responsive', () => clearTimeout(w.givre.hang));
  w.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    const f = params.editFlags;
    Menu.buildFromTemplate([
      { label: 'Annuler', role: 'undo', enabled: f.canUndo },
      { label: 'Rétablir', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Couper', role: 'cut', enabled: f.canCut },
      { label: 'Copier', role: 'copy', enabled: f.canCopy },
      { label: 'Coller', role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { label: 'Tout sélectionner', role: 'selectAll' },
    ]).popup({ window: w });
  });
  return w;
}

function whenReady(w, show) {
  w.once('ready-to-show', () => {
    glass.hideSystemBorder(w);
    if (store.data.settings.ghost) w.setIgnoreMouseEvents(true);
    applyOpacity(w, false);
    show(w);
    if (store.data.settings.alwaysOnTop) glass.ensureTopmost(w);
    glass.keepActive(w);
  });
}

function createWindow(bounds = initialBounds()) {
  win = buildWindow(bounds, { minHeight: store.data.compact ? COMPACT_HEIGHT : MIN_HEIGHT });
  if (store.data.compact) win.setMaximumSize(10000, COMPACT_HEIGHT);
  whenReady(win, (w) => (process.argv.includes('--autostart') ? w.showInactive() : w.show()));
  win.on('moved', rememberBounds);
  win.on('resized', rememberBounds);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('session-end', () => {
    quitting = true;
    store.flush();
  });
}

// A note whose display died (page crash, GPU reset) is replaced by a brand-new window at the
// same place — what relaunching Givre used to fix. Reloading the page alone could leave it blank.
let rebuilds = [];

function rebuildWindow(w) {
  if (quitting || !w || w.isDestroyed()) return;
  const now = Date.now();
  rebuilds = rebuilds.filter((t) => now - t < 60_000);
  if (rebuilds.length >= 6) return; // failing in a loop: stop rather than spin
  rebuilds.push(now);
  const bounds = w.getBounds();
  const noteId = [...notes].find(([, nw]) => nw === w)?.[0];
  // The replacement is created first: with no window left, Electron would quit.
  if (noteId) createNoteWindow(noteId, bounds);
  else if (w === win) {
    mainReady = false;
    createWindow(bounds);
  } else return;
  w.givre.closing = true;
  w.destroy();
}

function rebuildAll() {
  for (const w of allWindows()) rebuildWindow(w);
}

function rememberBounds() {
  if (!win || heightAnim) return;
  const b = win.getBounds();
  store.data.bounds = store.data.compact ? { ...b, height: store.data.bounds?.height ?? DEFAULT_SIZE.height } : b;
  store.save();
}

function reveal() {
  if (!win) return;
  allHidden = false;
  for (const w of notes.values()) {
    if (w.isDestroyed()) continue;
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.showInactive();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('focus-editor');
}

function hideAll() {
  allHidden = true;
  for (const w of allWindows()) w.hide();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) hideAll();
  else reveal();
}

// ─── Detached notes ────────────────────────────────────────────────────────

function noteBounds(saved) {
  if (saved && intersectsDisplay(saved)) {
    return { x: saved.x, y: saved.y, width: Math.max(MIN_WIDTH, saved.width), height: Math.max(MIN_HEIGHT, saved.height) };
  }
  return besideMain();
}

function besideMain() {
  const m = win.getBounds();
  const wa = screen.getDisplayMatching(m).workArea;
  const x = m.x - NOTE_SIZE.width - 16 >= wa.x ? m.x - NOTE_SIZE.width - 16 : m.x + m.width + 16;
  return clampToDisplay({ x, y: m.y + 36, ...NOTE_SIZE });
}

function overAttachZone() {
  if (!win || !win.isVisible()) return false;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + ATTACH_ZONE;
}

function createNoteWindow(tabId, bounds) {
  const w = buildWindow(bounds, { query: { note: tabId } });
  notes.set(tabId, w);
  whenReady(w, (nw) => (allHidden ? null : nw.showInactive()));

  const isTearing = () => tearing?.id === tabId;
  w.on('resized', () => store.setDetached(tabId, w.getBounds()));
  w.on('move', () => {
    if (isTearing()) return;
    const over = overAttachZone();
    if (over === w.givre.over) return;
    w.givre.over = over;
    win?.webContents.send('attach-hint', over);
  });
  w.on('moved', () => {
    if (isTearing()) return;
    if (w.givre.over) {
      w.givre.over = false;
      win?.webContents.send('attach-hint', false);
      attachTab(tabId, screen.getCursorScreenPoint().x);
    } else {
      store.setDetached(tabId, w.getBounds());
    }
  });
  // Closing a note never loses it: it goes back into the main window as a tab.
  w.on('close', (e) => {
    if (quitting || w.givre.closing) return;
    e.preventDefault();
    attachTab(tabId, null);
  });
  w.on('closed', () => {
    if (notes.get(tabId) === w) notes.delete(tabId);
  });
  return w;
}

function attachTab(tabId, screenX) {
  const tab = store.tab(tabId);
  if (!tab?.detached) return;
  store.setDetached(tabId, null);
  const w = notes.get(tabId);
  notes.delete(tabId);
  if (w && !w.isDestroyed()) {
    w.givre.closing = true;
    w.close();
  }
  if (!win) return;
  win.webContents.send('tab-attached', plainTab(tab), screenX == null ? null : screenX - win.getBounds().x);
  if (!win.isVisible()) reveal();
}

// ─── Compact (rolled-up) main window ───────────────────────────────────────

function animateHeight(to, done) {
  clearInterval(heightAnim);
  const from = win.getBounds().height;
  const t0 = Date.now();
  const duration = 180;
  heightAnim = setInterval(() => {
    const t = Math.min(1, (Date.now() - t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.round(from + (to - from) * eased) });
    if (t === 1) {
      clearInterval(heightAnim);
      heightAnim = null;
      done?.();
    }
  }, 12);
}

function setCompact(on) {
  if (!win || on === store.data.compact) return store.data.compact;
  const b = win.getBounds();
  if (on) {
    store.data.bounds = b;
    store.data.compact = true;
    win.setMinimumSize(MIN_WIDTH, COMPACT_HEIGHT);
    animateHeight(COMPACT_HEIGHT, () => win.setMaximumSize(10000, COMPACT_HEIGHT));
  } else {
    store.data.compact = false;
    const wa = screen.getDisplayMatching(b).workArea;
    const target = Math.min(Math.max(MIN_HEIGHT, store.data.bounds?.height ?? DEFAULT_SIZE.height), wa.y + wa.height - b.y);
    win.setMaximumSize(10000, 10000);
    animateHeight(Math.max(MIN_HEIGHT, target), () => win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT));
  }
  store.save();
  win.webContents.send('compact', store.data.compact);
  return store.data.compact;
}

// ─── Opacity, discreet & ghost modes (per window) ──────────────────────────

function targetOpacity(w) {
  const s = store.data.settings;
  const g = w.givre;
  if (g.preview != null) return g.preview;
  // Ghost: clicks go through, and the note clears out of the way under the cursor.
  if (s.ghost && g.hovering) return Math.max(0.12, s.opacity * 0.28);
  const idle = s.discreet && !g.hovering && !w.isFocused();
  return idle ? Math.min(s.opacity, s.restOpacity) : s.opacity;
}

function applyOpacity(w, animate = true) {
  if (!w || w.isDestroyed()) return;
  const g = w.givre;
  const to = targetOpacity(w);
  clearInterval(g.fade);
  if (!animate) {
    g.opacity = to;
    w.setOpacity(to);
    return;
  }
  const from = g.opacity;
  const t0 = Date.now();
  const duration = to < from ? 420 : 160;
  g.fade = setInterval(() => {
    if (w.isDestroyed()) return clearInterval(g.fade);
    const t = Math.min(1, (Date.now() - t0) / duration);
    g.opacity = from + (to - from) * (1 - Math.pow(1 - t, 3));
    w.setOpacity(g.opacity);
    if (t === 1) clearInterval(g.fade);
  }, 16);
}

const applyOpacityAll = (animate) => allWindows().forEach((w) => applyOpacity(w, animate));

function applyGhost(on) {
  for (const w of allWindows()) w.setIgnoreMouseEvents(on);
  applyOpacityAll();
}

function toggleGhost() {
  setSetting('ghost', !store.data.settings.ghost);
}

// The cursor is polled rather than taken from DOM events: drag regions
// (title bar) are non-client areas and would read as "mouse left".
// Every second the same loop also checks that notes are still really on top.
function watchHover() {
  let tick = 0;
  hoverTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const checkTop = store.data.settings.alwaysOnTop && ++tick % 8 === 0;
    for (const w of allWindows()) {
      if (!w.isVisible()) continue;
      if (checkTop) glass.ensureTopmost(w);
      const b = w.getBounds();
      const g = w.givre;
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (inside === g.hovering) continue;
      g.hovering = inside;
      w.webContents.send('hover', inside);
      clearTimeout(g.leave);
      if (inside) applyOpacity(w);
      else g.leave = setTimeout(() => applyOpacity(w), store.data.settings.ghost ? 150 : 900);
    }
  }, 120);
}

// ─── Settings ──────────────────────────────────────────────────────────────

function syncLoginItem() {
  const args = app.isPackaged ? ['--autostart'] : [app.getAppPath(), '--autostart'];
  app.setLoginItemSettings({ openAtLogin: store.data.settings.launchAtLogin, path: process.execPath, args });
}

function registerShortcut(accelerator) {
  const previous = registeredShortcut;
  if (previous) globalShortcut.unregister(previous);
  registeredShortcut = null;
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, toggleWindow);
  } catch {
    ok = false;
  }
  if (ok) {
    registeredShortcut = accelerator;
    return true;
  }
  if (previous) {
    try {
      if (globalShortcut.register(previous, toggleWindow)) registeredShortcut = previous;
    } catch {}
  }
  return false;
}

const APPLY = {
  alwaysOnTop: (v) => allWindows().forEach((w) => w.setAlwaysOnTop(v, 'floating')),
  opacity: () => applyOpacityAll(false),
  restOpacity: () => applyOpacityAll(),
  discreet: () => applyOpacityAll(),
  ghost: (v) => applyGhost(v),
  theme: (v) => { nativeTheme.themeSource = v; },
  showInTaskbar: (v) => allWindows().forEach((w) => w.setSkipTaskbar(!v)),
  launchAtLogin: () => syncLoginItem(),
};

// `origin` is the window that made the change: it already shows it, and echoing
// settings back to it while a slider is being dragged would fight the drag.
function setSetting(key, raw, origin = null) {
  const s = store.data.settings;
  const value = store.cleanSetting(key, raw);
  if (value === undefined) return { ok: false, settings: s };
  if (key === 'shortcut' && value !== registeredShortcut && !registerShortcut(value)) {
    return { ok: false, error: 'Ce raccourci est déjà utilisé par une autre application.', settings: s };
  }
  s[key] = value;
  APPLY[key]?.(value);
  store.save();
  refreshTrayMenu();
  for (const w of allWindows()) if (w.webContents !== origin) w.webContents.send('settings', s);
  return { ok: true, settings: s };
}

// ─── Tray ──────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Givre');
  tray.on('click', () => (win?.isVisible() ? hideAll() : reveal()));
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = store.data.settings;
  const toggle = (key) => (item) => setSetting(key, item.checked);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher Givre', click: reveal },
    { label: 'Nouvel onglet', click: () => { reveal(); win.webContents.send('new-tab'); } },
    { type: 'separator' },
    { label: 'Mode fantôme (Ctrl+Alt+G)', type: 'checkbox', checked: s.ghost, click: toggle('ghost') },
    { label: 'Épinglé (position verrouillée)', type: 'checkbox', checked: s.pinned, click: toggle('pinned') },
    { label: 'Toujours au premier plan', type: 'checkbox', checked: s.alwaysOnTop, click: toggle('alwaysOnTop') },
    { label: 'Mode discret', type: 'checkbox', checked: s.discreet, click: toggle('discreet') },
    { label: 'Lancer au démarrage', type: 'checkbox', checked: s.launchAtLogin, click: toggle('launchAtLogin') },
    { type: 'separator' },
    { label: 'Réparer l’affichage', click: () => { rebuildAll(); reveal(); } },
    { label: 'Quitter Givre', click: quit },
  ]));
}

function quit() {
  quitting = true;
  app.quit();
}

// Hands over to the freshly installed copy: free the lock, hotkeys and tray first.
function relaunchInstalled() {
  store.flush();
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  app.releaseSingleInstanceLock();
  const exe = installer.installedExe();
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  quit();
}

async function runUninstall(quiet) {
  if (await installer.uninstall({ quiet })) quit();
}

// ─── IPC ───────────────────────────────────────────────────────────────────

const isMain = (e) => Boolean(win) && e.sender === win.webContents;

function contextOf(sender) {
  if (win && sender === win.webContents) return { w: win, noteId: null };
  for (const [id, w] of notes) if (!w.isDestroyed() && w.webContents === sender) return { w, noteId: id };
  return null;
}

ipcMain.handle('state:get', (e) => {
  const ctx = contextOf(e.sender);
  if (!ctx) return null;
  const base = { settings: store.data.settings, hovering: ctx.w.givre.hovering, version: app.getVersion() };
  if (ctx.noteId) {
    const tab = store.tab(ctx.noteId);
    return { ...base, note: true, tabs: tab ? [plainTab(tab)] : [], activeTabId: ctx.noteId, compact: false };
  }
  const { activeTabId, compact } = store.data;
  return { ...base, tabs: store.mainTabs().map(plainTab), activeTabId, compact, install: installer.status() };
});
ipcMain.on('tabs:save', (e, payload) => {
  const ctx = contextOf(e.sender);
  if (!ctx) return;
  if (ctx.noteId) store.updateTab(ctx.noteId, payload?.tabs?.[0]);
  else store.setMainTabs(payload);
  if (quitting) store.flush();
});
ipcMain.handle('settings:set', (e, key, value) => (contextOf(e.sender) ? setSetting(key, value, e.sender) : null));
// Live preview of "Opacité au repos" while its slider moves. It expires on its own,
// so a drag that never reports its end can't leave the window stuck at that opacity.
ipcMain.on('window:preview-opacity', (e, value) => {
  const ctx = contextOf(e.sender);
  if (!ctx) return;
  const g = ctx.w.givre;
  clearTimeout(g.previewTimer);
  g.preview = value == null ? null : Math.min(1, Math.max(0.05, Number(value) || 1));
  if (g.preview != null) {
    g.previewTimer = setTimeout(() => {
      g.preview = null;
      applyOpacity(ctx.w);
    }, 1200);
  }
  applyOpacity(ctx.w, false);
});
ipcMain.handle('window:compact', (e, on) => (isMain(e) ? setCompact(Boolean(on)) : null));
ipcMain.on('window:hide', (e) => {
  if (!isMain(e)) return;
  store.flush();
  win.hide();
});

// Tear-off: the main window drags a tab out, and a note window follows the cursor.
ipcMain.handle('note:detach', (e, tabData, point) => {
  if (!isMain(e)) return false;
  const tab = store.tab(tabData?.id);
  if (!tab || tab.detached || store.mainTabs().length < 2) return false;
  store.updateTab(tab.id, tabData);
  let bounds;
  if (point) {
    const dx = point.grabX + NOTE_CHIP.x;
    const dy = point.grabY + NOTE_CHIP.y;
    tearing = { id: tab.id, dx, dy };
    bounds = { x: Math.round(point.screenX - dx), y: Math.round(point.screenY - dy), ...NOTE_SIZE };
  } else {
    bounds = besideMain();
  }
  store.setDetached(tab.id, bounds);
  const w = createNoteWindow(tab.id, bounds);
  if (!point) w.once('ready-to-show', () => w.focus());
  return true;
});
ipcMain.on('note:tear-move', (e, screenX, screenY) => {
  if (!isMain(e) || !tearing) return;
  const w = notes.get(tearing.id);
  if (w && !w.isDestroyed()) w.setPosition(Math.round(screenX - tearing.dx), Math.round(screenY - tearing.dy));
});
ipcMain.on('note:tear-end', (e, dropOnTabs, screenX) => {
  if (!isMain(e) || !tearing) return;
  const { id } = tearing;
  tearing = null;
  if (dropOnTabs) return attachTab(id, screenX);
  const w = notes.get(id);
  if (!w || w.isDestroyed()) return;
  store.setDetached(id, clampToDisplay(w.getBounds()));
  w.setBounds(store.tab(id).detached);
  if (w.isVisible()) w.focus();
  else w.once('ready-to-show', () => w.focus());
});
ipcMain.on('note:attach', (e) => {
  const ctx = contextOf(e.sender);
  if (ctx?.noteId) attachTab(ctx.noteId, null);
});

ipcMain.on('window:ready', (e) => {
  if (!isMain(e)) return;
  mainReady = true;
  for (const note of pendingImports.splice(0)) win.webContents.send('note-imported', note);
});

// Sharing: a code on the clipboard (text only) or a .givre file (with images).
// Electron 45's clipboard API is asynchronous: every call must be awaited.
ipcMain.handle('share:copy', async (e, raw) => {
  if (!contextOf(e.sender)) return null;
  const tab = sharedTab(raw);
  const { code, hadImages, tooLong } = share.toCode(tab);
  if (tooLong) return { ok: false, tooLong: true };
  await clipboard.writeText(share.message(tab, code));
  ownShareCode = code;
  return { ok: true, hadImages };
});
ipcMain.handle('share:export', async (e, raw) => {
  const ctx = contextOf(e.sender);
  if (!ctx) return null;
  const tab = sharedTab(raw);
  const name = (tab.title || 'Note').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Note';
  const { canceled, filePath } = await dialog.showSaveDialog(ctx.w, {
    title: 'Partager la note',
    defaultPath: path.join(app.getPath('desktop'), `${name}.givre`),
    filters: [{ name: 'Note Givre', extensions: ['givre'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, share.toFile(tab, images.read), 'utf8');
  return { ok: true, file: path.basename(filePath) };
});
ipcMain.handle('share:import', (e, text) => (contextOf(e.sender) ? deliverImport(share.parse(text, images.save)) : false));
ipcMain.handle('share:open', async (e) => {
  const ctx = contextOf(e.sender);
  if (!ctx) return false;
  const { canceled, filePaths } = await dialog.showOpenDialog(ctx.w, {
    title: 'Importer une note',
    filters: [{ name: 'Note Givre', extensions: ['givre'] }],
    properties: ['openFile'],
  });
  return !canceled && filePaths[0] ? importFile(filePaths[0]) : false;
});
// When Givre gets focus with a friend's code on the clipboard, it offers to add it (once).
ipcMain.handle('share:peek', async (e) => {
  if (!isMain(e)) return null;
  const code = share.findCode(await clipboard.readText());
  if (!code || code === ownShareCode || code === offeredShareCode) return null;
  offeredShareCode = code;
  const note = share.fromCode(code);
  return note ? { title: note.title, code } : null;
});

ipcMain.on('app:open-data', (e) => isMain(e) && shell.openPath(app.getPath('userData')));
ipcMain.on('app:quit', (e) => isMain(e) && quit());
ipcMain.handle('image:save', (e, bytes, type) => (contextOf(e.sender) ? images.save(bytes, type) : null));
ipcMain.on('image:open', (e, url) => {
  const file = contextOf(e.sender) && images.fileFor(url);
  if (file) shell.openPath(file);
});
ipcMain.handle('app:install', (e) => {
  if (!isMain(e)) return null;
  try {
    installer.install();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  setTimeout(relaunchInstalled, 900);
  return { ok: true };
});
ipcMain.on('app:uninstall', (e) => isMain(e) && runUninstall(false));

// The GPU process restarts on its own, but glass windows can come back blank: rebuild them.
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && !quitting) setTimeout(rebuildAll, 800);
});

app.on('before-quit', () => {
  quitting = true;
  store.flush();
});
app.on('will-quit', () => {
  clearInterval(hoverTimer);
  globalShortcut.unregisterAll();
  store.flush();
});
app.on('window-all-closed', () => app.quit());
