const { GoogleGenAI } = require("@google/genai");

let ai = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return ai;
}

module.exports.config = {
  name: "zia",
  aliases: ["nova", "asknova", "gemini"],
  version: "3.3.0",
  author: "Bright Hemsworth",
  credits: "Bright Hemsworth",
  description: "Advanced AI Assistant powered by Google Gemini",
  usages: "[question]",

  category: "AI",
  permissions: [0],
  cooldown: 3,

  commandCategory: "AI",
  hasPermission: 0,
  cooldowns: 3,

  dependencies: {
    "@google/genai": ""
  }
};

module.exports.run = async function ({ api, event, args }) {
  // CRITICAL: ignore messages sent by the bot's own account.
  // Your logs show "Ask Nova" (61582403821885) — the bot itself — triggering
  // this command on its own error replies, causing the reply loop.
  const botID = api.getCurrentUserID ? api.getCurrentUserID() : null;
  if (botID && event.senderID === botID) return;

  const prompt = args.join(" ").trim();

  if (!prompt) {
    return api.sendMessage(
`ASKNOVA AI

Please enter a message.

Example:
.zia Hello
.zia Explain Quantum Physics
.zia Write a JavaScript calculator`,
      event.threadID,
      event.messageID
    );
  }

  const client = getClient();
  if (!client) {
    return api.sendMessage(
`ASKNOVA ERROR

No Gemini API key is configured on this bot (GEMINI_API_KEY is missing). Get a free key at aistudio.google.com/apikey and set it as an environment variable, then restart the bot.`,
      event.threadID,
      event.messageID
    );
  }

  const start = Date.now();

  try {
    const result = await client.models.generateContent({
      // gemini-2.5-flash is being retired (Oct 16, 2026) and already blocked
      // for new API keys — that's what caused your 404. gemini-3.6-flash is
      // the current GA replacement as of this writing.
      model: "gemini-3.6-flash",
      contents: prompt
      // Note: temperature / topP / topK are deprecated on 3.x models —
      // omitted intentionally. If you need to tune output, check Google's
      // current sampling docs for the 3.x equivalent before re-adding.
    });

    const answer =
      typeof result.text === "function"
        ? result.text()
        : result.text ||
          result.outputText ||
          result.output_text ||
          "No response.";

    const time = ((Date.now() - start) / 1000).toFixed(2);

    let message =
`ASKNOVA AI

${answer}

━━━━━━━━━━━━━━━━━━
Model  : Gemini 3.6 Flash
Time   : ${time}s
Author : Bright Hemsworth`;

    if (message.length > 1900) {
      message = message.substring(0, 1850) + "\n\n[Response shortened]";
    }

    return api.sendMessage(
      message,
      event.threadID,
      event.messageID
    );

  } catch (err) {
    console.error("Gemini raw error:", JSON.stringify(err, Object.getOwnPropertyNames(err)));

    let error = err.message || "Unknown error";

    if (error.includes("401") || error.includes("API_KEY_INVALID")) {
      error = "Invalid Gemini API Key.";
    }
    else if (error.includes("403")) {
      error = "Gemini API access denied — check that the Generative Language API is enabled for this key.";
    }
    else if (/model.*not found|model.*does not exist|no longer available/i.test(error)) {
      error = "That Gemini model is unavailable or has been retired. Try updating the model name in the command file.";
    }
    else if (error.includes("429")) {
      error = "Rate limit exceeded. Try again later.";
    }
    else if (error.includes("503")) {
      error = "Gemini service unavailable.";
    }

    return api.sendMessage(
`ASKNOVA ERROR

${error}`,
      event.threadID,
      event.messageID
    );
  }
};