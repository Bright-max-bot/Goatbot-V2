# Use Node.js 20 LTS
FROM node:20-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    ca-certificates \
    curl \
 && rm -rf /var/lib/apt/lists/*

# Prevent youtube-dl-exec from trying to install Python
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

# Prevent youtube-dl-exec from downloading yt-dlp during npm install
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev \
 && npm cache clean --force

# Copy application
COPY . .

# Download the latest yt-dlp binary directly (avoids GitHub API rate limit)
RUN mkdir -p /usr/local/bin && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

# Verify installation
RUN yt-dlp --version

ENV PORT=5000

EXPOSE 5000

CMD ["node", "index.js"]