'use strict';

/**
 * TEST 6: DURABILITY
 * a) Restart API + worker: completed job status persists (PostgreSQL volume).
 * b) Stop the worker, enqueue jobs, restart RabbitMQ: the durable queue and
 *    persistent messages survive; the jobs complete once the worker returns.
 */
const { submitJob, getJob, waitForApiHealthy, waitForStatus, waitForAllStatus } = require('../helpers/api');
const { compose, ensureStackRunning, waitForHealthy } = require('../helpers/compose');
const { closePool, getPool } = require('../helpers/db');
const { env } = require('../helpers/env');
const { getQueue } = require('../helpers/rabbit');
const { waitFor } = require('../helpers/wait');

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(async () => {
  await ensureStackRunning();
  await closePool();
});

test('job status survives an API and worker restart', async () => {
  const res = await submitJob({ reportType: 'sales_summary', parameters: { startDate: '2026-06-01', endDate: '2026-06-30' }, requestedBy: 'durability-restart' });
  const before = await waitForStatus(res.json.jobId, ['completed']);

  compose('restart', 'api', 'worker');
  await waitForHealthy('api');
  await waitForHealthy('worker');
  await waitForApiHealthy();

  const after = (await getJob(res.json.jobId)).json;
  expect(after).toMatchObject({ status: 'completed', attempts: before.attempts, completedAt: before.completedAt });
  expect(after.result.checksum).toBe(before.result.checksum);
});

test('pending messages survive a RabbitMQ restart', async () => {
  compose('stop', 'worker');

  const responses = [];
  for (let i = 0; i < 3; i += 1) {
    responses.push(await submitJob({ reportType: 'inventory_snapshot', parameters: { startDate: '2026-06-01', endDate: '2026-06-30' }, requestedBy: `durability-broker-${i}` }));
  }
  expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
  const ids = responses.map((r) => r.json.jobId);

  // Wait until the outbox publisher has handed all three to the broker (confirmed).
  await waitFor(async () => {
    const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM outbox WHERE job_id = ANY($1::uuid[]) AND published_at IS NOT NULL', [ids]);
    return rows[0].n === 3;
  }, { timeoutMs: 30000, description: 'outbox rows to be published' });
  const before = await waitFor(async () => {
    const q = await getQueue(env.rabbitmq.mainQueue);
    return q.messages_ready >= 3 ? q : null;
  }, { timeoutMs: 30000, intervalMs: 1000, description: '3 ready messages before the broker restart' });
  console.log(`[TEST 6] before broker restart: ready=${before.messages_ready}, durable=${before.durable}, persistent bytes=${before.message_bytes_persistent}`);
  expect(before.durable).toBe(true);

  compose('restart', 'rabbitmq');
  await waitForHealthy('rabbitmq');

  const after = await waitFor(async () => {
    const q = await getQueue(env.rabbitmq.mainQueue);
    return q.messages_ready !== undefined ? q : null;
  }, { timeoutMs: 60000, intervalMs: 1000, description: 'management API after broker restart' });
  console.log(`[TEST 6] after broker restart: ready=${after.messages_ready}`);
  expect(after.messages_ready).toBeGreaterThanOrEqual(3);
  for (const id of ids) expect((await getJob(id)).json.status).toBe('queued');

  compose('start', 'worker');
  await waitForHealthy('outbox-publisher'); // it reconnects after the broker restart
  await waitForHealthy('worker');
  const finished = await waitForAllStatus(ids, ['completed'], { timeoutMs: 90000 });
  expect(finished.every((j) => j.status === 'completed')).toBe(true);
});
