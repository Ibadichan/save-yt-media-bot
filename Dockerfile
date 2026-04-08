FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp curl_cffi && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY . .

RUN mkdir -p /app/logs && chown -R node:node /app/logs

ENV NODE_ENV=production

USER node

CMD ["node", "index.js"]
