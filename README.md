<div align="center">

# Interview With AI

<img src="build/logo.png" alt="Interview With AI Logo" width="140" height="140"/>

**A real-time, AI-powered interview assistant that listens, transcribes, and answers — invisibly.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![Electron](https://img.shields.io/badge/electron-v35-blue)
![Powered by Gemini](https://img.shields.io/badge/AI-Google%20Gemini-8e44ad)

</div>

---

## Overview

**Interview With AI** is an Electron desktop application that helps you during live, voice-based interviews. It captures your computer's audio in real time, transcribes what the interviewer is saying, decides whether it's a question, and generates a tailored answer — all within seconds, and all while staying **invisible to screen-sharing software**.

It was originally built for a Japanese-language technical interview, so it has first-class support for **Japanese answers with furigana** (reading hints over kanji, e.g. `開発(かいはつ)`). The assistant's persona and knowledge are driven entirely by a single editable [`prompt.txt`](#customizing-for-your-own-project) file, making it trivial to adapt to **your own project, language, or domain** without touching the code.

> ⚠️ **Disclaimer.** This tool is intended for interview *preparation*, mock interviews, accessibility, and learning. Using it to deceive an interviewer in a real hiring process may violate the terms of that process. Use responsibly.

---

## Key Features

### 🎙️ Live Voice Mode (the core feature)
- Continuously listens to your system audio (the interviewer's voice through your speakers).
- Built-in **Voice Activity Detection (VAD)** automatically segments speech into utterances — no need to press a button per question.
- Each utterance is processed in a **two-stage pipeline**:
  1. **Transcription** — Gemini transcribes the raw audio faithfully (no hallucinated filler or paraphrasing).
  2. **Judge & Answer** — Gemini decides if the utterance is a question directed at you and, if so, generates a full answer using your project context.
- Greetings, small talk, and acknowledgements are recognized as **non-questions** and skipped, so you only get answers when they matter.

### 🈁 Japanese Furigana Support
- When enabled, every kanji in the response is annotated with its hiragana reading: `私(わたし)はSplitterを開発(かいはつ)しました`.
- Perfect for non-native speakers who can speak Japanese but read kanji slowly.
- Toggle on/off in Settings.

### 🫥 Invisible During Screen Sharing
- On Windows, uses the native Win32 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` API (via [`koffi`](https://koffi.dev/)) so the window is **completely excluded** from screen capture — not just a black box.
- The assistant stays fully visible to you while being absent from Google Meet, Zoom, Teams, and OBS captures.
- Falls back to Electron's `setContentProtection` on other platforms.

### 💬 Chat & Screenshot Modes
- **Chat mode** (`Ctrl/⌘ + T`): type a question and get a streamed, markdown-rendered answer.
- **Screenshot mode** (`Ctrl/⌘ + H`): capture the screen and let the AI analyze a coding problem or question.
- Conversation context is preserved per window.

### 🧩 Fully Customizable via `prompt.txt`
- A single `prompt.txt` at the project root defines the AI's persona, your project details, answer language, and formatting rules.
- Fork the repo, replace the contents with **your** project, and the assistant instantly becomes an expert on it.

### 🌐 Multiple AI Providers
- **Google Gemini** (recommended — generous free tier, excellent multilingual + audio support).
- OpenAI (GPT-4 family).
- Local **Ollama** models.
- Azure Foundry (Claude models).

---

## How the Voice Pipeline Works

```
 ┌──────────────┐   system audio    ┌─────────────────┐
 │  Your PC's   │ ────────────────▶ │  Renderer (VAD) │
 │   speakers   │   (loopback)      │  detects speech │
 └──────────────┘                   └────────┬────────┘
                                              │ utterance (WebM/Opus)
                                              ▼
                                    ┌──────────────────────┐
                                    │  Stage 1: Transcribe  │
                                    │  Gemini (audio → text)│
                                    └──────────┬───────────┘
                                               │ faithful transcript
                                               ▼
                                    ┌──────────────────────┐
                                    │  Stage 2: Judge+Answer│
                                    │  Gemini (text → JSON) │
                                    │  {isQuestion, answer} │
                                    └──────────┬───────────┘
                                               │ answer (with furigana)
                                               ▼
                                    ┌──────────────────────┐
                                    │   Chat UI (you read)  │
                                    └──────────────────────┘
```

Splitting transcription and answering into two calls is deliberate: when a single prompt is asked to both transcribe *and* role-play as an interviewee, the model tends to **hallucinate** plausible interview questions instead of transcribing what was actually said. Keeping the transcription step context-free fixes this.

---

## Prerequisites

- [Node.js](https://nodejs.org/) **v18+** (developed on v22).
- A **Google Gemini API key** — free from [Google AI Studio](https://aistudio.google.com/apikey). Keys start with `AIzaSy...`.
- **Windows 10 (build 19041 / version 2004) or newer** for full screen-capture invisibility. Earlier builds fall back to a less reliable mode.
- For voice mode, your OS must expose **system audio loopback** (default on Windows via the desktop audio capturer).

---

## Installation

```bash
# 1. Clone
git clone https://github.com/SherzodkhujaNiyozov/interview-with-ai.git
cd interview-with-ai

# 2. Install dependencies
npm install

# 3. Run
npm start
```

For development with hot reload:

```bash
npm run dev          # macOS / Linux
npm run dev:windows  # Windows
```

---

## Setup

1. Launch the app and press `Ctrl + ,` (or `⌘ + ,` on macOS) to open **Settings**.
2. Select **Google Gemini** as the AI provider.
3. Paste your API key (the full `AIzaSy...` string — nothing else).
4. Choose a model — **`gemini-2.5-flash`** or **`gemini-2.5-flash-lite`** are recommended (they have a working free-tier quota and support audio).
5. Set the response language (e.g. **Japanese**) and toggle **Furigana** if desired.
6. Save.

> **Note:** `gemini-2.0-flash` has no free-tier quota and is automatically upgraded to `gemini-2.5-flash` for voice requests.

---

## Usage

### Voice Mode
1. Open the chat panel: `Ctrl/⌘ + T`.
2. Click the **microphone button** in the input bar (or press `Ctrl/⌘ + Shift + L`).
3. A red "listening" indicator appears with a live audio-level meter.
4. Leave it running for the whole interview. As the interviewer asks questions, transcripts appear and answers stream in automatically.
5. Click the button again (or press the hotkey) to stop.

### Chat Mode
- Type a question in the input box and press **Enter**. Answers stream in with full markdown formatting.

### Screenshot Mode
- Press `Ctrl/⌘ + H` to capture and analyze the screen.

---

## Customizing for Your Own Project

The assistant's entire personality and knowledge live in **`prompt.txt`** at the project root. To adapt it to your own project:

1. Open `prompt.txt`.
2. Replace the project description, tech stack, and rules with your own.
3. Keep (or remove) the furigana rules depending on your target language.
4. Restart — done. No code changes required.

The app loads the prompt in this order: `prompt.txt` (project root) → `systemPrompt.txt` (user data dir, legacy) → empty. This makes the repo **fork-friendly**: anyone can clone it, drop in their own `prompt.txt`, and have a personalized interview assistant.

---

## Keyboard Shortcuts

Use `⌘` on macOS, `Ctrl` on Windows/Linux.

| Shortcut            | Action                                   |
| ------------------- | ---------------------------------------- |
| `Mod + Shift + L`   | **Start/stop live voice listening**      |
| `Mod + T`           | Toggle chat (split view)                 |
| `Mod + N`           | New chat                                 |
| `Mod + H`           | Capture & analyze screenshot             |
| `Mod + D`           | Capture selected area                    |
| `Mod + Enter`       | Process screenshots                      |
| `Mod + B`           | Toggle window visibility                 |
| `Mod + R`           | Reset chat / current process             |
| `Mod + ,`           | Open settings                            |
| `Mod + Shift + ↑↓←→`| Move window                              |
| `Shift + ↑↓`        | Scroll content                           |
| `Mod + Shift + =/-` | Increase / decrease window size          |
| `Mod + Shift + I`   | Toggle DevTools                          |
| `Mod + /`           | Show all hotkeys                         |
| `Mod + Q`           | Quit                                     |

---

## Tech Stack

- **Electron 35** — cross-platform desktop shell.
- **Google Generative AI SDK** (`@google/generative-ai`) — Gemini text + audio.
- **koffi** — native FFI to call Win32 `SetWindowDisplayAffinity` for screen-capture exclusion.
- **Web Audio API + MediaRecorder** — system-audio capture and VAD in the renderer.
- **unified / remark / rehype** — markdown rendering with syntax highlighting.
- **electron-log**, **electron-builder**, **electron-updater**.

---

## Project Structure

```
interview-with-ai/
├── main.js                          # Electron main process & IPC wiring
├── renderer.js                      # Renderer entry (chat UI, events)
├── prompt.txt                       # ← Edit this to customize the AI
├── index.html                       # Main window markup
└── js/
    ├── voice-handler.js             # Main-process: audio → Gemini → answer
    ├── voice-recognition-renderer.js# Renderer: system-audio capture + VAD
    ├── prompt-loader.js             # Loads prompt.txt (fork-friendly)
    ├── win-capture-hide.js          # Native WDA_EXCLUDEFROMCAPTURE hiding
    ├── chat-handler.js              # Chat conversations & streaming
    ├── ai-providers.js              # Provider clients (Gemini/OpenAI/Ollama/Azure)
    ├── window-manager.js            # Always-on-top, transparent window
    ├── hotkey-manager.js            # Global shortcuts
    ├── config-manager.js            # Settings persistence
    └── ...
```

---

## Troubleshooting

| Symptom | Cause / Fix |
| ------- | ----------- |
| **Voice listens but no answer** | Check the API key is a valid `AIzaSy...` key (not an OAuth token, not a log paste). Re-enter it in Settings. |
| **`429 quota exceeded`** | You're on `gemini-2.0-flash` (no free quota) or hit the rate limit. Switch to `gemini-2.5-flash` / `-flash-lite` and wait a minute. |
| **`503 overloaded`** | Gemini is temporarily busy. The app auto-retries and falls back to `flash-lite`; wait ~30s. |
| **Window still visible in screen share** | Requires Windows 10 build 19041+. Check `winver`. Older builds can only use the weaker fallback. |
| **No audio detected (meter stays flat)** | Voice mode captures *system* audio, not your mic — play the interviewer's audio through your speakers. |
| **macOS "app is damaged"** | Run `xattr -cr "/Applications/Interview With AI.app"`. |

---

## License

[MIT](LICENSE).

This project is a customized fork of [MinhOmega/interview-coder](https://github.com/MinhOmega/interview-coder), extended with live voice transcription, furigana support, `prompt.txt`-based customization, and native screen-capture invisibility.
