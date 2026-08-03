FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install -g npm@10

ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true

RUN npm install --no-audit --no-fund

COPY . .

RUN mkdir -p /usr/local/bin \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

RUN yt-dlp --version
RUN npm ls moment-timezone

ENV PORT=5000

EXPOSE 5000

CMD ["node", "index.js"]