# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /agent

# Deps first for layer caching. npm ci when a lockfile is present, else install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=8787
EXPOSE 8787
USER node

# Coolify healthcheck target is GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
