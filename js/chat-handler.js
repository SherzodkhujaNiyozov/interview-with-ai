const axios = require("axios");
const { AI_PROVIDERS } = require("./constants");
const { getUserDataPath } = require("./utils");
const { loadPrompt } = require("./prompt-loader");
const fs = require("fs");
const { HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const EventEmitter = require("events");

/**
 * Handles chat functionality with AI models
 * Maintains conversation context and processes messages
 */
class ChatHandler {
  constructor(aiProviders, configManager) {
    this.aiProviders = aiProviders;
    this.configManager = configManager;
    this.conversations = new Map(); // Store conversations by window ID
    this.systemPrompts = new Map(); // Store system prompts by window ID

    // Initialize AI providers
    this.initializeAIProviders();
  }

  /**
   * Initialize AI providers from configuration
   */
  initializeAIProviders() {
    try {
      // Force initialization of AI providers
      const initStatus = this.aiProviders.initializeFromConfig();
      console.log("Chat handler initialized AI providers with status:", initStatus);

      // Get current provider from configuration
      const currentProvider = this.configManager.getAiProvider();
      console.log(`Current AI provider configured: ${currentProvider}`);

      // Check if the configured provider is initialized
      if (currentProvider === AI_PROVIDERS.GEMINI && !this.aiProviders.getGeminiAI()) {
        console.warn("Gemini AI is configured but not initialized");
      } else if (currentProvider === AI_PROVIDERS.OPENAI && !this.aiProviders.getOpenAI()) {
        console.warn("OpenAI is configured but not initialized");
      } else if (currentProvider === AI_PROVIDERS.AZURE_FOUNDRY && !this.aiProviders.getAzureFoundryClient()) {
        console.warn("Azure Foundry is configured but not initialized");
      }
    } catch (error) {
      console.error("Failed to initialize AI providers:", error);
    }
  }

  /**
   * Process a chat message and generate a response
   * @param {Array} messages The conversation history with the new message
   * @param {number} windowId The ID of the chat window
   * @param {string} systemPrompt Optional system prompt to use
   * @param {boolean} useStreaming Whether to use streaming (defaults to true for Gemini)
   * @param {function} streamCallback Optional callback function for handling streaming responses
   * @returns {Promise<Object>} The AI's response or a streaming handler
   */
  async processMessage(messages, windowId, systemPrompt, useStreaming, streamCallback) {
    try {
      // Store system prompt for this window if provided
      if (systemPrompt) {
        this.systemPrompts.set(windowId, systemPrompt);
      }

      // Get cached system prompt for this window or load from file if not in memory
      let currentSystemPrompt = this.systemPrompts.get(windowId);
      if (!currentSystemPrompt) {
        currentSystemPrompt = this.loadSystemPrompt();
        if (currentSystemPrompt) {
          this.systemPrompts.set(windowId, currentSystemPrompt);
        }
      }

      // Append furigana instruction if enabled and language is Japanese
      const responseLanguage = this.configManager.getResponseLanguage();
      const withFurigana = this.configManager.getWithFurigana();
      if (withFurigana && responseLanguage === "ja") {
        const furiganaInstruction = `【絶対ルール：ふりがな必須】
あなたの回答(かいとう)では、全(すべ)ての漢字(かんじ)の直後(ちょくご)に丸括弧(まるかっこ)でひらがなの読(よ)みを付(つ)けてください。
例外(れいがい)なし。一(ひと)つでも漢字(かんじ)にふりがなが無(な)ければ失格(しっかく)です。

正(ただ)しい例(れい)：
「私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。技術(ぎじゅつ)スタックはReact Nativeです。」
「認証(にんしょう)にはJWTを使(つか)っています。データベースはPostgreSQLで、Prismaで操作(そうさ)します。」

間違(まちが)った例(れい)：
「私はSplitterを開発しました」← ふりがなが無いのでNG`;

        if (currentSystemPrompt) {
          // Put furigana instruction BEFORE the system prompt so model sees it first
          currentSystemPrompt = furiganaInstruction + "\n\n" + currentSystemPrompt;
        } else {
          currentSystemPrompt = furiganaInstruction + "\n\nあなたは日本語で答えるアシスタントです。";
        }
      }

      // Get the current AI provider and model from config
      const provider = this.configManager.getAiProvider();
      let currentModel = this.configManager.getCurrentModel();

      // For Ollama chat, prefer deepseek-r1:14b for better text quality (especially Japanese)
      // minicpm-v is a vision model and produces poor text-only responses
      if (provider === AI_PROVIDERS.OLLAMA && currentModel && currentModel.startsWith("minicpm")) {
        currentModel = "deepseek-r1:14b";
        console.log("Chat: Switched from minicpm-v to deepseek-r1:14b for better text quality");
      }

      console.log(`Processing message with ${provider} using model ${currentModel}`);

      // Default to streaming for Gemini and Ollama if not specified
      if (useStreaming === undefined) {
        useStreaming = provider === AI_PROVIDERS.GEMINI || provider === AI_PROVIDERS.OLLAMA;
      }

      // If furigana is enabled, append reminder to the last user message
      // This is critical for small models that may forget system prompt instructions
      if (withFurigana && responseLanguage === "ja") {
        messages = [...messages];
        const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf("user");
        if (lastUserMsgIndex !== -1) {
          messages[lastUserMsgIndex] = {
            ...messages[lastUserMsgIndex],
            content: messages[lastUserMsgIndex].content + "\n\n（※回答(かいとう)の全(すべ)ての漢字(かんじ)にふりがなを付(つ)けてください。例(れい)：私(わたし)は開発(かいはつ)しました。）"
          };
        }
      }

      // Create a copy of messages with system prompt if available
      let messagesWithSystem = [...messages];

      // Always include system prompt at the beginning if it exists
      if (currentSystemPrompt) {
        if (messagesWithSystem.length === 0) {
          messagesWithSystem.unshift({
            role: "system",
            content: currentSystemPrompt,
          });
        } else if (messagesWithSystem[0].role === "system") {
          messagesWithSystem[0] = {
            role: "system",
            content: currentSystemPrompt
          };
        } else {
          messagesWithSystem.unshift({
            role: "system",
            content: currentSystemPrompt,
          });
        }
      }

      // For furigana mode: inject a few-shot example right after system prompt
      // This is the most effective way to make small models follow formatting
      if (withFurigana && responseLanguage === "ja") {
        const fewShotUser = {
          role: "user",
          content: "このプロジェクトの技術スタックを教えてください。"
        };
        const fewShotAssistant = {
          role: "assistant",
          content: "私(わたし)はSplitterという割(わ)り勘(かん)アプリを開発(かいはつ)しました。\n\nフロントエンドにはReact Native + Expoを使(つか)い、バックエンドにはNode.js + Express + Prisma + PostgreSQLを採用(さいよう)しました。\n\n主(おも)な技術(ぎじゅつ)：\n- 状態(じょうたい)管理(かんり)：Zustand\n- 認証(にんしょう)：JWT\n- AI解析(かいせき)：Google Gemini\n- 多言語(たげんご)対応(たいおう)：i18next（日本語(にほんご)・英語(えいご)・ウズベク語(ご)・ロシア語(ご)）"
        };

        // Insert few-shot example after system prompt (index 1)
        const insertIdx = messagesWithSystem[0]?.role === "system" ? 1 : 0;
        messagesWithSystem.splice(insertIdx, 0, fewShotUser, fewShotAssistant);
      }

      // Generate response based on the configured AI provider
      let response;
      try {
        switch (provider) {
          case AI_PROVIDERS.GEMINI:
            // For Gemini, system prompts are handled specially in the generateWithGemini method
            // by converting them to user messages (since Gemini doesn't support system role)
            response = await this.generateWithGemini(
              messagesWithSystem,
              currentModel,
              useStreaming,
              streamCallback,
              windowId,
            );
            break;
          case AI_PROVIDERS.OLLAMA:
            response = await this.generateWithOllama(
              messagesWithSystem,
              currentModel,
              useStreaming,
              streamCallback,
              windowId,
            );
            break;
          case AI_PROVIDERS.OPENAI:
            response = await this.generateWithOpenAI(
              messagesWithSystem,
              currentModel,
              useStreaming,
              streamCallback,
              windowId,
            );
            break;
          case AI_PROVIDERS.AZURE_FOUNDRY:
            response = await this.generateWithAzureFoundry(
              messagesWithSystem,
              currentModel,
              useStreaming,
              streamCallback,
              windowId,
            );
            break;
          default:
            // If provider not set or invalid, try each available provider
            if (this.aiProviders.getGeminiAI()) {
              response = await this.generateWithGemini(
                messagesWithSystem,
                "gemini-pro",
                useStreaming,
                streamCallback,
                windowId,
              );
            } else if (this.aiProviders.getOpenAI()) {
              response = await this.generateWithOpenAI(
                messagesWithSystem,
                "gpt-3.5-turbo",
                useStreaming,
                streamCallback,
                windowId,
              );
            } else if (this.configManager.getOllamaUrl) {
              response = await this.generateWithOllama(messagesWithSystem, "llama2", useStreaming, streamCallback, windowId);
            } else {
              throw new Error(`No AI providers are configured. Please go to Settings and configure an AI provider.`);
            }
        }
      } catch (providerError) {
        console.error(`Error with provider ${provider}:`, providerError);

        // Try fallback providers if the primary one fails
        if (provider !== AI_PROVIDERS.GEMINI && this.aiProviders.getGeminiAI()) {
          console.log("Trying fallback with Gemini...");
          response = await this.generateWithGemini(
            messagesWithSystem,
            "gemini-pro",
            useStreaming,
            streamCallback,
            windowId,
          );
        } else if (provider !== AI_PROVIDERS.OPENAI && this.aiProviders.getOpenAI()) {
          console.log("Trying fallback with OpenAI...");
          response = await this.generateWithOpenAI(
            messagesWithSystem,
            "gpt-3.5-turbo",
            useStreaming,
            streamCallback,
            windowId,
          );
        } else if (provider !== AI_PROVIDERS.OLLAMA) {
          console.log("Trying fallback with Ollama...");
          response = await this.generateWithOllama(messagesWithSystem, "llama2", useStreaming, streamCallback, windowId);
        } else {
          // If we've tried all options, rethrow the original error
          throw providerError;
        }
      }

      // If streaming, the response is handled through callbacks
      if (useStreaming) {
        return response;
      }

      // For non-streaming responses, save conversation for context (but without system prompt in history)
      if (!response.streaming) {
        const historyWithoutSystem = messages.filter(msg => msg.role !== "system");
        this.saveConversation(windowId, historyWithoutSystem.concat([response]));
      }

      return response;
    } catch (error) {
      console.error("Error processing chat message:", error);
      return {
        role: "assistant",
        content: `Error: ${
          error.message || "Failed to generate response"
        }. Please check your API keys in the Settings menu (${
          (this.configManager.getModifierKey && this.configManager.getModifierKey()) || "Cmd/Ctrl"
        }+,).`,
      };
    }
  }

  /**
   * Load system prompt from file
   * @returns {string} The system prompt or empty string if not found
   */
  loadSystemPrompt() {
    return loadPrompt();
  }

  /**
   * Generate a response using Gemini AI
   * @param {Array} messages The conversation history
   * @param {string} model The Gemini model to use
   * @param {boolean} streaming Whether to use streaming
   * @param {function} streamCallback Optional callback function for handling streaming responses
   * @param {number} windowId Optional window ID for managing conversations
   * @returns {Promise<Object>} The response or streaming handler
   */
  async generateWithGemini(messages, model, streaming = true, streamCallback, windowId) {
    try {
      // Ensure Gemini client is available
      const geminiClient = this.aiProviders.getGeminiAI();
      if (!geminiClient) {
        throw new Error("Gemini client not initialized. Please go to Settings and enter your API key.");
      }

      // Check for existing conversation context for this window
      if (windowId) {
        const existingConversation = this.getConversation(windowId);
        if (existingConversation && existingConversation.length > 0) {
          console.log(`Using existing conversation context for Gemini (window ${windowId}): ${existingConversation.length} messages`);
        }
      }

      // If streaming is requested, use the streaming approach
      if (streaming && streamCallback) {
        // Signal stream start
        streamCallback("start");

        // Convert messages to Gemini format
        // Gemini uses 'model' for AI messages instead of 'assistant'
        const safetySettings = [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ];

        // Only consider the most recent messages to avoid token limits
        // Always include the system prompt if present
        const systemMessage = messages.find(msg => msg.role === "system");
        const nonSystemMessages = messages.filter(msg => msg.role !== "system");
        
        // Use up to the last 10 messages to stay within context limits
        // For very large messages, consider limiting further
        const recentMessages = nonSystemMessages.slice(-10);
        
        // Add system message at the beginning if it exists
        const messagesForModel = systemMessage ? [systemMessage, ...recentMessages] : recentMessages;
        
        // Convert to Gemini format using our helper function
        const geminiMessages = this._formatMessagesForProvider(messagesForModel, AI_PROVIDERS.GEMINI).map(msg => {
          // Convert "assistant" role to "model" for Gemini
          const role = msg.role === "assistant" ? "model" : msg.role;
          return { role, parts: [{ text: msg.content }] };
        });

        // Get the specific model
        const geminiModel = geminiClient.getGenerativeModel({ 
          model: model || "gemini-pro",
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
          },
          safetySettings
        });

        try {
          // Create a chat session
          const chat = geminiModel.startChat({
            history: geminiMessages.slice(0, -1), // All but the last message
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 8192,
            },
            safetySettings
          });

          // Get the last message to send
          const lastMessage = geminiMessages[geminiMessages.length - 1];
          
          // Send the message and stream the response
          const streamingResponse = await chat.sendMessageStream(lastMessage.parts);

          // Process the stream
          let fullResponse = "";
          
          for await (const chunk of streamingResponse.stream) {
            const chunkText = chunk.text();
            fullResponse += chunkText;
            
            // Send the chunk to the callback
            streamCallback("chunk", chunkText, fullResponse);
          }
          
          // Create the final response
          const finalResponse = {
            role: "assistant",
            content: fullResponse
          };
          
          // Signal stream completion
          streamCallback("complete", finalResponse, fullResponse);
          
          // Save the conversation if window ID is provided
          if (windowId) {
            // Get the recent history without system messages
            const historyWithoutSystem = messages.filter(msg => msg.role !== "system");
            this.saveConversation(windowId, historyWithoutSystem.concat([finalResponse]));
          }
          
          return { streaming: true };
        } catch (streamError) {
          console.error("Error with Gemini streaming:", streamError);
          streamCallback("error", streamError);
          throw streamError;
        }
      } else {
        // Standard non-streaming approach
        // Set up safety settings to allow more content through
        const safetySettings = [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
          },
        ];

        // Only consider the most recent messages to avoid token limits
        // Always include the system prompt if present
        const systemMessage = messages.find(msg => msg.role === "system");
        const nonSystemMessages = messages.filter(msg => msg.role !== "system");
        
        // Use up to the last 10 messages to stay within context limits
        // For very large messages, consider limiting further
        const recentMessages = nonSystemMessages.slice(-10);
        
        // Add system message at the beginning if it exists
        const messagesForModel = systemMessage ? [systemMessage, ...recentMessages] : recentMessages;
        
        // Convert to Gemini format using our helper function
        const geminiMessages = this._formatMessagesForProvider(messagesForModel, AI_PROVIDERS.GEMINI).map(msg => {
          // Convert "assistant" role to "model" for Gemini
          const role = msg.role === "assistant" ? "model" : msg.role;
          return { role, parts: [{ text: msg.content }] };
        });

        // Get the specific model
        const geminiModel = geminiClient.getGenerativeModel({ model: model || "gemini-pro" });

        // Generate response
        const result = await geminiModel.generateContent({
          contents: geminiMessages,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
          },
          safetySettings,
        });

        const response = result.response;
        const text = response.text();

        const finalResponse = {
          role: "assistant",
          content: text,
        };

        // Save the conversation if window ID is provided
        if (windowId) {
          // Get the recent history without system messages
          const historyWithoutSystem = messages.filter(msg => msg.role !== "system");
          this.saveConversation(windowId, historyWithoutSystem.concat([finalResponse]));
        }

        return finalResponse;
      }
    } catch (error) {
      console.error("Error generating with Gemini:", error);
      throw error;
    }
  }

  /**
   * Generate a response using Ollama
   * @param {Array} messages The conversation history
   * @param {string} model The Ollama model to use
   * @param {boolean} streaming Whether to use streaming (default: false)
   * @param {function} streamCallback Optional callback function for handling streaming responses
   * @param {number} windowId Optional window ID for managing conversations
   * @returns {Promise<Object>} The response or streaming handler
   */
  async generateWithOllama(messages, model, streaming = false, streamCallback, windowId) {
    try {
      // Get Ollama URL from config
      const ollamaUrl = this.configManager.getCurrentSettings().ollamaUrl;
      if (!ollamaUrl) {
        throw new Error("Ollama URL is not configured");
      }

      // Format messages for Ollama API - separate system message for Ollama's dedicated system parameter
      const systemMsg = messages.find(msg => msg.role === "system");
      const nonSystemMessages = messages.filter(msg => msg.role !== "system");
      const formattedMessages = nonSystemMessages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Build base Ollama request body with dedicated system parameter
      const ollamaBaseBody = {
        model: model || "llama2",
        messages: formattedMessages,
        options: {
          temperature: 0.7,
        },
        keep_alive: "10m",
      };
      // Use Ollama's dedicated 'system' parameter — stronger than system role in messages
      if (systemMsg) {
        ollamaBaseBody.system = systemMsg.content;
      }

      // Check for existing conversation context for this window
      if (windowId) {
        const existingConversation = this.getConversation(windowId);
        if (existingConversation && existingConversation.length > 0) {
          console.log(`Using existing conversation context for Ollama (window ${windowId}): ${existingConversation.length} messages`);
        }
      }

      // If streaming is requested, handle it
      if (streaming && streamCallback) {
        // Signal stream start
        streamCallback("start");

        // Setup for stream handling
        let fullResponse = "";

        try {
          // API call to Ollama with streaming
          const response = await axios.post(`${ollamaUrl}/api/chat`, {
            ...ollamaBaseBody,
            stream: true,
          }, {
            responseType: 'stream'
          });
          
          // Handle the stream
          response.data.on('data', (chunk) => {
            try {
              const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
              
              for (const line of lines) {
                const data = JSON.parse(line);
                if (data.message && data.message.content) {
                  const chunkText = data.message.content;
                  fullResponse += chunkText;
                  
                  // Send each chunk to the callback
                  streamCallback("chunk", chunkText, fullResponse);
                }
              }
            } catch (error) {
              console.error("Error parsing Ollama stream chunk:", error);
            }
          });
          
          // On completion
          response.data.on('end', () => {
            const finalResponse = {
              role: "assistant",
              content: fullResponse
            };
            
            // Signal stream completion
            streamCallback("complete", finalResponse, fullResponse);
            
            // Save the conversation if window ID is provided
            if (windowId) {
              // Get the recent history without system messages
              const historyWithoutSystem = messages.filter(msg => msg.role !== "system");
              this.saveConversation(windowId, historyWithoutSystem.concat([finalResponse]));
            }
          });
          
          // Return a placeholder since actual response is handled via callbacks
          return { streaming: true };
        } catch (streamError) {
          console.error("Error with Ollama streaming:", streamError);
          streamCallback("error", streamError);
          throw streamError;
        }
      } else {
        // Non-streaming request
        const response = await axios.post(`${ollamaUrl}/api/chat`, {
          ...ollamaBaseBody,
          stream: false,
        });

        if (!response.data || !response.data.message) {
          throw new Error("Invalid response from Ollama");
        }

        const result = {
          role: "assistant",
          content: response.data.message.content,
        };
        
        // Save the conversation if window ID is provided
        if (windowId) {
          // Get the recent history without system messages
          const historyWithoutSystem = messages.filter(msg => msg.role !== "system");
          this.saveConversation(windowId, historyWithoutSystem.concat([result]));
        }

        return result;
      }
    } catch (error) {
      console.error("Error generating with Ollama:", error);
      throw error;
    }
  }

  /**
   * Generate a response using OpenAI
   * @param {Array} messages The conversation history
   * @param {string} model The OpenAI model to use
   * @param {boolean} streaming Whether to use streaming
   * @param {function} streamCallback Optional callback function for handling streaming responses
   * @param {number} windowId Optional window ID for managing conversations
   * @returns {Promise<Object>} The response or streaming handler
   */
  async generateWithOpenAI(messages, model, streaming = false, streamCallback, windowId) {
    try {
      // Ensure OpenAI client is available
      const openaiClient = this.aiProviders.getOpenAI();
      if (!openaiClient) {
        throw new Error("OpenAI client not initialized. Please go to Settings and enter your API key.");
      }

      // Format messages for OpenAI API
      const formattedMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Use streaming if requested
      if (streaming) {
        const stream = await openaiClient.chat.completions.create({
          model: model || "gpt-3.5-turbo",
          messages: formattedMessages,
          temperature: 0.7,
          max_tokens: 2048,
          stream: true,
        });

        if (streamCallback) {
          let fullText = "";

          // Process the stream
          (async () => {
            try {
              // Signal that streaming has started
              streamCallback("start");

              for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || "";
                if (content) {
                  fullText += content;
                  streamCallback("chunk", content, fullText);
                }
              }

              // Signal that streaming is complete
              streamCallback("complete", fullText);

              // Save the conversation with the final response
              if (windowId) {
                this.saveConversation(
                  windowId,
                  messages.concat([
                    {
                      role: "assistant",
                      content: fullText,
                    },
                  ]),
                );
              }
            } catch (error) {
              console.error("Error in OpenAI stream processing:", error);
              streamCallback("error", error);
            }
          })();
        }

        // Return an object similar to Gemini streaming for consistency
        const emitter = new EventEmitter();
        return {
          streaming: true,
          emitter: emitter,
          text: () => "",
        };
      }

      // Standard non-streaming response
      const response = await openaiClient.chat.completions.create({
        model: model || "gpt-3.5-turbo",
        messages: formattedMessages,
        temperature: 0.7,
        max_tokens: 2048,
      });

      if (!response.choices || !response.choices[0] || !response.choices[0].message) {
        throw new Error("Invalid response from OpenAI");
      }

      return {
        role: "assistant",
        content: response.choices[0].message.content,
      };
    } catch (error) {
      console.error("Error generating with OpenAI:", error);
      throw error;
    }
  }

  /**
   * Generate a response using Azure Foundry Claude
   * @param {Array} messages The conversation history
   * @param {string} model The Claude model to use
   * @param {boolean} streaming Whether to use streaming (default: false)
   * @param {function} streamCallback Optional callback function for handling streaming responses
   * @param {number} windowId Optional window ID for managing conversations
   * @returns {Promise<Object>} The response or streaming handler
   */
  async generateWithAzureFoundry(messages, model, streaming = false, streamCallback, windowId) {
    try {
      // Get the Azure Foundry generator function from ai-providers
      const generateWithAzureFoundry = this.aiProviders.generateWithAzureFoundry;
      if (!generateWithAzureFoundry) {
        throw new Error("Azure Foundry client not initialized. Please go to Settings and enter your API key and endpoint.");
      }

      // Extract system prompt if present
      const systemMessage = messages.find(msg => msg.role === "system");
      const systemPrompt = systemMessage ? systemMessage.content : null;

      // Format messages for Azure Foundry API
      const formattedMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Use streaming if requested
      if (streaming) {
        // Generate with Azure Foundry in streaming mode
        const result = await generateWithAzureFoundry(formattedMessages, model, true, systemPrompt);

        if (result.streaming && result.emitter && streamCallback) {
          let fullText = "";

          // Signal that streaming has started
          streamCallback("start");

          // Handle streaming events
          result.emitter.on("chunk", (chunk) => {
            fullText += chunk;
            streamCallback("chunk", chunk, fullText);
          });

          result.emitter.on("accumulated", (accumulated) => {
            // Update full text with accumulated response
            fullText = accumulated;
          });

          result.emitter.on("complete", (finalText) => {
            // Signal that streaming is complete
            streamCallback("complete", finalText);

            // Save the conversation with the final response
            if (windowId) {
              this.saveConversation(
                windowId,
                messages.concat([
                  {
                    role: "assistant",
                    content: finalText,
                  },
                ]),
              );
            }
          });

          result.emitter.on("error", (error) => {
            console.error("Azure Foundry streaming error:", error);
            streamCallback("error", error);
          });

          return {
            streaming: true,
            text: () => fullText,
          };
        } else {
          // No streaming callback provided, return the emitter for external handling
          return result;
        }
      }

      // Non-streaming response
      const response = await generateWithAzureFoundry(formattedMessages, model, false, systemPrompt);

      // Save the conversation if window ID is provided
      if (windowId) {
        this.saveConversation(
          windowId,
          messages.concat([
            {
              role: "assistant",
              content: response,
            },
          ]),
        );
      }

      return {
        role: "assistant",
        content: response,
      };
    } catch (error) {
      console.error("Error generating with Azure Foundry:", error);
      throw error;
    }
  }

  /**
   * Save conversation history for a window
   * @param {number} windowId The window ID
   * @param {Array} messages The conversation messages
   */
  saveConversation(windowId, messages) {
    // For all providers, we want to save the conversation history without system messages
    // This ensures we don't lose context but don't duplicate system messages
    const messagesWithoutSystem = messages.filter(msg => msg.role !== "system");
    
    // Store the conversation history for this window
    this.conversations.set(windowId, messagesWithoutSystem);
    
    // Log how many messages are being stored
    console.log(`Saved ${messagesWithoutSystem.length} messages for window ${windowId}`);
  }

  /**
   * Get conversation history for a window
   * @param {number} windowId The window ID
   * @returns {Array|null} The conversation messages or null if none
   */
  getConversation(windowId) {
    return this.conversations.get(windowId) || null;
  }

  /**
   * Clear conversation history for a window
   * @param {number} windowId The window ID
   */
  clearConversation(windowId) {
    this.conversations.delete(windowId);
  }

  /**
   * Formats a message array to ensure system prompts are properly handled
   * This is necessary because different AI providers handle system prompts differently
   * @param {Array} messages Array of messages with potential system prompts
   * @param {string} provider The AI provider ID (GEMINI, OPENAI, etc.)
   * @returns {Array} Properly formatted messages for the specific provider
   * @private
   */
  _formatMessagesForProvider(messages, provider) {
    // Create a copy of the messages
    const formattedMessages = [...messages];
    
    // For Gemini, convert system messages to user messages
    if (provider === AI_PROVIDERS.GEMINI) {
      return formattedMessages.map(msg => {
        if (msg.role === "system") {
          return { role: "user", content: msg.content };
        }
        return msg;
      });
    }
    
    // For other providers, we can use the messages as they are
    return formattedMessages;
  }
}

module.exports = ChatHandler;
