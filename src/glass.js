'use strict';

// Small Win32 helpers around the native acrylic backdrop.
//
// Windows 11 turns the acrylic backdrop into a flat colour as soon as the
// window loses focus. A note that stays on screen is unfocused most of the
// time, so after every deactivation we tell the window it is still "active"
// (WM_NCACTIVATE) – DWM then keeps rendering the live blur.

let SendMessageW = null;
let DwmSetWindowAttribute = null;

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  SendMessageW = user32.func('intptr_t __stdcall SendMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
  DwmSetWindowAttribute = dwmapi.func('int __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32_t attr, uint32_t *value, uint32_t size)');
} catch (err) {
  console.warn('[givre] native glass helpers unavailable:', err.message);
}

const WM_NCACTIVATE = 0x0086;
const DWMWA_BORDER_COLOR = 34;
const DWMWA_COLOR_NONE = 0xfffffffe;

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function keepActive(win) {
  if (!SendMessageW || !win || win.isDestroyed()) return;
  SendMessageW(hwndOf(win), WM_NCACTIVATE, 1, 0);
}

// The system draws a 1px accent border; the glass rim is drawn in CSS instead.
function hideSystemBorder(win) {
  if (!DwmSetWindowAttribute || !win || win.isDestroyed()) return;
  DwmSetWindowAttribute(hwndOf(win), DWMWA_BORDER_COLOR, [DWMWA_COLOR_NONE], 4);
}

module.exports = { keepActive, hideSystemBorder };
