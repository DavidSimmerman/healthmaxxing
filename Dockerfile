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

# Run pending migrations, then start the server. If migration fails the
# container exits non-zero (Coolify will surface it) rather than serving on a
# stale schema.
CMD ["sh", "-c", "node migrate.mjs && node build"]
