'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['settings', 'compact', 'hover', 'focus-editor', 'new-tab', 'saved', 'tab-attached', 'attach-hint', 'note-imported']);

contextBridge.exposeInMainWorld('givre', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveTabs: (tabs, activeTabId) => ipcRenderer.send('tabs:save', { tabs, activeTabId }),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  setCompact: (on) => ipcRenderer.invoke('window:compact', on),
  hide: () => ipcRenderer.send('window:hide'),
  openDataFolder: () => ipcRenderer.send('app:open-data'),
  quit: () => ipcRenderer.send('app:quit'),
  saveImage: (bytes, type) => ipcRenderer.invoke('image:save', bytes, type),
  openImage: (url) => ipcRenderer.send('image:open', url),
  install: () => ipcRenderer.invoke('app:install'),
  uninstall: () => ipcRenderer.send('app:uninstall'),
  previewOpacity: (value) => ipcRenderer.send('window:preview-opacity', value),
  detach: (tab, point) => ipcRenderer.invoke('note:detach', tab, point),
  tearMove: (screenX, screenY) => ipcRenderer.send('note:tear-move', screenX, screenY),
  tearEnd: (dropOnTabs, screenX) => ipcRenderer.send('note:tear-end', dropOnTabs, screenX),
  attachSelf: () => ipcRenderer.send('note:attach'),
  ready: () => ipcRenderer.send('window:ready'),
  copyShare: (tab) => ipcRenderer.invoke('share:copy', tab),
  exportShare: (tab) => ipcRenderer.invoke('share:export', tab),
  importShare: (text) => ipcRenderer.invoke('share:import', text),
  openShareFile: () => ipcRenderer.invoke('share:open'),
  peekShare: () => ipcRenderer.invoke('share:peek'),
  on: (event, callback) => {
    if (EVENTS.has(event)) ipcRenderer.on(event, (_e, ...args) => callback(...args));
  },
});
