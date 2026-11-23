'use strict';

/**
 * TEST 7: API VALIDATION AND SECURITY
 * - malformed bodies, missing fields, unknown IDs
 * - SQL injection strings are stored/handled as plain data
 * - PostgreSQL outage -> 503; RabbitMQ outage -> ingestion still works (outbox)
 * - no secrets in API responses or in files tracked by git
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { request, submitJob, getJob, health, seenBodies, defaultJob, waitForApiHealthy, waitForStatus } = require('../helpers/api');
const { compose, ensureStackRunning, waitForHealthy } = require('../helpers/compose');
const { getPool, closePool } = require('../helpers/db');
const { env } = require('../helpers/env');
const { waitFor } = require('../helpers/wait');

beforeAll(async () => {
  await ensureStackRunning();
  await waitForApiHealthy();
});
afterAll(async () => {
  await ensureStackRunning();
  await closePool();
});

describe('input validation', () => {
  test('malformed JSON -> 400 invalid_json', async () => {
    const r = await request('POST', '/api/jobs', { rawBody: '{"reportType": "sales_summary",', headers: { 'Content-Type': 'application/json' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_json');
  });

  test('missing required fields -> 400 with field details', async () => {
    const r = await submitJob({ parameters: { format: 'pdf' } });
    expect(r.status).toBe(400);
    expect(r.json.details.map((d) => d.field)).toEqual(expect.arrayContaining(['reportType', 'parameters.startDate', 'parameters.endDate']));
  });

  test.each([
    ['empty object', {}],
    ['unknown report type', defaultJob({ reportType: 'payroll' })],
    ['invalid date', defaultJob({ parameters: { startDate: '2026-13-01', endDate: '2026-12-31' } })],
    ['unexpected field', defaultJob({ priority: 'high' })],
    ['wrong type', defaultJob({ parameters: 'everything' })],
  ])('%s -> 400', async (_name, body) => {
    expect((await submitJob(body)).status).toBe(400);
  });

  test('non-JSON content type -> 415', async () => {
    const r = await request('POST', '/api/jobs', { rawBody: 'reportType=sales_summary', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(415);
  });

  test('unknown job ID -> 404, malformed ID -> 400', async () => {
    expect((await getJob('3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')).status).toBe(404);
    expect((await getJob('12345')).status).toBe(400);
  });
});

describe('SQL injection', () => {
  test('injection strings in the body are stored literally and execute nothing', async () => {
    const payload = "x'); DROP TABLE jobs; --";
    const r = await submitJob(defaultJob({ requestedBy: payload }));
    expect(r.status).toBe(202);
    const stored = await getJob(r.json.jobId);
    expect(stored.json.request.requestedBy).toBe(payload);
    const { rows } = await getPool().query("SELECT to_regclass('public.jobs') AS t");
    expect(rows[0].t).toBe('jobs');
    await waitForStatus(r.json.jobId, ['completed']);
  });

  test('injection strings in the path and query are rejected', async () => {
    expect((await request('GET', `/api/jobs/${encodeURIComponent("' OR '1'='1")}`)).status).toBe(400);
    expect((await request('GET', `/api/jobs?status=${encodeURIComponent("queued' OR '1'='1")}`)).status).toBe(400);
    expect((await request('GET', `/api/jobs?limit=${encodeURIComponent('1; DROP TABLE jobs')}`)).status).toBe(400);
    expect((await submitJob(defaultJob({ reportType: "sales_summary'; DROP TABLE jobs; --" }))).status).toBe(400);
  });
});

describe('infrastructure failures', () => {
  test('PostgreSQL down -> POST/GET/health return 503; recovers when it is back', async () => {
    compose('stop', 'postgres');
    try {
      const post = await submitJob();
      expect(post.status).toBe(503);
      expect(post.json.error).toBe('service_unavailable');
      expect((await health()).status).toBe(503);
      expect((await request('GET', '/api/jobs')).status).toBe(503);
    } finally {
      compose('start', 'postgres');
      await waitForHealthy('postgres');
    }
    await waitForApiHealthy();
    const again = await submitJob();
    expect(again.status).toBe(202);
    await waitForStatus(again.json.jobId, ['completed'], { timeoutMs: 120000 });
  });

  test('RabbitMQ down -> POST still returns 202 (outbox); job completes after recovery', async () => {
    compose('stop', 'rabbitmq');
    let jobId;
    try {
      const post = await submitJob(defaultJob({ requestedBy: 'broker-outage' }));
      expect(post.status).toBe(202);
      jobId = post.json.jobId;
      await waitFor(async () => {
        const { rows } = await getPool().query('SELECT published_at FROM outbox WHERE job_id = $1', [jobId]);
        return rows.length === 1 && rows[0].published_at === null;
      }, { timeoutMs: 5000, description: 'an unpublished outbox row' });
      expect((await getJob(jobId)).json.status).toBe('queued');
      const h = await health();
      expect(h.status).toBe(200); // the API itself is fine
      expect(h.json.checks.outbox.pending).toBeGreaterThanOrEqual(1);
    } finally {
      compose('start', 'rabbitmq');
      await waitForHealthy('rabbitmq');
    }
    await waitForHealthy('outbox-publisher');
    await waitForHealthy('worker');
    const final = await waitForStatus(jobId, ['completed'], { timeoutMs: 120000 });
    expect(final.status).toBe('completed');
  });
});

describe('secrets', () => {
  test('no API response seen in this file contains a configured password', async () => {
    await health();
    await request('GET', '/api/stats');
    await request('GET', '/api/jobs?limit=100');
    expect(seenBodies.length).toBeGreaterThan(10);
    for (const secret of env.secrets) {
      for (const body of seenBodies) expect(body.includes(secret)).toBe(false);
    }
  });

  test('.env is not tracked by git and tracked files do not contain the configured passwords', () => {
    let tracked;
    try {
      tracked = execFileSync('git', ['ls-files'], { cwd: env.repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      console.warn('[TEST 7] git not available or not a repository; skipping tracked-file check');
      return;
    }
    expect(tracked).not.toContain('.env');
    for (const file of tracked) {
      const full = path.join(env.repoRoot, file);
      if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
      const content = fs.readFileSync(full, 'utf8');
      for (const secret of env.secrets) {
        // The placeholder passwords in .env.example are allowed only in .env.example.
        if (file === '.env.example') continue;
        expect({ file, leaked: content.includes(secret) }).toEqual({ file, leaked: false });
      }
    }
  });
});
