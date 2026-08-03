const ytSearch = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const cacheDir = path.join(__dirname, "cache");
const cookiesFilePath = path.join(cacheDir, "cookies.txt");

// Path to the yt-dlp binary that youtube-dl-exec vendors.
const ytDlpBinPath = path.join(
  __dirname,
  "node_modules",
  "youtube-dl-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

// ---------------------------------------------------------------------------
// In-memory guards / caches (per-process, reset on redeploy/restart).
// ---------------------------------------------------------------------------

// Prevents the same user from stacking multiple concurrent downloads, which
// on Render's shared CPU could starve every in-flight request and also risks
// two writes racing on cleanup. Keyed by `${threadID}:${senderID}`.
const activeDownloads = new Set();

// Cached after first detection so we don't shell out to `--help` on every
// single download attempt.
let impersonateSupportCache = null;

// ---------------------------------------------------------------------------
// Startup diagnostics: cookies file + yt-dlp version/capability logging.
// These run once when the module is first required.
// ---------------------------------------------------------------------------

async function ensureCookiesFile() {
  if (await fs.pathExists(cookiesFilePath)) return;
  if (!process.env.YT_COOKIES_B64) {
    console.warn("sing.js: YT_COOKIES_B64 not set — downloads will likely fail with bot-check errors.");
    return;
  }
  try {
    await fs.ensureDir(cacheDir);
    const decoded = Buffer.from(process.env.YT_COOKIES_B64, "base64").toString("utf8");
    await fs.writeFile(cookiesFilePath, decoded);
    console.log("sing.js: cookies.txt written from YT_COOKIES_B64");
  } catch (e) {
    console.error("sing.js: failed to write cookies.txt —", e.message);
  }
}

/**
 * Validates that the cookies file looks like a real Netscape cookie jar and
 * logs a redacted preview so you can confirm (from logs) that the file that
 * actually landed on disk is sane, without ever printing cookie values.
 *
 * Returns { valid: boolean, reason?: string, cookieCount?: number }
 */
async function validateCookiesFile() {
  const exists = await fs.pathExists(cookiesFilePath);
  if (!exists) {
    return { valid: false, reason: "cookies.txt does not exist on disk" };
  }

  let raw;
  try {
    raw = await fs.readFile(cookiesFilePath, "utf8");
  } catch (e) {
    return { valid: false, reason: `could not read cookies.txt: ${e.message}` };
  }

  if (!raw || !raw.trim()) {
    return { valid: false, reason: "cookies.txt is empty" };
  }

  const lines = raw.split("\n");
  const header = lines.slice(0, 3).join("\n");
  const looksNetscape =
    header.includes("Netscape HTTP Cookie File") || header.includes("HTTP Cookie File");

  // Redacted preview: show line structure/column count but never the value
  // column (the last tab-separated field, which holds the secret).
  const previewLines = lines.slice(0, 5).map((line) => {
    if (line.startsWith("#") || !line.trim()) return line;
    const cols = line.split("\t");
    if (cols.length < 7) return "<malformed cookie line>";
    const [domain, , , , , name] = cols;
    return `${domain}\t...\t...\t...\t...\t${name}\t<redacted>`;
  });
  console.log("sing.js: cookies.txt preview (redacted):\n" + previewLines.join("\n"));

  const cookieLines = lines.filter((l) => l.trim() && !l.startsWith("#"));
  const requiredNames = ["SID", "SAPISID", "SSID", "HSID"];
  const foundNames = new Set(
    cookieLines
      .map((l) => l.split("\t")[5])
      .filter(Boolean)
  );
  const missingRequired = requiredNames.filter((n) => !foundNames.has(n));

  if (!looksNetscape) {
    return { valid: false, reason: "file does not start with the Netscape cookie header" };
  }
  if (cookieLines.length === 0) {
    return { valid: false, reason: "no cookie entries found in file" };
  }
  if (missingRequired.length > 0) {
    return {
      valid: false,
      reason: `missing expected auth cookies: ${missingRequired.join(", ")}`,
      cookieCount: cookieLines.length,
    };
  }

  return { valid: true, cookieCount: cookieLines.length };
}

function getYtDlpVersion() {
  try {
    return execFileSync(ytDlpBinPath, ["--version"], { timeout: 10000 }).toString().trim();
  } catch (e) {
    console.warn("sing.js: could not read yt-dlp version —", e.message);
    return null;
  }
}

/**
 * Detects whether the vendored yt-dlp binary supports --impersonate
 * (requires yt-dlp to be built/installed with curl_cffi). Not every
 * distribution of yt-dlp ships with impersonation support, so we probe
 * `--help` once and cache the result rather than assuming.
 */
function detectImpersonateSupport() {
  if (impersonateSupportCache !== null) return impersonateSupportCache;
  try {
    const help = execFileSync(ytDlpBinPath, ["--help"], { timeout: 10000 }).toString();
    impersonateSupportCache = help.includes("--impersonate");
  } catch (e) {
    console.warn("sing.js: could not probe yt-dlp --help for --impersonate support —", e.message);
    impersonateSupportCache = false;
  }
  console.log("sing.js: yt-dlp --impersonate support:", impersonateSupportCache);
  return impersonateSupportCache;
}

function logStartupDiagnostics() {
  const version = getYtDlpVersion();
  console.log("sing.js: yt-dlp version:", version || "unknown");
  detectImpersonateSupport();
  console.log(
    "sing.js: YT_ env keys visible:",
    Object.keys(process.env).filter((k) => k.startsWith("YT_"))
  );
}

ensureCookiesFile().then(() => logStartupDiagnostics());

// ---------------------------------------------------------------------------
// Error classification: turns raw yt-dlp stderr into a known category +
// a friendly Messenger-facing message.
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  {
    type: "bot_check",
    test: /sign in to confirm you.?re not a bot/i,
    friendly:
      "YouTube is asking to verify the bot isn't a robot (bot-check). This usually means the stored login cookies are stale or YouTube flagged this server's IP. Try refreshing the cookies export.",
  },
  {
    type: "cookies_expired",
    test: /cookies are no longer valid|has expired|please sign in\. this may happen/i,
    friendly:
      "The saved YouTube login has expired. Please export fresh cookies and update YT_COOKIES_B64.",
  },
  {
    type: "login_required",
    test: /sign in to view this content|login required/i,
    friendly: "That video requires signing in to view, and the current session can't access it.",
  },
  {
    type: "age_restricted",
    test: /age[- ]restrict/i,
    friendly: "That video is age-restricted and can't be downloaded with the current permissions.",
  },
  {
    type: "private_video",
    test: /private video/i,
    friendly: "That video is private and can't be downloaded.",
  },
  {
    type: "unavailable",
    test: /video (is )?unavailable|this video is no longer available/i,
    friendly: "That video is unavailable (removed, deleted, or never existed).",
  },
  {
    type: "geo_restricted",
    test: /not available in your country|blocked it in your country|geo.?restrict/i,
    friendly: "That video is geo-restricted and isn't available from this server's region.",
  },
  {
    type: "rate_limited",
    test: /429|too many requests|rate.?limit/i,
    friendly: "YouTube is rate-limiting this server right now. Please try again in a bit.",
  },
];

/**
 * @param {string} stderrOrMessage raw text from a failed yt-dlp invocation
 * @returns {{type: string, friendly: string, transient: boolean}}
 */
function classifyError(stderrOrMessage) {
  const text = stderrOrMessage || "";
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test.test(text)) {
      return {
        type: pattern.type,
        friendly: pattern.friendly,
        transient: pattern.type === "rate_limited",
      };
    }
  }
  return {
    type: "unknown",
    friendly: "Download failed for an unknown reason. Check server logs for details.",
    transient: false,
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redacts sensitive values (cookie path, headers) before logging an options
 * object, so logs never leak secrets even though we log "the exact command".
 */
function redactOptionsForLogging(options) {
  const clone = { ...options };
  if (clone.cookies) clone.cookies = "<cookies file path redacted>";
  if (clone.cookiesFromBrowser) clone.cookiesFromBrowser = "<redacted>";
  return clone;
}

const MIN_VALID_MP3_BYTES = 15 * 1024; // ~15KB floor to catch empty/broken files

// ---------------------------------------------------------------------------
// Core download routine.
// Tries multiple format strings, and for each format string tries with/without
// --impersonate + youtube:player_client=web when supported, retrying
// transient (rate-limit) failures with exponential backoff.
// ---------------------------------------------------------------------------

async function downloadAudio(url, outputPath) {
  const formatAttempts = ["bestaudio/best", "bestaudio*", "best"];
  const impersonateAvailable = detectImpersonateSupport();

  // Build the list of "strategies" to try, in priority order. When
  // impersonation is available we prefer it first since it's the strongest
  // defense against bot-check; we still fall back to a plain attempt in case
  // impersonation itself causes an unrelated issue on some formats.
  const strategyVariants = impersonateAvailable
    ? [{ impersonate: true }, { impersonate: false }]
    : [{ impersonate: false }];

  const cookiesValidation = await validateCookiesFile();
  if (!cookiesValidation.valid) {
    console.warn("sing.js: cookies validation failed —", cookiesValidation.reason);
  } else {
    console.log(`sing.js: cookies.txt looks valid (${cookiesValidation.cookieCount} cookie entries)`);
  }

  let lastError = null;
  let lastClassification = null;

  for (const fmt of formatAttempts) {
    for (const variant of strategyVariants) {
      const maxRetries = 2; // total attempts for transient errors on this exact strategy
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const options = {
          format: fmt,
          extractAudio: true,
          audioFormat: "mp3",
          audioQuality: 0, // best
          output: outputPath,
          noCheckCertificate: true,
          noWarnings: true,
          preferFreeFormats: true,
          forceIpv4: true, // avoid flaky IPv6 routes on Render
          addHeader: ["referer:youtube.com"],
        };

        if (cookiesValidation.valid) {
          options.cookies = cookiesFilePath;
        } else if (process.env.YT_COOKIES_FROM_BROWSER) {
          // Local-dev convenience: e.g. YT_COOKIES_FROM_BROWSER="chrome"
          options.cookiesFromBrowser = process.env.YT_COOKIES_FROM_BROWSER;
        } else {
          console.warn("sing.js: no usable cookie source — expect bot-check failures.");
        }

        if (variant.impersonate) {
          options.impersonate = "chrome";
          options.extractorArgs = "youtube:player_client=web";
        }

        console.log(
          `sing.js: attempting download — format="${fmt}" impersonate=${!!variant.impersonate} attempt=${attempt}/${maxRetries}`
        );
        console.log("sing.js: yt-dlp options:", JSON.stringify(redactOptionsForLogging(options)));

        try {
          await youtubedl(url, options);

          // Verify the file actually landed and isn't a truncated/empty stub.
          const exists = await fs.pathExists(outputPath);
          if (!exists) {
            throw new Error("yt-dlp reported success but no output file was found");
          }
          const stat = await fs.stat(outputPath);
          if (stat.size < MIN_VALID_MP3_BYTES) {
            throw new Error(`output file is suspiciously small (${stat.size} bytes)`);
          }

          console.log(`sing.js: download succeeded — format="${fmt}" impersonate=${!!variant.impersonate} size=${stat.size} bytes`);
          return { success: true };
        } catch (e) {
          const stderr = e.stderr || e.message || String(e);
          lastError = e;
          lastClassification = classifyError(stderr);

          console.warn(
            `sing.js: strategy failed — format="${fmt}" impersonate=${!!variant.impersonate} attempt=${attempt} type=${lastClassification.type}`
          );
          console.warn("sing.js: full stderr/stdout for failed attempt:\n", stderr);

          await fs.remove(outputPath).catch(() => {});

          // Only retry the *same* strategy for transient (rate-limit) errors;
          // anything else (bot-check, unavailable, etc.) won't be fixed by
          // simply trying again with the same inputs, so move on immediately.
          if (lastClassification.transient && attempt < maxRetries) {
            const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, ...
            console.log(`sing.js: transient error, backing off ${backoffMs}ms before retry`);
            await sleep(backoffMs);
            continue;
          }
          break; // move on to next variant/format
        }
      }
    }
  }

  return {
    success: false,
    error: lastError,
    classification: lastClassification || classifyError(""),
  };
}

// ---------------------------------------------------------------------------
// GoatBot V2 command
// ---------------------------------------------------------------------------

module.exports = {
  config: {
    name: "sing",
    aliases: ["song", "music"],
    version: "4.0",
    author: "Bright",
    countDown: 5,
    role: 0,
    shortDescription: { en: "Search and download YouTube audio" },
    category: "media",
    guide: { en: "{pn} <song name>" },
  },

  onStart: async function ({ message, args, event, commandName }) {
    const query = args.join(" ");
    if (!query) return message.reply("Please provide a song name.");

    let searchResult;
    try {
      searchResult = await ytSearch(query);
    } catch (e) {
      console.error("sing.js: yt-search failed:", e.message);
      return message.reply("Search failed — YouTube search is unavailable right now.");
    }

    const videos = searchResult?.videos;
    if (!Array.isArray(videos) || videos.length === 0) {
      return message.reply("No songs found.");
    }

    const topResults = videos.slice(0, 6);
    await fs.ensureDir(cacheDir);

    let msg = "";
    const attachments = [];
    const tempImagePaths = [];

    for (let i = 0; i < topResults.length; i++) {
      const v = topResults[i];
      msg += `${i + 1}. ${v.title}\n[${v.timestamp}]\n\n`;
      try {
        const imgPath = path.join(
          cacheDir,
          `sing_thumb_${Date.now()}_${crypto.randomBytes(3).toString("hex")}_${i}.jpg`
        );
        const imgRes = await axios.get(v.thumbnail, { responseType: "arraybuffer", timeout: 10000 });
        await fs.writeFile(imgPath, Buffer.from(imgRes.data));
        attachments.push(fs.createReadStream(imgPath));
        tempImagePaths.push(imgPath);
      } catch (e) {
        console.error("sing.js: thumbnail fetch failed:", e.message);
      }
    }

    message.reply(
      { body: msg.trim(), attachment: attachments.length ? attachments : undefined },
      (err, info) => {
        // Clean up thumbnail files regardless of send success, so a crash
        // mid-send never leaves temp images behind.
        tempImagePaths.forEach((p) => {
          setTimeout(() => fs.remove(p).catch(() => {}), 10000);
        });

        if (err) {
          console.error("sing.js: failed to send results message:", err);
          return;
        }

        global.GoatBot.onReply.set(info.messageID, {
          commandName,
          author: event.senderID,
          results: topResults.map((v) => ({ title: v.title, url: v.url })),
        });
      }
    );
  },

  onReply: async function ({ message, event, Reply, api }) {
    const choice = parseInt(event.body, 10);
    if (isNaN(choice) || choice < 1 || choice > Reply.results.length) return;

    // Prevent the same user from firing overlapping downloads (e.g. double
    // tapping a number) which could otherwise race on cleanup or hammer
    // yt-dlp needlessly.
    const lockKey = `${event.threadID}:${event.senderID}`;
    if (activeDownloads.has(lockKey)) {
      return message.reply("Already downloading your previous request — please wait for it to finish.");
    }
    activeDownloads.add(lockKey);

    const selected = Reply.results[choice - 1];
    const threadID = event.threadID;

    // Unique-per-request filename (timestamp + random suffix) so concurrent
    // downloads from different users never collide on disk.
    const filePath = path.join(
      cacheDir,
      `sing_dl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp3`
    );

    try {
      // Safely unsend the previous prompt message, if it exists.
      try {
        if (event.messageReply?.messageID) {
          await api.unsendMessage(event.messageReply.messageID, threadID);
        }
      } catch (e) {
        console.error("sing.js: unsendMessage failed:", e.message);
      }

      // Safely react with an hourglass while downloading.
      try {
        await api.setMessageReaction("⏳", event.messageID, threadID);
      } catch (e) {
        console.error("sing.js: setMessageReaction (⏳) failed:", e.message);
      }

      await fs.ensureDir(cacheDir);

      let result;
      try {
        result = await downloadAudio(selected.url, filePath);
      } catch (e) {
        // Defensive: downloadAudio should never throw, but guarantee the
        // bot never crashes even if it does.
        console.error("sing.js: downloadAudio threw unexpectedly:", e.message);
        result = { success: false, error: e, classification: classifyError(e.message) };
      }

      if (!result.success) {
        console.error(
          "sing.js: download failed after all strategies —",
          result.classification.type,
          result.error?.stderr || result.error?.message
        );
        await api.setMessageReaction("❌", event.messageID, threadID).catch((err) => {
          console.error("sing.js: setMessageReaction (❌) failed:", err.message);
        });
        message.reply(result.classification.friendly);
        return;
      }

      try {
        await message.reply({
          body: selected.title,
          attachment: fs.createReadStream(filePath),
        });

        await api.setMessageReaction("✅", event.messageID, threadID).catch((e) => {
          console.error("sing.js: setMessageReaction (✅) failed:", e.message);
        });
      } catch (e) {
        console.error("sing.js: failed to send audio reply:", e.message);
        await api.setMessageReaction("❌", event.messageID, threadID).catch(() => {});
        message.reply(`Download succeeded but sending failed: ${e.message}`);
      }
    } finally {
      // Always clean up, even if something above threw unexpectedly.
      await fs.remove(filePath).catch(() => {});
      activeDownloads.delete(lockKey);
    }
  },
};