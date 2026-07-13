FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY certs ./certs
COPY scripts ./scripts
COPY src ./src

RUN mkdir -p data logs \
  && chown -R node:node /app

USER node

CMD ["node", "scripts/run-with-ca.js", "src/polling.js"]
