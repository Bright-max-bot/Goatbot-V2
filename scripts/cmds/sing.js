const ytSearch = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const cacheDir = path.join(__dirname, "cache");
const cookiesFilePath = path.join(cacheDir, "cookies.txt");

// ---------------------------------------------------------------------------
// yt-dlp binary resolution.
//
// IMPORTANT: we never hand-build a path like `__dirname + "/node_modules/..."`.
// GoatBot commands can end up nested several levels deep (e.g.
// /app/scripts/cmds/sing.js) while youtube-dl-exec may actually be installed
// higher up the tree (hoisted to the project root's node_modules) or, less
// commonly, nested right next to this file. Node's own module resolution
// algorithm (the same one `require()` uses) is the only thing that reliably
// finds the correct copy for *this* file's location, so we lean on
// `require.resolve()` exclusively — never `path.join()` — for locating it.
//
// We try a small list of candidate subpaths (both binary names, regardless
// of platform) because some Windows builds still ship the extension-less
// name and some third-party mirrors ship `.exe` even where you wouldn't
// expect it. Each candidate is resolved independently so one failure never
// blocks the others.
// ---------------------------------------------------------------------------

let ytDlpBinPath = null;
let ytDlpBinSource = null; // which candidate subpath actually resolved
let ytDlpModulePath = null; // resolved youtube-dl-exec/package.json, for diagnostics only
let ytDlpResolutionError = null;

function resolveYtDlpModulePath() {
  try {
    return { path: require.resolve("youtube-dl-exec/package.json"), error: null };
  } catch (e) {
    return { path: null, error: e.message };
  }
}

function resolveYtDlpBinary() {
  const candidates =
    process.platform === "win32"
      ? ["youtube-dl-exec/bin/yt-dlp.exe", "youtube-dl-exec/bin/yt-dlp"]
      : ["youtube-dl-exec/bin/yt-dlp", "youtube-dl-exec/bin/yt-dlp.exe"];

  const errors = [];
  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate);
      return { path: resolved, source: candidate, error: null };
    } catch (e) {
      errors.push(`${candidate} -> ${e.message}`);
    }
  }
  return { path: null, source: null, error: errors.join(" | ") };
}

(function initYtDlpBinaryResolution() {
  const moduleResult = resolveYtDlpModulePath();
  ytDlpModulePath = moduleResult.path;
  if (!moduleResult.path) {
    console.warn(
      "sing.js: could not resolve the youtube-dl-exec package itself —",
      moduleResult.error
    );
  }

  const binResult = resolveYtDlpBinary();
  ytDlpBinPath = binResult.path;
  ytDlpBinSource = binResult.source;
  ytDlpResolutionError = binResult.error;

  if (!ytDlpBinPath) {
    // Never crash on this — the bot should keep running (search UI, replies,
    // etc. all still work), it just won't be able to actually download
    // audio until this is fixed.
    console.warn(
      "sing.js: could not resolve a yt-dlp binary via require.resolve() — downloads will fail until this is fixed. Reason:",
      ytDlpResolutionError
    );
  }
})();

// ---------------------------------------------------------------------------
// In-memory guards / caches (per-process, reset on redeploy/restart).
// ---------------------------------------------------------------------------

// Prevents the same user from stacking multiple concurrent downloads, which
// on Render's shared CPU could starve every in-flight request and also risks
// two writes racing on cleanup. Keyed by `${threadID}:${senderID}`.
const activeDownloads = new Set();

// Cached after first detection so we don't shell out to `--help` on every
// single download attempt. yt-dlp's capabilities don't change mid-process,
// so this is safe to cache for the lifetime of the process.
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

/**
 * Reads the yt-dlp version by invoking the resolved binary directly. This is
 * the one place we still shell out to the binary manually — it's purely for
 * diagnostics (there's no youtube-dl-exec API for "give me --version" that's
 * cheaper than just running it), and it's guarded so a missing/broken binary
 * can never crash the process.
 */
function getYtDlpVersion() {
  if (!ytDlpBinPath) {
    console.warn("sing.js: skipping version check — no yt-dlp binary was resolved.");
    return null;
  }
  try {
    return execFileSync(ytDlpBinPath, ["--version"], { timeout: 10000 }).toString().trim();
  } catch (e) {
    console.warn("sing.js: could not read yt-dlp version —", e.message);
    return null;
  }
}

/**
 * Detects whether the resolved yt-dlp binary supports --impersonate
 * (requires yt-dlp to be built/installed with curl_cffi). Not every
 * distribution of yt-dlp ships with impersonation support, so we probe
 * `--help` once and cache the result rather than assuming.
 */
function detectImpersonateSupport() {
  if (impersonateSupportCache !== null) return impersonateSupportCache;
  if (!ytDlpBinPath) {
    console.warn("sing.js: skipping --impersonate probe — no yt-dlp binary was resolved.");
    impersonateSupportCache = false;
    return impersonateSupportCache;
  }
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
  console.log("sing.js: ---- startup diagnostics ----");
  console.log("sing.js: platform:", process.platform, "| node:", process.version);
  console.log(
    "sing.js: resolved youtube-dl-exec module path:",
    ytDlpModulePath ? path.dirname(ytDlpModulePath) : "NOT FOUND"
  );
  console.log(
    "sing.js: resolved yt-dlp binary path:",
    ytDlpBinPath ? `${ytDlpBinPath} (via "${ytDlpBinSource}")` : `NOT FOUND — ${ytDlpResolutionError || "unknown reason"}`
  );

  const version = getYtDlpVersion();
  console.log("sing.js: yt-dlp version:", version || "unknown");
  detectImpersonateSupport();

  console.log(
    "sing.js: YT_ env keys visible:",
    Object.keys(process.env).filter((k) => k.startsWith("YT_"))
  );
  console.log("sing.js: ---- end startup diagnostics ----");
}

ensureCookiesFile()
  .then(() => logStartupDiagnostics())
  .catch((e) => console.error("sing.js: startup diagnostics failed unexpectedly —", e.message));

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
  {
    type: "network_failure",
    test: /econnreset|enotfound|etimedout|network is unreachable|socket hang up|econnrefused/i,
    friendly: "A network error occurred while talking to YouTube. Please try again.",
  },
  {
    type: "timeout",
    test: /timed out|operation timeout/i,
    friendly: "The download timed out. Please try again.",
  },
  {
    type: "binary_missing",
    test: /enoent.*yt-dlp|spawn.*enoent/i,
    friendly:
      "The download engine isn't available on this server right now. An admin needs to check the deployment (yt-dlp binary missing).",
  },
];

// Failure types that are worth retrying (transient / environment-level) as
// opposed to failures that are inherent to the video itself and will never
// succeed no matter how many times we retry.
const RETRYABLE_TYPES = new Set(["rate_limited", "network_failure", "timeout"]);

// Failure types that should never be retried, even against a different
// format/strategy — retrying wastes time and just re-confirms the same
// permanent outcome.
const NEVER_RETRY_TYPES = new Set(["private_video", "unavailable", "login_required"]);

/**
 * @param {string} stderrOrMessage raw text from a failed yt-dlp invocation
 * @returns {{type: string, friendly: string, transient: boolean, retryable: boolean}}
 */
function classifyError(stderrOrMessage) {
  const text = stderrOrMessage || "";
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test.test(text)) {
      return {
        type: pattern.type,
        friendly: pattern.friendly,
        transient: RETRYABLE_TYPES.has(pattern.type),
        retryable: !NEVER_RETRY_TYPES.has(pattern.type),
      };
    }
  }
  return {
    type: "unknown",
    friendly: "Download failed for an unknown reason. Check server logs for details.",
    transient: false,
    retryable: true,
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
// transient (rate-limit/network/timeout) failures with exponential backoff.
//
// This calls youtube-dl-exec's official API (`youtubedl(url, options)`)
// exclusively for the actual download — we never spawn the yt-dlp binary
// ourselves for this part, so binary path resolution mistakes here can't
// happen. Manual invocation is reserved strictly for the diagnostics above
// (version / --help probing), which is unavoidable since youtube-dl-exec
// doesn't expose those as API calls.
// ---------------------------------------------------------------------------

async function downloadAudio(url, outputPath) {
  if (!ytDlpBinPath) {
    // Fail fast with a clear, correctly-classified error instead of letting
    // youtube-dl-exec throw a raw ENOENT partway through a retry loop.
    const message =
      "yt-dlp binary is not available (resolution failed at startup: " +
      (ytDlpResolutionError || "unknown reason") +
      ")";
    console.error("sing.js: aborting download —", message);
    return {
      success: false,
      error: new Error(message),
      classification: classifyError(message),
    };
  }

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
  let totalAttempts = 0;

  outer: for (const fmt of formatAttempts) {
    for (const variant of strategyVariants) {
      const maxRetries = 2; // total attempts for transient errors on this exact strategy
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        totalAttempts++;
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
          `sing.js: attempting download — format="${fmt}" impersonate=${!!variant.impersonate} attempt=${attempt}/${maxRetries} (total attempt #${totalAttempts})`
        );
        console.log("sing.js: yt-dlp options:", JSON.stringify(redactOptionsForLogging(options)));

        try {
          const result = await youtubedl(url, options);
          if (result && typeof result === "string" && result.trim()) {
            console.log("sing.js: yt-dlp stdout:\n", result);
          }

          // Verify the file actually landed and isn't a truncated/empty stub.
          const exists = await fs.pathExists(outputPath);
          if (!exists) {
            throw new Error("yt-dlp reported success but no output file was found");
          }
          const stat = await fs.stat(outputPath);
          if (stat.size < MIN_VALID_MP3_BYTES) {
            throw new Error(`output file is suspiciously small (${stat.size} bytes)`);
          }
          try {
            await fs.access(outputPath, fs.constants.R_OK);
          } catch (accessErr) {
            throw new Error(`output file is not readable: ${accessErr.message}`);
          }

          console.log(
            `sing.js: download succeeded — format="${fmt}" impersonate=${!!variant.impersonate} size=${stat.size} bytes exitCode=0 retries=${attempt - 1}`
          );
          return { success: true };
        } catch (e) {
          const stderr = e.stderr || e.message || String(e);
          const stdout = e.stdout || "";
          const exitCode = typeof e.exitCode === "number" ? e.exitCode : (typeof e.code === "number" ? e.code : "unknown");
          lastError = e;
          lastClassification = classifyError(stderr);

          console.warn(
            `sing.js: strategy failed — format="${fmt}" impersonate=${!!variant.impersonate} attempt=${attempt}/${maxRetries} type=${lastClassification.type} exitCode=${exitCode}`
          );
          if (stdout && stdout.trim()) {
            console.warn("sing.js: stdout for failed attempt:\n", stdout);
          }
          console.warn("sing.js: stderr for failed attempt:\n", stderr);

          await fs.remove(outputPath).catch(() => {});

          // Never retry failures that are inherent to the video itself —
          // no amount of retrying fixes a private/unavailable video or a
          // hard login requirement.
          if (!lastClassification.retryable) {
            console.log(`sing.js: "${lastClassification.type}" is not retryable — stopping entirely.`);
            break outer;
          }

          // Only retry the *same* strategy for transient errors (rate-limit,
          // network, timeout); anything else (bot-check, age-restricted,
          // geo-restricted, etc.) won't be fixed by simply trying again with
          // the same inputs, so move on to the next strategy immediately.
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
        const thumbStream = fs.createReadStream(imgPath);
        // Readable streams emit 'error' on read failures; with no listener
        // that's an uncaught exception that crashes the whole bot process.
        thumbStream.on("error", (err) =>
          console.error("sing.js: thumbnail stream error:", err.message)
        );
        attachments.push(thumbStream);
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
    // Only the user who triggered the original search should be able to act
    // on this reply.
    if (event.senderID !== Reply.author) return;

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
    // downloads from different users — or the same user across retries —
    // never collide on disk.
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
        const audioStream = fs.createReadStream(filePath);
        audioStream.on("error", (err) =>
          console.error("sing.js: audio stream error:", err.message)
        );

        await message.reply({
          body: selected.title,
          attachment: audioStream,
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