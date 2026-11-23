'use strict';

/**
 * Minimal structured (JSON lines) logger. Structured logs make it easy to
 * follow a single job across services with `docker compose logs | grep <jobId>`.
 * Never pass secrets (passwords, connection strings) into log fields.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(service, level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, service, msg, ...fields };
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/** Serialise an error for logs without leaking connection strings. */
function errorFields(err) {
  if (!err) return {};
  return { error: err.message, errorName: err.name, errorCode: err.code };
}

module.exports = { createLogger, errorFields };
