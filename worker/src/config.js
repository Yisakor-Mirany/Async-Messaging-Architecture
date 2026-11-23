'use strict';

/**
 * Configuration for the worker and the outbox publisher. All values come from
 * environment variables (documented in .env.example).
 */
const os = require('os');
const crypto = require('crypto');

function readInt(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid configuration: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const processingMinMs = readInt(env, 'PROCESSING_MIN_MS', 3000, { min: 0 });
  const processingMaxMs = readInt(env, 'PROCESSING_MAX_MS', 5000, { min: 0 });
  if (processingMaxMs < processingMinMs) throw new Error('PROCESSING_MAX_MS must be >= PROCESSING_MIN_MS');

  const jobLeaseMs = readInt(env, 'JOB_LEASE_MS', 10000, { min: 1000 });

  return {
    logLevel: env.LOG_LEVEL || 'info',
    // Unique per process: a restarted worker is a *new* lease holder.
    workerId: `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,

    // Consumer behaviour
    prefetch: readInt(env, 'WORKER_PREFETCH', 1, { min: 1, max: 100 }),
    maxAttempts: readInt(env, 'MAX_ATTEMPTS', 3, { min: 1, max: 20 }),
    infraBackoffMs: readInt(env, 'INFRA_RETRY_BACKOFF_MS', 2000, { min: 0 }),
    jobLeaseMs,
    processingMinMs,
    processingMaxMs,
    shutdownTimeoutMs: readInt(env, 'WORKER_SHUTDOWN_TIMEOUT_MS', 15000, { min: 0 }),
    heartbeatFile: env.HEARTBEAT_FILE || '/tmp/service.heartbeat',

    // Outbox publisher behaviour
    outboxPollIntervalMs: readInt(env, 'OUTBOX_POLL_INTERVAL_MS', 250, { min: 10 }),
    outboxBatchSize: readInt(env, 'OUTBOX_BATCH_SIZE', 50, { min: 1, max: 1000 }),
    reconcileIntervalMs: readInt(env, 'RECONCILE_INTERVAL_MS', 60000, { min: 1000 }),
    reconcileStaleMs: readInt(env, 'RECONCILE_STALE_MS', 600000, { min: 10000 }),

    rabbitmq: {
      hostname: env.RABBITMQ_HOST || 'localhost',
      port: readInt(env, 'RABBITMQ_PORT', 5672, { min: 1, max: 65535 }),
      username: env.RABBITMQ_USER,
      password: env.RABBITMQ_PASSWORD,
      vhost: env.RABBITMQ_VHOST || '/',
      heartbeat: readInt(env, 'RABBITMQ_HEARTBEAT_S', 30, { min: 0 }),
    },
    topology: {
      exchange: env.RABBITMQ_EXCHANGE || 'reports',
      routingKey: env.RABBITMQ_ROUTING_KEY || 'report.generate',
      mainQueue: env.RABBITMQ_QUEUE || 'reports.jobs',
      retryExchange: env.RABBITMQ_RETRY_EXCHANGE || 'reports.retry',
      retryQueue: env.RABBITMQ_RETRY_QUEUE || 'reports.jobs.retry',
      retryDelayMs: readInt(env, 'RETRY_DELAY_MS', 3000, { min: 100 }),
      deadLetterExchange: env.RABBITMQ_DLX || 'reports.dlx',
      deadLetterQueue: env.RABBITMQ_DLQ || 'reports.jobs.dlq',
      deadLetterRoutingKey: env.RABBITMQ_DLQ_ROUTING_KEY || 'report.dead',
    },
    database: {
      host: env.POSTGRES_HOST || 'localhost',
      port: readInt(env, 'POSTGRES_PORT', 5432, { min: 1, max: 65535 }),
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
      max: readInt(env, 'POSTGRES_POOL_MAX', 5, { min: 1, max: 100 }),
      connectionTimeoutMillis: readInt(env, 'POSTGRES_CONNECT_TIMEOUT_MS', 3000, { min: 100 }),
      queryTimeoutMs: readInt(env, 'POSTGRES_QUERY_TIMEOUT_MS', 10000, { min: 100 }),
    },
  };
}

function assertCredentials(config) {
  const missing = [];
  if (!config.database.user) missing.push('POSTGRES_USER');
  if (!config.database.password) missing.push('POSTGRES_PASSWORD');
  if (!config.database.database) missing.push('POSTGRES_DB');
  if (!config.rabbitmq.username) missing.push('RABBITMQ_USER');
  if (!config.rabbitmq.password) missing.push('RABBITMQ_PASSWORD');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')} (copy .env.example to .env)`);
}

module.exports = { loadConfig, assertCredentials, readInt };
