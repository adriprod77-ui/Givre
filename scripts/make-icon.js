'use strict';

// Renders assets/icon.svg offscreen and writes assets/icon.ico (PNG-compressed
// entries, 16–256 px) plus assets/icon.png. Run with: npm run icon

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function buildIco(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`,
  ));
  await new Promise((r) => setTimeout(r, 400));
  const master = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), master.toPNG());

  const pngs = SIZES.map((size) => ({
    size,
    data: (size === 256 ? master : nativeImage.createFromBuffer(master.toPNG()).resize({ width: size, height: size, quality: 'best' })).toPNG(),
  }));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(pngs));
  console.log('icon.ico written with sizes', SIZES.join(', '));
  app.quit();
});
