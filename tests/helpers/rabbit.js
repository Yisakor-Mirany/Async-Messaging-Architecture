'use strict';

/**
 * RabbitMQ helpers: Management HTTP API (queue depth, consumers) and a direct
 * AMQP connection for controlled tests (poison messages, manual redelivery,
 * DLQ inspection).
 */
const amqp = require('amqplib');
const { env } = require('./env');

const r = env.rabbitmq;
const authHeader = `Basic ${Buffer.from(`${r.username}:${r.password}`).toString('base64')}`;

async function management(path) {
  const res = await fetch(`${r.managementUrl}/api${path}`, { headers: { Authorization: authHeader } });
  if (!res.ok) throw new Error(`Management API ${path} -> HTTP ${res.status}`);
  return res.json();
}

const vhost = encodeURIComponent(r.vhost);
const getQueue = (name) => management(`/queues/${vhost}/${encodeURIComponent(name)}`);

async function connect() {
  return amqp.connect({ protocol: 'amqp', hostname: r.hostname, port: r.port, username: r.username, password: r.password, vhost: r.vhost });
}

/** Publishes raw content to the main exchange and waits for the broker confirm. */
async function publishRaw(content, { messageId, headers = {}, exchange = r.exchange, routingKey = r.routingKey } = {}) {
  const conn = await connect();
  try {
    const ch = await conn.createConfirmChannel();
    await new Promise((resolve, reject) => {
      ch.publish(exchange, routingKey, Buffer.isBuffer(content) ? content : Buffer.from(content), {
        persistent: true, contentType: 'application/json', messageId, headers,
      }, (err) => (err ? reject(err) : resolve()));
    });
    await ch.close();
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Removes and returns DLQ messages matching `predicate`; every other message
 * is put back untouched (nack + requeue after the scan).
 */
async function takeFromDlq(predicate, { max = 500 } = {}) {
  const conn = await connect();
  const matched = [];
  try {
    const ch = await conn.createChannel();
    const others = [];
    for (let i = 0; i < max; i += 1) {
      const msg = await ch.get(r.deadLetterQueue, { noAck: false });
      if (!msg) break;
      if (predicate(msg)) {
        matched.push({ content: msg.content.toString('utf8'), properties: msg.properties });
        ch.ack(msg);
      } else {
        others.push(msg);
      }
    }
    for (const msg of others) ch.nack(msg, false, true);
    await ch.close();
  } finally {
    await conn.close().catch(() => {});
  }
  return matched;
}

module.exports = { management, getQueue, connect, publishRaw, takeFromDlq };
