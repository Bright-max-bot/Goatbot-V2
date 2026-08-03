module.exports.config = {
  name: "ping",
  version: "1.0.0",
  author: "Bright",
  hasPermission: 0,
  cooldowns: 0,
  commandCategory: "System"
};

module.exports.run = async function ({ api, event }) {
  console.log("PING START");
  return api.sendMessage(
    "Pong!",
    event.threadID,
    event.messageID
  );
};