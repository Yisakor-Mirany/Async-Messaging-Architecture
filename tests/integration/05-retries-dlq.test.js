'use strict';

/**
 * TEST 5: RETRIES AND DEAD-LETTER QUEUE
 * a) Transient failure: fails once, retried after RETRY_DELAY_MS, completes.
 * b) Persistent failure: retried until MAX_ATTEMPTS, then failed + DLQ.
 * c) Poison messages (invalid JSON, unknown job ID) go straight to the DLQ.
 * d) The worker keeps processing valid jobs afterwards.
 *
 * Requires ALLOW_FAILURE_SIMULATION=true (the default in .env.example).
 */
const crypto = require('crypto');
const { submitJob, waitForApiHealthy, waitForStatus } = require('../helpers/api');
const { ensureStackRunning } = require('../helpers/compose');
const { closePool, jobEvents, outboxRows, countEvents } = require('../helpers/db');
const { env } = require('../helpers/env');
const { publishRaw, takeFromDlq } = require('../helpers/rabbit');
const { waitFor } = require('../helpers/wait');

const job = (simulate, requestedBy) => ({ reportType: 'user_activity', parameters: { startDate: '2026-05-01', endDate: '2026-05-31' }, requestedBy, simulate });

async function waitForDlqMessage(predicate, description) {
  return waitFor(async () => {
    const found = await takeFromDlq(predicate);
    return found.length ? found[0] : null;
  }, { timeoutMs: 60000, intervalMs: 1000, description });
}

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(closePool);

test('transient failure is retried with a delay and then succeeds', async () => {
  const res = await submitJob(job({ mode: 'fail_then_succeed', failAttempts: 1 }, 'retry-transient'));
  expect(res.status).toBe(202);
  const final = await waitForStatus(res.json.jobId, ['completed', 'failed'], { timeoutMs: 90000 });

  expect(final.status).toBe('completed');
  expect(final.attempts).toBe(2);
  expect(final.error).toMatchObject({ simulated: true, category: 'simulated_failure', attempt: 1 });

  const ev = await jobEvents(res.json.jobId);
  expect(countEvents(ev, 'retry_scheduled')).toBe(1);
  const claims = ev.filter((e) => e.event_type === 'claimed').map((e) => new Date(e.created_at).getTime());
  const retryAt = new Date(ev.find((e) => e.event_type === 'retry_scheduled').created_at).getTime();
  console.log(`[TEST 5] retry gap: ${claims[1] - retryAt} ms (RETRY_DELAY_MS=${env.retryDelayMs})`);
  expect(claims[1] - retryAt).toBeGreaterThanOrEqual(env.retryDelayMs * 0.9); // delayed, not an instant requeue
});

test(`persistent failure stops after MAX_ATTEMPTS (${env.maxAttempts}) and lands in the DLQ`, async () => {
  const res = await submitJob(job({ mode: 'always_fail' }, 'retry-exhaust'));
  expect(res.status).toBe(202);
  const jobId = res.json.jobId;
  const final = await waitForStatus(jobId, ['completed', 'failed'], { timeoutMs: env.maxAttempts * (6000 + env.retryDelayMs) + 30000 });

  expect(final.status).toBe('failed');
  expect(final.attempts).toBe(env.maxAttempts);
  expect(final.failedAt).not.toBeNull();
  expect(final.error).toMatchObject({ simulated: true, attempt: env.maxAttempts });

  const ev = await jobEvents(jobId);
  expect(countEvents(ev, 'claimed')).toBe(env.maxAttempts);
  expect(countEvents(ev, 'retry_scheduled')).toBe(env.maxAttempts - 1);
  expect(countEvents(ev, 'failed')).toBe(1);

  const [outbox] = await outboxRows(jobId);
  const dead = await waitForDlqMessage((m) => m.properties.messageId === outbox.message_id, 'the exhausted job in the DLQ');
  console.log(`[TEST 5] DLQ headers: ${JSON.stringify(dead.properties.headers)}`);
  expect(dead.properties.headers['x-dead-letter-reason']).toBe('max_attempts_exhausted');
  expect(JSON.parse(dead.content).jobId).toBe(jobId);
});

test('poison messages are dead-lettered without retries and the worker keeps going', async () => {
  const invalidId = crypto.randomUUID();
  await publishRaw('this is definitely not JSON', { messageId: invalidId });
  const deadInvalid = await waitForDlqMessage((m) => m.properties.messageId === invalidId, 'invalid-JSON poison message in the DLQ');
  expect(deadInvalid.properties.headers['x-dead-letter-reason']).toBe('invalid_message');

  const unknownMsgId = crypto.randomUUID();
  const unknownJobId = crypto.randomUUID();
  await publishRaw(JSON.stringify({ schemaVersion: 1, messageId: unknownMsgId, jobId: unknownJobId, reportType: 'sales_summary' }), { messageId: unknownMsgId });
  const deadUnknown = await waitForDlqMessage((m) => m.properties.messageId === unknownMsgId, 'unknown-job poison message in the DLQ');
  expect(deadUnknown.properties.headers['x-dead-letter-reason']).toBe('unknown_job');

  // The worker is still healthy and processing.
  const ok = await submitJob(job(undefined, 'after-poison'));
  const final = await waitForStatus(ok.json.jobId, ['completed', 'failed']);
  expect(final.status).toBe('completed');
  expect(final.attempts).toBe(1);
});
