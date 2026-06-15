/**
 * Centralized prompt loader.
 *
 * Loads the system prompt from a single place: `prompt.txt` at the project
 * root (i.e. next to package.json). This makes the app easy to fork — anyone
 * who wants to use it for their own project just edits prompt.txt with their
 * project info, no code changes needed.
 *
 * Fallback chain:
 *   1. prompt.txt at the app root (preferred — versioned with the repo)
 *   2. systemPrompt.txt in userData dir (legacy — for existing installs)
 *   3. "" (no system prompt)
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const log = require("electron-log");
const { getUserDataPath } = require("./utils");

function getProjectRoot() {
  // In dev, app.getAppPath() == project root.
  // In packaged builds, it points to the asar — also fine for reading bundled prompt.txt.
  try {
    return app.getAppPath();
  } catch (e) {
    return process.cwd();
  }
}

function loadPrompt() {
  // 1. Project-root prompt.txt (recommended)
  try {
    const root = getProjectRoot();
    const promptPath = path.join(root, "prompt.txt");
    if (fs.existsSync(promptPath)) {
      const content = fs.readFileSync(promptPath, "utf8");
      if (content.trim().length > 0) {
        return content;
      }
    }
  } catch (err) {
    log.warn("prompt-loader: failed to read prompt.txt at project root:", err.message);
  }

  // 2. Legacy systemPrompt.txt in userData
  try {
    const userPath = getUserDataPath("systemPrompt.txt");
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, "utf8");
      if (content.trim().length > 0) {
        log.info("prompt-loader: using legacy systemPrompt.txt from userData");
        return content;
      }
    }
  } catch (err) {
    log.warn("prompt-loader: failed to read userData systemPrompt.txt:", err.message);
  }

  return "";
}

module.exports = { loadPrompt };
