# API image (also used by the one-shot `migrate` service).
# Build context is the repository root so the image can include the
# frontend and database migrations:  docker build -f api/Dockerfile .
FROM node:24-alpine

ENV NODE_ENV=production \
    FRONTEND_DIR=/app/public \
    MIGRATIONS_DIR=/app/database/migrations

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY api/src ./src
COPY database ./database
COPY frontend ./public

# Run as the unprivileged "node" user that ships with the official image.
USER node

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/server.js"]
