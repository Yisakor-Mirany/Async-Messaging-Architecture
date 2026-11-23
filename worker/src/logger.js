'use strict';

/** Minimal structured JSON-lines logger (same format as the API). */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(service, level = 'info', base = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, service, ...base, msg, ...fields };
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

/** A logger that discards everything (used in unit tests). */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { createLogger, silentLogger };
