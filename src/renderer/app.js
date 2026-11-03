'use strict';

(() => {
  const api = window.givre;

  const PALETTE = [
    ['Glacier', '#5AC8FA'], ['Océan', '#4F7CFF'], ['Lavande', '#A78BFA'], ['Orchidée', '#E879F9'], ['Rose', '#F472B6'],
    ['Corail', '#FB7185'], ['Pêche', '#FB923C'], ['Ambre', '#FBBF24'], ['Menthe', '#34D399'], ['Ardoise', '#94A3B8'],
  ];
  const BLOCK_TYPES = ['todo', 'bullet', 'h'];
  const MARKDOWN = [
    [/^\[\s?\]$/, 'todo', false],
    [/^\[[xX]\]$/, 'todo', true],
    [/^[-*•]$/, 'bullet'],
    [/^#$/, 'h'],
  ];
  const RING = 47.12;
  // Marker colours as stored in the note (Chromium inline style) → swatch shown in the dock.
  // styles.css restyles each stored value with a theme-aware tint.
  const HL = {
    yellow: 'rgb(255, 221, 87)',
    green: 'rgb(93, 220, 160)',
    pink: 'rgb(245, 140, 195)',
    blue: 'rgb(120, 200, 250)',
    orange: 'rgb(252, 165, 95)',
  };
  const HL_SWATCH = { yellow: '#FFC800', green: '#2ECF8F', pink: '#F06AB4', blue: '#3FA9F5', orange: '#FF8A2A' };
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]}»]/gi;
  // Characters an inline calculation (`400*3/2=`) may contain.
  const CALC_CHAR = /[0-9.,+\-*/x×÷^%()  ]/;
  // A detached note window shows a single tab (?note=<id>).
  const IS_NOTE = new URLSearchParams(location.search).has('note');

  const $ = (sel) => document.querySelector(sel);
  const el = {
    app: $('#app'),
    tabs: $('#tabs'),
    sheet: $('#sheet'),
    editor: $('#editor'),
    dock: $('#dock'),
    hlMenu: $('#hlMenu'),
    status: $('#status'),
    statusText: $('#statusText'),
    progress: $('#progress'),
    progressBar: $('#progressBar'),
    progressText: $('#progressText'),
    toast: $('#toast'),
    toastText: $('#toastText'),
    toastAction: $('#toastAction'),
    menu: $('#tabMenu'),
    tabName: $('#tabName'),
    swatches: $('#swatches'),
    hueRow: $('#hueRow'),
    hue: $('#hue'),
    settings: $('#settings'),
    pin: $('#btnPin'),
    shortcut: $('#setShortcut'),
    shortcutHint: $('#shortcutHint'),
    ghost: $('#btnGhost'),
    lightbox: $('#lightbox'),
    lightboxImg: $('#lightboxImg'),
  };

  const state = { tabs: [], activeId: null, settings: {}, compact: false, hovering: false };
  const scrollMemory = new Map();
  let awaitingWrite = false;
  let lastGhost = null;
  let statusTimer = null;
  let toastTimer = null;
  let menuTabId = null;
  let drag = null;
  let recording = false;
  let lensKey = '';
  let internalDrag = false;

  const uid = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
  const tabById = (id) => state.tabs.find((t) => t.id === id);
  const activeTab = () => tabById(state.activeId) ?? state.tabs[0];
  const tabEl = (id) => el.tabs.querySelector(`.tab[data-id="${CSS.escape(id)}"]`);
  const sameColor = (a, b) => a.toLowerCase() === b.toLowerCase();

  // ─── Persistence ─────────────────────────────────────────────────────────

  function commitEditor() {
    const tab = activeTab();
    if (!tab) return;
    tab.content = isEditorEmpty() ? '' : el.editor.innerHTML;
  }

  function persist() {
    commitEditor();
    api.saveTabs(state.tabs, state.activeId);
  }

  // Every edit is sent right away; the indicator waits for the main process to
  // confirm the write actually reached the disk.
  function saveEdit() {
    persist();
    awaitingWrite = true;
  }

  function showSaved(ok) {
    if (!awaitingWrite && ok) return;
    awaitingWrite = false;
    el.status.classList.toggle('error', !ok);
    el.statusText.textContent = ok ? 'Enregistré' : 'Échec de l’enregistrement';
    el.status.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.status.classList.remove('show'), ok ? 1400 : 5000);
  }

  // ─── Tabs ────────────────────────────────────────────────────────────────

  function renderTabs({ entering } = {}) {
    const frag = document.createDocumentFragment();
    for (const tab of state.tabs) {
      const node = document.createElement('div');
      node.className = 'tab';
      node.dataset.id = tab.id;
      node.setAttribute('role', 'tab');
      node.title = tab.title;
      node.style.setProperty('--c', tab.color);
      if (tab.id === entering) node.classList.add('enter');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = tab.title || 'Sans titre';
      node.append(dot, label);
      frag.append(node);
    }
    el.tabs.replaceChildren(frag);
    markActiveTab();
  }

  function markActiveTab() {
    for (const node of el.tabs.children) {
      const on = node.dataset.id === state.activeId;
      node.classList.toggle('active', on);
      node.setAttribute('aria-selected', String(on));
      node.tabIndex = on ? 0 : -1;
    }
    updateTabOverflow();
  }

  function updateTabOverflow() {
    const t = el.tabs;
    t.classList.toggle('overflow-l', t.scrollLeft > 2);
    t.classList.toggle('overflow-r', t.scrollLeft + t.clientWidth < t.scrollWidth - 2);
  }

  function revealActiveTab() {
    tabEl(state.activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function selectTab(id) {
    if (!tabById(id)) return;
    if (id !== state.activeId) {
      commitEditor();
      scrollMemory.set(state.activeId, el.sheet.scrollTop);
      state.activeId = id;
      closeTabMenu();
      markActiveTab();
      loadEditor(true);
      persist();
    }
    if (state.compact) setCompact(false);
    revealActiveTab();
  }

  function cycleTab(step) {
    const i = state.tabs.findIndex((t) => t.id === state.activeId);
    const n = state.tabs.length;
    selectTab(state.tabs[(i + step + n) % n].id);
  }

  function makeTab() {
    const used = new Set(state.tabs.map((t) => t.color.toLowerCase()));
    const free = PALETTE.find(([, hex]) => !used.has(hex.toLowerCase()));
    const color = (free ?? PALETTE[state.tabs.length % PALETTE.length])[1];
    return { id: uid(), title: 'Nouvelle note', color, content: '' };
  }

  function insertTab(tab, { rename = false } = {}) {
    commitEditor();
    closeOverlays();
    scrollMemory.set(state.activeId, el.sheet.scrollTop);
    const index = state.tabs.findIndex((t) => t.id === state.activeId) + 1;
    state.tabs.splice(index, 0, tab);
    state.activeId = tab.id;
    if (state.compact) setCompact(false);
    renderTabs({ entering: tab.id });
    loadEditor(true);
    persist();
    requestAnimationFrame(() => {
      revealActiveTab();
      if (rename) startRename(tab.id);
    });
  }

  const addTab = () => insertTab(makeTab(), { rename: true });

  function duplicateTab(id) {
    commitEditor();
    const tab = tabById(id);
    if (tab) insertTab({ ...tab, id: uid(), title: `${tab.title} (copie)`.slice(0, 40) });
  }

  function deleteTab(id) {
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    commitEditor();
    closeTabMenu();
    const [removed] = state.tabs.splice(index, 1);
    const wasActive = removed.id === state.activeId;
    const filler = state.tabs.length ? null : makeTab();
    if (filler) state.tabs.push(filler);
    if (wasActive) state.activeId = state.tabs[Math.min(index, state.tabs.length - 1)].id;
    renderTabs();
    if (wasActive) loadEditor(true);
    persist();

    toast(`« ${removed.title || 'Sans titre'} » supprimé`, 'Annuler', () => {
      commitEditor();
      if (filler && !filler.content) state.tabs = state.tabs.filter((t) => t !== filler);
      state.tabs.splice(Math.min(index, state.tabs.length), 0, removed);
      state.activeId = removed.id;
      renderTabs({ entering: removed.id });
      loadEditor(true);
      persist();
    });
  }

  function setTabColor(id, color) {
    const tab = tabById(id);
    if (!tab) return;
    tab.color = color;
    tabEl(id)?.style.setProperty('--c', color);
    if (id === state.activeId) document.documentElement.style.setProperty('--accent', color);
    renderSwatches(color);
    persist();
  }

  // ─── Detached notes ──────────────────────────────────────────────────────

  // Drops a tab from this window once the main process has moved it into a note window.
  function releaseTab(id) {
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    state.tabs.splice(index, 1);
    if (state.activeId === id) {
      state.activeId = state.tabs[Math.min(index, state.tabs.length - 1)].id;
      loadEditor(true);
    }
    if (drag) markActiveTab();
    else renderTabs();
    persist();
  }

  async function detachTab(id, point = null) {
    if (IS_NOTE) return false;
    if (state.tabs.length < 2) {
      toast('Garde au moins un onglet dans Givre.', null, null, 2500);
      return false;
    }
    commitEditor();
    const tab = tabById(id);
    if (!tab || !(await api.detach({ ...tab }, point))) return false;
    releaseTab(id);
    return true;
  }

  // ─── Sharing ─────────────────────────────────────────────────────────────

  const SHARE_CODE_RE = /GIVRE1\.[A-Za-z0-9+/=]{8,}/;
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'LINK', 'META']);
  const KEEP_TAGS = new Set(['DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'IMG']);
  const IMG_SRC_OK = /^givre-img:\/\/[a-f0-9]{16}\.(?:png|jpg|gif|webp)\/?$/;

  // A note received from someone else only keeps what Givre itself produces.
  function sanitizeNote(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const clean = (parent) => {
      for (const node of [...parent.childNodes]) {
        if (node.nodeType === 3) continue;
        if (node.nodeType !== 1 || DROP_TAGS.has(node.tagName)) {
          node.remove();
          continue;
        }
        clean(node);
        if (!KEEP_TAGS.has(node.tagName)) {
          node.replaceWith(...node.childNodes);
          continue;
        }
        const keep = {
          class: node.tagName === 'DIV' ? [...node.classList].filter((c) => BLOCK_TYPES.includes(c)).join(' ') : '',
          checked: ['true', 'false'].includes(node.dataset.checked) ? node.dataset.checked : '',
          bg: node.tagName === 'SPAN' && Object.values(HL).includes(node.style.backgroundColor) ? node.style.backgroundColor : '',
          src: node.tagName === 'IMG' ? node.getAttribute('src') ?? '' : '',
          width: node.tagName === 'IMG' ? parseInt(node.getAttribute('width'), 10) || 0 : 0,
          height: node.tagName === 'IMG' ? parseInt(node.getAttribute('height'), 10) || 0 : 0,
        };
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
        if (node.tagName === 'IMG') {
          if (!IMG_SRC_OK.test(keep.src)) {
            node.remove();
            continue;
          }
          node.setAttribute('src', keep.src);
          if (keep.width && keep.height) {
            node.setAttribute('width', keep.width);
            node.setAttribute('height', keep.height);
          }
        }
        if (keep.class) node.className = keep.class;
        if (keep.checked && keep.class.includes('todo')) node.dataset.checked = keep.checked;
        if (keep.bg) node.style.backgroundColor = keep.bg;
      }
    };
    clean(doc.body);
    return doc.body.innerHTML;
  }

  async function shareTab(id, mode) {
    commitEditor();
    const tab = tabById(id);
    if (!tab) return;
    const payload = { title: tab.title, color: tab.color, content: tab.content };
    if (mode === 'file') {
      const res = await api.exportShare(payload);
      if (res?.ok) toast(`« ${res.file} » créé ✓ Envoie ce fichier : il suffit de l’ouvrir ou de le glisser dans Givre.`, null, null, 7000);
      return;
    }
    const res = await api.copyShare(payload);
    if (res?.tooLong) {
      toast('Note trop longue pour un code : partage-la en fichier.', 'Fichier…', () => shareTab(id, 'file'), 9000);
    } else if (res?.ok) {
      const extra = res.hadImages ? ' Les images ne passent pas par le code : partage en fichier pour les garder.' : '';
      toast(`Copié ✓ Colle-le à ton ami : il fait Ctrl + V dans Givre.${extra}`, null, null, res.hadImages ? 9000 : 6000);
    }
  }

  function addSharedNote(note) {
    insertTab({ id: uid(), title: note.title, color: note.color, content: sanitizeNote(note.content) });
    toast(`« ${note.title} » ajoutée depuis un partage ✓`, null, null, 3500);
  }

  // Coming back to Givre with a friend's code on the clipboard: offer to add it.
  async function offerClipboardShare() {
    const found = await api.peekShare();
    if (found) toast(`Note partagée copiée : « ${found.title} »`, 'Ajouter', () => api.importShare(found.code), 12000);
  }

  // A note window was dropped on the tab bar (or closed): it becomes a tab again.
  function attachTab(tab, clientX) {
    el.app.classList.remove('attach-hint');
    if (tabById(tab.id)) return selectTab(tab.id);
    commitEditor();
    scrollMemory.set(state.activeId, el.sheet.scrollTop);
    let index = state.tabs.length;
    if (clientX != null) {
      index = 0;
      for (const node of el.tabs.children) {
        const r = node.getBoundingClientRect();
        if (!node.classList.contains('torn') && clientX > r.left + r.width / 2) index++;
      }
    }
    state.tabs.splice(Math.min(index, state.tabs.length), 0, { id: tab.id, title: tab.title, color: tab.color, content: tab.content });
    state.activeId = tab.id;
    if (state.compact) setCompact(false);
    renderTabs({ entering: tab.id });
    loadEditor(true);
    persist();
    requestAnimationFrame(revealActiveTab);
  }

  // Dragging a tab ~45px away from the strip tears it off; its note window then follows the cursor.
  function tearOff(e) {
    const d = drag;
    d.torn = true;
    const rect = d.node.getBoundingClientRect();
    const point = { screenX: e.screenX, screenY: e.screenY, grabX: e.clientX - rect.left, grabY: e.clientY - rect.top };
    el.tabs.classList.remove('reordering');
    for (const n of d.nodes) n.style.transform = '';
    d.node.classList.remove('dragging');
    d.node.classList.add('torn');
    detachTab(d.id, point).then((ok) => {
      if (ok) return;
      d.torn = false;
      d.node.classList.remove('torn');
    });
  }

  function startRename(id) {
    const node = tabEl(id);
    const tab = tabById(id);
    if (!node || !tab) return;
    const label = node.querySelector('.label');
    const ac = new AbortController();
    node.classList.add('editing');
    label.contentEditable = 'plaintext-only';
    label.textContent = tab.title;
    label.focus();
    getSelection().selectAllChildren(label);

    const finish = (commit) => {
      ac.abort();
      const value = label.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (commit && value) tab.title = value;
      label.contentEditable = 'false';
      label.textContent = tab.title || 'Sans titre';
      node.title = tab.title;
      node.classList.remove('editing');
      el.tabs.scrollLeft = el.tabs.scrollLeft;
      persist();
    };
    label.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        finish(e.key === 'Enter');
        focusEditor();
      }
    }, { signal: ac.signal });
    label.addEventListener('blur', () => finish(true), { signal: ac.signal });
  }

  // Pointer-driven reordering: a press that moves less than 5px is a click.
  function startDrag() {
    drag.moved = true;
    try { drag.node.setPointerCapture(drag.pointerId); } catch {}
    drag.nodes = [...el.tabs.children];
    drag.from = drag.nodes.indexOf(drag.node);
    drag.to = drag.from;
    drag.slots = drag.nodes.map((n) => ({ left: n.offsetLeft, width: n.offsetWidth }));
    drag.step = drag.node.offsetWidth + 3;
    el.tabs.classList.add('reordering');
    drag.node.classList.add('dragging');
    closeTabMenu();
  }

  function moveDrag(rawDx) {
    const { slots, from, nodes } = drag;
    const first = slots[0];
    const last = slots[slots.length - 1];
    const self = slots[from];
    const dx = Math.max(first.left - self.left, Math.min(last.left + last.width - self.left - self.width, rawDx));
    drag.node.style.transform = `translateX(${dx}px)`;
    // The leading edge decides: a neighbour is passed once that edge crosses its middle.
    let to = from;
    slots.forEach((s, i) => {
      const mid = s.left + s.width / 2;
      if (i > from && self.left + self.width + dx > mid) to++;
      if (i < from && self.left + dx < mid) to--;
    });
    drag.to = to;
    nodes.forEach((n, i) => {
      if (i === from) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -drag.step;
      if (from > to && i >= to && i < from) shift = drag.step;
      n.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      if (e.type === 'pointerup') selectTab(d.id);
      return;
    }
    if (d.torn) {
      // Released back over the tab strip: the note goes straight back to being a tab.
      const r = el.tabs.getBoundingClientRect();
      const onTabs = e.type === 'pointerup' && e.clientY > r.top - 16 && e.clientY < r.bottom + 16 && e.clientX >= 0 && e.clientX <= innerWidth;
      api.tearEnd(onTabs, e.screenX);
      renderTabs();
      return;
    }
    el.tabs.classList.remove('reordering');
    if (d.to !== d.from) {
      const [tab] = state.tabs.splice(d.from, 1);
      state.tabs.splice(d.to, 0, tab);
      persist();
    }
    renderTabs();
  }

  // ─── Tab menu (rename, colour, duplicate, delete) ────────────────────────

  function renderSwatches(current) {
    const frag = document.createDocumentFragment();
    for (const [name, hex] of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.title = name;
      b.dataset.color = hex;
      b.style.setProperty('--c', hex);
      if (sameColor(hex, current)) b.classList.add('sel');
      frag.append(b);
    }
    const custom = document.createElement('button');
    custom.className = 'swatch custom';
    custom.title = 'Couleur personnalisée';
    if (!PALETTE.some(([, hex]) => sameColor(hex, current))) {
      custom.classList.add('sel');
      custom.style.setProperty('--c', current);
    }
    frag.append(custom);
    el.swatches.replaceChildren(frag);
  }

  function openTabMenu(id, anchor) {
    if (state.compact) setCompact(false);
    const tab = tabById(id);
    if (!tab) return;
    menuTabId = id;
    el.tabName.value = tab.title;
    renderSwatches(tab.color);
    el.hueRow.hidden = PALETTE.some(([, hex]) => sameColor(hex, tab.color));
    el.hue.value = hexToHue(tab.color);
    paintHue();
    el.menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, innerWidth - el.menu.offsetWidth - 8));
    el.menu.style.left = `${left}px`;
    el.menu.style.top = `${r.bottom + 6}px`;
    el.menu.style.maxHeight = `${innerHeight - r.bottom - 14}px`;
    el.menu.style.setProperty('--ox', `${r.left + r.width / 2 - left}px`);
    el.tabName.focus();
    el.tabName.select();
  }

  function closeTabMenu() {
    if (el.menu.hidden) return false;
    el.menu.hidden = true;
    menuTabId = null;
    return true;
  }

  function paintHue() {
    el.hue.style.setProperty('--thumb', hslToHex(Number(el.hue.value), 82, 62));
  }

  // ─── Editor ──────────────────────────────────────────────────────────────

  const blankLine = () => {
    const d = document.createElement('div');
    d.append(document.createElement('br'));
    return d;
  };

  function blockOf(node) {
    while (node && node !== el.editor) {
      if (node.parentNode === el.editor) return node.nodeType === 1 ? node : null;
      node = node.parentNode;
    }
    return null;
  }

  function currentBlock() {
    const sel = getSelection();
    return sel.rangeCount ? blockOf(sel.anchorNode) : null;
  }

  function selectedBlocks() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const start = blockOf(range.startContainer);
    const end = blockOf(range.endContainer);
    if (!start || !end) return [];
    const blocks = [];
    for (let b = start; b; b = b.nextElementSibling) {
      blocks.push(b);
      if (b === end) break;
    }
    return blocks;
  }

  const blockType = (b) => BLOCK_TYPES.find((t) => b.classList.contains(t)) ?? null;
  const isBlockEmpty = (b) => b.textContent.replace(/​/g, '') === '' && !b.querySelector('img');

  function setBlockType(b, type, checked = false) {
    b.classList.remove(...BLOCK_TYPES);
    b.removeAttribute('data-checked');
    if (type) b.classList.add(type);
    if (type === 'todo') b.dataset.checked = String(checked);
    if (!b.classList.length) b.removeAttribute('class');
  }

  function rangeBeforeCaret(block) {
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r;
  }

  function placeCaret(node, offset) {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function isEditorEmpty() {
    const ed = el.editor;
    return !ed.textContent && ed.children.length <= 1 && !ed.querySelector('.todo, .bullet, .h, img');
  }

  // Chromium leaves the first typed line as a bare text node; every line must be a <div>.
  function ensureBlocks() {
    const ed = el.editor;
    const stray = [...ed.childNodes].some((n) => n.nodeType !== 1 || n.tagName !== 'DIV');
    if (!stray) {
      if (!ed.firstChild) ed.append(blankLine());
      return;
    }
    const sel = getSelection();
    const anchor = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset] : null;
    let run = null;
    for (const node of [...ed.childNodes]) {
      if (node.nodeType === 1 && node.tagName === 'DIV') {
        run = null;
        continue;
      }
      if (node.nodeType === 3 && !node.textContent && node !== anchor?.[0]) {
        node.remove();
        continue;
      }
      if (!run) {
        run = document.createElement('div');
        ed.insertBefore(run, node);
      }
      run.append(node);
    }
    if (!ed.firstChild) ed.append(blankLine());
    if (anchor?.[0]?.isConnected && anchor[0] !== ed) {
      try { placeCaret(anchor[0], anchor[1]); } catch {}
    }
  }

  function loadEditor(animate) {
    const tab = activeTab();
    document.documentElement.style.setProperty('--accent', tab.color);
    el.editor.innerHTML = tab.content;
    cleanupSpans();
    ensureBlocks();
    refreshEditorState();
    refreshLinks();
    el.sheet.scrollTop = scrollMemory.get(tab.id) ?? 0;
    if (animate) {
      el.editor.classList.remove('swap');
      void el.editor.offsetWidth;
      el.editor.classList.add('swap');
    }
  }

  function refreshEditorState() {
    el.sheet.classList.toggle('is-empty', isEditorEmpty());
    const todos = [...el.editor.querySelectorAll(':scope > .todo')].filter((b) => !isBlockEmpty(b));
    const total = todos.length;
    const done = todos.filter((b) => b.dataset.checked === 'true').length;
    el.progress.hidden = total === 0;
    if (total) {
      el.progressText.textContent = `${done}/${total}`;
      el.progressBar.style.strokeDashoffset = String(RING * (1 - done / total));
      el.progress.classList.toggle('done', done === total);
    }
    updateLens();
  }

  function afterEdit() {
    refreshEditorState();
    scheduleLinks();
    saveEdit();
  }

  // ─── Inline calculator ───────────────────────────────────────────────────
  // Typing `400*3/2=` writes the result right after the "=" (Ctrl+Z removes it).

  function evaluate(src) {
    const tokens = src.match(/\d+(?:[.,]\d+)?|[.,]\d+|[+\-*/x×÷^%()]/g);
    if (!tokens || tokens.join('') !== src.replace(/[\s ]/g, '')) return null;
    if (!tokens.some((t, i) => i > 0 && /^[+\-*/x×÷^%]$/.test(t))) return null;
    let pos = 0;
    const peek = () => tokens[pos] ?? '';
    const take = () => tokens[pos++];
    const primary = () => {
      const t = take();
      if (t === '(') {
        const v = sum();
        if (take() !== ')') throw new Error('paren');
        return v;
      }
      if (t && /^[\d.,]/.test(t)) return parseFloat(t.replace(',', '.'));
      throw new Error('token');
    };
    const percent = () => {
      let v = primary();
      while (peek() === '%') { take(); v /= 100; }
      return v;
    };
    const power = () => {
      const base = percent();
      return peek() === '^' ? (take(), base ** unary()) : base;
    };
    const unary = () => {
      if (peek() === '-') return take(), -unary();
      if (peek() === '+') return take(), unary();
      return power();
    };
    const product = () => {
      let v = unary();
      while (/^[*x×/÷]$/.test(peek())) v = /[/÷]/.test(take()) ? v / unary() : v * unary();
      return v;
    };
    const sum = () => {
      let v = product();
      while (peek() === '+' || peek() === '-') v = take() === '+' ? v + product() : v - product();
      return v;
    };
    try {
      const v = sum();
      return pos === tokens.length && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  const formatNumber = (v) => Number(v.toPrecision(12)).toLocaleString('fr-FR', { useGrouping: false, maximumFractionDigits: 6 });

  function applyCalc() {
    const sel = getSelection();
    const node = sel.anchorNode;
    if (!sel.isCollapsed || node?.nodeType !== 3) return;
    const before = node.data.slice(0, sel.anchorOffset);
    if (!before.endsWith('=')) return;
    let start = before.length - 1;
    while (start > 0 && CALC_CHAR.test(before[start - 1])) start--;
    // "taux 3=" scans back into the x of "taux": leading operators are dropped.
    const expr = before.slice(start, -1).replace(/^[\s x×*/+^%.,]+/, '').trim();
    const value = evaluate(expr);
    if (value != null) document.execCommand('insertText', false, formatNumber(value));
  }

  // ─── Links ───────────────────────────────────────────────────────────────
  // URLs are painted with the CSS Highlight API (no markup in the note) and open on click.

  let links = [];
  let linkTimer = null;

  function refreshLinks() {
    if (!window.Highlight || !CSS.highlights) return;
    links = [];
    const walker = document.createTreeWalker(el.editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const m of node.data.matchAll(URL_RE)) {
        const range = new Range();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        links.push({ range, url: /^www\./i.test(m[0]) ? `https://${m[0]}` : m[0] });
      }
    }
    CSS.highlights.set('givre-link', new Highlight(...links.map((l) => l.range)));
  }

  function scheduleLinks() {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(refreshLinks, 120);
  }

  function linkAt(x, y) {
    for (const l of links) {
      for (const r of l.range.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return l.url;
      }
    }
    return null;
  }

  function applyMarkdown() {
    const block = currentBlock();
    if (!block || !getSelection().isCollapsed) return;
    const range = rangeBeforeCaret(block);
    const typed = range.toString().replace(/[\s ]$/, '');
    for (const [re, type, checked] of MARKDOWN) {
      if (!re.test(typed)) continue;
      range.deleteContents();
      setBlockType(block, type, checked);
      if (!block.firstChild) block.append(document.createElement('br'));
      placeCaret(block, 0);
      return;
    }
  }

  // After Enter: a new line under a heading is plain text, a new to-do starts unchecked.
  function fixNewLine() {
    const b = currentBlock();
    if (!b) return;
    const prev = b.previousElementSibling;
    const type = blockType(b);
    if (type === 'h') {
      if (isBlockEmpty(b)) setBlockType(b, null);
      else if (prev && blockType(prev) === 'h' && isBlockEmpty(prev)) setBlockType(prev, null);
    } else if (type === 'todo') {
      if (isBlockEmpty(b)) b.dataset.checked = 'false';
      else if (prev && blockType(prev) === 'todo' && isBlockEmpty(prev)) prev.dataset.checked = 'false';
    }
  }

  function toggleTodo(block, checked = block.dataset.checked !== 'true') {
    block.dataset.checked = String(checked);
    block.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(.76)', offset: 0.4 }, { transform: 'scale(1)' }],
      { duration: 420, easing: 'cubic-bezier(.3,1.35,.5,1)', pseudoElement: '::before' },
    );
  }

  function toggleTodoAtSelection() {
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    if (blocks.every((b) => blockType(b) === 'todo')) {
      const check = blocks.some((b) => b.dataset.checked !== 'true');
      blocks.forEach((b) => toggleTodo(b, check));
    } else {
      blocks.forEach((b) => setBlockType(b, 'todo'));
    }
    afterEdit();
  }

  function toggleBlockType(type) {
    const blocks = selectedBlocks();
    const all = blocks.length && blocks.every((b) => blockType(b) === type);
    blocks.forEach((b) => setBlockType(b, all ? null : type));
  }

  function focusEditor(toEnd = false) {
    if (state.compact || el.app.classList.contains('settings-open')) return;
    el.editor.focus({ preventScroll: true });
    const sel = getSelection();
    if (toEnd || !sel.rangeCount || !el.editor.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(el.editor.lastElementChild ?? el.editor);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  function runCommand(cmd) {
    if (cmd === 'hl-menu') return toggleHlMenu();
    closeHlMenu();
    if (!el.editor.contains(getSelection().anchorNode)) focusEditor(true);
    if (cmd === 'bold' || cmd === 'italic') document.execCommand(cmd);
    else if (cmd === 'strike') document.execCommand('strikeThrough');
    else if (cmd === 'highlight') highlight(state.settings.highlight, true);
    else toggleBlockType(cmd);
    afterEdit();
  }

  // ─── Highlighter ─────────────────────────────────────────────────────────

  function highlightAt(node) {
    for (let n = node?.nodeType === 3 ? node.parentNode : node; n && n !== el.editor; n = n.parentNode) {
      const bg = n.style?.backgroundColor;
      if (bg && bg !== 'transparent') return bg;
    }
    return null;
  }

  // With `toggle`, a selection already fully in this colour gets un-highlighted.
  function highlight(color, toggle) {
    const sel = getSelection();
    const value = HL[color];
    const covered = value && highlightAt(sel.anchorNode) === value && highlightAt(sel.focusNode) === value;
    document.execCommand('hiliteColor', false, !value || (toggle && covered) ? 'transparent' : value);
  }

  function toggleHlMenu() {
    el.hlMenu.hidden = !el.hlMenu.hidden;
  }

  function closeHlMenu() {
    if (el.hlMenu.hidden) return false;
    el.hlMenu.hidden = true;
    return true;
  }

  // Removing a highlight leaves `background-color: transparent` spans behind; drop them on load.
  function cleanupSpans() {
    for (const s of el.editor.querySelectorAll('span[style]')) {
      if (s.style.length === 1 && s.style.backgroundColor === 'transparent') s.replaceWith(...s.childNodes);
    }
  }

  // ─── Liquid-glass lens for the dock ──────────────────────────────────────
  // A displacement map that bends what is behind the capsule near its rim.

  function buildLensMap(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const r = h / 2;
    const bezel = Math.min(13, r);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const dx = px - Math.min(Math.max(px, r), w - r);
        const dy = py - r;
        const d = Math.hypot(dx, dy);
        const edge = r - d;
        let vx = 0;
        let vy = 0;
        if (edge > 0 && edge < bezel && d > 0) {
          const t = 1 - edge / bezel;
          const m = t * t * (3 - 2 * t);
          vx = (-dx / d) * m;
          vy = (-dy / d) * m;
        }
        const i = (y * w + x) * 4;
        img.data[i] = 128 + vx * 127;
        img.data[i + 1] = 128 + vy * 127;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  function updateLens() {
    const w = el.dock.offsetWidth;
    const h = el.dock.offsetHeight;
    const key = `${w}x${h}`;
    if (!w || !h || key === lensKey) return;
    lensKey = key;
    const map = document.getElementById('lensMap');
    map.setAttribute('width', w);
    map.setAttribute('height', h);
    map.setAttribute('href', buildLensMap(w, h));
    el.dock.classList.add('lens');
  }

  // ─── Toast ───────────────────────────────────────────────────────────────

  function toast(text, actionLabel, action, duration = 5000) {
    el.toastText.textContent = text;
    el.toastAction.hidden = !actionLabel;
    el.toastAction.textContent = actionLabel ?? '';
    el.toast.classList.toggle('plain', !actionLabel);
    el.toastAction.onclick = () => {
      hideToast();
      action?.();
    };
    el.toast.hidden = false;
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth;
    el.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    el.toast.hidden = true;
  }

  // ─── Images ──────────────────────────────────────────────────────────────

  const imageFiles = (dt) => [...(dt?.files ?? [])].filter((f) => f.type.startsWith('image/'));

  async function insertImages(files) {
    const sel = getSelection();
    const range = sel.rangeCount && el.editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const wanted = files.slice(0, 10);
    const saved = [];
    for (const file of wanted) {
      const res = file.size <= 25 * 1024 * 1024 ? await api.saveImage(new Uint8Array(await file.arrayBuffer()), file.type) : null;
      if (res) saved.push(res);
    }
    if (saved.length < wanted.length) toast('Image ignorée : format non pris en charge ou plus de 25 Mo.');
    if (!saved.length) return;
    el.editor.focus({ preventScroll: true });
    if (range) {
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      focusEditor(true);
    }
    const html = saved
      .map(({ url, width, height }) => (width ? `<img src="${url}" width="${width}" height="${height}" alt="">` : `<img src="${url}" alt="">`))
      .join('');
    document.execCommand('insertHTML', false, html);
    afterEdit();
  }

  function openLightbox(src) {
    el.lightboxImg.src = src;
    el.lightbox.hidden = false;
  }

  function closeLightbox() {
    if (el.lightbox.hidden) return false;
    el.lightbox.hidden = true;
    el.lightboxImg.removeAttribute('src');
    return true;
  }

  // ─── Installation ────────────────────────────────────────────────────────

  function renderInstall(info) {
    const show = Boolean(info?.available);
    $('#installTitle').hidden = !show;
    $('#installGroup').hidden = !show;
    if (!show) return;
    const btn = $('#btnInstall');
    btn.disabled = false;
    btn.classList.toggle('danger', info.running);
    if (info.running) {
      $('#installLabel').textContent = 'Givre est installé ✓';
      $('#installHint').textContent = info.dir;
      btn.textContent = 'Désinstaller';
      btn.onclick = () => api.uninstall();
    } else {
      $('#installLabel').textContent = info.present ? 'Mettre à jour Givre installé' : 'Installer Givre sur ce PC';
      $('#installHint').textContent = 'Menu Démarrer, Bureau et applications Windows';
      btn.textContent = info.present ? 'Mettre à jour' : 'Installer';
      btn.onclick = runInstall;
    }
  }

  async function runInstall() {
    const btn = $('#btnInstall');
    btn.disabled = true;
    btn.textContent = 'Installation…';
    persist();
    const res = await api.install();
    if (res?.ok) {
      toast('Givre est installé ✓ Il redémarre depuis le menu Démarrer…', null, null, 4000);
    } else {
      renderInstall(state.install);
      toast(`Installation impossible : ${res?.error ?? 'erreur inconnue'}`, null, null, 7000);
    }
  }

  // ─── Settings ────────────────────────────────────────────────────────────

  const ranges = {
    opacity: { input: $('#setOpacity'), out: $('#outOpacity'), toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, label: (v) => `${v} %` },
    frost: { input: $('#setFrost'), out: $('#outFrost'), toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, label: (v) => `${v} %` },
    fontSize: { input: $('#setFont'), out: $('#outFont'), toUi: (v) => v, fromUi: (v) => v, label: (v) => `${v} px` },
    restOpacity: { input: $('#setRest'), out: $('#outRest'), toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, label: (v) => `${v} %` },
  };

  function paintRange(input) {
    const p = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', `${p}%`);
  }

  function prettyAccelerator(accel) {
    return (accel || '—')
      .split('+')
      .map((k) => ({ Control: 'Ctrl', CommandOrControl: 'Ctrl', Super: 'Win', Shift: 'Maj', Space: 'Espace' }[k] ?? k))
      .join(' + ');
  }

  function applyLiveSettings() {
    const s = state.settings;
    const root = document.documentElement.style;
    root.setProperty('--frost', String(s.frost));
    root.setProperty('--fs', `${s.fontSize}px`);
  }

  function applySettings() {
    const s = state.settings;
    applyLiveSettings();
    el.pin.classList.toggle('on', s.pinned);
    el.pin.setAttribute('aria-pressed', String(s.pinned));
    el.pin.title = s.pinned ? 'Épinglé : position verrouillée (cliquer pour libérer)' : 'Épingler : verrouiller la position';
    el.app.classList.toggle('pinned', s.pinned);
    el.ghost.classList.toggle('on', s.ghost);
    el.app.classList.toggle('ghost', s.ghost);
    if (lastGhost !== null && s.ghost !== lastGhost && !IS_NOTE) {
      if (s.ghost) toast('Mode fantôme : les clics traversent la note. Ctrl + Alt + G pour en sortir.', null, null, 7000);
      else toast('Mode fantôme désactivé.', null, null, 2200);
    }
    lastGhost = s.ghost;
    updateEngaged();
    el.dock.style.setProperty('--hl-cur', HL_SWATCH[s.highlight] ?? HL_SWATCH.yellow);
    for (const d of el.hlMenu.querySelectorAll('.hl-dot')) d.classList.toggle('sel', d.dataset.hl === s.highlight);
    for (const [key, r] of Object.entries(ranges)) {
      if (document.activeElement === r.input) continue; // being dragged: leave it to the user
      const v = r.toUi(s[key]);
      r.input.value = v;
      r.out.textContent = r.label(v);
      paintRange(r.input);
    }
    for (const sw of document.querySelectorAll('.switch[data-key]')) sw.checked = Boolean(s[sw.dataset.key]);
    for (const b of $('#setTheme').children) b.classList.toggle('sel', b.dataset.v === s.theme);
    $('#restRow').hidden = !s.discreet;
    if (!recording) el.shortcut.textContent = prettyAccelerator(s.shortcut);
    $('#btnHide').title = IS_NOTE ? 'Remettre dans Givre (redevient un onglet)' : `Masquer (${prettyAccelerator(s.shortcut)})`;
  }

  async function updateSetting(key, value) {
    state.settings[key] = value;
    const res = await api.setSetting(key, value);
    // While a slider moves, replies arrive late: keep the newest local value for this key.
    if (res?.ok) state.settings = { ...res.settings, [key]: state.settings[key] };
    else if (res?.settings) state.settings = { ...res.settings };
    return res;
  }

  function toggleSettings(open = !el.app.classList.contains('settings-open')) {
    if (open && state.compact) setCompact(false);
    closeTabMenu();
    el.app.classList.toggle('settings-open', open);
    el.settings.inert = !open;
    $('#btnSettings').classList.toggle('on', open);
    if (!open) {
      api.previewOpacity(null);
      stopRecording();
      focusEditor();
    }
  }

  function keyName(e) {
    const c = e.code;
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit\d$/.test(c)) return c.slice(5);
    if (/^Numpad\d$/.test(c)) return `num${c.slice(6)}`;
    if (/^F([1-9]|1\d|2[0-4])$/.test(c)) return c;
    return {
      Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
    }[c] ?? null;
  }

  function startRecording() {
    recording = true;
    el.shortcut.classList.add('recording');
    el.shortcut.textContent = 'Appuie sur les touches…';
    el.shortcutHint.textContent = 'Échap pour annuler';
  }

  function stopRecording(hint = 'Raccourci global') {
    if (!recording) return;
    recording = false;
    el.shortcut.classList.remove('recording');
    el.shortcut.textContent = prettyAccelerator(state.settings.shortcut);
    el.shortcutHint.textContent = hint;
  }

  async function onRecordKey(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopRecording();
    const key = keyName(e);
    if (!key) return;
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (!mods.some((m) => m !== 'Shift')) {
      el.shortcutHint.textContent = 'Ajoute Ctrl, Alt ou Win';
      return;
    }
    const previous = state.settings.shortcut;
    const res = await updateSetting('shortcut', [...mods, key].join('+'));
    if (res?.ok) {
      stopRecording();
    } else {
      state.settings.shortcut = previous;
      stopRecording(res?.error ?? 'Raccourci invalide');
      el.shortcut.classList.remove('error');
      void el.shortcut.offsetWidth;
      el.shortcut.classList.add('error');
    }
    applySettings();
  }

  // ─── Window state ────────────────────────────────────────────────────────

  async function setCompact(on) {
    applyCompact(await api.setCompact(on));
  }

  function applyCompact(on) {
    state.compact = on;
    el.app.classList.toggle('compact', on);
    $('#btnCompact').title = on ? 'Déplier' : 'Replier';
    if (on) {
      closeOverlays();
      el.app.classList.remove('settings-open');
      el.settings.inert = true;
      $('#btnSettings').classList.remove('on');
    } else {
      requestAnimationFrame(updateLens);
    }
  }

  function updateEngaged() {
    const typing = document.hasFocus() && document.activeElement === el.editor;
    const engaged = !state.settings.ghost && (state.hovering || typing);
    el.app.classList.toggle('engaged', engaged);
    if (!engaged) closeHlMenu();
  }

  function closeOverlays() {
    let closed = closeTabMenu();
    if (closeLightbox()) closed = true;
    if (closeHlMenu()) closed = true;
    if (!el.toast.hidden) {
      hideToast();
      closed = true;
    }
    return closed;
  }

  // ─── Wiring ──────────────────────────────────────────────────────────────

  function bind() {
    // Tabs
    el.tabs.addEventListener('pointerdown', (e) => {
      const node = e.target.closest('.tab');
      if (!node || e.button !== 0 || node.classList.contains('editing')) return;
      drag = { node, id: node.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, moved: false, torn: false };
    });
    el.tabs.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) startDrag();
      if (drag.torn) api.tearMove(e.screenX, e.screenY);
      else if (!IS_NOTE && state.tabs.length > 1 && Math.abs(dy) > 44) tearOff(e);
      else moveDrag(dx);
    });
    el.tabs.addEventListener('pointerup', endDrag);
    el.tabs.addEventListener('pointercancel', endDrag);
    el.tabs.addEventListener('dblclick', (e) => {
      const node = e.target.closest('.tab');
      if (node) startRename(node.dataset.id);
    });
    el.tabs.addEventListener('contextmenu', (e) => {
      const node = e.target.closest('.tab');
      if (!node) return;
      e.preventDefault();
      openTabMenu(node.dataset.id, node);
    });
    el.tabs.addEventListener('auxclick', (e) => {
      const node = e.target.closest('.tab');
      if (node && e.button === 1 && !IS_NOTE) deleteTab(node.dataset.id);
    });
    el.tabs.addEventListener('wheel', (e) => {
      e.preventDefault();
      el.tabs.scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });
    el.tabs.addEventListener('scroll', updateTabOverflow, { passive: true });
    $('#btnAddTab').addEventListener('click', addTab);

    // Tab menu
    el.tabName.addEventListener('input', () => {
      const tab = tabById(menuTabId);
      if (!tab) return;
      tab.title = el.tabName.value.replace(/\s+/g, ' ').slice(0, 40);
      const node = tabEl(menuTabId);
      if (node) {
        node.querySelector('.label').textContent = tab.title || 'Sans titre';
        node.title = tab.title;
      }
      saveEdit();
    });
    el.tabName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeTabMenu();
        focusEditor();
      }
    });
    el.swatches.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      if (sw.classList.contains('custom')) {
        el.hueRow.hidden = !el.hueRow.hidden;
        return;
      }
      el.hueRow.hidden = true;
      setTabColor(menuTabId, sw.dataset.color);
    });
    el.hue.addEventListener('input', () => {
      paintHue();
      setTabColor(menuTabId, hslToHex(Number(el.hue.value), 82, 62));
    });
    el.menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const id = menuTabId;
      if (act === 'duplicate') {
        closeTabMenu();
        duplicateTab(id);
      } else if (act === 'delete') {
        deleteTab(id);
      } else if (act === 'detach') {
        closeTabMenu();
        detachTab(id);
      } else if (act === 'share-code' || act === 'share-file') {
        closeTabMenu();
        shareTab(id, act === 'share-file' ? 'file' : 'code');
      } else if (act === 'attach') {
        closeTabMenu();
        persist();
        api.attachSelf();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!el.menu.hidden && !el.menu.contains(e.target) && !e.target.closest?.('.tab')) closeTabMenu();
      if (!el.hlMenu.hidden && !el.hlMenu.contains(e.target) && !e.target.closest?.('.hl-more')) closeHlMenu();
    }, true);

    // Highlighter colours
    el.hlMenu.addEventListener('mousedown', (e) => e.preventDefault());
    el.hlMenu.addEventListener('click', async (e) => {
      const color = e.target.closest('[data-hl]')?.dataset.hl;
      if (!color) return;
      closeHlMenu();
      if (!el.editor.contains(getSelection().anchorNode)) focusEditor(true);
      highlight(color, false);
      afterEdit();
      if (HL[color] && color !== state.settings.highlight) {
        await updateSetting('highlight', color);
        applySettings();
      }
    });

    // Editor
    el.editor.addEventListener('keydown', (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        const b = currentBlock();
        const type = b && blockType(b);
        if (type && type !== 'h' && isBlockEmpty(b)) {
          e.preventDefault();
          setBlockType(b, null);
          afterEdit();
        }
      } else if (e.key === 'Backspace') {
        const b = currentBlock();
        if (b && blockType(b) && getSelection().isCollapsed && rangeBeforeCaret(b).toString() === '') {
          e.preventDefault();
          setBlockType(b, null);
          afterEdit();
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertText', false, '\t');
      }
    });
    el.editor.addEventListener('input', (e) => {
      ensureBlocks();
      if (e.inputType === 'insertText' && /^[\s ]$/.test(e.data ?? '')) applyMarkdown();
      else if (e.inputType === 'insertParagraph') fixNewLine();
      else if (e.inputType === 'insertText' && e.data === '=') applyCalc();
      afterEdit();
    });
    el.editor.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const b = blockOf(e.target);
      if (!b || blockType(b) !== 'todo') return;
      const rect = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      if (e.clientX - rect.left < parseFloat(cs.paddingLeft) && e.clientY - rect.top < parseFloat(cs.lineHeight) * 1.1) {
        e.preventDefault();
        toggleTodo(b);
        afterEdit();
      }
    });
    el.editor.addEventListener('mousemove', (e) => {
      const url = linkAt(e.clientX, e.clientY);
      const b = blockOf(e.target);
      const overBox = b && blockType(b) === 'todo' && e.clientX - b.getBoundingClientRect().left < parseFloat(getComputedStyle(b).paddingLeft);
      el.editor.style.cursor = url || overBox ? 'pointer' : '';
      el.editor.title = url ? `Ouvrir ${url}` : '';
    });
    // Text wins over images: spreadsheets also put a bitmap on the clipboard.
    // A pasted share code becomes a new tab instead of text.
    el.editor.addEventListener('paste', async (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      const files = imageFiles(e.clipboardData);
      if (text && SHARE_CODE_RE.test(text) && (await api.importShare(text))) return;
      if (text) document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
      else if (files.length) insertImages(files);
    });
    el.editor.addEventListener('dragstart', () => { internalDrag = true; });
    el.editor.addEventListener('dragend', () => { internalDrag = false; });
    el.editor.addEventListener('drop', (e) => {
      if (internalDrag) return;
      e.preventDefault();
      const files = imageFiles(e.dataTransfer);
      const text = e.dataTransfer.getData('text/plain');
      if (!files.length && !text) return;
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      if (files.length) insertImages(files);
      else document.execCommand('insertText', false, text);
    });
    el.editor.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG') return openLightbox(e.target.src);
      const url = getSelection().isCollapsed && linkAt(e.clientX, e.clientY);
      if (url) window.open(url);
    });
    el.lightbox.addEventListener('click', (e) => {
      if (e.target.closest('#lbOpen')) api.openImage(el.lightboxImg.getAttribute('src'));
      else closeLightbox();
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    // A .givre file dropped anywhere on a note is imported (capture: before the editor's own drop).
    window.addEventListener('drop', (e) => {
      const shared = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.givre$/i.test(f.name));
      if (shared.length) {
        e.preventDefault();
        e.stopPropagation();
        for (const f of shared) {
          f.text().then((text) => api.importShare(text)).then((ok) => ok || toast(`« ${f.name} » n’est pas une note Givre lisible.`));
        }
        return;
      }
      if (!el.editor.contains(e.target)) e.preventDefault();
    }, true);
    el.editor.addEventListener('focus', updateEngaged);
    el.editor.addEventListener('blur', updateEngaged);
    el.sheet.addEventListener('mousedown', (e) => {
      if (e.target === el.sheet) {
        e.preventDefault();
        focusEditor(true);
      }
    });

    // Dock
    el.dock.addEventListener('mousedown', (e) => e.preventDefault());
    el.dock.addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
      if (cmd) runCommand(cmd);
    });

    // Title bar
    el.ghost.addEventListener('click', async () => {
      await updateSetting('ghost', true);
      applySettings();
    });
    el.pin.addEventListener('click', async () => {
      await updateSetting('pinned', !state.settings.pinned);
      applySettings();
    });
    // Trying to drag a pinned note: the pin nods to explain why nothing moves.
    $('.titlebar').addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.settings.pinned || e.target.closest('.controls')) return;
      el.pin.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.14) rotate(-8deg)', offset: 0.3 }, { transform: 'scale(.97) rotate(5deg)', offset: 0.65 }, { transform: 'scale(1)' }],
        { duration: 460, easing: 'cubic-bezier(.3,1.35,.5,1)' },
      );
    });
    $('#btnCompact').addEventListener('click', () => setCompact(!state.compact));
    $('#btnSettings').addEventListener('click', () => toggleSettings());
    $('#btnSettingsBack').addEventListener('click', () => toggleSettings(false));
    $('#btnHide').addEventListener('click', () => {
      persist();
      if (IS_NOTE) api.attachSelf();
      else api.hide();
    });

    // Settings controls
    for (const [key, r] of Object.entries(ranges)) {
      r.input.addEventListener('input', () => {
        const v = Number(r.input.value);
        r.out.textContent = r.label(v);
        paintRange(r.input);
        state.settings[key] = r.fromUi(v);
        applyLiveSettings();
        updateSetting(key, r.fromUi(v));
      });
    }
    // While dragging "Opacité au repos", the window shows that opacity live.
    const rest = ranges.restOpacity.input;
    rest.addEventListener('input', () => api.previewOpacity(Number(rest.value) / 100));
    for (const end of ['change', 'pointerup', 'blur']) rest.addEventListener(end, () => api.previewOpacity(null));
    for (const sw of document.querySelectorAll('.switch[data-key]')) {
      sw.addEventListener('change', async () => {
        await updateSetting(sw.dataset.key, sw.checked);
        applySettings();
      });
    }
    $('#setTheme').addEventListener('click', async (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      await updateSetting('theme', v);
      applySettings();
    });
    el.shortcut.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
    document.addEventListener('keydown', onRecordKey, true);
    $('#btnOpenData').addEventListener('click', () => api.openDataFolder());
    $('#btnImport').addEventListener('click', async () => {
      if (await api.openShareFile()) toggleSettings(false);
    });
    $('#btnQuit').addEventListener('click', () => {
      persist();
      api.quit();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (closeOverlays()) e.preventDefault();
        else if (el.app.classList.contains('settings-open')) toggleSettings(false);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (IS_NOTE && k === 'w') {
        persist();
        api.attachSelf();
      } else if (IS_NOTE && (k === 't' || k === ',' || e.key === 'Tab' || /^Digit[1-9]$/.test(e.code))) {
        // Tabs and settings live in the main window.
      } else if (k === 't') addTab();
      else if (k === 'w') deleteTab(state.activeId);
      else if (e.key === 'Tab') cycleTab(e.shiftKey ? -1 : 1);
      else if (/^Digit[1-9]$/.test(e.code)) {
        const tab = state.tabs[Number(e.code.slice(5)) - 1];
        if (tab) selectTab(tab.id);
      } else if (e.key === ',') toggleSettings();
      else if (k === 'x' && e.shiftKey) runCommand('strike');
      else if (k === 'h' && e.shiftKey) runCommand('highlight');
      else if (e.key === 'Enter' && document.activeElement === el.editor) toggleTodoAtSelection();
      else return;
      e.preventDefault();
    });

    // Main process events
    api.on('hover', (h) => {
      state.hovering = h;
      updateEngaged();
    });
    api.on('settings', (s) => {
      state.settings = { ...s };
      applySettings();
    });
    api.on('compact', applyCompact);
    api.on('saved', showSaved);
    api.on('focus-editor', () => focusEditor());
    api.on('new-tab', addTab);
    api.on('tab-attached', attachTab);
    api.on('attach-hint', (on) => el.app.classList.toggle('attach-hint', on));
    api.on('note-imported', addSharedNote);

    window.addEventListener('focus', () => {
      updateEngaged();
      if (!IS_NOTE) offerClipboardShare();
    });
    window.addEventListener('blur', updateEngaged);
    window.addEventListener('beforeunload', persist);
    window.addEventListener('resize', () => {
      updateTabOverflow();
      closeTabMenu();
    });
  }

  // ─── Colour helpers ──────────────────────────────────────────────────────

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }

  function hexToHue(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return Math.round((h * 60 + 360) % 360);
  }

  // ─── Boot ────────────────────────────────────────────────────────────────

  async function init() {
    const s = await api.getState();
    if (!s?.tabs.length) return;
    el.app.classList.toggle('note-window', IS_NOTE);
    state.tabs = s.tabs.map((t) => ({ ...t }));
    state.activeId = s.activeTabId;
    state.settings = { ...s.settings };
    state.hovering = s.hovering;
    state.install = s.install;
    $('#about').textContent = `Givre ${s.version}`;
    el.settings.inert = true;
    applySettings();
    renderTabs();
    loadEditor(false);
    applyCompact(s.compact);
    renderInstall(s.install);
    bind();
    updateEngaged();
    requestAnimationFrame(() => {
      document.body.classList.add('ready');
      updateLens();
      revealActiveTab();
    });

    if (IS_NOTE) return;
    api.ready(); // notes opened from a .givre file can now arrive
    if (state.settings.ghost) {
      toast('Mode fantôme actif : Ctrl + Alt + G pour en sortir.', null, null, 6000);
    } else if (s.install?.available && !s.install.running) {
      setTimeout(() => {
        const update = s.install.present;
        toast(update ? 'Cette copie de Givre n’est pas celle installée.' : 'Givre n’est pas encore installé sur ce PC.', update ? 'Mettre à jour' : 'Installer', runInstall, 10000);
      }, 1200);
    }
  }

  init();
})();
