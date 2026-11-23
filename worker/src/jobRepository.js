'use strict';

/**
 * Worker-side data access. All state transitions are single conditional
 * UPDATE statements executed in a transaction together with their audit
 * event. The WHERE clause of each UPDATE is the concurrency guard:
 *
 *   claim     : queued -> processing   (or take over an EXPIRED lease)
 *   progress  : processing -> processing (only by the current lease holder)
 *   complete  : processing -> completed  (only by the current lease holder)
 *   retry     : processing -> queued     (only by the current lease holder)
 *   fail      : processing -> failed     (only by the current lease holder)
 *
 * PostgreSQL row locks make each UPDATE atomic: if two consumers race for the
 * same job, the second one re-evaluates the WHERE clause after the first
 * commits, sees `status = 'processing'` with a live lease, and updates 0 rows.
 *
 * The module receives a `pool` (anything with query()/connect()) and does not
 * require('pg') itself, so the QA suite can reuse it with its own pool.
 */

const LEASE_SQL = "now() + make_interval(secs => $3::double precision / 1000)";

function createJobRepository(pool) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function insertEvent(client, { jobId, type, attempt = null, workerId = null, messageId = null, details = null }) {
    await client.query(
      `INSERT INTO job_events (job_id, event_type, attempt, worker_id, message_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [jobId, type, attempt, workerId, messageId, details],
    );
  }

  /**
   * Atomically claims a job for processing and increments its attempt counter.
   * Returns { outcome: 'claimed' | 'not_found' | 'already_terminal' | 'locked', job }.
   */
  async function claimJob(jobId, { workerId, leaseMs, messageId = null, redelivered = false }) {
    return tx(async (client) => {
      const claimed = await client.query(
        `UPDATE jobs
            SET status = 'processing',
                attempts = attempts + 1,
                progress = 0,
                started_at = COALESCE(started_at, now()),
                locked_by = $2,
                lease_expires_at = ${LEASE_SQL},
                updated_at = now()
          WHERE id = $1
            AND (status = 'queued'
                 OR (status = 'processing' AND (lease_expires_at < now() OR locked_by = $2)))
          RETURNING *`,
        [jobId, workerId, leaseMs],
      );
      if (claimed.rowCount === 1) {
        const job = claimed.rows[0];
        await insertEvent(client, { jobId, type: 'claimed', attempt: job.attempts, workerId, messageId, details: { redelivered } });
        return { outcome: 'claimed', job };
      }
      const current = await client.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
      if (current.rowCount === 0) return { outcome: 'not_found', job: null };
      const job = current.rows[0];
      if (job.status === 'completed' || job.status === 'failed') return { outcome: 'already_terminal', job };
      return { outcome: 'locked', job };
    });
  }

  /** Updates progress and extends the lease (a heartbeat). False = lease lost. */
  async function updateProgress(jobId, { workerId, leaseMs, progress }) {
    const r = await pool.query(
      `UPDATE jobs
          SET progress = $4, lease_expires_at = ${LEASE_SQL}, updated_at = now()
        WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
      [jobId, workerId, leaseMs, progress],
    );
    return r.rowCount === 1;
  }

  /** processing -> completed. Returns the updated row, or null if the lease was lost. */
  async function markCompleted(jobId, { workerId, result, messageId = null }) {
    return tx(async (client) => {
      const r = await client.query(
        `UPDATE jobs
            SET status = 'completed', progress = 100, result = $3, completed_at = now(),
                locked_by = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'processing' AND locked_by = $2
          RETURNING *`,
        [jobId, workerId, result],
      );
      if (r.rowCount === 0) return null;
      const job = r.rows[0];
      await insertEvent(client, { jobId, type: 'completed', attempt: job.attempts, workerId, messageId, details: { durationMs: result && result.generationMs } });
      return job;
    });
  }

  /** processing -> queued, recording the error, before a delayed retry is published. */
  async function releaseForRetry(jobId, { workerId, errorDetails, messageId = null, retryDelayMs }) {
    return tx(async (client) => {
      const r = await client.query(
        `UPDATE jobs
            SET status = 'queued', progress = 0, error_details = $3,
                locked_by = NULL, lease_expires_at = NULL,
                last_enqueued_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'processing' AND locked_by = $2
          RETURNING *`,
        [jobId, workerId, errorDetails],
      );
      if (r.rowCount === 0) return null;
      const job = r.rows[0];
      await insertEvent(client, { jobId, type: 'retry_scheduled', attempt: job.attempts, workerId, messageId, details: { error: errorDetails, retryDelayMs } });
      return job;
    });
  }

  /** processing -> failed (terminal). */
  async function markFailed(jobId, { workerId, errorDetails, messageId = null }) {
    return tx(async (client) => {
      const r = await client.query(
        `UPDATE jobs
            SET status = 'failed', failed_at = now(), error_details = $3,
                locked_by = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'processing' AND locked_by = $2
          RETURNING *`,
        [jobId, workerId, errorDetails],
      );
      if (r.rowCount === 0) return null;
      const job = r.rows[0];
      await insertEvent(client, { jobId, type: 'failed', attempt: job.attempts, workerId, messageId, details: { error: errorDetails } });
      return job;
    });
  }

  /** Records a non-transition event (duplicate_ignored, deferred, lease_lost). */
  async function recordEvent(jobId, type, { attempt = null, workerId = null, messageId = null, details = null } = {}) {
    await pool.query(
      `INSERT INTO job_events (job_id, event_type, attempt, worker_id, message_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [jobId, type, attempt, workerId, messageId, details],
    );
  }

  /** Marks the job as re-enqueued (used when a deferral is published). */
  async function touchEnqueued(jobId) {
    await pool.query('UPDATE jobs SET last_enqueued_at = now() WHERE id = $1', [jobId]);
  }

  return { claimJob, updateProgress, markCompleted, releaseForRetry, markFailed, recordEvent, touchEnqueued };
}

module.exports = { createJobRepository };
