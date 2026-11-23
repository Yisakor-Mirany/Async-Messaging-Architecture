'use strict';

/**
 * Data access for the API. Every statement is parameterised ($1, $2, ...):
 * user input is never concatenated into SQL text.
 */
const crypto = require('crypto');

const MESSAGE_SCHEMA_VERSION = 1;

/** The broker message only carries identifiers; PostgreSQL holds the job data. */
function buildJobMessage({ messageId, jobId, reportType, createdAt }) {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId,
    jobId,
    reportType,
    createdAt: new Date(createdAt).toISOString(),
  };
}

function createJobsRepository(pool, { routingKey }) {
  /**
   * Transactional outbox: the job row, its "created" audit event and the
   * outbox message are committed atomically. Either all three exist or none.
   * The API never talks to RabbitMQ directly, so a broker outage cannot cause
   * a "saved but never published" job - the outbox-publisher will deliver it.
   */
  async function createJob({ id, reportType, payload }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO jobs (id, report_type, payload)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, reportType, payload],
      );
      const job = rows[0];
      const messageId = crypto.randomUUID();
      await client.query(
        `INSERT INTO job_events (job_id, event_type, message_id, details)
         VALUES ($1, 'created', $2, $3)`,
        [id, messageId, { source: 'api' }],
      );
      await client.query(
        `INSERT INTO outbox (message_id, job_id, routing_key, payload)
         VALUES ($1, $2, $3, $4)`,
        [messageId, id, routingKey, buildJobMessage({ messageId, jobId: id, reportType, createdAt: job.created_at })],
      );
      await client.query('COMMIT');
      return job;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function getJob(id) {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async function listJobs({ limit, status }) {
    const { rows } = await pool.query(
      `SELECT * FROM jobs
       WHERE ($2::text IS NULL OR status = $2::text)
       ORDER BY created_at DESC, id
       LIMIT $1`,
      [limit, status ?? null],
    );
    return rows;
  }

  async function getJobEvents(id) {
    const { rows } = await pool.query(
      `SELECT event_type, attempt, worker_id, message_id, details, created_at
       FROM job_events WHERE job_id = $1 ORDER BY id`,
      [id],
    );
    return rows;
  }

  async function getStats() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM jobs WHERE status = 'queued')::int       AS queued,
         (SELECT COUNT(*) FROM jobs WHERE status = 'processing')::int   AS processing,
         (SELECT COUNT(*) FROM jobs WHERE status = 'completed')::int    AS completed,
         (SELECT COUNT(*) FROM jobs WHERE status = 'failed')::int       AS failed,
         (SELECT COUNT(*) FROM outbox WHERE published_at IS NULL)::int  AS outbox_pending,
         (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000
            FROM outbox WHERE published_at IS NULL)::float8             AS outbox_oldest_pending_ms`,
    );
    return rows[0];
  }

  async function ping() {
    const started = process.hrtime.bigint();
    await pool.query('SELECT 1');
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  return { createJob, getJob, listJobs, getJobEvents, getStats, ping };
}

module.exports = { createJobsRepository, buildJobMessage, MESSAGE_SCHEMA_VERSION };
