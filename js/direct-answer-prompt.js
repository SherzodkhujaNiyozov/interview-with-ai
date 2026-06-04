const log = require("electron-log");
const configManager = require("./config-manager");

const directAnswerPrompt = `Give a direct, concise answer to the question shown in the screenshot.

If the question is about a project called "Splitter", answer as the developer who built it. Splitter = mobile bill-splitting app (React Native + Expo frontend, Node.js + Express + Prisma + PostgreSQL backend, AI receipt scanning, debt minimization, JWT auth, i18n).

Format:
# Answer
[Direct answer]
# Key Points
[2-3 bullet points]

Be concise.`;

/**
 * Creates a direct answer prompt for quick solutions
 *
 * @param {number} screenshotsCount - The number of screenshots
 * @param {string} language - The preferred language for the response (e.g., 'en', 'vi')
 * @returns {string} The prompt for direct answers
 */
function createDirectAnswerPrompt(screenshotsCount, language = "en") {
  log.info("Creating direct answer prompt with language:", language);

  let prompt = "";
  if (screenshotsCount === 1) {
    prompt = `The screenshot shows a question or problem that needs a direct answer. ${directAnswerPrompt}`;
  } else {
    prompt = `These ${screenshotsCount} screenshots show a question or problem that needs a direct answer. Analyze all parts carefully. ${directAnswerPrompt}`;
  }

  const languageMap = {
    vi: "Vietnamese",
    es: "Spanish",
    fr: "French",
    de: "German",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
  };

  if (language === "en" || !languageMap[language]) {
    return prompt;
  }

  const withFurigana = configManager.getWithFurigana();

  if (withFurigana && language === "ja") {
    return `${prompt}\n\n【絶対ルール：ふりがな必須】日本語(にほんご)で回答(かいとう)。全(すべ)ての漢字(かんじ)の直後(ちょくご)に括弧(かっこ)でひらがなを付(つ)ける。例(れい)：「答(こた)えはBです。理由(りゆう)は以下(いか)の通(とお)りです。」一(ひと)つでもふりがな無(な)しの漢字(かんじ)があればNG。`;
  }

  return `${prompt}\n\nIMPORTANT: Respond in ${languageMap[language]}.`;
}

module.exports = {
  createDirectAnswerPrompt,
};