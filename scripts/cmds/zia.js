const axios = require("axios");

module.exports.config = {
  name: "zia",
  version: "1.0.0",
  hasPermission: 0,
  credits: "Bright Hemsworth",
  description: "Chat with SimSimi AI",
  usages: "[message]",
  commandCategory: "AI",
  cooldowns: 3
};

module.exports.run = async ({ api, event, args }) => {
  const message = args.join(" ");

  if (!message) {
    return api.sendMessage(
      "Please enter a message.\n\nExample:\n.zia hello",
      event.threadID,
      event.messageID
    );
  }

  try {
    const res = await axios.get(
      "https://simsimi7.p.rapidapi.com/v1/talk",
      {
        params: {
          message: message,
          language: "en",
          bad_words_filter: true
        },
        headers: {
          "x-rapidapi-host": "simsimi7.p.rapidapi.com",
          "x-rapidapi-key": "84ca6184fbmsh6c565fd8287f241p10d8adjsn3d750c07adee"
        }
      }
    );

    const reply =
      res.data?.success ||
      res.data?.response ||
      res.data?.answer ||
      JSON.stringify(res.data);

    api.sendMessage(reply, event.threadID, event.messageID);

  } catch (err) {
    console.log(err.response?.data || err.message);

    api.sendMessage(
      "SimSimi API Error:\n" +
      JSON.stringify(err.response?.data || err.message, null, 2),
      event.threadID,
      event.messageID
    );
  }
};