'use strict';

/**
 * TEST 2: BURST TRAFFIC
 * - 5 jobs are submitted concurrently; all are ingested (202).
 * - Most of them wait in the queue (buffering), visible in PostgreSQL and in
 *   RabbitMQ queue depth.
 * - With ONE worker and prefetch = 1, processing intervals never overlap.
 * - All jobs eventually complete.
 */
const { submitJob, waitForApiHealthy, waitForAllStatus } = require('../helpers/api');
const { ensureStackRunning, containerIds } = require('../helpers/compose');
const { getPool, closePool, jobEvents } = require('../helpers/db');
const { env } = require('../helpers/env');
const { getQueue } = require('../helpers/rabbit');
const { sleep, waitFor } = require('../helpers/wait');

const BURST = 5;

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(closePool);

test('burst of 5 jobs is buffered and processed sequentially by one prefetch=1 worker', async () => {
  // ---- Preconditions for the "sequential" assertion ----------------------
  const workerContainers = containerIds('worker').length;
  const queueInfo = await waitFor(async () => {
    const q = await getQueue(env.rabbitmq.mainQueue);
    return q.consumers >= 1 ? q : null;
  }, { timeoutMs: 30000, description: 'a consumer on the main queue' });
  const prefetches = (queueInfo.consumer_details || []).map((c) => c.prefetch_count);
  console.log(`[TEST 2] worker containers=${workerContainers}, consumers=${queueInfo.consumers}, prefetch=${JSON.stringify(prefetches)}`);
  const sequentialSetup = workerContainers === 1 && queueInfo.consumers === 1 && prefetches.every((p) => p === 1);

  // ---- Burst ---------------------------------------------------------------
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: BURST }, (_, i) => submitJob({
    reportType: ['sales_summary', 'inventory_snapshot', 'user_activity', 'financial_statement', 'sales_summary'][i],
    parameters: { startDate: '2026-02-01', endDate: '2026-02-28' },
    requestedBy: `burst-${i}`,
  })));
  const burstMs = performance.now() - started;
  console.log(`[TEST 2] ${BURST} concurrent submissions finished in ${burstMs.toFixed(1)} ms; per-request: ${responses.map((r) => r.latencyMs.toFixed(1)).join(', ')} ms`);

  expect(responses.map((r) => r.status)).toEqual(Array(BURST).fill(202));
  const ids = responses.map((r) => r.json.jobId);
  expect(new Set(ids).size).toBe(BURST);

  // ---- Buffering evidence ------------------------------------------------
  const { rows } = await getPool().query("SELECT status, COUNT(*)::int AS n FROM jobs WHERE id = ANY($1::uuid[]) GROUP BY status", [ids]);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  console.log(`[TEST 2] status right after the burst: ${JSON.stringify(byStatus)}`);
  expect(byStatus.queued || 0).toBeGreaterThanOrEqual(BURST - 2); // at most one or two picked up yet

  let maxDepth = 0;
  const watchUntil = Date.now() + 15000;
  while (Date.now() < watchUntil) {
    const q = await getQueue(env.rabbitmq.mainQueue);
    maxDepth = Math.max(maxDepth, q.messages || 0);
    if (maxDepth >= 2) break;
    await sleep(500);
  }
  console.log(`[TEST 2] max observed RabbitMQ depth of ${env.rabbitmq.mainQueue} (ready + unacked): ${maxDepth}`);
  expect(maxDepth).toBeGreaterThanOrEqual(2);

  // ---- Completion ----------------------------------------------------------
  const finished = await waitForAllStatus(ids, ['completed'], { timeoutMs: BURST * 7000 + 30000 });
  expect(finished.every((j) => j.status === 'completed' && j.attempts === 1)).toBe(true);

  // ---- Sequential processing (from the audit trail) ----------------------
  const intervals = [];
  for (const id of ids) {
    const ev = await jobEvents(id);
    const claimed = ev.find((e) => e.event_type === 'claimed');
    const completed = ev.find((e) => e.event_type === 'completed');
    intervals.push({ id, start: new Date(claimed.created_at).getTime(), end: new Date(completed.created_at).getTime() });
  }
  intervals.sort((a, b) => a.start - b.start);
  const overlaps = [];
  for (let i = 1; i < intervals.length; i += 1) {
    if (intervals[i].start < intervals[i - 1].end) overlaps.push([intervals[i - 1].id, intervals[i].id]);
  }
  console.log(`[TEST 2] processing windows (ms from first start): ${intervals.map((w) => `[${w.start - intervals[0].start}..${w.end - intervals[0].start}]`).join(' ')}`);

  if (sequentialSetup) {
    expect(overlaps).toEqual([]);
  } else {
    console.warn('[TEST 2] Sequential assertion skipped: run exactly one worker with WORKER_PREFETCH=1 to verify it.');
  }
});
