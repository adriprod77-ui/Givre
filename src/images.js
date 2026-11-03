'use strict';

// Pasted images live as files in %APPDATA%\Givre\images and notes reference them
// as givre-img://<name>: the notes file stays small, so saving stays instant.

const { protocol, net, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SCHEME = 'givre-img';
const NAME_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_WIDTH = 2400;
const PRUNE_AGE = 60 * 60 * 1000;

let dir = null;

// Must run before the app is ready.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

function init(userData) {
  dir = path.join(userData, 'images');
  fs.mkdirSync(dir, { recursive: true });
  protocol.handle(SCHEME, (req) => {
    const file = fileFor(req.url);
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response(null, { status: 404 });
  });
}

function fileFor(url) {
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && NAME_RE.test(u.hostname) ? path.join(dir, u.hostname) : null;
  } catch {
    return null;
  }
}

function save(bytes, type) {
  const ext = EXTENSIONS[type];
  if (!ext || !bytes?.byteLength || bytes.byteLength > MAX_BYTES) return null;
  let data = Buffer.from(bytes);
  let width = 0;
  let height = 0;
  if (ext === 'png' || ext === 'jpg') {
    let img = nativeImage.createFromBuffer(data);
    if (img.isEmpty()) return null;
    if (img.getSize().width > MAX_WIDTH) {
      img = img.resize({ width: MAX_WIDTH, quality: 'best' });
      data = ext === 'jpg' ? img.toJPEG(90) : img.toPNG();
    }
    ({ width, height } = img.getSize());
  }
  const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), data);
  return { url: `${SCHEME}://${name}`, width, height };
}

function read(name) {
  if (!NAME_RE.test(name)) return null;
  try {
    return { type: TYPES[name.split('.').pop()], data: fs.readFileSync(path.join(dir, name)) };
  } catch {
    return null;
  }
}

// Drops files no note references any more (kept for an hour so undo still works).
function prune(tabs) {
  const refs = tabs.map((t) => t.content).join('\n');
  const cutoff = Date.now() - PRUNE_AGE;
  for (const name of fs.readdirSync(dir)) {
    if (!NAME_RE.test(name) || refs.includes(name)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = { registerScheme, init, save, read, fileFor, prune };
