# Self-hosted edition (DESIGN.md §11). One image, two processes selected via
# `command:` in docker-compose.selfhosted.yml (server vs worker) — same as
# the two `npm run` scripts used in normal dev.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    # docker CLI only (no daemon) — the worker process shells out to a
    # sibling `docker run` on the host engine via the mounted socket
    # (docker-outside-of-docker) to launch the execution sandbox (DESIGN.md
    # §7.3). Harmless/unused by the server process.
    && apt-get update \
    && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/server.js"]
