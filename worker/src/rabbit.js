'use strict';

/**
 * RabbitMQ connection, topology and confirmed publishing helpers.
 *
 * Topology (all durable):
 *
 *   [reports] --report.generate--> (reports.jobs) --consume--> worker
 *      ^                               |  x-dead-letter-exchange = reports.dlx
 *      |                               v  (on reject/nack requeue=false)
 *      |                          [reports.dlx] --report.dead--> (reports.jobs.dlq)
 *      |
 *      +-- TTL expiry -- (reports.jobs.retry) <--report.generate-- [reports.retry]
 *            x-message-ttl = RETRY_DELAY_MS, x-dead-letter-exchange = reports
 *
 * The retry queue has NO consumers. A message published there waits
 * RETRY_DELAY_MS, expires, and is dead-lettered back into the main exchange.
 * This gives a delayed retry without any immediate requeue loop.
 */
const amqp = require('amqplib');

function connectionOptions(rmq) {
  // Passing an object (not a URL string) avoids URL-encoding issues with
  // special characters in passwords.
  return {
    protocol: 'amqp',
    hostname: rmq.hostname,
    port: rmq.port,
    username: rmq.username,
    password: rmq.password,
    vhost: rmq.vhost,
    heartbeat: rmq.heartbeat,
  };
}

async function connectWithRetry(rmq, logger, { clientName, maxDelayMs = 10000 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      const conn = await amqp.connect(connectionOptions(rmq), { clientProperties: { connection_name: clientName } });
      logger.info('Connected to RabbitMQ', { host: rmq.hostname, attempt });
      return conn;
    } catch (err) {
      const delay = Math.min(maxDelayMs, 500 * 2 ** Math.min(attempt, 5));
      logger.warn('RabbitMQ not reachable, retrying', { attempt, delayMs: delay, error: err.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Idempotently declares every exchange, queue and binding. */
async function assertTopology(channel, t) {
  await channel.assertExchange(t.exchange, 'direct', { durable: true });
  await channel.assertExchange(t.retryExchange, 'direct', { durable: true });
  await channel.assertExchange(t.deadLetterExchange, 'direct', { durable: true });

  await channel.assertQueue(t.mainQueue, {
    durable: true,
    arguments: {
      'x-queue-type': 'classic',
      'x-dead-letter-exchange': t.deadLetterExchange,
      'x-dead-letter-routing-key': t.deadLetterRoutingKey,
    },
  });
  await channel.bindQueue(t.mainQueue, t.exchange, t.routingKey);

  await channel.assertQueue(t.retryQueue, {
    durable: true,
    arguments: {
      'x-queue-type': 'classic',
      'x-message-ttl': t.retryDelayMs,
      'x-dead-letter-exchange': t.exchange,
      'x-dead-letter-routing-key': t.routingKey,
    },
  });
  await channel.bindQueue(t.retryQueue, t.retryExchange, t.routingKey);

  await channel.assertQueue(t.deadLetterQueue, { durable: true, arguments: { 'x-queue-type': 'classic' } });
  await channel.bindQueue(t.deadLetterQueue, t.deadLetterExchange, t.deadLetterRoutingKey);
}

/**
 * Publishes a persistent message on a ConfirmChannel and resolves only when
 * the broker has confirmed it (basic.ack). Rejects on basic.nack.
 *
 * Limitation: a confirm means the broker accepted responsibility for the
 * message (written to disk for persistent messages on durable queues). It does
 * NOT mean a consumer processed it. For unroutable messages the broker also
 * confirms; `mandatory: true` makes it return them first (see outbox-publisher).
 */
function publishConfirmed(channel, exchange, routingKey, content, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      channel.publish(exchange, routingKey, content, { persistent: true, contentType: 'application/json', ...options }, (err) => {
        if (err) reject(err instanceof Error ? err : new Error('Broker NACKed publish'));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** Copies headers for a re-publish, dropping broker-managed ones. */
function forwardHeaders(headers = {}) {
  const { 'x-death': _death, 'x-first-death-exchange': _a, 'x-first-death-queue': _b, 'x-first-death-reason': _c, 'x-last-death-exchange': _d, 'x-last-death-queue': _e, 'x-last-death-reason': _f, ...rest } = headers || {};
  return rest;
}

module.exports = { connectWithRetry, assertTopology, publishConfirmed, forwardHeaders };
