/**
 * Windows-only: Hide a window from screen capture using native Win32 API.
 *
 * Calls SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) directly.
 * This is what professional "invisible during share" apps do — Electron's
 * built-in setContentProtection uses the older WDA_MONITOR flag on Windows,
 * which makes the window appear as a black rectangle instead of being fully
 * excluded from screen capture.
 *
 * Requirements:
 *  - Windows 10 version 2004 (build 19041) or later
 *  - Windows 11 (all versions)
 */

const log = require("electron-log");

const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011; // Win10 2004+, Win11

let SetWindowDisplayAffinity = null;
let GetLastError = null;
let initialized = false;
let unavailableReason = null;

function init() {
  if (initialized) return SetWindowDisplayAffinity !== null;
  initialized = true;

  if (process.platform !== "win32") {
    unavailableReason = "Not on Windows";
    return false;
  }

  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");

    // BOOL SetWindowDisplayAffinity(HWND hwnd, DWORD dwAffinity)
    SetWindowDisplayAffinity = user32.func(
      "__stdcall",
      "SetWindowDisplayAffinity",
      "bool",
      ["void *", "uint32"]
    );

    // DWORD GetLastError(void)
    GetLastError = kernel32.func("__stdcall", "GetLastError", "uint32", []);

    log.info("win-capture-hide: koffi initialized successfully");
    return true;
  } catch (err) {
    unavailableReason = err.message;
    log.error("win-capture-hide: failed to initialize koffi:", err);
    return false;
  }
}

/**
 * Exclude an Electron BrowserWindow from screen capture.
 * @param {Electron.BrowserWindow} browserWindow
 * @returns {boolean} true if successfully applied
 */
function excludeFromCapture(browserWindow) {
  if (!init()) {
    log.warn(`win-capture-hide: skipped (${unavailableReason})`);
    return false;
  }
  if (!browserWindow || browserWindow.isDestroyed()) return false;

  try {
    // getNativeWindowHandle() returns a Buffer containing the HWND value
    const hwndBuffer = browserWindow.getNativeWindowHandle();

    // On 64-bit Windows the HWND is a 64-bit pointer; on 32-bit it's 32-bit.
    // koffi expects a raw pointer (void *), so we pass the underlying buffer.
    // To pass the HWND as a pointer value we need to read it as an address.
    const hwndValue = process.arch === "x64" || process.arch === "arm64"
      ? hwndBuffer.readBigUInt64LE(0)
      : BigInt(hwndBuffer.readUInt32LE(0));

    // koffi accepts BigInt for pointer values when using 'void *'
    const success = SetWindowDisplayAffinity(hwndValue, WDA_EXCLUDEFROMCAPTURE);

    if (!success) {
      const errCode = GetLastError ? GetLastError() : -1;
      log.warn(`win-capture-hide: SetWindowDisplayAffinity failed (GLE=${errCode}). ` +
        `Likely Windows < 10.0.19041 — falling back to Electron's setContentProtection.`);
      return false;
    }

    log.info("win-capture-hide: WDA_EXCLUDEFROMCAPTURE applied successfully");
    return true;
  } catch (err) {
    log.error("win-capture-hide: error applying flag:", err);
    return false;
  }
}

/**
 * Re-show window in screen capture (undo excludeFromCapture).
 */
function showInCapture(browserWindow) {
  if (!init()) return false;
  if (!browserWindow || browserWindow.isDestroyed()) return false;

  try {
    const hwndBuffer = browserWindow.getNativeWindowHandle();
    const hwndValue = process.arch === "x64" || process.arch === "arm64"
      ? hwndBuffer.readBigUInt64LE(0)
      : BigInt(hwndBuffer.readUInt32LE(0));

    return Boolean(SetWindowDisplayAffinity(hwndValue, WDA_NONE));
  } catch (err) {
    log.error("win-capture-hide: error clearing flag:", err);
    return false;
  }
}

module.exports = {
  excludeFromCapture,
  showInCapture,
  isAvailable: () => init(),
};
