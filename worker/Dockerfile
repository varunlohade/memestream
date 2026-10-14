# node:22-slim (Debian), so ffmpeg and streamlink can be added later for the video grabber:
#   RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-pip && pip install --break-system-packages streamlink
FROM node:22-slim
WORKDIR /app
COPY package.json loop.mjs index.mjs ./
USER node
CMD ["node", "index.mjs"]
