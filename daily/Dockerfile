# node:22-slim (Debian). No npm dependencies: plain fetch, node:crypto ed25519 and JSON-RPC.
FROM node:22-slim
WORKDIR /app
COPY package.json index.mjs job.mjs solana.mjs streams.mjs ./
USER node
CMD ["node", "index.mjs"]
