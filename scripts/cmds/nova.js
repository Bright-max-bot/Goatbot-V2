const axios = require("axios");

module.exports.config = {
  name: "AskNova",
  version: "1",
  hasPermission: 0,
  credits: "Bright Hemsworth",
  description: "Ask AI a question",
  usages: "[question]",
  commandCategory: "AI",
  cooldowns: 0
};

module.exports.run = async ({ api, event, args }) => {
  try {
    const question = args.join(" ");

    if (!question) {
      return api.sendMessage(
        "Please provide a question.",
        event.threadID,
        event.messageID
      );
    }

    const response = await axios.get(
      `https://sarapmosake.heckerman06.repl.co/erjohn?question=${encodeURIComponent(question)}`
    );

    if (response.data.error) {
      return api.sendMessage(
        `Error: ${response.data.error}`,
        event.threadID,
        event.messageID
      );
    }

    api.sendMessage(
      response.data.reply,
      event.threadID,
      event.messageID
    );

  } catch (error) {
    console.log(error.response?.data || error.message);
    api.sendMessage(
        `Error:\n${error.response?.data?.error || error.message}`,
        event.threadID,
        event.messageID
    );
}
};