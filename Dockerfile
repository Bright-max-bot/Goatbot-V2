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

# Force the real, universally-reachable public registry. package-lock.json
# was generated inside a Replit workspace, where Replit's Package Firewall
# (Socket) transparently rewrites every "resolved" URL to point at the
# internal host package-firewall.replit.local. That host is unreachable
# from this isolated Docker build container, which is what caused every
# ENOTFOUND above and, in turn, npm's "Exit handler never called!" bug.
# Setting this as an env var overrides any .npmrc (including one baked
# into the repo) that might otherwise point back at the internal proxy.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org

ENV NPM_CONFIG_FETCH_RETRIES=2
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=30000

COPY package.json package-lock.json ./

# One-time repair: rewrite every lockfile "resolved" URL from Replit's
# internal Package Firewall host back to the real npm registry. The path
# structure is identical (/npm/<pkg>/-/<pkg>-<version>.tgz maps 1:1 onto
# registry.npmjs.org's own tarball layout) — this is a pure host swap.
RUN sed -i 's#http://package-firewall\.replit\.local/npm/#https://registry.npmjs.org/#g' package-lock.json

# DIAGNOSTIC MODE: package-lock.json is still out of sync with package.json
# (see chat explanation) — `npm ci` will refuse to run until that's fixed.
# --loglevel=verbose streams every registry request straight to the build
# log, and the `||` fallback dumps npm's internal debug log so we can see
# the real underlying error if anything still goes wrong.
# Once package-lock.json is properly regenerated (ideally outside any
# Replit-proxied environment, so its resolved URLs are correct from the
# start), replace this whole line with:
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
