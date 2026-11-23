'use strict';

/**
 * TEST 4: IDEMPOTENCY
 * a) Re-publish the exact message of a completed job twice. The worker must
 *    recognise the duplicates (via PostgreSQL state), ACK them, and not
 *    process the job again.
 * b) Concurrent consumers racing for the same job: only one claim succeeds
 *    (atomic conditional UPDATE). Uses the worker's own repository module.
 */
const crypto = require('crypto');
const { submitJob, waitForApiHealthy, waitForStatus, getJob } = require('../helpers/api');
const { ensureStackRunning } = require('../helpers/compose');
const { getPool, closePool, jobEvents, jobRow, outboxRows, countEvents } = require('../helpers/db');
const { env } = require('../helpers/env');
const { publishRaw, getQueue } = require('../helpers/rabbit');
const { waitFor } = require('../helpers/wait');
// The repository takes the pool as a parameter and does not import 'pg', so
// it can be loaded from here without installing the worker's dependencies.
const { createJobRepository } = require('../../worker/src/jobRepository');

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(closePool);

test('redelivered messages for a completed job are not processed twice', async () => {
  const res = await submitJob({ reportType: 'inventory_snapshot', parameters: { startDate: '2026-04-01', endDate: '2026-04-30' }, requestedBy: 'idempotency' });
  expect(res.status).toBe(202);
  const jobId = res.json.jobId;
  const completed = await waitForStatus(jobId, ['completed']);
  const before = await jobRow(jobId);

  // Re-send the very same message (same body and message_id) twice.
  const [outbox] = await outboxRows(jobId);
  const body = JSON.stringify(outbox.payload);
  await publishRaw(body, { messageId: outbox.message_id, headers: { 'x-qa': 'duplicate-1' } });
  await publishRaw(body, { messageId: outbox.message_id, headers: { 'x-qa': 'duplicate-2' } });

  const events = await waitFor(async () => {
    const ev = await jobEvents(jobId);
    return countEvents(ev, 'duplicate_ignored') >= 2 ? ev : null;
  }, { timeoutMs: 60000, description: 'two duplicate_ignored events' });
  console.log(`[TEST 4] events: ${events.map((e) => e.event_type).join(', ')}`);

  const after = await jobRow(jobId);
  expect(countEvents(events, 'claimed')).toBe(1);
  expect(countEvents(events, 'completed')).toBe(1);
  expect(after.status).toBe('completed');
  expect(after.attempts).toBe(before.attempts);
  expect(after.completed_at.toISOString()).toBe(before.completed_at.toISOString());
  expect(after.result.checksum).toBe(before.result.checksum);
  expect((await getJob(jobId)).json.completedAt).toBe(completed.completedAt);

  // The duplicates were acknowledged (not stuck/unacked, not dead-lettered).
  await waitFor(async () => (await getQueue(env.rabbitmq.mainQueue)).messages === 0, { timeoutMs: 30000, intervalMs: 1000, description: 'main queue to drain' });
});

test('the database rejects a second completion event for the same job', async () => {
  const res = await submitJob({ reportType: 'sales_summary', parameters: { startDate: '2026-04-01', endDate: '2026-04-02' }, requestedBy: 'idempotency-db' });
  const jobId = res.json.jobId;
  await waitForStatus(jobId, ['completed']);
  await expect(getPool().query("INSERT INTO job_events (job_id, event_type) VALUES ($1, 'completed')", [jobId]))
    .rejects.toMatchObject({ code: '23505' }); // unique_violation
});

test('concurrent claims on one job: exactly one consumer wins', async () => {
  // Insert a job directly (no outbox row => no message, the real worker will not see it).
  const jobId = crypto.randomUUID();
  await getPool().query(
    'INSERT INTO jobs (id, report_type, payload) VALUES ($1, $2, $3)',
    [jobId, 'sales_summary', { reportType: 'sales_summary', parameters: { startDate: '2026-01-01', endDate: '2026-01-02' } }],
  );
  try {
    const repo = createJobRepository(getPool());
    const contenders = Array.from({ length: 10 }, (_, i) => `qa-contender-${i}`);
    const outcomes = await Promise.all(contenders.map((workerId) => repo.claimJob(jobId, { workerId, leaseMs: 30000 })));
    const winners = outcomes.filter((o) => o.outcome === 'claimed');
    console.log(`[TEST 4] claim outcomes: ${outcomes.map((o) => o.outcome).join(', ')}`);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'locked')).toHaveLength(9);

    const row = await jobRow(jobId);
    expect(row.attempts).toBe(1);
    expect(row.locked_by).toBe(winners[0].job.locked_by);

    // A non-owner can neither complete nor fail the job.
    const loser = contenders.find((c) => c !== row.locked_by);
    expect(await repo.markCompleted(jobId, { workerId: loser, result: { x: 1 } })).toBeNull();
    expect(await repo.markFailed(jobId, { workerId: loser, errorDetails: { x: 1 } })).toBeNull();
  } finally {
    await getPool().query('DELETE FROM jobs WHERE id = $1', [jobId]);
  }
});
