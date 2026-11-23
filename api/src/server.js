'use strict';

/**
 * API entry point. Starts the HTTP server and shuts down gracefully on
 * SIGTERM/SIGINT (docker compose stop) so in-flight requests can finish.
 */
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createPool } = require('./db');
const { createJobsRepository } = require('./jobsRepository');
const { createApp } = require('./app');

const config = loadConfig();
const logger = createLogger('api', config.logLevel);

if (!config.database.user || !config.database.password || !config.database.database) {
  logger.error('POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB must be set (copy .env.example to .env)');
  process.exit(1);
}

const pool = createPool(config.database, logger);
const repo = createJobsRepository(pool, { routingKey: config.routingKey });
const app = createApp({ repo, config, logger });

const server = app.listen(config.port, () => {
  logger.info('API listening', { port: config.port, failureSimulation: config.allowFailureSimulation });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down API', { signal });
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  server.close(async () => {
    await pool.end().catch(() => {});
    logger.info('API stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
