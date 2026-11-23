'use strict';

const { Pool } = require('pg');
const { env } = require('./env');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({ ...env.postgres, max: 12, connectionTimeoutMillis: 3000 });
    pool.on('error', () => {}); // tolerate restarts during resilience tests
  }
  return pool;
}

async function closePool() {
  if (pool) await pool.end().catch(() => {});
  pool = undefined;
}

async function jobEvents(jobId) {
  const { rows } = await getPool().query(
    'SELECT event_type, attempt, worker_id, message_id, details, created_at FROM job_events WHERE job_id = $1 ORDER BY id',
    [jobId],
  );
  return rows;
}

async function jobRow(jobId) {
  const { rows } = await getPool().query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return rows[0] || null;
}

async function outboxRows(jobId) {
  const { rows } = await getPool().query('SELECT * FROM outbox WHERE job_id = $1 ORDER BY id', [jobId]);
  return rows;
}

const countEvents = (events, type) => events.filter((e) => e.event_type === type).length;

module.exports = { getPool, closePool, jobEvents, jobRow, outboxRows, countEvents };
