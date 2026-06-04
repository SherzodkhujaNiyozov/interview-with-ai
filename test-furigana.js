const axios = require("axios");

async function testFurigana() {
  const systemPrompt = `【絶対ルール：ふりがな必須】
あなたの回答では、全ての漢字の直後に丸括弧でひらがなの読みを付けてください。
例外なし。一つでも漢字にふりがなが無ければ失格です。

正しい例：
「私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。技術(ぎじゅつ)スタックはReact Nativeです。」
「認証(にんしょう)にはJWTを使(つか)っています。」

間違った例：
「私はSplitterを開発しました」← ふりがなが無いのでNG`;

  const messages = [
    {
      role: "user",
      content: "このプロジェクトの技術スタックを教えてください。"
    },
    {
      role: "assistant",
      content: "私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。\n\nフロントエンドにはReact Native + Expoを使(つか)い、バックエンドにはNode.js + Express + Prisma + PostgreSQLを採用(さいよう)しました。"
    },
    {
      role: "user",
      content: "あなたが一番苦労した機能は何ですか？\n\n（※回答(かいとう)の全(すべ)ての漢字(かんじ)にふりがなを付(つ)けてください。例(れい)：私(わたし)は開発(かいはつ)しました。）"
    }
  ];

  console.log("Testing qwen2.5:7b with furigana...\n");

  try {
    const response = await axios.post("http://127.0.0.1:11434/api/chat", {
      model: "qwen2.5:7b",
      messages: messages,
      system: systemPrompt,
      stream: false,
      options: { temperature: 0.7 },
      keep_alive: "10m"
    });

    console.log("=== qwen2.5:7b Response ===");
    console.log(response.data.message.content);
    console.log("\n=== Timing ===");
    console.log(`Total: ${(response.data.total_duration / 1e9).toFixed(1)}s`);
    console.log(`Eval: ${(response.data.eval_duration / 1e9).toFixed(1)}s`);
  } catch (err) {
    console.error("Error:", err.message);
  }

  console.log("\n\nTesting qwen2.5:3b with furigana...\n");

  try {
    const response = await axios.post("http://127.0.0.1:11434/api/chat", {
      model: "qwen2.5:3b",
      messages: messages,
      system: systemPrompt,
      stream: false,
      options: { temperature: 0.7 },
      keep_alive: "10m"
    });

    console.log("=== qwen2.5:3b Response ===");
    console.log(response.data.message.content);
    console.log("\n=== Timing ===");
    console.log(`Total: ${(response.data.total_duration / 1e9).toFixed(1)}s`);
    console.log(`Eval: ${(response.data.eval_duration / 1e9).toFixed(1)}s`);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testFurigana();
