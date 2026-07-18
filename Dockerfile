# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Dependencies — isolated so a source change does not re-run npm ci.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

# tini reaps zombies and forwards SIGTERM, so the app's graceful shutdown
# actually runs instead of the container being killed outright.
RUN apk add --no-cache tini wget

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY public ./public

# Never run as root.
USER node

EXPOSE 4000

# The app reports 503 here when MongoDB is unreachable, so an unhealthy
# container is one that genuinely cannot serve calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
