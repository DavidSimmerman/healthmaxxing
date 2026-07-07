# syntax=docker/dockerfile:1

# ── Base ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# ── Build (full deps) ─────────────────────────────────────────────────────────
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── Production deps only ──────────────────────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

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
COPY --from=build /app/agent ./agent
RUN cd agent && npm ci --omit=dev

# Run migrations, then start the sidecar (background) + the app (foreground). See scripts/start.sh.
CMD ["sh", "scripts/start.sh"]
