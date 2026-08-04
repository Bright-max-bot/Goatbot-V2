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

# Make registry fetches resilient to transient DNS/network blips, without
# padding failures out to many minutes while we're still diagnosing.
ENV NPM_CONFIG_FETCH_RETRIES=2
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=30000

COPY package.json package-lock.json ./

# DIAGNOSTIC MODE: package-lock.json is still out of sync with package.json,
# which is forcing npm to fully re-resolve the tree (see chat explanation) —
# that's the top suspect for the ~500s hang you just hit. --loglevel=verbose
# streams every registry request straight to the build log, and the `||`
# fallback dumps npm's internal debug log (the file the generic "Exit
# handler never called!" message points to but Docker normally discards on
# failure) so we can see the ACTUAL underlying error instead of the mask.
# Once the real cause is identified and the lockfile is regenerated, replace
# this whole line with:
#   RUN npm ci --no-audit --no-fund
RUN npm install --no-audit --no-fund --loglevel=verbose \
 || (echo "----- NPM DEBUG LOG -----"; cat /root/.npm/_logs/*-debug-0.log; exit 1)

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
