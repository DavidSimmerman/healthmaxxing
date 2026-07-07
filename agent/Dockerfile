# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /agent

# curl for the container healthcheck — node:slim ships neither curl nor wget, and
# Coolify's default healthcheck shells out to one of them.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl \
	&& rm -rf /var/lib/apt/lists/*

# Deps first for layer caching. npm ci when a lockfile is present, else install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=8787
EXPOSE 8787
USER node

# Coolify healthcheck target is GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
	CMD curl -fsS "http://127.0.0.1:${PORT:-8787}/health" || exit 1

CMD ["node", "server.mjs"]
