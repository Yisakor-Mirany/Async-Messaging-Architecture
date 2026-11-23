'use strict';

/**
 * TEST 1: ASYNCHRONOUS DECOUPLING
 * - POST returns 202 Accepted with a UUID before processing happens.
 * - Response latency is MEASURED (p50/p95/max) and compared with a budget.
 * - The job eventually progresses queued -> processing -> completed.
 */
const { env } = require('../helpers/env');
const { UUID_V4_RE, submitJob, getJob, waitForApiHealthy, waitForAllStatus } = require('../helpers/api');
const { ensureStackRunning } = require('../helpers/compose');
const { closePool } = require('../helpers/db');
const { percentile, sleep } = require('../helpers/wait');

const LATENCY_SAMPLES = 10;

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(closePool);

test('POST /api/jobs returns 202 + UUID immediately and the job later completes', async () => {
  const res = await submitJob();

  expect(res.status).toBe(202);
  expect(res.json.jobId).toMatch(UUID_V4_RE);
  expect(res.json.status).toBe('queued');
  expect(res.json.statusUrl).toBe(`/api/jobs/${res.json.jobId}`);
  expect(res.headers.get('location')).toBe(res.json.statusUrl);
  console.log(`[TEST 1] first submission latency: ${res.latencyMs.toFixed(1)} ms`);

  // Processing takes 3-5 s, so a "completed" answer right now would prove
  // that the API blocked on the worker.
  const immediately = await getJob(res.json.jobId);
  expect(['queued', 'processing']).toContain(immediately.json.status);

  // Observe the state machine by polling quickly.
  const observed = [immediately.json.status];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const r = await getJob(res.json.jobId);
    if (observed[observed.length - 1] !== r.json.status) observed.push(r.json.status);
    if (r.json.status === 'completed' || r.json.status === 'failed') break;
    await sleep(100);
  }
  console.log(`[TEST 1] observed status sequence: ${observed.join(' -> ')}`);

  expect(observed).toContain('processing');
  expect(observed[observed.length - 1]).toBe('completed');
  const order = ['queued', 'processing', 'completed'];
  const indexes = observed.map((s) => order.indexOf(s));
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b)); // never goes backwards

  const final = (await getJob(res.json.jobId)).json;
  expect(final.attempts).toBe(1);
  expect(final.processingMs).toBeGreaterThanOrEqual(2900);
  expect(final.result).toHaveProperty('checksum');
});

test(`measured POST latency (${LATENCY_SAMPLES} sequential requests) is within the budget`, async () => {
  const latencies = [];
  const ids = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const r = await submitJob();
    expect(r.status).toBe(202);
    latencies.push(r.latencyMs);
    ids.push(r.json.jobId);
  }
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const max = Math.max(...latencies);
  console.log(`[TEST 1] POST /api/jobs latency over ${LATENCY_SAMPLES} requests: p50=${p50.toFixed(1)} ms, p95=${p95.toFixed(1)} ms, max=${max.toFixed(1)} ms (budget p95 < ${env.latencyBudgetMs} ms)`);

  // A measurement, not a guarantee: the budget is configurable via QA_LATENCY_BUDGET_MS.
  expect(p95).toBeLessThan(env.latencyBudgetMs);

  // Drain these jobs so later tests start with an empty queue.
  const done = await waitForAllStatus(ids, ['completed'], { timeoutMs: LATENCY_SAMPLES * 6000 + 30000 });
  expect(done.every((j) => j.status === 'completed')).toBe(true);
});
