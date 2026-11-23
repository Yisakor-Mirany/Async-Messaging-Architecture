'use strict';

/**
 * TEST 3: WORKER CRASH RECOVERY
 * 1. Submit job A and wait until the worker is processing it.
 * 2. SIGKILL the worker container (no graceful shutdown, no ACK).
 * 3. Submit jobs B and C while no worker is running -> still 202.
 * 4. Verify A's unacked message went back to the queue and nothing was lost.
 * 5. Start the worker -> A, B and C all complete; A completes exactly once.
 */
const { submitJob, getJob, waitForApiHealthy, waitForStatus, waitForAllStatus } = require('../helpers/api');
const { compose, ensureStackRunning, waitForHealthy, serviceState } = require('../helpers/compose');
const { closePool, jobEvents, countEvents } = require('../helpers/db');
const { env } = require('../helpers/env');
const { getQueue } = require('../helpers/rabbit');
const { waitFor } = require('../helpers/wait');

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(async () => {
  await ensureStackRunning(); // never leave the worker stopped
  await closePool();
});

test('jobs survive an abrupt worker crash and are completed after restart', async () => {
  // 1. Job A is being processed.
  const a = await submitJob({ reportType: 'financial_statement', parameters: { startDate: '2026-03-01', endDate: '2026-03-31' }, requestedBy: 'crash-A' });
  expect(a.status).toBe(202);
  const jobA = a.json.jobId;
  await waitForStatus(jobA, ['processing'], { timeoutMs: 60000 });

  // 2. Crash the worker mid-job.
  compose('kill', '-s', 'SIGKILL', 'worker');
  await waitFor(() => !serviceState('worker').running, { timeoutMs: 20000, description: 'worker to stop' });
  console.log('[TEST 3] worker killed with SIGKILL while job A was processing');

  // 3. Ingestion keeps working without any worker.
  const b = await submitJob({ reportType: 'sales_summary', parameters: { startDate: '2026-03-01', endDate: '2026-03-31' }, requestedBy: 'crash-B' });
  const c = await submitJob({ reportType: 'user_activity', parameters: { startDate: '2026-03-01', endDate: '2026-03-31' }, requestedBy: 'crash-C' });
  expect([b.status, c.status]).toEqual([202, 202]);
  console.log(`[TEST 3] submissions while worker down: ${b.latencyMs.toFixed(1)} ms, ${c.latencyMs.toFixed(1)} ms`);
  const all = [jobA, b.json.jobId, c.json.jobId];

  // 4. Nothing is being processed; messages wait in RabbitMQ.
  const q = await waitFor(async () => {
    const info = await getQueue(env.rabbitmq.mainQueue);
    return info.consumers === 0 && info.messages_ready >= 3 ? info : null;
  }, { timeoutMs: 30000, intervalMs: 1000, description: '3 ready messages and 0 consumers on the main queue' });
  console.log(`[TEST 3] queue while worker down: ready=${q.messages_ready}, unacked=${q.messages_unacknowledged}, consumers=${q.consumers}`);
  expect((await getJob(b.json.jobId)).json.status).toBe('queued');
  expect((await getJob(c.json.jobId)).json.status).toBe('queued');
  const aWhileDown = (await getJob(jobA)).json;
  expect(aWhileDown.status).toBe('processing'); // stale: its owner is dead, it is NOT marked completed
  expect(aWhileDown.completedAt).toBeNull();

  // 5. Restart the worker; everything completes.
  compose('start', 'worker');
  await waitForHealthy('worker');
  const finished = await waitForAllStatus(all, ['completed'], { timeoutMs: 120000 });
  expect(finished.map((j) => j.status)).toEqual(['completed', 'completed', 'completed']);

  const eventsA = await jobEvents(jobA);
  const claimsA = eventsA.filter((e) => e.event_type === 'claimed');
  console.log(`[TEST 3] job A events: ${eventsA.map((e) => e.event_type).join(', ')}`);
  expect(claimsA.length).toBeGreaterThanOrEqual(2); // interrupted attempt + recovery attempt
  expect(new Set(claimsA.map((e) => e.worker_id)).size).toBeGreaterThanOrEqual(2); // a different worker process finished it
  expect(countEvents(eventsA, 'completed')).toBe(1);
  expect(finished[0].attempts).toBe(claimsA.length);

  // No message left behind.
  const after = await waitFor(async () => {
    const info = await getQueue(env.rabbitmq.mainQueue);
    return info.messages === 0 ? info : null;
  }, { timeoutMs: 30000, intervalMs: 1000, description: 'main queue to drain' });
  expect(after.messages).toBe(0);
});
