'use strict';

const { Pool } = require('pg');

function createPool(dbConfig, logger, applicationName) {
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
    application_name: applicationName,
  });
  pool.on('error', (err) => logger.warn('Idle PostgreSQL client error', { error: err.message, errorCode: err.code }));
  return pool;
}

module.exports = { createPool };
