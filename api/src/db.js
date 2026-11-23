'use strict';

const { Pool } = require('pg');

/**
 * Creates the PostgreSQL connection pool. Short connection and query timeouts
 * make the API fail fast (HTTP 503) instead of hanging when the database is down.
 */
function createPool(dbConfig, logger) {
  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    max: dbConfig.max,
    connectionTimeoutMillis: dbConfig.connectionTimeoutMillis,
    query_timeout: dbConfig.queryTimeoutMs,
    idleTimeoutMillis: 30000,
    application_name: 'async-messaging-api',
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => logger.warn('Idle PostgreSQL client error', { error: err.message, errorCode: err.code }));
  return pool;
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (database starting up)
  '53300', // too_many_connections
]);

/**
 * True when an error means "the database is unreachable" (=> HTTP 503) rather
 * than a bug or constraint violation (=> HTTP 500).
 */
function isDatabaseUnavailableError(err) {
  if (!err) return false;
  if (CONNECTION_ERROR_CODES.has(err.code)) return true;
  if (typeof err.code === 'string' && err.code.startsWith('08')) return true; // connection_exception class
  const msg = String(err.message || '');
  return /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED|Query read timeout|getaddrinfo/i.test(msg);
}

module.exports = { createPool, isDatabaseUnavailableError };
