const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = "AQ.Ab8RN6KWh_jN2V4gAQFKMnVRBoaCd0JFjYG5YX_IMcYb1jS0Sw";

async function testModel(modelName) {
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: modelName });

  const systemPrompt = `【絶対ルール：ふりがな必須】
あなたの回答では、全ての漢字の直後に丸括弧でひらがなの読みを付けてください。
例外なし。一つでも漢字にふりがなが無ければ失格です。

正しい例：
「私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。」

あなたはSplitterプロジェクトの開発者です。Splitterは割り勘モバイルアプリです。
技術スタック: React Native + Expo, Node.js + Express + Prisma + PostgreSQL, Google Gemini AI, JWT認証, i18n(4言語)`;

  const chat = model.startChat({
    history: [
      {
        role: "user",
        parts: [{ text: systemPrompt }],
      },
      {
        role: "model",
        parts: [{ text: "分(わ)かりました。私(わたし)はSplitterの開発者(かいはつしゃ)として、全(すべ)ての漢字(かんじ)にふりがなを付(つ)けて回答(かいとう)します。" }],
      },
    ],
  });

  const startTime = Date.now();
  const result = await chat.sendMessage("あなたが一番苦労した機能は何ですか？詳しく教えてください。");
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== ${modelName} (${elapsed}s) ===`);
  console.log(result.response.text());
}

async function main() {
  console.log("Testing Gemini models with furigana...\n");

  try {
    await testModel("gemini-2.5-flash-lite");
  } catch (err) {
    console.error("gemini-2.5-flash-lite error:", err.message);
  }
}

main();
