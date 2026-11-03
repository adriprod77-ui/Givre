'use strict';

// Self-installer: copies the packaged app to %LOCALAPPDATA%\Programs\Givre, adds
// Start menu and Desktop shortcuts and an entry in Windows "Installed apps".
// No admin rights needed. Notes in %APPDATA%\Givre are never touched by install.

const { app, dialog, shell } = require('electron');
const fs = require('original-fs'); // plain fs: app.asar must be copied as a file
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const APP_ID = 'fr.givre.app';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Givre';
// Double-clicking a shared .givre file opens it in Givre.
const FILE_EXT_KEY = 'HKCU\\Software\\Classes\\.givre';
const FILE_TYPE_KEY = 'HKCU\\Software\\Classes\\Givre.Note';

const localAppData = () => process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
const installDir = () => path.join(localAppData(), 'Programs', 'Givre');
const installedExe = () => path.join(installDir(), 'Givre.exe');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const shortcutPaths = () => [
  path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Givre.lnk'),
  path.join(app.getPath('desktop'), 'Givre.lnk'),
];

function status() {
  return {
    available: app.isPackaged,
    running: app.isPackaged && samePath(process.execPath, installedExe()),
    present: fs.existsSync(installedExe()),
    dir: installDir(),
  };
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const reg = (args) => execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore' });

function install() {
  if (!app.isPackaged) throw new Error('Disponible uniquement dans la version packagée.');
  const source = path.dirname(process.execPath);
  const target = installDir();
  const exe = installedExe();
  if (samePath(source, target)) return exe;

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });

  for (const lnk of shortcutPaths()) {
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    shell.writeShortcutLink(lnk, 'create', {
      target: exe,
      cwd: target,
      icon: exe,
      iconIndex: 0,
      description: 'Givre — aide-mémoire en verre',
      appUserModelId: APP_ID,
    });
  }

  const values = [
    ['DisplayName', 'REG_SZ', 'Givre'],
    ['DisplayIcon', 'REG_SZ', exe],
    ['DisplayVersion', 'REG_SZ', app.getVersion()],
    ['Publisher', 'REG_SZ', 'Givre'],
    ['InstallLocation', 'REG_SZ', target],
    ['UninstallString', 'REG_SZ', `"${exe}" --uninstall`],
    ['QuietUninstallString', 'REG_SZ', `"${exe}" --uninstall --quiet`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(Math.round(dirSize(target) / 1024))],
  ];
  for (const [name, type, value] of values) reg(['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', value, '/f']);

  const association = [
    [FILE_EXT_KEY, 'Givre.Note'],
    [FILE_TYPE_KEY, 'Note Givre'],
    [`${FILE_TYPE_KEY}\\DefaultIcon`, `"${exe}",0`],
    [`${FILE_TYPE_KEY}\\shell\\open\\command`, `"${exe}" "%1"`],
  ];
  for (const [key, value] of association) reg(['add', key, '/ve', '/d', value, '/f']);
  return exe;
}

// Resolves to true once Givre is removed; the caller must then quit so the
// detached cleanup can delete the (no longer locked) program folder.
async function uninstall({ quiet = false } = {}) {
  let wipeNotes = false;
  if (!quiet) {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      title: 'Givre',
      message: 'Désinstaller Givre ?',
      detail: 'Givre sera retiré du menu Démarrer, du Bureau et des applications installées. Tes notes restent dans %APPDATA%\\Givre, sauf si tu coches la case.',
      buttons: ['Désinstaller', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      checkboxLabel: 'Supprimer aussi mes notes',
      checkboxChecked: false,
    });
    if (response !== 0) return false;
    wipeNotes = checkboxChecked;
  }

  for (const lnk of shortcutPaths()) fs.rmSync(lnk, { force: true });
  for (const key of [UNINSTALL_KEY, FILE_EXT_KEY, FILE_TYPE_KEY]) {
    try { reg(['delete', key, '/f']); } catch {}
  }
  app.setLoginItemSettings({ openAtLogin: false, path: installedExe(), args: ['--autostart'] });

  const doomed = [installDir(), ...(wipeNotes ? [app.getPath('userData')] : [])].filter((d) => /[\\/]Givre$/i.test(d));
  const cmd = `ping -n 3 127.0.0.1 >nul & ${doomed.map((d) => `rmdir /s /q "${d}"`).join(' & ')}`;
  spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
    cwd: os.tmpdir(), // a cwd inside the program folder would keep it from being removed
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
  return true;
}

module.exports = { status, install, uninstall, installedExe };
