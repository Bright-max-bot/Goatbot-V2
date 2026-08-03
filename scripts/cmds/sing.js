const ytSearch = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

// --- Cookies support (needed to pass YouTube's bot-check) ---
// YT_COOKIES_B64 = base64-encoded Netscape-format cookies.txt, set as a
// Render environment variable. Decoded to a real file once at startup.
const cookiesFilePath = path.join(__dirname, "cache", "cookies.txt");

async function ensureCookiesFile() {
  if (await fs.pathExists(cookiesFilePath)) return;
  if (!process.env.YT_COOKIES_B64) {
    console.warn("sing.js: YT_COOKIES_B64 not set — downloads will likely fail with bot-check errors.");
    return;
  }
  try {
    await fs.ensureDir(path.dirname(cookiesFilePath));
    const decoded = Buffer.from(process.env.YT_COOKIES_B64, "base64").toString("utf8");
    await fs.writeFile(cookiesFilePath, decoded);
    console.log("sing.js: cookies.txt written from YT_COOKIES_B64");
  } catch (e) {
    console.error("sing.js: failed to write cookies.txt —", e.message);
  }
}
ensureCookiesFile();

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
    const threadID = event.threadID;

    // Safely unsend the previous prompt message, if it exists
    try {
      if (event.messageReply?.messageID) {
        await api.unsendMessage(event.messageReply.messageID, threadID);
      }
    } catch (e) {
      console.error("sing.js unsendMessage failed:", e.message);
    }

    // Safely react with an hourglass while downloading
    try {
      await api.setMessageReaction("⏳", event.messageID, threadID);
    } catch (e) {
      console.error("sing.js setMessageReaction (⏳) failed:", e.message);
    }

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
        addHeader: ["referer:youtube.com"]
      };

      // Use cookies file only if it exists (optional fallback)
      const cookiesExist = await fs.pathExists(cookiesFilePath);
      console.log("sing.js: using cookies file?", cookiesExist);
      if (cookiesExist) {
        options.cookies = cookiesFilePath;
      } else {
        console.warn("sing.js: no cookies file found at download time — expect bot-check failures.");
      }

      await youtubedl(selected.url, options);

      await message.reply({
        body: selected.title,
        attachment: fs.createReadStream(filePath)
      });

      await api.setMessageReaction("✅", event.messageID, threadID).catch((e) => {
        console.error("sing.js setMessageReaction (✅) failed:", e.message);
      });
    } catch (e) {
      console.error("sing.js download failed:", e.stderr || e.message);
      await api.setMessageReaction("❌", event.messageID, threadID).catch((err) => {
        console.error("sing.js setMessageReaction (❌) failed:", err.message);
      });
      message.reply(`Download error: ${e.message}`);
    } finally {
      fs.remove(filePath).catch(() => {});
    }
  }
};