FROM node:20-slim

WORKDIR /app

# System packages required to COMPILE the native modules in this project:
# - build-essential, pkg-config: gcc/g++/make + pkg-config, needed by
#   node-gyp for bcrypt, sqlite3, and canvas when no prebuilt binary
#   matches this exact Node/glibc/arch combination.
# - libcairo2-dev, libpango1.0-dev, libjpeg-dev, libgif-dev, librsvg2-dev:
#   canvas's Cairo bindings will NOT build without these — this was the
#   single most likely cause of the native-module portion of the crash;
#   node:20-slim ships none of them.
# - python3: required by node-gyp itself.
# - ffmpeg, curl, ca-certificates: runtime/deploy-time needs (fluent-ffmpeg,
#   yt-dlp download step below).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pin npm to a release that still supports Node 20 (npm@latest now requires
# Node >=22.22/24.15/26 and fails outright on this base image).
RUN npm install -g npm@10

ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true

# Make registry fetches resilient to the transient DNS/network blips that
# are common inside Docker's build-time network namespace. A fetch failure
# partway through install is one of the documented triggers of npm's
# generic "Exit handler never called!" internal-error bug (npm/cli issues
# #6409, #7639, #7666, #8407, #8766, #8974) — it doesn't fix that bug, but
# it removes one of its most common triggers.
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

COPY package.json package-lock.json ./

# IMPORTANT: package-lock.json is currently out of sync with package.json
# (see chat explanation) — `npm ci` will refuse to run until that's fixed.
# Once you've regenerated the lockfile locally (see instructions), switch
# this line to:
#   RUN npm ci --no-audit --no-fund
# npm ci is faster, fully deterministic, and — critically — will fail with
# a clear, specific error instead of silently re-resolving a mismatched
# tree, which is what a stale lockfile forces `npm install` to do now.
RUN npm install --no-audit --no-fund

COPY . .

RUN mkdir -p /usr/local/bin \
 && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

RUN yt-dlp --version
# Non-fatal: this is a diagnostic sanity check, not something that should
# fail the whole image build if it ever returns non-zero.
RUN npm ls moment-timezone || true

ENV PORT=5000

EXPOSE 5000

CMD ["node", "index.js"]
