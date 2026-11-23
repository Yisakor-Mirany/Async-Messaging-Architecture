# Worker image. Also runs the outbox publisher with a different command:
#   node src/index.js             -> report worker (RabbitMQ consumer)
#   node src/outbox-publisher.js  -> transactional outbox relay
FROM node:24-alpine

ENV NODE_ENV=production \
    HEARTBEAT_FILE=/tmp/service.heartbeat

WORKDIR /app

COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY worker/src ./src

USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/index.js"]
