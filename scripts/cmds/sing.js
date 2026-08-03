const ytSearch = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");

const cookiesFilePath = path.join(__dirname, "cache", "cookies.txt");

// Resolve the yt-dlp binary via Node's module resolution instead of __dirname,
// since node_modules is hoisted to the project root (/app/node_modules),
// not this command file's own folder (/app/scripts/cmds).
let ytDlpBinPath = null;
try {
  const pkgJsonPath = require.resolve("youtube-dl-exec/package.json");
  const pkgDir = path.dirname(pkgJsonPath);
  ytDlpBinPath = path.join(
    pkgDir,
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
} catch (e) {
  console.warn("sing.js: could not resolve youtube-dl-exec package path —", e.message);
}

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

console.log(
  "sing.js: YT_ env keys visible:",
  Object.keys(process.env).filter((k) => k.startsWith("YT_"))
);

// --- Log current yt-dlp binary version, then attempt a self-update ---
function logAndUpdateYtDlp() {
  if (!ytDlpBinPath || !fs.existsSync(ytDlpBinPath)) {
    console.warn("sing.js: yt-dlp binary not found at resolved path:", ytDlpBinPath);
    return;
  }

  try {
    const before = execSync(`"${ytDlpBinPath}" --version`).toString().trim();
    console.log("sing.js: yt-dlp version (before update):", before);
  } catch (e) {
    console.warn("sing.js: could not read yt-dlp version —", e.message);
  }

  try {
    const updateOutput = execSync(`"${ytDlpBinPath}" -U`, { timeout: 30000 }).toString().trim();
    console.log("sing.js: yt-dlp self-update output:", updateOutput);
  } catch (e) {
    console.warn("sing.js: yt-dlp self-update failed (may be network-restricted) —", e.message);
  }

  try {
    const after = execSync(`"${ytDlpBinPath}" --version`).toString().trim();
    console.log("sing.js: yt-dlp version (after update):", after);
  } catch (e) {
    console.warn("sing.js: could not read yt-dlp version after update —", e.message);
  }
}
logAndUpdateYtDlp();

module.exports = {
  config: {
    name: "sing",
    aliases: ["song", "music"],
    version: "3.3",
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

    // Try a sequence of format strings, in case the video lacks some formats
    const formatAttempts = ["bestaudio/best", "bestaudio*", "best"];

    let lastError = null;
    let success = false;

    for (const fmt of formatAttempts) {
      try {
        const options = {
          format: fmt,
          extractAudio: true,
          audioFormat: "mp3",
          audioQuality: 0, // best
          output: filePath,
          noCheckCertificate: true,
          noWarnings: true,
          preferFreeFormats: true,
          addHeader: ["referer:youtube.com"]
        };

        const cookiesExist = await fs.pathExists(cookiesFilePath);
        if (cookiesExist) {
          options.cookies = cookiesFilePath;
        } else {
          console.warn("sing.js: no cookies file found at download time — expect bot-check failures.");
        }

        console.log(`sing.js: attempting download with format "${fmt}"`);
        await youtubedl(selected.url, options);
        success = true;
        break;
      } catch (e) {
        lastError = e;
        console.warn(`sing.js: format "${fmt}" failed —`, e.stderr || e.message);
        await fs.remove(filePath).catch(() => {});
      }
    }

    if (!success) {
      console.error("sing.js download failed after all format attempts:", lastError?.stderr || lastError?.message);
      await api.setMessageReaction("❌", event.messageID, threadID).catch((err) => {
        console.error("sing.js setMessageReaction (❌) failed:", err.message);
      });
      message.reply(`Download error: ${lastError?.message || "unknown error"}`);
      return;
    }

    try {
      await message.reply({
        body: selected.title,
        attachment: fs.createReadStream(filePath)
      });

      await api.setMessageReaction("✅", event.messageID, threadID).catch((e) => {
        console.error("sing.js setMessageReaction (✅) failed:", e.message);
      });
    } catch (e) {
      console.error("sing.js failed to send audio reply:", e.message);
      await api.setMessageReaction("❌", event.messageID, threadID).catch(() => {});
      message.reply(`Download succeeded but sending failed: ${e.message}`);
    } finally {
      fs.remove(filePath).catch(() => {});
    }
  }
};
