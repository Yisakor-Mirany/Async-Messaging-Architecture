'use strict';

/**
 * Transactional outbox relay ("outbox-publisher" service).
 *
 * The API commits each job together with an outbox row. This process moves
 * outbox rows to RabbitMQ:
 *
 *   BEGIN
 *     SELECT ... FROM outbox WHERE published_at IS NULL
 *       ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED     -- safe with N relays
 *     publish each row (persistent, mandatory) on a ConfirmChannel
 *     waitForConfirms()                                 -- broker has it on disk
 *     UPDATE outbox SET published_at = now() ...
 *   COMMIT
 *
 * Failure analysis:
 *   - Broker down          -> publish/confirm fails -> ROLLBACK -> row stays
 *                             unpublished -> retried after reconnect. No loss.
 *   - Relay crashes after confirm but before COMMIT -> the row is published
 *                             again later -> a DUPLICATE message. The worker's
 *                             PostgreSQL idempotency check makes this harmless.
 *   => at-least-once delivery from database to broker.
 *
 * It also runs a low-frequency reconciler that re-enqueues jobs that have been
 * stuck in `queued`/`processing` far longer than any normal delay (e.g. after
 * the broker's volume was wiped). Re-enqueued duplicates are harmless.
 */
const crypto = require('crypto');
const { loadConfig, assertCredentials } = require('./config');
const { createLogger } = require('./logger');
const { createPool } = require('./db');
const { connectWithRetry, assertTopology } = require('./rabbit');
const { startHeartbeat } = require('./heartbeat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = loadConfig();
  const logger = createLogger('outbox-publisher', config.logLevel);
  assertCredentials(config);
  const t = config.topology;

  const pool = createPool(config.database, logger, 'async-messaging-outbox');
  const connection = await connectWithRetry(config.rabbitmq, logger, { clientName: 'outbox-publisher' });
  const channel = await connection.createConfirmChannel();
  await assertTopology(channel, t);

  let shuttingDown = false;
  let connected = true;
  const fatal = (reason) => (err) => {
    connected = false;
    if (shuttingDown) return;
    logger.error(`RabbitMQ ${reason}; exiting so Docker restarts the publisher`, { error: err && err.message });
    process.exit(1);
  };
  connection.on('error', (err) => logger.warn('RabbitMQ connection error', { error: err.message }));
  connection.on('close', fatal('connection closed'));
  channel.on('close', fatal('channel closed'));

  // With mandatory=true the broker returns messages it could not route to any
  // queue. Confirms alone would report these as "acked" - a known limitation.
  const returned = new Set();
  channel.on('return', (msg) => {
    returned.add(msg.properties.messageId);
    logger.error('Message was unroutable and returned by the broker', { messageId: msg.properties.messageId, routingKey: msg.fields.routingKey });
  });

  async function publishBatch() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, message_id, job_id, routing_key, payload
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [config.outboxBatchSize],
      );
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      try {
        for (const row of rows) {
          const ok = channel.publish(t.exchange, row.routing_key, Buffer.from(JSON.stringify(row.payload)), {
            persistent: true, // deliveryMode 2: written to disk on durable queues
            mandatory: true,
            messageId: row.message_id,
            contentType: 'application/json',
            type: 'report.generate',
            timestamp: Math.floor(Date.now() / 1000),
            headers: { 'x-attempt': 1, 'x-outbox-id': String(row.id) },
          });
          if (!ok) await new Promise((r) => channel.once('drain', r));
        }
        await channel.waitForConfirms(); // rejects if the broker NACKs any message
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        await pool.query(
          'UPDATE outbox SET publish_attempts = publish_attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])',
          [rows.map((r) => r.id), String(err.message).slice(0, 500)],
        ).catch(() => {});
        throw err;
      }

      const confirmed = rows.filter((r) => !returned.has(r.message_id));
      const unroutable = rows.filter((r) => returned.has(r.message_id));
      for (const r of unroutable) returned.delete(r.message_id);

      if (confirmed.length) {
        await client.query(
          `UPDATE outbox SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL
            WHERE id = ANY($1::bigint[])`,
          [confirmed.map((r) => r.id)],
        );
        await client.query(
          `INSERT INTO job_events (job_id, event_type, message_id, details)
           SELECT j, 'published', m, jsonb_build_object('exchange', $3::text)
             FROM unnest($1::uuid[], $2::uuid[]) AS u(j, m)`,
          [confirmed.map((r) => r.job_id), confirmed.map((r) => r.message_id), t.exchange],
        );
      }
      if (unroutable.length) {
        await client.query(
          `UPDATE outbox SET publish_attempts = publish_attempts + 1, last_error = 'unroutable (returned by broker)'
            WHERE id = ANY($1::bigint[])`,
          [unroutable.map((r) => r.id)],
        );
      }
      await client.query('COMMIT');
      if (confirmed.length) logger.info('Published outbox messages', { count: confirmed.length, jobIds: confirmed.map((r) => r.job_id) });
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Re-enqueue jobs stuck far longer than any legitimate delay. */
  async function reconcile() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT j.id, j.report_type, j.created_at, j.status
           FROM jobs j
          WHERE ((j.status = 'processing' AND j.lease_expires_at < now() - make_interval(secs => $1::double precision / 1000))
              OR (j.status = 'queued' AND j.last_enqueued_at < now() - make_interval(secs => $1::double precision / 1000)))
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id AND o.published_at IS NULL)
          ORDER BY j.created_at
          LIMIT 100
          FOR UPDATE OF j SKIP LOCKED`,
        [config.reconcileStaleMs],
      );
      for (const job of rows) {
        const messageId = crypto.randomUUID();
        const payload = { schemaVersion: 1, messageId, jobId: job.id, reportType: job.report_type, createdAt: new Date(job.created_at).toISOString() };
        await client.query('INSERT INTO outbox (message_id, job_id, routing_key, payload) VALUES ($1, $2, $3, $4)', [messageId, job.id, t.routingKey, payload]);
        await client.query('UPDATE jobs SET last_enqueued_at = now() WHERE id = $1', [job.id]);
        await client.query(
          `INSERT INTO job_events (job_id, event_type, message_id, details) VALUES ($1, 'reconciled', $2, $3)`,
          [job.id, messageId, { previousStatus: job.status, staleAfterMs: config.reconcileStaleMs }],
        );
      }
      await client.query('COMMIT');
      if (rows.length) logger.warn('Reconciler re-enqueued stale jobs', { count: rows.length, jobIds: rows.map((r) => r.id) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.warn('Reconciler run failed', { error: err.message });
    } finally {
      client.release();
    }
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Outbox publisher shutting down', { signal });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startHeartbeat(config.heartbeatFile, () => connected && !shuttingDown);
  logger.info('Outbox publisher running', { exchange: t.exchange, pollIntervalMs: config.outboxPollIntervalMs, batchSize: config.outboxBatchSize });

  let lastReconcile = Date.now();
  let consecutiveDbErrors = 0;
  while (!shuttingDown) {
    try {
      const n = await publishBatch();
      consecutiveDbErrors = 0;
      if (Date.now() - lastReconcile >= config.reconcileIntervalMs) {
        lastReconcile = Date.now();
        await reconcile();
      }
      // Drain quickly while there is a backlog; otherwise poll.
      if (n < config.outboxBatchSize) await sleep(config.outboxPollIntervalMs);
    } catch (err) {
      consecutiveDbErrors += 1;
      const delay = Math.min(5000, 250 * 2 ** Math.min(consecutiveDbErrors, 5));
      logger.warn('Outbox publish cycle failed; will retry', { error: err.message, errorCode: err.code, delayMs: delay });
      await sleep(delay);
    }
  }

  // Finish the current cycle (loop exited), then close cleanly.
  await channel.close().catch(() => {});
  await connection.close().catch(() => {});
  await pool.end().catch(() => {});
  logger.info('Outbox publisher stopped');
  process.exit(0);
}

main().catch((err) => {
  createLogger('outbox-publisher').error('Outbox publisher failed to start', { error: err.message });
  process.exit(1);
});
