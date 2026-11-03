'use strict';

// Sharing a note with another Givre, two ways:
//  - a short code (text only) that fits in a chat message: "GIVRE1.<deflate+base64>"
//  - a .givre file (JSON) that also carries the note's images
// Both decode to { title, color, content }; the renderer sanitises content before use.

const zlib = require('zlib');

const CODE_RE = /GIVRE1\.([A-Za-z0-9+/=]{8,})/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const IMG_SRC_RE = /givre-img:\/\/([a-f0-9]{16}\.(?:png|jpg|gif|webp))/g;
const MAX_CODE = 1800; // the whole message stays under Discord's 2000 characters
const MAX_CONTENT = 2_000_000;

function clean(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    title: String(o.title ?? '').slice(0, 40) || 'Note partagée',
    color: COLOR_RE.test(o.color) ? o.color : '#5AC8FA',
    content: typeof o.content === 'string' ? o.content.slice(0, MAX_CONTENT) : '',
  };
}

function toCode(tab) {
  const content = tab.content.replace(/<img[^>]*>/gi, '');
  const json = JSON.stringify({ v: 1, t: tab.title, c: tab.color, h: content });
  const code = `GIVRE1.${zlib.deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64')}`;
  return { code, hadImages: content.length !== tab.content.length, tooLong: code.length > MAX_CODE };
}

const message = (tab, code) =>
  `🧊 Note Givre « ${tab.title || 'Sans titre'} » : copie ce message puis fais Ctrl + V dans Givre\n${code}`;

const findCode = (text) => CODE_RE.exec(String(text ?? ''))?.[0] ?? null;

function fromCode(text) {
  const m = CODE_RE.exec(String(text ?? ''));
  if (!m) return null;
  try {
    const raw = zlib.inflateRawSync(Buffer.from(m[1], 'base64'), { maxOutputLength: 4 * 1024 * 1024 });
    const o = JSON.parse(raw.toString('utf8'));
    return o?.v === 1 ? clean({ title: o.t, color: o.c, content: o.h }) : null;
  } catch {
    return null;
  }
}

// readImage(name) → { type, data: Buffer } | null
function toFile(tab, readImage) {
  const images = [];
  for (const [, name] of tab.content.matchAll(IMG_SRC_RE)) {
    if (images.some((i) => i.name === name)) continue;
    const img = readImage(name);
    if (img) images.push({ name, type: img.type, data: img.data.toString('base64') });
  }
  return JSON.stringify({ givre: 1, title: tab.title, color: tab.color, content: tab.content, images });
}

// saveImage(buffer, type) → { url } | null. Image references are remapped to the new files.
function fromFile(text, saveImage) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (o?.givre !== 1) return null;
  const urls = new Map();
  for (const img of Array.isArray(o.images) ? o.images.slice(0, 40) : []) {
    if (typeof img?.name !== 'string' || typeof img.data !== 'string') continue;
    const saved = saveImage(Buffer.from(img.data, 'base64'), img.type);
    if (saved) urls.set(img.name, saved.url);
  }
  const note = clean(o);
  if (note) note.content = note.content.replace(IMG_SRC_RE, (_m, name) => urls.get(name) ?? '');
  return note;
}

function parse(text, saveImage) {
  const t = String(text ?? '').trim();
  return t.startsWith('{') ? fromFile(t, saveImage) : fromCode(t);
}

module.exports = { toCode, message, findCode, fromCode, toFile, fromFile, parse };
