'use strict';

/**
 * Centralised, validated configuration for the API service.
 * Every value comes from environment variables (see .env.example) so that no
 * credentials are hard-coded. Defaults are suitable for local development only.
 */
const path = require('path');

function readInt(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid configuration: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid configuration: ${name} must be true or false`);
}

function loadConfig(env = process.env) {
  return {
    port: readInt(env, 'API_INTERNAL_PORT', 3000, { min: 1, max: 65535 }),
    logLevel: env.LOG_LEVEL || 'info',
    allowFailureSimulation: readBool(env, 'ALLOW_FAILURE_SIMULATION', false),
    routingKey: env.RABBITMQ_ROUTING_KEY || 'report.generate',
    outboxDegradedAfterMs: readInt(env, 'OUTBOX_DEGRADED_AFTER_MS', 30000, { min: 1000 }),
    frontendDir: env.FRONTEND_DIR || path.resolve(__dirname, '..', '..', 'frontend'),
    migrationsDir: env.MIGRATIONS_DIR || path.resolve(__dirname, '..', '..', 'database', 'migrations'),
    database: {
      host: env.POSTGRES_HOST || 'localhost',
      port: readInt(env, 'POSTGRES_PORT', 5432, { min: 1, max: 65535 }),
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
      max: readInt(env, 'POSTGRES_POOL_MAX', 10, { min: 1, max: 100 }),
      connectionTimeoutMillis: readInt(env, 'POSTGRES_CONNECT_TIMEOUT_MS', 2000, { min: 100 }),
      queryTimeoutMs: readInt(env, 'POSTGRES_QUERY_TIMEOUT_MS', 5000, { min: 100 }),
    },
  };
}

module.exports = { loadConfig, readInt, readBool };
