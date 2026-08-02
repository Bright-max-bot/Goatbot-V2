const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "AQ.Ab8RN6JC_kDtgNoWhD6oxQTFqNasnVHKLJBYhHEcJIdTi3h36A"
});

module.exports.config = {
  name: "zia",
  aliases: ["nova", "asknova", "gemini"],
  version: "3.0.0",
  author: "Bright Hemsworth",
  hasPermission: 0,
  credits: "Bright Hemsworth",
  description: "Advanced AI Assistant powered by Google Gemini",
  usages: "[question]",
  commandCategory: "AI",
  cooldowns: 3,
  dependencies: {
    "@google/genai": ""
  }
};

module.exports.run = async function ({ api, event, args }) {
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

  const start = Date.now();

  try {
    api.sendTypingIndicator(event.threadID, true);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    api.sendTypingIndicator(event.threadID, false);

    const answer =
      response.text ||
      response.output_text ||
      "I couldn't generate a response.";

    const time = ((Date.now() - start) / 1000).toFixed(2);

    const message =
`ASKNOVA AI

${answer}

━━━━━━━━━━━━━━━━━━
Model  : Gemini 2.5 Flash
Time   : ${time}s
Author : Bright Hemsworth`;

    if (message.length <= 1900) {
      return api.sendMessage(
        message,
        event.threadID,
        event.messageID
      );
    }

    for (let i = 0; i < message.length; i += 1900) {
      await api.sendMessage(
        message.substring(i, i + 1900),
        event.threadID
      );
    }

  } catch (err) {
    api.sendTypingIndicator(event.threadID, false);

    console.error(err);

    let error = err.message;

    if (error.includes("401"))
      error = "Invalid Gemini API Key.";

    if (error.includes("429"))
      error = "Rate limit exceeded. Please try again later.";

    if (error.includes("503"))
      error = "Gemini service is temporarily unavailable.";

    api.sendMessage(
`ASKNOVA ERROR

${error}`,
      event.threadID,
      event.messageID
    );
  }
};