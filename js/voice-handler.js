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
const { getUserDataPath } = require("./utils");
const fs = require("fs");

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
  try {
    const p = getUserDataPath("systemPrompt.txt");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch (err) {
    log.error("voice-handler: failed to load system prompt:", err);
  }
  return "";
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
    safeSend(sender, IPC_CHANNELS.VOICE_ERROR, "Gemini not initialized.");
    return;
  }

  const systemPrompt = loadSystemPrompt();
  const modelName = configManager.getCurrentModel() || "gemini-2.5-flash";

  // Build the prompt asking Gemini for structured JSON output
  const projectContext = systemPrompt
    ? `\n\n--- Splitter project context ---\n${systemPrompt}\n--- end context ---\n`
    : "";

  const prompt = `あなたは技術面接(ぎじゅつめんせつ)を受(う)けているSplitterというアプリの開発者(かいはつしゃ)です。
${projectContext}
以下(いか)は面接(めんせつ)中(ちゅう)に録音(ろくおん)された短(みじか)い音声(おんせい)クリップです。
まず音声(おんせい)を正確(せいかく)に文字起(もじお)こししてください。
次(つぎ)に、その内容(ないよう)があなたに対(たい)する「質問(しつもん)」なのか、それとも単(たん)なる挨拶(あいさつ)、自己紹介(じこしょうかい)、雑談(ざつだん)、相槌(あいづち)、案内(あんない)などの非質問(ひしつもん)なのかを判断(はんだん)してください。

質問(しつもん)である場合(ばあい)：開発者(かいはつしゃ)として日本語(にほんご)で答(こた)えてください。

【絶対(ぜったい)ルール：ふりがな必須(ひっす)】
回答(かいとう)では全(すべ)ての漢字(かんじ)の直後(ちょくご)に括弧(かっこ)でふりがなを付(つ)けてください。
例(れい)：「私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。」

【出力(しゅつりょく)形式(けいしき) — 必(かなら)ずJSONで】
{
  "transcript": "音声から書き起こした日本語のテキスト",
  "isQuestion": true または false,
  "answer": "isQuestionがtrueの場合のみ。Splitter開発者としての回答（全漢字にふりがな）。falseなら空文字列。"
}

JSONのみを返(かえ)してください。他(ほか)の説明(せつめい)は不要(ふよう)です。`;

  log.info(`voice-handler: processing utterance #${payload.seq} (${payload.durationMs}ms, ${payload.base64.length} b64 chars) with ${modelName}`);

  const model = geminiClient.getGenerativeModel({
    model: modelName,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });

  const audioPart = {
    inlineData: {
      mimeType: payload.mimeType || "audio/webm",
      data: payload.base64,
    },
  };

  let raw = "";
  try {
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }, audioPart] },
      ],
    });
    raw = result.response.text();
  } catch (err) {
    log.error(`voice-handler: Gemini call failed (utterance #${payload.seq}):`, err.message);
    return;
  }

  // Parse JSON (Gemini may sometimes wrap in markdown — strip)
  const parsed = parseJsonLenient(raw);
  if (!parsed) {
    log.warn(`voice-handler: could not parse JSON for #${payload.seq}: ${raw.slice(0, 200)}`);
    return;
  }

  const transcript = (parsed.transcript || "").trim();
  const isQuestion = Boolean(parsed.isQuestion);
  const answer = (parsed.answer || "").trim();

  if (!transcript) {
    log.info(`voice-handler: #${payload.seq} empty transcript, skipping`);
    return;
  }

  log.info(`voice-handler: #${payload.seq} → isQuestion=${isQuestion}, transcript="${transcript.slice(0, 60)}..."`);

  // Always show the transcript as a live message
  safeSend(sender, IPC_CHANNELS.VOICE_LIVE_TRANSCRIPT, {
    transcript,
    isQuestion,
    seq: payload.seq,
  });

  // If question and we have an answer, stream it as a chat response
  if (isQuestion && answer) {
    safeSend(sender, IPC_CHANNELS.CHAT_MESSAGE_STREAM_START);
    // We already have the full answer; emit as one chunk then end
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

function parseJsonLenient(text) {
  if (!text) return null;
  // Strip markdown code fences if present
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Find first { and last } to recover from stray text
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    log.warn("voice-handler: JSON.parse failed:", e.message);
    return null;
  }
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
