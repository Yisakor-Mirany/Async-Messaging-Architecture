'use strict';

/**
 * Unit tests for the ACK/NACK/retry/DLQ decision logic using fakes. They
 * verify the ORDER of operations: the DB transition must happen before the ACK.
 */
const { createMessageHandler } = require('../src/handler');
const { SimulatedFailureError, PermanentProcessingError } = require('../src/errors');
const { silentLogger } = require('../src/logger');

const jobId = '7b6f2a64-2d4f-4c1e-9b8a-1f2e3d4c5b6a';
const config = { maxAttempts: 3, jobLeaseMs: 10000, infraBackoffMs: 0, processingMinMs: 0, processingMaxMs: 0, retryDelayMs: 1000 };

function message(body = { schemaVersion: 1, jobId, messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    properties: { messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', headers: {} },
    fields: { redelivered: false, exchange: 'reports', routingKey: 'report.generate' },
  };
}

function setup({ claim, generate, repoOverrides = {} } = {}) {
  const calls = [];
  const job = { id: jobId, report_type: 'sales_summary', attempts: 1, payload: { parameters: {} } };
  const repo = {
    claimJob: jest.fn(async () => { calls.push('claim'); return claim || { outcome: 'claimed', job }; }),
    updateProgress: jest.fn(async () => true),
    markCompleted: jest.fn(async () => { calls.push('markCompleted'); return { ...job, status: 'completed' }; }),
    releaseForRetry: jest.fn(async () => { calls.push('releaseForRetry'); return job; }),
    markFailed: jest.fn(async () => { calls.push('markFailed'); return job; }),
    recordEvent: jest.fn(async (_id, type) => { calls.push(`event:${type}`); }),
    touchEnqueued: jest.fn(async () => {}),
    ...repoOverrides,
  };
  const broker = {
    ack: jest.fn(() => calls.push('ack')),
    nack: jest.fn((_m, requeue) => calls.push(`nack:${requeue}`)),
    publishRetry: jest.fn(async () => { calls.push('publishRetry'); }),
    deadLetter: jest.fn(async () => { calls.push('deadLetter'); }),
  };
  const generateReport = jest.fn(generate || (async (_j, { onProgress }) => { await onProgress(50); return { generationMs: 1 }; }));
  const { handle } = createMessageHandler({ repo, broker, generateReport, config, logger: silentLogger, workerId: 'w1', sleep: async () => {} });
  return { handle, repo, broker, calls, job };
}

test('success: marks completed in the DB BEFORE acknowledging', async () => {
  const { handle, calls } = setup();
  await expect(handle(message())).resolves.toBe('completed');
  expect(calls).toEqual(['claim', 'markCompleted', 'ack']);
});

test('invalid JSON is dead-lettered without touching the database', async () => {
  const { handle, calls, repo } = setup();
  await expect(handle(message('{oops'))).resolves.toBe('dead_lettered');
  expect(calls).toEqual(['deadLetter', 'ack']);
  expect(repo.claimJob).not.toHaveBeenCalled();
});

test('unknown job ID is dead-lettered', async () => {
  const { handle, calls } = setup({ claim: { outcome: 'not_found', job: null } });
  await expect(handle(message())).resolves.toBe('dead_lettered');
  expect(calls).toEqual(['claim', 'deadLetter', 'ack']);
});

test('duplicate delivery of a completed job is acknowledged and NOT reprocessed', async () => {
  const { handle, calls, broker } = setup({ claim: { outcome: 'already_terminal', job: { status: 'completed', attempts: 1 } } });
  await expect(handle(message())).resolves.toBe('duplicate');
  expect(calls).toEqual(['claim', 'event:duplicate_ignored', 'ack']);
  expect(broker.publishRetry).not.toHaveBeenCalled();
});

test('job leased by another worker is deferred through the delay queue', async () => {
  const { handle, calls } = setup({ claim: { outcome: 'locked', job: { status: 'processing', attempts: 1, locked_by: 'w2' } } });
  await expect(handle(message())).resolves.toBe('deferred');
  expect(calls).toEqual(['claim', 'publishRetry', 'event:deferred', 'ack']);
});

test('transient (simulated) failure below the limit: release, publish retry, then ack', async () => {
  const { handle, calls, broker, repo } = setup({ generate: async () => { throw new SimulatedFailureError('sim'); } });
  await expect(handle(message())).resolves.toBe('retry_scheduled');
  expect(calls).toEqual(['claim', 'releaseForRetry', 'publishRetry', 'ack']);
  expect(broker.publishRetry.mock.calls[0][1]).toMatchObject({ attempt: 2 });
  expect(repo.releaseForRetry.mock.calls[0][1].errorDetails).toMatchObject({ simulated: true, category: 'simulated_failure' });
});

test('failure on the final attempt: mark failed, dead-letter, then ack', async () => {
  const { handle, calls } = setup({
    claim: { outcome: 'claimed', job: { id: jobId, report_type: 'sales_summary', attempts: 3, payload: {} } },
    generate: async () => { throw new SimulatedFailureError('sim'); },
  });
  await expect(handle(message())).resolves.toBe('failed');
  expect(calls).toEqual(['claim', 'markFailed', 'deadLetter', 'ack']);
});

test('non-retryable processing error fails immediately even on attempt 1', async () => {
  const { handle, calls } = setup({ generate: async () => { throw new PermanentProcessingError('bad definition'); } });
  await expect(handle(message())).resolves.toBe('failed');
  expect(calls).toEqual(['claim', 'markFailed', 'deadLetter', 'ack']);
});

test('attempts already exhausted by interrupted (crashed) attempts are failed without processing', async () => {
  const { handle, calls, repo } = setup({ claim: { outcome: 'claimed', job: { id: jobId, attempts: 4, payload: {} } } });
  await expect(handle(message())).resolves.toBe('failed');
  expect(calls).toEqual(['claim', 'markFailed', 'deadLetter', 'ack']);
  expect(repo.markFailed.mock.calls[0][1].errorDetails.category).toBe('attempts_exhausted');
});

test('infrastructure error: NACK with requeue, no ACK, no attempt recorded as failure', async () => {
  const dbDown = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const { handle, calls, repo } = setup({ repoOverrides: { claimJob: jest.fn(async () => { throw dbDown; }) } });
  await expect(handle(message())).resolves.toBe('requeued');
  expect(calls).toEqual(['nack:true']);
  expect(repo.markFailed).not.toHaveBeenCalled();
});

test('infrastructure error while completing does NOT ack (message will be redelivered)', async () => {
  const dbDown = Object.assign(new Error('Connection terminated unexpectedly'), {});
  const { handle, calls } = setup({ repoOverrides: { markCompleted: jest.fn(async () => { throw dbDown; }) } });
  await expect(handle(message())).resolves.toBe('requeued');
  expect(calls).toEqual(['claim', 'nack:true']);
});

test('lost lease during progress update abandons the attempt without marking completed', async () => {
  const { handle, calls, repo } = setup({ repoOverrides: { updateProgress: jest.fn(async () => false) } });
  await expect(handle(message())).resolves.toBe('lease_lost');
  expect(repo.markCompleted).not.toHaveBeenCalled();
  expect(calls).toEqual(['claim', 'event:lease_lost', 'ack']);
});

test('a second copy of a job already in flight in this process is deferred', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { handle } = setup({ generate: async () => { await gate; return { generationMs: 1 }; } });
  const first = handle(message());
  await new Promise((r) => setImmediate(r));
  await expect(handle(message())).resolves.toBe('deferred');
  release();
  await expect(first).resolves.toBe('completed');
});
