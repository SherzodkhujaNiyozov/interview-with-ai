/**
 * Live voice capture with VAD (Voice Activity Detection).
 *
 * Once started, this records continuously and uses an AudioContext analyser
 * to detect when the interviewer is speaking vs silent. When a silence longer
 * than END_OF_UTTERANCE_MS is detected after some speech, we finalize the
 * current utterance, ship it to main for Gemini to transcribe + (if it's a
 * question) answer, then immediately start recording the next utterance.
 *
 * This means the user can leave it running for the whole interview and
 * questions get answered automatically as they're asked.
 */

const { ipcRenderer } = require("electron");
const { IPC_CHANNELS } = require("./constants");

// VAD tuning constants
const VAD_TICK_MS = 100;             // how often we sample volume
const VAD_VOLUME_THRESHOLD = 0.005;  // RMS threshold for "speech" (0–1). Lower = more sensitive.
const END_OF_UTTERANCE_MS = 1300;    // silence after speech → finalize utterance
const MIN_UTTERANCE_MS = 700;        // discard shorter blips (noise)
const MAX_UTTERANCE_MS = 25000;      // safety: force flush even if no silence
const DEBUG_LOG_INTERVAL_MS = 1500;  // log peak RMS every ~1.5s so user can verify audio

let mediaStream = null;
let audioContext = null;
let analyser = null;
let mediaRecorder = null;
let recorderChunks = [];
let recorderMimeType = "";
let vadIntervalId = null;
let isListening = false;
let pillElement = null;
let utteranceStartTime = 0;
let lastSpeechTime = 0;
let inSpeech = false;
let utteranceCounter = 0;
let peakRmsSinceLastLog = 0;
let lastDebugLogTime = 0;

function ensurePill() {
  if (pillElement) return pillElement;
  pillElement = document.createElement("div");
  pillElement.id = "voice-recording-pill";
  pillElement.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(220, 38, 38, 0.95);
    color: white;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    z-index: 99999;
    display: none;
    align-items: center;
    gap: 8px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    user-select: none;
    pointer-events: none;
  `;
  pillElement.innerHTML = `
    <span id="voice-pill-dot" style="
      display: inline-block;
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
      animation: voice-pulse 1s ease-in-out infinite;
    "></span>
    <span id="voice-pill-text">Live listening...</span>
  `;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes voice-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.4); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(pillElement);
  return pillElement;
}

function setPill(text, color) {
  const pill = ensurePill();
  if (color) pill.style.background = color;
  const t = pill.querySelector("#voice-pill-text");
  if (t && text) t.textContent = text;
  pill.style.display = "flex";
}

function hidePill() {
  if (pillElement) pillElement.style.display = "none";
}

async function getSystemAudioStream() {
  const sourceId = await ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_AUDIO_SOURCE);
  if (!sourceId) throw new Error("No screen source available");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
      },
    },
  });

  stream.getVideoTracks().forEach((t) => t.stop());
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("No audio track in desktop capture");
  }
  return stream;
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function startNewRecorder() {
  recorderChunks = [];
  const audioOnlyStream = new MediaStream(mediaStream.getAudioTracks());
  recorderMimeType = pickMimeType();
  try {
    mediaRecorder = new MediaRecorder(
      audioOnlyStream,
      recorderMimeType ? { mimeType: recorderMimeType } : undefined
    );
  } catch (err) {
    console.error("[voice] recorder init failed:", err);
    setPill(`⚠ Recorder failed: ${err.message}`, "rgba(180,30,30,0.95)");
    return false;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recorderChunks.push(e.data);
  };

  mediaRecorder.onerror = (e) => {
    console.error("[voice] recorder error:", e);
  };

  mediaRecorder.start();
  utteranceStartTime = Date.now();
  inSpeech = false;
  lastSpeechTime = 0;
  return true;
}

async function finalizeUtteranceAndShip() {
  if (!mediaRecorder) return;
  const duration = Date.now() - utteranceStartTime;

  // Stop current recorder to get final blob, then immediately restart
  const stopPromise = new Promise((resolve) => {
    mediaRecorder.addEventListener("stop", resolve, { once: true });
  });

  try {
    mediaRecorder.stop();
    await stopPromise;
  } catch (err) {
    console.error("[voice] stop error:", err);
  }

  const chunks = recorderChunks;
  const mime = recorderMimeType || "audio/webm";

  // Restart for next utterance as fast as possible
  if (isListening) {
    startNewRecorder();
  }

  // Skip very short blips (likely noise)
  if (duration < MIN_UTTERANCE_MS) {
    console.log(`[voice] skipping ${duration}ms blip`);
    return;
  }

  // Combine chunks into one blob
  const blob = new Blob(chunks, { type: mime });
  if (blob.size < 1500) {
    console.log("[voice] skipping ~empty blob:", blob.size, "bytes");
    return;
  }

  // Send to main
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = bufferToBase64(arrayBuffer);
  utteranceCounter++;
  const seq = utteranceCounter;
  console.log(`[voice] shipping utterance #${seq}: ${blob.size} bytes, ${duration}ms`);

  ipcRenderer.send(IPC_CHANNELS.VOICE_SUBMIT_AUDIO, {
    base64,
    mimeType: mime,
    durationMs: duration,
    seq,
    live: true,
  });
}

function tickVAD() {
  if (!analyser || !mediaRecorder) return;
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);
  // Compute RMS
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSq / buffer.length);

  const now = Date.now();
  const utteranceDuration = now - utteranceStartTime;

  // Track peak so we can debug-log it periodically
  if (rms > peakRmsSinceLastLog) peakRmsSinceLastLog = rms;
  if (now - lastDebugLogTime >= DEBUG_LOG_INTERVAL_MS) {
    const status = peakRmsSinceLastLog >= VAD_VOLUME_THRESHOLD ? "✓ SPEECH" : "(silent)";
    console.log(`[voice] audio level — peak RMS=${peakRmsSinceLastLog.toFixed(4)} threshold=${VAD_VOLUME_THRESHOLD} ${status}`);
    updatePillLevel(peakRmsSinceLastLog);
    peakRmsSinceLastLog = 0;
    lastDebugLogTime = now;
  }

  if (rms >= VAD_VOLUME_THRESHOLD) {
    // Detected speech
    if (!inSpeech) {
      inSpeech = true;
      console.log("[voice] speech start (rms=", rms.toFixed(4), ")");
    }
    lastSpeechTime = now;
  }

  // Force flush if utterance is too long
  if (utteranceDuration >= MAX_UTTERANCE_MS && inSpeech) {
    console.log("[voice] max utterance length reached, flushing");
    finalizeUtteranceAndShip();
    return;
  }

  // End-of-utterance detection: had speech, then silence for END_OF_UTTERANCE_MS
  if (inSpeech && lastSpeechTime > 0 && now - lastSpeechTime >= END_OF_UTTERANCE_MS) {
    console.log(`[voice] end-of-utterance (silence ${now - lastSpeechTime}ms)`);
    finalizeUtteranceAndShip();
  }
}

function updatePillLevel(rms) {
  if (!pillElement) return;
  const t = pillElement.querySelector("#voice-pill-text");
  if (!t) return;
  // Map RMS [0..0.1] to bar [0..15 chars]
  const barLen = Math.min(15, Math.round(rms * 150));
  const bar = "▓".repeat(barLen) + "░".repeat(15 - barLen);
  const detecting = rms >= VAD_VOLUME_THRESHOLD ? "🎤 hearing" : "👂 listening";
  t.textContent = `${detecting} [${bar}]`;
}

async function startListening() {
  if (isListening) return;
  try {
    mediaStream = await getSystemAudioStream();
  } catch (err) {
    console.error("[voice] system audio failed:", err);
    setPill(`⚠ ${err.message}`, "rgba(180,30,30,0.95)");
    setTimeout(hidePill, 5000);
    return;
  }

  // Set up analyser for VAD
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(
    new MediaStream(mediaStream.getAudioTracks())
  );
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);

  if (!startNewRecorder()) {
    stopListening();
    return;
  }

  peakRmsSinceLastLog = 0;
  lastDebugLogTime = Date.now();
  vadIntervalId = setInterval(tickVAD, VAD_TICK_MS);
  isListening = true;
  updateButtonState();
  setPill("👂 listening [░░░░░░░░░░░░░░░]");
  ipcRenderer.send(IPC_CHANNELS.VOICE_STATE_CHANGED, { listening: true });
  console.log("[voice] live mode started — peak RMS will be logged every 1.5s");
}

function stopListening() {
  if (vadIntervalId) {
    clearInterval(vadIntervalId);
    vadIntervalId = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;
  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
    audioContext = null;
  }
  analyser = null;
  if (mediaStream) {
    try { mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    mediaStream = null;
  }
  isListening = false;
  updateButtonState();
  hidePill();
  ipcRenderer.send(IPC_CHANNELS.VOICE_STATE_CHANGED, { listening: false });
  console.log("[voice] stopped");
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    );
  }
  return btoa(binary);
}

function toggleVoice() {
  if (isListening) stopListening();
  else startListening();
}

// UI updates for live transcript / Q&A
function appendLiveTranscript(text, isQuestion) {
  const container = document.getElementById("split-messages-container");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "message user-message";
  div.style.opacity = isQuestion ? "1" : "0.55";
  const icon = isQuestion ? "❓" : "🎤";
  div.innerHTML = `<div><strong>${icon} ${isQuestion ? "Question heard" : "Heard"}:</strong> ${escapeHtml(text)}</div>`;
  container.appendChild(div);
  scrollToBottom(container);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function updateButtonState() {
  const btn = document.getElementById("voice-listen-btn");
  const dot = document.getElementById("voice-listen-dot");
  if (btn) {
    btn.title = isListening
      ? "Stop listening (Ctrl+Shift+L)"
      : "Start live voice listening (Ctrl+Shift+L)";
    btn.style.background = isListening ? "rgba(220, 38, 38, 0.15)" : "";
  }
  if (dot) {
    dot.style.display = isListening ? "block" : "none";
  }
}

function wireButton() {
  const btn = document.getElementById("voice-listen-btn");
  if (!btn) {
    // Button not yet in DOM — retry after a short delay
    setTimeout(wireButton, 300);
    return;
  }
  btn.addEventListener("click", () => {
    console.log("[voice] button clicked");
    toggleVoice();
  });
  console.log("[voice] button wired up");
}

function init() {
  ipcRenderer.on(IPC_CHANNELS.VOICE_TOGGLE, () => {
    console.log("[voice] IPC VOICE_TOGGLE received");
    toggleVoice();
  });

  // Live transcript: just show the heard text
  ipcRenderer.on(IPC_CHANNELS.VOICE_LIVE_TRANSCRIPT, (_, payload) => {
    appendLiveTranscript(payload.transcript, payload.isQuestion);
  });

  // Streamed answer for a detected question — reuse existing chat stream UI
  ipcRenderer.on(IPC_CHANNELS.VOICE_QUESTION_ANSWER_START, () => {
    const typingIndicator = document.getElementById("split-typing-indicator");
    if (typingIndicator) typingIndicator.classList.add("visible");
  });

  // Wire up the visible button (works even if global hotkey is blocked)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireButton);
  } else {
    wireButton();
  }

  console.log("[voice] live handler initialized");
}

module.exports = { init, toggleVoice };
