'use strict';

/**
 * Minimal, dependency-free migration runner.
 *
 * - Applies every *.sql file in MIGRATIONS_DIR in lexical order.
 * - Each file runs in its own transaction and is recorded in schema_migrations
 *   together with a SHA-256 checksum, so it is never applied twice.
 * - A PostgreSQL advisory lock prevents two runners from racing.
 * - Editing an already-applied migration is detected (checksum mismatch) and
 *   aborts startup instead of silently diverging.
 *
 * Run by the one-shot `migrate` service in docker-compose.yml.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');

const LOCK_KEY = 72_060_601; // arbitrary constant shared by all runners

async function connectWithRetry(dbConfig, logger, attempts = 30) {
  for (let i = 1; i <= attempts; i += 1) {
    const client = new Client({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      connectionTimeoutMillis: 3000,
      application_name: 'async-messaging-migrate',
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      logger.warn('Database not ready, retrying', { attempt: i, error: err.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('Could not connect to PostgreSQL for migrations');
}

async function migrate({ config = loadConfig(), logger = createLogger('migrate') } = {}) {
  const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const client = await connectWithRetry(config.database, logger);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT        PRIMARY KEY,
        checksum    TEXT        NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        }
        continue;
      }
      logger.info('Applying migration', { file });
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    logger.info('Migrations up to date', { total: files.length });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(
    () => process.exit(0),
    (err) => {
      createLogger('migrate').error('Migration failed', { error: err.message });
      process.exit(1);
    },
  );
}

module.exports = { migrate };
