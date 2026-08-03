const ytSearch = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

// --- Optional cookies support ---
// If a cache/cookies.txt file exists (Netscape-format cookies.txt, NOT the
// JSON export), it's passed to yt-dlp automatically. yt-dlp handles
// YouTube's bot-check well on its own in most cases, so this is a
// fallback rather than a requirement.
const cookiesFilePath = path.join(__dirname, "cache", "cookies.txt");

module.exports = {
  config: {
    name: "sing",
    aliases: ["song", "music"],
    version: "3.0",
    author: "Bright",
    countDown: 5,
    role: 0,
    shortDescription: { en: "Search and download YouTube audio" },
    category: "media",
    guide: { en: "{pn} <song name>" }
  },

  onStart: async function ({ message, args, event, commandName }) {
    const query = args.join(" ");
    if (!query) return message.reply("Please provide a song name.");

    let searchResult;
    try {
      searchResult = await ytSearch(query);
    } catch (e) {
      console.error("sing.js yt-search failed:", e.message);
      return message.reply("Search failed — YouTube search is unavailable right now.");
    }

    const videos = searchResult?.videos;
    if (!Array.isArray(videos) || videos.length === 0)
      return message.reply("No songs found.");

    const topResults = videos.slice(0, 6);
    const cacheDir = path.join(__dirname, "cache");
    await fs.ensureDir(cacheDir);

    let msg = "";
    const attachments = [];
    for (let i = 0; i < topResults.length; i++) {
      const v = topResults[i];
      msg += `${i + 1}. ${v.title}\n[${v.timestamp}]\n\n`;
      try {
        const imgPath = path.join(cacheDir, `sing_${Date.now()}_${i}.jpg`);
        const imgRes = await axios.get(v.thumbnail, { responseType: "arraybuffer" });
        await fs.writeFile(imgPath, Buffer.from(imgRes.data));
        attachments.push(fs.createReadStream(imgPath));
      } catch (e) {
        console.error("sing.js thumbnail fetch failed:", e.message);
      }
    }

    message.reply({ body: msg.trim(), attachment: attachments.length ? attachments : undefined }, (err, info) => {
      if (err) {
        console.error("sing.js failed to send results message:", err);
        return;
      }
      global.GoatBot.onReply.set(info.messageID, {
        commandName,
        author: event.senderID,
        results: topResults.map(v => ({ title: v.title, url: v.url }))
      });
      attachments.forEach(s => setTimeout(() => fs.remove(s.path).catch(() => {}), 10000));
    });
  },

  onReply: async function ({ message, event, Reply, api }) {
    const choice = parseInt(event.body);
    if (isNaN(choice) || choice < 1 || choice > Reply.results.length) return;

    const selected = Reply.results[choice - 1];
    api.unsendMessage(event.messageReply.messageID);
    api.setMessageReaction("⏳", event.messageID);

    const cacheDir = path.join(__dirname, "cache");
    await fs.ensureDir(cacheDir);
    const filePath = path.join(cacheDir, `sing_dl_${Date.now()}.mp3`);

    try {
      const options = {
        extractAudio: true,
        audioFormat: "mp3",
        audioQuality: 0, // best
        output: filePath,
        noCheckCertificate: true,
        noWarnings: true,
        preferFreeFormats: true,
        addHeader: ["referer:youtube.com", "user-agent:googlebot"]
      };

      // Use cookies file only if it exists (optional fallback)
      if (await fs.pathExists(cookiesFilePath)) {
        options.cookies = cookiesFilePath;
      }

      await youtubedl(selected.url, options);

      await message.reply({
        body: selected.title,
        attachment: fs.createReadStream(filePath)
      });

      api.setMessageReaction("✅", event.messageID);
    } catch (e) {
      console.error("sing.js download failed:", e.stderr || e.message);
      api.setMessageReaction("❌", event.messageID);
      message.reply(`Download error: ${e.message}`);
    } finally {
      fs.remove(filePath).catch(() => {});
    }
  }
};