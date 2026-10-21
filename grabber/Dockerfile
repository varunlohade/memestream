# node:22-slim (Debian) with ffmpeg and a pinned yt-dlp. yt-dlp[default] brings yt-dlp-ejs, which
# solves YouTube's player challenges with the image's own Node (--js-runtimes node).
FROM node:22-slim
ARG YTDLP_VERSION=2026.08.19
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates \
  && pip install --no-cache-dir --break-system-packages "yt-dlp[default]==${YTDLP_VERSION}" \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json grab.mjs index.mjs ./
USER node
CMD ["node", "index.mjs"]
