'use strict';

/**
 * Report worker (RabbitMQ consumer).
 *
 * - Manual acknowledgements (noAck: false) with configurable prefetch
 *   (WORKER_PREFETCH, default 1). Prefetch is also this process's concurrency
 *   limit: amqplib never delivers more than `prefetch` unacked messages.
 * - Uses a separate ConfirmChannel for publishing retry / dead-letter copies.
 * - Graceful shutdown on SIGTERM/SIGINT: cancel the consumer (no new
 *   deliveries), wait for in-flight jobs, then close channels.
 * - Crash-only recovery: if the broker connection is lost unexpectedly the
 *   process exits with code 1 and Docker's restart policy starts a fresh one.
 *   RabbitMQ requeues every unacked message of the dead connection.
 */
const { loadConfig, assertCredentials } = require('./config');
const { createLogger } = require('./logger');
const { createPool } = require('./db');
const { createJobRepository } = require('./jobRepository');
const { generateReport } = require('./reportGenerator');
const { createMessageHandler } = require('./handler');
const { connectWithRetry, assertTopology, publishConfirmed, forwardHeaders } = require('./rabbit');
const { startHeartbeat } = require('./heartbeat');

async function main() {
  const config = loadConfig();
  const logger = createLogger('worker', config.logLevel, { workerId: config.workerId });
  assertCredentials(config);
  const t = config.topology;

  const pool = createPool(config.database, logger, 'async-messaging-worker');
  const repo = createJobRepository(pool);

  const connection = await connectWithRetry(config.rabbitmq, logger, { clientName: `worker ${config.workerId}` });
  const consumeChannel = await connection.createChannel();
  const publishChannel = await connection.createConfirmChannel();
  await assertTopology(consumeChannel, t);
  await consumeChannel.prefetch(config.prefetch);

  let shuttingDown = false;
  let connected = true;
  let inFlight = 0;
  let consumerTag = null;

  const fatal = (reason) => (err) => {
    connected = false;
    if (shuttingDown) return;
    logger.error(`RabbitMQ ${reason}; exiting so Docker restarts the worker`, { error: err && err.message });
    // Unacked messages are requeued by the broker when this connection dies.
    process.exit(1);
  };
  connection.on('error', (err) => logger.warn('RabbitMQ connection error', { error: err.message }));
  connection.on('close', fatal('connection closed'));
  consumeChannel.on('close', fatal('consume channel closed'));
  publishChannel.on('close', fatal('publish channel closed'));

  /** Transport adapter used by the transport-agnostic handler. */
  const broker = {
    ack: (msg) => consumeChannel.ack(msg),
    nack: (msg, requeue) => consumeChannel.nack(msg, false, requeue),
    publishRetry: (msg, { attempt, deferred = false, lastError } = {}) => {
      const headers = forwardHeaders(msg.properties.headers);
      if (attempt) headers['x-attempt'] = attempt;
      if (deferred) headers['x-deferred-count'] = (Number(headers['x-deferred-count']) || 0) + 1;
      if (lastError) headers['x-last-error'] = String(lastError).slice(0, 255);
      return publishConfirmed(publishChannel, t.retryExchange, t.routingKey, msg.content, {
        messageId: msg.properties.messageId,
        contentType: msg.properties.contentType || 'application/json',
        type: msg.properties.type,
        headers,
      });
    },
    deadLetter: (msg, { reason, error, workerId, attempt }) => publishConfirmed(publishChannel, t.deadLetterExchange, t.deadLetterRoutingKey, msg.content, {
      messageId: msg.properties.messageId,
      contentType: msg.properties.contentType || 'application/octet-stream',
      type: msg.properties.type,
      headers: {
        ...forwardHeaders(msg.properties.headers),
        'x-dead-letter-reason': reason,
        'x-error-message': String(error || '').slice(0, 500),
        ...(attempt ? { 'x-failed-attempt': attempt } : {}),
        'x-original-exchange': msg.fields.exchange,
        'x-original-routing-key': msg.fields.routingKey,
        'x-dead-lettered-by': workerId,
        'x-dead-lettered-at': new Date().toISOString(),
      },
    }),
  };

  const { handle } = createMessageHandler({
    repo,
    broker,
    generateReport,
    logger,
    workerId: config.workerId,
    config: {
      maxAttempts: config.maxAttempts,
      jobLeaseMs: config.jobLeaseMs,
      infraBackoffMs: config.infraBackoffMs,
      processingMinMs: config.processingMinMs,
      processingMaxMs: config.processingMaxMs,
      retryDelayMs: t.retryDelayMs,
    },
  });

  const consumer = await consumeChannel.consume(t.mainQueue, (msg) => {
    if (msg === null) {
      // The broker cancelled our consumer (e.g. queue deleted).
      fatal('consumer cancelled by broker')(new Error('consumer cancelled'));
      return;
    }
    inFlight += 1;
    handle(msg)
      .catch((err) => {
        // Last-resort safety net (e.g. ack/publish failed because the channel
        // died). Requeue so the message is not lost; idempotency protects us.
        logger.error('Unhandled error while handling message; requeueing', { error: err.message, stack: err.stack });
        try { consumeChannel.nack(msg, false, true); } catch { /* channel already gone: broker requeues */ }
      })
      .finally(() => { inFlight -= 1; });
  }, { noAck: false });
  consumerTag = consumer.consumerTag;

  startHeartbeat(config.heartbeatFile, () => connected && !shuttingDown);
  logger.info('Worker consuming', {
    queue: t.mainQueue,
    prefetch: config.prefetch,
    maxAttempts: config.maxAttempts,
    retryDelayMs: t.retryDelayMs,
    leaseMs: config.jobLeaseMs,
  });

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Graceful shutdown started', { signal, inFlight });
    try {
      if (consumerTag) await consumeChannel.cancel(consumerTag); // stop new deliveries
    } catch (err) {
      logger.warn('Consumer cancel failed', { error: err.message });
    }
    const deadline = Date.now() + config.shutdownTimeoutMs;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (inFlight > 0) {
      logger.warn('Shutdown timeout reached with jobs in flight; they will be redelivered', { inFlight });
    }
    await consumeChannel.close().catch(() => {});
    await publishChannel.close().catch(() => {});
    await connection.close().catch(() => {});
    await pool.end().catch(() => {});
    logger.info('Worker stopped', { signal });
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  createLogger('worker').error('Worker failed to start', { error: err.message });
  process.exit(1);
});
