FROM node:slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
RUN npm install && npm cache clean --force

COPY . .

ENV PORT=5000
EXPOSE 5000

CMD ["node", "index.js"]