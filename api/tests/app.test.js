'use strict';

/**
 * HTTP-level unit tests with an in-memory fake repository (no PostgreSQL).
 * The live-stack equivalents are in tests/integration.
 */
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeRepo(overrides = {}) {
  const jobs = new Map();
  return {
    jobs,
    createJob: jest.fn(async ({ id, reportType, payload }) => {
      const row = { id, report_type: reportType, payload, status: 'queued', progress: 0, attempts: 0, created_at: new Date(), updated_at: new Date() };
      jobs.set(id, row);
      return row;
    }),
    getJob: jest.fn(async (id) => jobs.get(id) || null),
    listJobs: jest.fn(async () => [...jobs.values()]),
    getJobEvents: jest.fn(async () => []),
    getStats: jest.fn(async () => ({ queued: jobs.size, processing: 0, completed: 0, failed: 0, outbox_pending: 0, outbox_oldest_pending_ms: null })),
    ping: jest.fn(async () => 1.5),
    ...overrides,
  };
}

function makeApp(repo = fakeRepo(), configOverrides = {}) {
  const config = {
    allowFailureSimulation: false,
    outboxDegradedAfterMs: 30000,
    frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
    ...configOverrides,
  };
  return { app: createApp({ repo, config, logger: silentLogger }), repo };
}

const validBody = { reportType: 'sales_summary', parameters: { startDate: '2026-01-01', endDate: '2026-01-31' } };

function dbDownError() {
  const err = new Error('connect ECONNREFUSED 172.18.0.2:5432');
  err.code = 'ECONNREFUSED';
  return err;
}

describe('POST /api/jobs', () => {
  test('returns 202 with a UUID, status URL and Location header', async () => {
    const { app, repo } = makeApp();
    const res = await request(app).post('/api/jobs').send(validBody);
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.status).toBe('queued');
    expect(res.body.statusUrl).toBe(`/api/jobs/${res.body.jobId}`);
    expect(res.headers.location).toBe(res.body.statusUrl);
    expect(repo.createJob).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for malformed JSON', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/jobs').set('Content-Type', 'application/json').send('{"reportType": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  test('returns 400 with field details for missing fields', async () => {
    const { app, repo } = makeApp();
    const res = await request(app).post('/api/jobs').send({ parameters: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    const fields = res.body.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['reportType', 'parameters.startDate', 'parameters.endDate']));
    expect(repo.createJob).not.toHaveBeenCalled();
  });

  test('returns 415 for non-JSON content type', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/jobs').set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(415);
  });

  test('returns 413 for oversized bodies', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/jobs').send({ ...validBody, requestedBy: 'x'.repeat(20000) });
    expect(res.status).toBe(413);
  });

  test('rejects failure simulation when disabled', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/jobs').send({ ...validBody, simulate: { mode: 'always_fail' } });
    expect(res.status).toBe(400);
  });

  test('accepts failure simulation when enabled', async () => {
    const { app } = makeApp(fakeRepo(), { allowFailureSimulation: true });
    const res = await request(app).post('/api/jobs').send({ ...validBody, simulate: { mode: 'always_fail' } });
    expect(res.status).toBe(202);
  });

  test('returns 503 without leaking internals when the database is down', async () => {
    const { app } = makeApp(fakeRepo({ createJob: jest.fn(async () => { throw dbDownError(); }) }));
    const res = await request(app).post('/api/jobs').send(validBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|5432|172\.18/);
    expect(res.headers['retry-after']).toBe('5');
  });

  test('returns 500 with a generic message for unexpected errors', async () => {
    const { app } = makeApp(fakeRepo({ createJob: jest.fn(async () => { throw new Error('secret internal detail'); }) }));
    const res = await request(app).post('/api/jobs').send(validBody);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret internal detail/);
  });
});

describe('GET /api/jobs/:id', () => {
  test('returns 400 for a non-UUID id (including SQL injection attempts)', async () => {
    const { app, repo } = makeApp();
    const res = await request(app).get(`/api/jobs/${encodeURIComponent("1' OR '1'='1")}`);
    expect(res.status).toBe(400);
    expect(repo.getJob).not.toHaveBeenCalled();
  });

  test('returns 404 for an unknown job', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/jobs/7b6f2a64-2d4f-4c1e-9b8a-1f2e3d4c5b6a');
    expect(res.status).toBe(404);
  });

  test('returns a submitted job', async () => {
    const { app } = makeApp();
    const created = await request(app).post('/api/jobs').send(validBody);
    const res = await request(app).get(created.body.statusUrl);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jobId: created.body.jobId, status: 'queued', reportType: 'sales_summary' });
  });
});

describe('GET /api/jobs', () => {
  test('rejects invalid query parameters', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/jobs?limit=abc')).status).toBe(400);
    expect((await request(app).get('/api/jobs?status=deleted')).status).toBe(400);
  });

  test('lists jobs', async () => {
    const { app } = makeApp();
    await request(app).post('/api/jobs').send(validBody);
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe('GET /api/health', () => {
  test('200 ok when the database responds', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('200 degraded when the outbox is backlogged', async () => {
    const repo = fakeRepo({ getStats: jest.fn(async () => ({ queued: 3, processing: 0, completed: 0, failed: 0, outbox_pending: 3, outbox_oldest_pending_ms: 60000 })) });
    const { app } = makeApp(repo);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  test('503 when the database is down', async () => {
    const { app } = makeApp(fakeRepo({ ping: jest.fn(async () => { throw dbDownError(); }) }));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
  });
});

describe('static dashboard and security headers', () => {
  test('serves index.html with a restrictive CSP and no x-powered-by', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Async Report Jobs');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('unknown API routes return JSON 404', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
