/**
 * Main-process voice handler — live mode.
 *
 * Renderer continuously sends utterance audio clips (typically a few seconds
 * of speech, ended on detected silence). For each utterance we ask Gemini to:
 *   1. Transcribe the Japanese audio
 *   2. Decide whether it's a question directed at the interviewee
 *   3. If yes, answer it as the Splitter developer with furigana
 *
 * Response is structured JSON so we can route transcripts vs answers
 * separately:
 *   - Transcripts → live-transcript IPC (shown as dimmed messages)
 *   - Answers → existing chat-stream IPC (rendered as AI replies)
 */

const log = require("electron-log");
const { desktopCapturer } = require("electron");
const { IPC_CHANNELS, AI_PROVIDERS } = require("./constants");
const { HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { loadPrompt } = require("./prompt-loader");

let aiProviders = null;
let configManager = null;

// Per-sender utterance queue so we never have two Gemini calls in flight
// for the same renderer at once (avoids out-of-order answers).
const senderQueues = new WeakMap();

function init(deps) {
  aiProviders = deps.aiProviders;
  configManager = deps.configManager;
}

async function getAudioSourceId() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
    if (sources.length === 0) return null;
    return sources[0].id;
  } catch (err) {
    log.error("voice-handler: getAudioSourceId failed:", err);
    return null;
  }
}

function loadSystemPrompt() {
  return loadPrompt();
}

/**
 * Sanity-check a Gemini API key before sending it over the wire.
 * Returns a human-readable reason if invalid, or null if it looks fine.
 *
 * We can't truly validate it (only Google can), but we can catch the common
 * paste mistakes that produce confusing low-level errors:
 *   - empty
 *   - whitespace/newlines (likely a log dump)
 *   - non-ASCII characters (smart quotes, ›, Cyrillic, etc.)
 *   - wrong prefix (AQ. is an OAuth token, not an API key)
 */
function validateGeminiApiKey(key) {
  if (!key || typeof key !== "string") return "missing";
  const trimmed = key.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > 200) return "too long — looks like you pasted a log or other text";
  if (/\s/.test(trimmed)) return "contains whitespace (likely a log paste)";
  // Latin-1 only — anything above U+00FF will crash fetch with ByteString error
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) > 127) {
      return `contains non-ASCII character at index ${i} (code ${trimmed.charCodeAt(i)})`;
    }
  }
  if (trimmed.startsWith("AQ.")) {
    return "this looks like an OAuth access token, not an API key. Get an API key from https://aistudio.google.com/apikey";
  }
  if (!trimmed.startsWith("AIzaSy")) {
    return "API key should start with 'AIzaSy'";
  }
  if (trimmed.length < 35 || trimmed.length > 45) {
    return `unexpected length ${trimmed.length} (expected ~39 chars)`;
  }
  return null;
}

/**
 * Queue an utterance for the given sender. We process serially per sender.
 */
async function processAudio(sender, payload) {
  if (!sender || sender.isDestroyed()) return;

  const queue = senderQueues.get(sender) || { busy: false, items: [] };
  senderQueues.set(sender, queue);
  queue.items.push(payload);

  if (queue.busy) return;
  queue.busy = true;

  while (queue.items.length > 0) {
    const item = queue.items.shift();
    try {
      await processOneUtterance(sender, item);
    } catch (err) {
      log.error("voice-handler: utterance failed:", err);
    }
  }
  queue.busy = false;
}

async function processOneUtterance(sender, payload) {
  const provider = configManager.getAiProvider();
  if (provider !== AI_PROVIDERS.GEMINI) {
    safeSend(sender, IPC_CHANNELS.VOICE_ERROR, "Live voice requires Gemini provider.");
    return;
  }
  const geminiClient = aiProviders.getGeminiAI();
  if (!geminiClient) {
    safeSend(sender, IPC_CHANNELS.VOICE_ERROR, "Gemini not initialized — paste your API key (AIzaSy...) in Settings.");
    return;
  }

  // Validate API key format — Google Gemini keys are AIzaSy... + ~33 ASCII chars.
  // If the user accidentally pasted something else (a log dump, an OAuth token),
  // bail out clearly instead of hitting confusing 401/ByteString errors later.
  const apiKey = configManager.getApiKey(AI_PROVIDERS.GEMINI);
  const keyError = validateGeminiApiKey(apiKey);
  if (keyError) {
    log.warn(`voice-handler: invalid API key — ${keyError}`);
    safeSend(sender, IPC_CHANNELS.VOICE_ERROR,
      `Invalid Gemini API key: ${keyError}. Open Settings (Ctrl+,) and paste a fresh key from https://aistudio.google.com/apikey`);
    return;
  }

  const systemPrompt = loadSystemPrompt();
  // Force a model that has a real free-tier quota. gemini-2.0-flash has
  // limit=0 on the free tier; gemini-2.5-flash and -flash-lite are the
  // models that actually work without billing enabled.
  let modelName = configManager.getCurrentModel() || "gemini-2.5-flash";
  if (modelName === "gemini-2.0-flash") {
    log.info("voice-handler: gemini-2.0-flash has no free-tier quota; using gemini-2.5-flash instead");
    modelName = "gemini-2.5-flash";
  }

  const audioPart = {
    inlineData: {
      mimeType: payload.mimeType || "audio/webm",
      data: payload.base64,
    },
  };

  log.info(`voice-handler: processing utterance #${payload.seq} (${payload.durationMs}ms, ${payload.base64.length} b64 chars) with ${modelName}`);

  // ───── STEP 1: pure transcription, no project/interview context ─────
  // Any mention of "interview" or "developer" here makes Gemini hallucinate
  // plausible interview prompts (with filler words あの, じゃあ, polite
  // forms) instead of transcribing the actual audio.
  const transcribePrompt = `添付された音声をそのまま日本語で書き起こしてください。

【絶対の禁止事項】
- 音声に含まれていない単語を一切追加しないでください
- 「あの」「えっと」「じゃあ」「はい」「お伺いしたいんですけど」などの相槌や丁寧表現を、音声に含まれていなければ絶対に追加しないでください
- 丁寧語化（〜たいんですけど、〜でしょうか等への変換）は禁止です
- 文脈の補完・推測・要約は禁止です
- ふりがな、括弧、補助記号を一切追加しないでください
- 話者が面接官だと仮定しないでください
- 話者が日本語ネイティブだと仮定しないでください

【動作】
- 音声を一語一句そのまま文字に変換するだけ
- もし無音、雑音のみ、聞き取れない場合は transcript を空文字列("")にする

【出力 — JSONのみ】
{
  "transcript": "音声の内容をそのまま。それ以外は何も書かない。"
}`;

  let transcribeRaw = "";
  try {
    transcribeRaw = await callGeminiWithRetry(geminiClient, modelName, transcribePrompt, audioPart, 2);
  } catch (err) {
    log.warn(`voice-handler: ${modelName} transcription failed (${truncate(err.message, 80)})`);
    if (isOverloaded(err) && modelName !== "gemini-2.5-flash-lite") {
      log.info("voice-handler: falling back to gemini-2.5-flash-lite for transcription");
      try {
        transcribeRaw = await callGeminiWithRetry(geminiClient, "gemini-2.5-flash-lite", transcribePrompt, audioPart, 1);
      } catch (err2) {
        notifyTranscriptError(sender, payload.seq, errorMessageFor(err2));
        return;
      }
    } else {
      notifyTranscriptError(sender, payload.seq, errorMessageFor(err));
      return;
    }
  }

  const transcribeParsed = parseJsonLenient(transcribeRaw);
  const transcript = (transcribeParsed && transcribeParsed.transcript || "").trim();
  if (!transcript) {
    log.info(`voice-handler: #${payload.seq} empty transcript (silence/noise), skipping`);
    return;
  }

  log.info(`voice-handler: #${payload.seq} transcript="${transcript.slice(0, 80)}"`);

  // ───── STEP 2: judge isQuestion + generate answer with context ─────
  const projectContext = systemPrompt
    ? `\n--- Splitter開発者としての背景情報 ---\n${systemPrompt}\n--- ここまで ---\n`
    : "";

  const judgePrompt = `あなたはSplitterというモバイル割り勘アプリを開発した開発者です。日本語の技術面接を受けています。
${projectContext}
面接官が次のように話しました（音声から書き起こされた発言）：
「${transcript}」

【タスク】
この発言が、あなた（開発者）に向けられた「具体的な質問」かどうかを判定してください。
- 質問なら: isQuestion=true、Splitter開発者として日本語で答える
- 挨拶・自己紹介・相槌・雑談・案内などの非質問なら: isQuestion=false、answerは空文字列

【answerの絶対ルール：ふりがな必須】
回答内の全ての漢字の直後に括弧でひらがなのふりがなを付ける。
例：「私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。技術(ぎじゅつ)スタックはReact Nativeです。」
一つでもふりがな無しの漢字があれば失格。ひらがな・カタカナ・英数字にはふりがな不要。

【出力 — JSONのみ】
{
  "isQuestion": true または false,
  "answer": "質問でなければ空文字列。質問なら、全漢字にふりがな付きの回答。"
}`;

  // We send judge prompt as TEXT only (no audio) — much cheaper and faster
  let judgeRaw = "";
  try {
    judgeRaw = await callGeminiWithRetryTextOnly(geminiClient, modelName, judgePrompt, 1);
  } catch (err) {
    log.warn(`voice-handler: judge call failed (${truncate(err.message, 80)})`);
    if (isOverloaded(err) && modelName !== "gemini-2.5-flash-lite") {
      try {
        judgeRaw = await callGeminiWithRetryTextOnly(geminiClient, "gemini-2.5-flash-lite", judgePrompt, 1);
      } catch (err2) {
        notifyTranscriptError(sender, payload.seq, errorMessageFor(err2));
        // Still show transcript even if judge failed
        safeSend(sender, IPC_CHANNELS.VOICE_LIVE_TRANSCRIPT, { transcript, isQuestion: false, seq: payload.seq });
        return;
      }
    } else {
      safeSend(sender, IPC_CHANNELS.VOICE_LIVE_TRANSCRIPT, { transcript, isQuestion: false, seq: payload.seq });
      return;
    }
  }

  const judgeParsed = parseJsonLenient(judgeRaw);
  const isQuestion = judgeParsed ? Boolean(judgeParsed.isQuestion) : false;
  const answer = (judgeParsed && judgeParsed.answer || "").trim();

  log.info(`voice-handler: #${payload.seq} → isQuestion=${isQuestion}, answer length=${answer.length}`);

  // Always show the transcript as a live message
  safeSend(sender, IPC_CHANNELS.VOICE_LIVE_TRANSCRIPT, {
    transcript,
    isQuestion,
    seq: payload.seq,
  });

  // If question and we have an answer, push it through the chat stream channels
  if (isQuestion && answer) {
    safeSend(sender, IPC_CHANNELS.CHAT_MESSAGE_STREAM_START);
    safeSend(sender, IPC_CHANNELS.CHAT_MESSAGE_STREAM_CHUNK, {
      content: answer,
      fullContent: answer,
    });
    safeSend(sender, IPC_CHANNELS.CHAT_MESSAGE_STREAM_END, {
      role: "assistant",
      content: answer,
    });
  }
}

function errorMessageFor(err) {
  return isOverloaded(err)
    ? "Gemini servers are overloaded. Try again in 30s."
    : `Gemini error: ${truncate(err.message, 80)}`;
}

/**
 * Call Gemini.generateContent with retry on transient overload (503).
 * Non-retryable errors (401, 400, etc.) throw immediately.
 */
async function callGeminiWithRetry(geminiClient, modelName, prompt, audioPart, maxRetries) {
  const model = geminiClient.getGenerativeModel({
    model: modelName,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: {
      temperature: 0.3, // lower → more faithful transcription, less hallucination
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }, audioPart] }],
      });
      return result.response.text();
    } catch (err) {
      lastError = err;
      if (!isOverloaded(err) || attempt === maxRetries) throw err;
      const delayMs = 1500 * (attempt + 1); // 1.5s, 3s, 4.5s
      log.info(`voice-handler: ${modelName} overloaded, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Same as callGeminiWithRetry but text-only — used for the judge/answer step
 * where we already have the transcript and don't need to re-send audio.
 */
async function callGeminiWithRetryTextOnly(geminiClient, modelName, prompt, maxRetries) {
  const model = geminiClient.getGenerativeModel({
    model: modelName,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      return result.response.text();
    } catch (err) {
      lastError = err;
      if (!isOverloaded(err) || attempt === maxRetries) throw err;
      const delayMs = 1500 * (attempt + 1);
      log.info(`voice-handler: ${modelName} overloaded (text), retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function isOverloaded(err) {
  const msg = (err && err.message) || "";
  return /\b503\b|UNAVAILABLE|high demand|overload/i.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "..." : s;
}

/**
 * Surface a transient error to the renderer as a dimmed transcript line so
 * the user knows something went wrong, instead of silent failure.
 */
function notifyTranscriptError(sender, seq, message) {
  safeSend(sender, IPC_CHANNELS.VOICE_LIVE_TRANSCRIPT, {
    transcript: `⚠ ${message}`,
    isQuestion: false,
    seq,
  });
}

function parseJsonLenient(text) {
  if (!text) return null;
  // Strip markdown code fences if present
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Try strict parse first
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      log.warn("voice-handler: strict JSON.parse failed:", e.message);
    }
  }

  // Fallback: regex-extract individual fields. This handles the common
  // failure mode where Gemini hits maxOutputTokens mid-string, leaving an
  // unterminated JSON. We can still salvage the transcript and isQuestion.
  const transcriptMatch = s.match(/"transcript"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const isQuestionMatch = s.match(/"isQuestion"\s*:\s*(true|false)/);
  const answerMatch = s.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"?/); // last quote may be missing if truncated

  if (transcriptMatch) {
    log.info("voice-handler: recovered fields via regex after JSON.parse failure");
    return {
      transcript: unescapeJsonString(transcriptMatch[1]),
      isQuestion: isQuestionMatch ? isQuestionMatch[1] === "true" : false,
      answer: answerMatch ? unescapeJsonString(answerMatch[1]) : "",
      _recovered: true,
    };
  }

  return null;
}

function unescapeJsonString(s) {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
}

function safeSend(sender, channel, data) {
  try {
    if (sender && !sender.isDestroyed()) sender.send(channel, data);
  } catch (err) {
    log.error("voice-handler: safeSend failed:", err);
  }
}

module.exports = {
  init,
  getAudioSourceId,
  processAudio,
};
