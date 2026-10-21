# node:22-slim (Debian). The video grabber (ffmpeg + yt-dlp) is its own service: ../grabber.
FROM node:22-slim
WORKDIR /app
COPY package.json loop.mjs index.mjs ./
USER node
CMD ["node", "index.mjs"]
