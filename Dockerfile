# syntax=docker/dockerfile:1

# ── Base ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# ── Build (full deps) ─────────────────────────────────────────────────────────
# BuildKit cache mounts keep the pnpm store across builds (PNPM_HOME=/pnpm →
# store defaults to /pnpm/store). Coolify builds with BuildKit.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── Production deps only ──────────────────────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# adapter-node listens here; Coolify maps its proxy to this port.
ENV PORT=3000
EXPOSE 3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/src/lib/server/db/migrate.mjs ./migrate.mjs
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./

# Tandem insulin sidecar (Python). Tandem has no official API, so
# scripts/tandem_sync.py drives tconnectsync to decode the Tandem Source event
# log. Inert unless TANDEM_ENC_KEY is configured, but baked in so the integration
# works in this image when enabled. tandem.ts spawns it via these env paths.
COPY --from=build /app/scripts ./scripts
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl python3 python3-venv \
	&& rm -rf /var/lib/apt/lists/* \
	&& python3 -m venv /opt/tandem-venv \
	&& /opt/tandem-venv/bin/pip install --no-cache-dir -r scripts/requirements-tandem.txt
ENV TANDEM_PYTHON=/opt/tandem-venv/bin/python
ENV TANDEM_SCRIPT=/app/scripts/tandem_sync.py

# Claude sandbox sidecar — runs as a SEPARATE process inside this same container
# (127.0.0.1:8787), reached by the app at AGENT_URL=http://127.0.0.1:8787. Bundled here
# (like the Tandem sidecar above) so there's no cross-service networking and it inherits the
# app's zero-downtime deploy. Its deps live in agent/node_modules, isolated from the app's.
# Manifests first so agent source edits don't re-run the install; npm cache persists via mount.
COPY --from=build /app/agent/package.json /app/agent/package-lock.json ./agent/
RUN --mount=type=cache,id=npm,target=/root/.npm cd agent && npm ci --omit=dev
COPY --from=build /app/agent ./agent

# Drop root for both processes. Nothing under /app is written at runtime (no uploads dir,
# migrations are DB-only, tandem never caches to disk; /opt/tandem-venv is read+exec).
# The Claude CLI does write session state (chat resume) under $HOME — the node image
# ships /home/node owned by node, and HOME is pinned so the CLI never tries /root.
ENV HOME=/home/node
USER node

# Run migrations, then start the sidecar (background) + the app (foreground). See scripts/start.sh.
CMD ["sh", "scripts/start.sh"]
