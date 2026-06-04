const { AI_PROVIDERS, IPC_CHANNELS } = require("./constants");
const { getScreenshots } = require("./screenshot-manager");
const configManager = require("./config-manager");
const aiProviders = require("./ai-providers");
const windowManager = require("./window-manager");
const { getUserDataPath } = require("./utils");
const fs = require("fs");
const toastManager = require("./toast-manager");
const log = require("electron-log");
const { createUIPrompt } = require("./ui-implementation-prompt");
const { createDirectAnswerPrompt } = require("./direct-answer-prompt");

// Store active request controllers for cancellation
let activeRequestControllers = new Set();

const basePrompt = `Analyze the screenshot and provide a clear, helpful answer.

If the screenshot contains an interview question or a question about a project called "Splitter", answer as if you are the developer who built it. Splitter is a mobile bill-splitting app built with React Native + Expo (frontend), Node.js + Express + Prisma + PostgreSQL (backend). Key features: AI receipt scanning (Google Gemini), OFD QR code parsing, debt minimization algorithm, JWT auth, i18n (4 languages), Zustand state management, feature-sliced architecture.

For coding problems, structure your response as:
# Problem Analysis
# Solution Approach
# Implementation (with code)
# Complexity Analysis

Be concise and accurate.`;

/**
 * Creates a prompt for the AI based on the number of screenshots and preferred language
 *
 * @param {number} screenshotsCount - The number of screenshots
 * @param {string} language - The preferred language for the response (e.g., 'en', 'vi')
 * @returns {string} The prompt for the AI
 */
function createPrompt(screenshotsCount, language = "en") {
  log.info("Create prompt with language:", language);
  const withFurigana = configManager.getWithFurigana();
  let prompt = "";
  if (screenshotsCount === 1) {
    prompt = `The screenshot shows a programming problem or question. ${basePrompt}`;
  } else {
    prompt = `These ${screenshotsCount} screenshots show a multi-part programming problem. ${basePrompt}`;
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

  if (withFurigana && language === "ja") {
    return `${prompt}\n\n【絶対ルール：ふりがな必須】日本語(にほんご)で回答(かいとう)。全(すべ)ての漢字(かんじ)の直後(ちょくご)に括弧(かっこ)でひらがなを付(つ)ける。例(れい)：「私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。技術(ぎじゅつ)スタックはReact Nativeです。」一(ひと)つでもふりがな無(な)しの漢字(かんじ)があればNG。`;
  }

  let languageInstruction = `\n\nIMPORTANT: Please respond entirely in ${languageMap[language]} language.`;

  return `${prompt}${languageInstruction}`;
}

/**
 * Processes the screenshots with the AI
 *
 * @param {BrowserWindow} mainWindow - The main application window
 * @param {string} aiProvider - The AI provider
 * @param {string} currentModel - The current model
 * @param {function} verifyOllamaModelFn - The function to verify the Ollama model
 * @param {function} generateWithOllamaFn - The function to generate with Ollama
 * @param {function} generateWithGeminiFn - The function to generate with Gemini
 * @param {boolean} useStreaming - Whether to use streaming
 */
async function processScreenshots(
  mainWindow,
  aiProvider,
  currentModel,
  verifyOllamaModelFn,
  generateWithOllamaFn,
  generateWithGeminiFn,
  useStreaming = false,
) {
  try {
    mainWindow.webContents.send("loading", true);
    const screenshots = getScreenshots();

    // Get the user's preferred response language
    const responseLanguage = configManager.getResponseLanguage();

    if (aiProvider === AI_PROVIDERS.OLLAMA) {
      const modelVerification = await verifyOllamaModelFn(currentModel);

      if (!modelVerification.exists) {
        let errorMessage = `The selected model "${currentModel}" is not available: ${modelVerification.error}`;
        throw new Error(errorMessage);
      }
    }

    const promptText = createPrompt(screenshots.length, responseLanguage);
    log.info("Prompt text in processScreenshots:", promptText);

    const messages = [{ type: "text", text: promptText }];

    for (const img of screenshots) {
      const imageData = img.startsWith("data:image/") ? img : `data:image/png;base64,${img}`;
      messages.push({
        type: "image_url",
        image_url: { url: imageData },
      });
    }

    let result;

    if (aiProvider === AI_PROVIDERS.DEFAULT) {
      // Create model selection window when the default provider is selected
      windowManager.createModelSelectionWindow();

      // Return early since we're opening the model selection window instead of processing
      mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
      mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
      return;
    }

    if (aiProvider === AI_PROVIDERS.OPENAI) {
      // Get OpenAI client from AI providers module
      const openai = aiProviders.getOpenAI();

      if (!openai) {
        throw new Error("OpenAI client is not initialized. Please go to Settings and enter your API key.");
      }

      if (useStreaming) {
        const stream = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: "user", content: messages }],
          max_tokens: 8000,
          stream: true,
        });

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            mainWindow.webContents.send(IPC_CHANNELS.STREAM_CHUNK, content);
          }
        }

        mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
        mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        return;
      } else {
        const response = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: "user", content: messages }],
          max_tokens: 8000,
        });

        result = response.choices[0].message.content;
      }
    } else if (aiProvider === AI_PROVIDERS.OLLAMA) {
      result = await generateWithOllamaFn(messages, currentModel);
    } else if (aiProvider === AI_PROVIDERS.GEMINI) {
      // Get Gemini client from AI providers module if not provided
      const geminiAI = aiProviders.getGeminiAI();

      if (!geminiAI) {
        throw new Error("Gemini AI client is not initialized. Please go to Settings and enter your API key.");
      }

      if (useStreaming) {
        const streamingResult = await generateWithGeminiFn(messages, currentModel, true);

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);

        let accumulatedText = "";

        streamingResult.emitter.on("chunk", (chunk) => {
          accumulatedText += chunk;
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_UPDATE, accumulatedText);
        });

        streamingResult.emitter.on("complete", () => {
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        streamingResult.emitter.on("error", (error) => {
          toastManager.error(`${error.message}`);
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        return;
      } else {
        result = await generateWithGeminiFn(messages, currentModel);
      }
    } else if (aiProvider === AI_PROVIDERS.AZURE_FOUNDRY) {
      // Try to reinitialize Azure Foundry if not already initialized
      let azureFoundryClient = aiProviders.getAzureFoundryClient();

      if (!azureFoundryClient) {
        // Try to initialize from config if not already initialized
        console.log("Azure Foundry client not found, attempting to initialize from config...");
        aiProviders.initializeFromConfig();
        azureFoundryClient = aiProviders.getAzureFoundryClient();

        if (!azureFoundryClient) {
          throw new Error("Azure Foundry client is not initialized. Please go to Settings and enter your API key and endpoint.");
        }
      }

      if (useStreaming) {
        const streamingResult = await aiProviders.generateWithAzureFoundry(messages, currentModel, true);

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);

        let accumulatedText = "";

        streamingResult.emitter.on("chunk", (chunk) => {
          accumulatedText += chunk;
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_UPDATE, accumulatedText);
        });

        streamingResult.emitter.on("complete", () => {
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        streamingResult.emitter.on("error", (error) => {
          toastManager.error(`${error.message}`);
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        return;
      } else {
        result = await aiProviders.generateWithAzureFoundry(messages, currentModel, false);
      }
    } else {
      throw new Error(`Unknown AI provider: ${aiProvider}`);
    }

    mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);

    mainWindow.webContents.send(IPC_CHANNELS.ANALYSIS_RESULT, result);

    mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
  } catch (err) {
    log.error("Error in processScreenshots:", err);
    log.error("Stack trace:", err.stack);

    if (err.response) {
      log.error("Response status:", err.response.status);
      log.error("Response data:", JSON.stringify(err.response.data));
    }

    mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
    mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
    toastManager.error(`${err.message}`);
  }
}

/**
 * Processes a chat message with the AI
 *
 * @param {BrowserWindow} window - The window sending the message
 * @param {Array} messageHistory - The message history including user and AI messages
 * @param {string} systemPrompt - Optional system prompt to include
 */
async function processChatMessage(window, messageHistory, systemPrompt) {
  try {
    // Get current AI settings
    const settings = configManager.getCurrentSettings();
    const { aiProvider, currentModel } = settings;

    if (!aiProvider || aiProvider === AI_PROVIDERS.DEFAULT) {
      toastManager.error("Please configure an AI provider in settings first.");
      return;
    }

    let messages = [];

    // Add system prompt if provided
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    // Add message history
    messageHistory.forEach((msg) => {
      messages.push({ role: msg.role, content: msg.content });
    });

    let response;

    if (aiProvider === AI_PROVIDERS.OPENAI) {
      // Get OpenAI client
      const openai = aiProviders.getOpenAI();

      if (!openai) {
        throw new Error("OpenAI client is not initialized. Please go to Settings and enter your API key.");
      }

      const result = await openai.chat.completions.create({
        model: currentModel,
        messages: messages,
        max_tokens: 4000,
      });

      response = { role: "assistant", content: result.choices[0].message.content };
    } else if (aiProvider === AI_PROVIDERS.GEMINI) {
      // Get Gemini client
      const geminiAI = aiProviders.getGeminiAI();

      if (!geminiAI) {
        throw new Error("Gemini AI client is not initialized. Please go to Settings and enter your API key.");
      }

      // Handle system prompts for Gemini by converting to user prompts if needed
      const geminiMessages = messages.map((msg) => {
        // For Gemini, convert system role to user role since Gemini doesn't support system
        if (msg.role === "system") {
          return { role: "user", parts: [{ text: msg.content }] };
        }
        return { role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] };
      });

      const result = await geminiAI.generateContent({
        contents: geminiMessages,
        generationConfig: {
          maxOutputTokens: 8192,
        },
      });

      response = { role: "assistant", content: result.response.text() };
    } else if (aiProvider === AI_PROVIDERS.OLLAMA) {
      // Use Ollama client
      const result = await aiProviders.generateWithOllama(
        messages.map((msg) => msg.content),
        currentModel,
      );

      response = { role: "assistant", content: result };
    }

    // Send response back to renderer
    window.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_RESPONSE, response);
  } catch (error) {
    log.error("Error in processChatMessage:", error);
    toastManager.error(`${error.message}`);
    // Send a fallback error response
    window.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_RESPONSE, {
      role: "assistant",
      content:
        "I'm sorry, I encountered an error while processing your message. Please try again or check your AI provider settings.",
    });
  }
}

/**
 * Gets the system prompt from file if it exists
 *
 * @returns {string} The system prompt or empty string if not found
 */
function getSystemPrompt() {
  try {
    const systemPromptFile = getUserDataPath("systemPrompt.txt");
    if (fs.existsSync(systemPromptFile)) {
      return fs.readFileSync(systemPromptFile, "utf8");
    }
  } catch (error) {
    log.error("Error loading system prompt:", error);
  }
  return "";
}

/**
 * Processes screenshots specifically for UI implementation
 *
 * @param {BrowserWindow} mainWindow - The main application window
 * @param {string} aiProvider - The AI provider
 * @param {string} currentModel - The current model
 * @param {function} verifyOllamaModelFn - The function to verify the Ollama model
 * @param {function} generateWithOllamaFn - The function to generate with Ollama
 * @param {function} generateWithGeminiFn - The function to generate with Gemini
 * @param {boolean} useStreaming - Whether to use streaming
 */
async function processScreenshotsForUI(
  mainWindow,
  aiProvider,
  currentModel,
  verifyOllamaModelFn,
  generateWithOllamaFn,
  generateWithGeminiFn,
  useStreaming = false,
) {
  try {
    mainWindow.webContents.send("loading", true);
    const screenshots = getScreenshots();

    if (aiProvider === AI_PROVIDERS.OLLAMA) {
      const modelVerification = await verifyOllamaModelFn(currentModel);

      if (!modelVerification.exists) {
        let errorMessage = `The selected model "${currentModel}" is not available: ${modelVerification.error}`;
        throw new Error(errorMessage);
      }
    }

    // Use the specialized UI implementation prompt
    const promptText = createUIPrompt(screenshots.length);
    log.info("UI implementation prompt created for", screenshots.length, "screenshots");

    const messages = [{ type: "text", text: promptText }];

    for (const img of screenshots) {
      const imageData = img.startsWith("data:image/") ? img : `data:image/png;base64,${img}`;
      messages.push({
        type: "image_url",
        image_url: { url: imageData },
      });
    }

    let result;

    if (aiProvider === AI_PROVIDERS.DEFAULT) {
      // Create model selection window when the default provider is selected
      windowManager.createModelSelectionWindow();

      // Return early since we're opening the model selection window instead of processing
      mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
      mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
      return;
    }

    if (aiProvider === AI_PROVIDERS.OPENAI) {
      // Get OpenAI client from AI providers module
      const openai = aiProviders.getOpenAI();

      if (!openai) {
        throw new Error("OpenAI client is not initialized. Please go to Settings and enter your API key.");
      }

      if (useStreaming) {
        const stream = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: "user", content: messages }],
          max_tokens: 8000,
          stream: true,
        });

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);
        mainWindow.webContents.send(IPC_CHANNELS.UI_IMPLEMENTATION_MODE, true);

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            mainWindow.webContents.send(IPC_CHANNELS.STREAM_CHUNK, content);
          }
        }

        mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
        mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        return;
      } else {
        const response = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: "user", content: messages }],
          max_tokens: 8000,
        });

        result = response.choices[0].message.content;
      }
    } else if (aiProvider === AI_PROVIDERS.OLLAMA) {
      result = await generateWithOllamaFn(messages, currentModel);
    } else if (aiProvider === AI_PROVIDERS.GEMINI) {
      // Get Gemini client from AI providers module if not provided
      const geminiAI = aiProviders.getGeminiAI();

      if (!geminiAI) {
        throw new Error("Gemini AI client is not initialized. Please go to Settings and enter your API key.");
      }

      if (useStreaming) {
        const streamingResult = await generateWithGeminiFn(messages, currentModel, true);

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);
        mainWindow.webContents.send(IPC_CHANNELS.UI_IMPLEMENTATION_MODE, true);

        let accumulatedText = "";

        streamingResult.emitter.on("chunk", (chunk) => {
          accumulatedText += chunk;
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_UPDATE, accumulatedText);
        });

        streamingResult.emitter.on("complete", () => {
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        streamingResult.emitter.on("error", (error) => {
          toastManager.error(`${error.message}`);
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        return;
      } else {
        result = await generateWithGeminiFn(messages, currentModel);
      }
    } else if (aiProvider === AI_PROVIDERS.AZURE_FOUNDRY) {
      // Try to reinitialize Azure Foundry if not already initialized
      let azureFoundryClient = aiProviders.getAzureFoundryClient();

      if (!azureFoundryClient) {
        // Try to initialize from config if not already initialized
        console.log("Azure Foundry client not found, attempting to initialize from config...");
        aiProviders.initializeFromConfig();
        azureFoundryClient = aiProviders.getAzureFoundryClient();

        if (!azureFoundryClient) {
          throw new Error("Azure Foundry client is not initialized. Please go to Settings and enter your API key and endpoint.");
        }
      }

      if (useStreaming) {
        const streamingResult = await aiProviders.generateWithAzureFoundry(messages, currentModel, true);

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);
        mainWindow.webContents.send(IPC_CHANNELS.UI_IMPLEMENTATION_MODE, true);

        let accumulatedText = "";

        streamingResult.emitter.on("chunk", (chunk) => {
          accumulatedText += chunk;
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_UPDATE, accumulatedText);
        });

        streamingResult.emitter.on("complete", () => {
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        streamingResult.emitter.on("error", (error) => {
          toastManager.error(`${error.message}`);
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        return;
      } else {
        result = await aiProviders.generateWithAzureFoundry(messages, currentModel, false);
      }
    } else {
      throw new Error(`Unknown AI provider: ${aiProvider}`);
    }

    mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
    mainWindow.webContents.send(IPC_CHANNELS.UI_IMPLEMENTATION_MODE, true);
    mainWindow.webContents.send(IPC_CHANNELS.ANALYSIS_RESULT, result);
    mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
  } catch (err) {
    log.error("Error in processScreenshotsForUI:", err);
    log.error("Stack trace:", err.stack);

    if (err.response) {
      log.error("Response status:", err.response.status);
      log.error("Response data:", JSON.stringify(err.response.data));
    }

    mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
    mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
    toastManager.error(`${err.message}`);
  }
}

/**
 * Processes screenshots for direct answers (quick solutions)
 *
 * @param {BrowserWindow} mainWindow - The main application window
 * @param {string} aiProvider - The AI provider
 * @param {string} currentModel - The current model
 * @param {function} verifyOllamaModelFn - The function to verify the Ollama model
 * @param {function} generateWithOllamaFn - The function to generate with Ollama
 * @param {function} generateWithGeminiFn - The function to generate with Gemini
 * @param {boolean} useStreaming - Whether to use streaming
 */
async function processScreenshotsForDirectAnswer(
  mainWindow,
  aiProvider,
  currentModel,
  verifyOllamaModelFn,
  generateWithOllamaFn,
  generateWithGeminiFn,
  useStreaming = false,
) {
  // Create an abort controller for this request
  const abortController = new AbortController();
  activeRequestControllers.add(abortController);

  try {
    mainWindow.webContents.send("loading", true);
    const screenshots = getScreenshots();

    // Get the user's preferred response language
    const responseLanguage = configManager.getResponseLanguage();

    if (aiProvider === AI_PROVIDERS.OLLAMA) {
      const modelVerification = await verifyOllamaModelFn(currentModel);

      if (!modelVerification.exists) {
        let errorMessage = `The selected model "${currentModel}" is not available: ${modelVerification.error}`;
        throw new Error(errorMessage);
      }
    }

    // Use the direct answer prompt instead of base prompt
    const promptText = createDirectAnswerPrompt(screenshots.length, responseLanguage);
    log.info("Direct answer prompt created for", screenshots.length, "screenshots");

    const messages = [{ type: "text", text: promptText }];

    for (const img of screenshots) {
      const imageData = img.startsWith("data:image/") ? img : `data:image/png;base64,${img}`;
      messages.push({
        type: "image_url",
        image_url: { url: imageData },
      });
    }

    let result;

    if (aiProvider === AI_PROVIDERS.DEFAULT) {
      // Create model selection window when the default provider is selected
      windowManager.createModelSelectionWindow();

      // Return early since we're opening the model selection window instead of processing
      mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
      mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
      return;
    }

    if (aiProvider === AI_PROVIDERS.OPENAI) {
      // Get OpenAI client from AI providers module
      const openai = aiProviders.getOpenAI();

      if (!openai) {
        throw new Error("OpenAI client is not initialized. Please go to Settings and enter your API key.");
      }

      if (useStreaming) {
        const stream = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: "user", content: messages }],
          max_tokens: 4000, // Shorter max tokens for direct answers
          stream: true,
          signal: abortController.signal,
        });

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);
        mainWindow.webContents.send(IPC_CHANNELS.DIRECT_ANSWER_MODE, true);

        for await (const chunk of stream) {
          // Check if request was cancelled
          if (abortController.signal.aborted) {
            break;
          }
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            mainWindow.webContents.send(IPC_CHANNELS.STREAM_CHUNK, content);
          }
        }

        mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
        mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        return;
      } else {
        const response = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: "user", content: messages }],
          max_tokens: 4000,
          signal: abortController.signal,
        });

        result = response.choices[0].message.content;
      }
    } else if (aiProvider === AI_PROVIDERS.OLLAMA) {
      result = await generateWithOllamaFn(messages, currentModel);
    } else if (aiProvider === AI_PROVIDERS.GEMINI) {
      // Get Gemini client from AI providers module if not provided
      const geminiAI = aiProviders.getGeminiAI();

      if (!geminiAI) {
        throw new Error("Gemini AI client is not initialized. Please go to Settings and enter your API key.");
      }

      if (useStreaming) {
        const streamingResult = await generateWithGeminiFn(messages, currentModel, true);

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);
        mainWindow.webContents.send(IPC_CHANNELS.DIRECT_ANSWER_MODE, true);

        let accumulatedText = "";

        streamingResult.emitter.on("chunk", (chunk) => {
          if (abortController.signal.aborted) {
            streamingResult.emitter.removeAllListeners();
            return;
          }
          accumulatedText += chunk;
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_UPDATE, accumulatedText);
        });

        streamingResult.emitter.on("complete", () => {
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        streamingResult.emitter.on("error", (error) => {
          if (!abortController.signal.aborted) {
            toastManager.error(`${error.message}`);
          }
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        return;
      } else {
        result = await generateWithGeminiFn(messages, currentModel);
      }
    } else if (aiProvider === AI_PROVIDERS.AZURE_FOUNDRY) {
      // Try to reinitialize Azure Foundry if not already initialized
      let azureFoundryClient = aiProviders.getAzureFoundryClient();

      if (!azureFoundryClient) {
        // Try to initialize from config if not already initialized
        console.log("Azure Foundry client not found, attempting to initialize from config...");
        aiProviders.initializeFromConfig();
        azureFoundryClient = aiProviders.getAzureFoundryClient();

        if (!azureFoundryClient) {
          throw new Error("Azure Foundry client is not initialized. Please go to Settings and enter your API key and endpoint.");
        }
      }

      if (useStreaming) {
        const streamingResult = await aiProviders.generateWithAzureFoundry(messages, currentModel, true);

        mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_START);
        mainWindow.webContents.send(IPC_CHANNELS.DIRECT_ANSWER_MODE, true);

        let accumulatedText = "";

        streamingResult.emitter.on("chunk", (chunk) => {
          if (abortController.signal.aborted) {
            streamingResult.emitter.removeAllListeners();
            return;
          }
          accumulatedText += chunk;
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_UPDATE, accumulatedText);
        });

        streamingResult.emitter.on("complete", () => {
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        streamingResult.emitter.on("error", (error) => {
          if (!abortController.signal.aborted) {
            toastManager.error(`${error.message}`);
          }
          mainWindow.webContents.send(IPC_CHANNELS.STREAM_END);
          mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
        });

        return;
      } else {
        result = await aiProviders.generateWithAzureFoundry(messages, currentModel, false);
      }
    } else {
      throw new Error(`Unknown AI provider: ${aiProvider}`);
    }

    mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
    mainWindow.webContents.send(IPC_CHANNELS.DIRECT_ANSWER_MODE, true);
    mainWindow.webContents.send(IPC_CHANNELS.ANALYSIS_RESULT, result);
    mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
  } catch (err) {
    // Don't show error if request was cancelled
    if (!abortController.signal.aborted) {
      log.error("Error in processScreenshotsForDirectAnswer:", err);
      log.error("Stack trace:", err.stack);

      if (err.response) {
        log.error("Response status:", err.response.status);
        log.error("Response data:", JSON.stringify(err.response.data));
      }

      toastManager.error(`${err.message}`);
    }

    mainWindow.webContents.send(IPC_CHANNELS.LOADING, false);
    mainWindow.webContents.send(IPC_CHANNELS.HIDE_INSTRUCTION);
  } finally {
    // Clean up the controller
    activeRequestControllers.delete(abortController);
  }
}

/**
 * Cancels all active AI requests
 */
function cancelAllRequests() {
  log.info(`Cancelling ${activeRequestControllers.size} active AI requests`);

  activeRequestControllers.forEach(controller => {
    try {
      controller.abort();
    } catch (error) {
      log.error("Error aborting request:", error);
    }
  });

  activeRequestControllers.clear();
}

module.exports = {
  createPrompt,
  processScreenshots,
  processScreenshotsForUI,
  processScreenshotsForDirectAnswer,
  processChatMessage,
  getSystemPrompt,
  cancelAllRequests,
};
