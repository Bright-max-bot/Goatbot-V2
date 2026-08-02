const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Prevent duplicate execution
const processedMessages = new Set();

module.exports.config = {
  name: "zia",
  aliases: ["nova", "asknova", "gemini"],
  version: "3.1.0",
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

  // Block duplicate message execution
  if (processedMessages.has(event.messageID)) {
    return;
  }

  processedMessages.add(event.messageID);

  // Remove old IDs after 1 minute
  setTimeout(() => {
    processedMessages.delete(event.messageID);
  }, 60000);


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

    const result = await ai.models.generateContent({

      model: "gemini-2.0-flash",

      contents: prompt,

      config: {
        temperature: 0.9,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 2048
      }

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
Model  : Gemini 2.0 Flash
Time   : ${time}s
Author : Bright Hemsworth`;


    // Keep only one Messenger reply
    if (message.length > 1900) {
      message = message.substring(0, 1850) + "\n\n[Response shortened]";
    }


    return api.sendMessage(
      message,
      event.threadID,
      event.messageID
    );


  } catch (err) {


    console.error("Gemini Error:", err);


    let error = err.message || "Unknown error";


    if (error.includes("401") || error.includes("API_KEY_INVALID")) {
      error = "Invalid Gemini API Key.";
    }

    else if (error.includes("403")) {
      error = "Gemini API access denied.";
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