'use strict';

// Small Win32 helpers around the native acrylic backdrop.
//
// Windows 11 turns the acrylic backdrop into a flat colour as soon as the
// window loses focus. A note that stays on screen is unfocused most of the
// time, so after every deactivation we tell the window it is still "active"
// (WM_NCACTIVATE) – DWM then keeps rendering the live blur.

let SendMessageW = null;
let DwmSetWindowAttribute = null;
let GetWindowLongPtrW = null;
let SetWindowPos = null;

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  SendMessageW = user32.func('intptr_t __stdcall SendMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
  DwmSetWindowAttribute = dwmapi.func('int __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32_t attr, uint32_t *value, uint32_t size)');
  GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
  SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
} catch (err) {
  console.warn('[givre] native glass helpers unavailable:', err.message);
}

const WM_NCACTIVATE = 0x0086;
const DWMWA_BORDER_COLOR = 34;
const DWMWA_COLOR_NONE = 0xfffffffe;
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x8;
const HWND_TOPMOST = -1;
const SWP_KEEP_ALL_BUT_ZORDER = 0x1 | 0x2 | 0x10; // NOSIZE | NOMOVE | NOACTIVATE

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

// Windows can silently drop a window out of the topmost band (e.g. a window rebuilt
// while the GPU restarts, fullscreen games): put it back if that happened.
function ensureTopmost(win) {
  if (!GetWindowLongPtrW || !win || win.isDestroyed()) return false;
  const hwnd = hwndOf(win);
  if (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) return false;
  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_KEEP_ALL_BUT_ZORDER);
  return true;
}

module.exports = { keepActive, hideSystemBorder, ensureTopmost };
