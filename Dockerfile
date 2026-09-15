# Self-hosted edition (DESIGN.md §11). One image, two processes selected via
# `command:` in docker-compose.selfhosted.yml (server vs worker) — same as
# the two `npm run` scripts used in normal dev.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Node's default UV_THREADPOOL_SIZE is 4 — DNS lookups and TLS handshakes both consume
# threadpool slots. Confirmed in production (2026-09-15): a review job's outbound call
# (embeddings) stalled, and — despite a real per-call timeout and no SDK-level retries —
# stayed stuck for many minutes with a fully healthy, non-blocked event loop (heartbeat
# timers kept firing normally throughout). That points at threadpool exhaustion, not an
# event-loop hang: with only 4 slots shared process-wide across every concurrent outbound
# HTTPS call this worker makes (Supabase, OpenAI, Anthropic, GitHub, batched 5 review jobs
# at once), one genuinely stalled connection can starve every other TLS/DNS-bound call in
# the process, including totally unrelated ones. A larger pool gives real headroom.
ENV UV_THREADPOOL_SIZE=16
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
