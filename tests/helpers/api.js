'use strict';

const { env } = require('./env');
const { waitFor } = require('./wait');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Every response body seen by the suite (used by the secret-leak check). */
const seenBodies = [];

function defaultJob(overrides = {}) {
  return {
    reportType: 'sales_summary',
    parameters: { startDate: '2026-01-01', endDate: '2026-01-31', format: 'pdf' },
    requestedBy: 'qa-suite',
    ...overrides,
  };
}

async function request(method, path, { body, rawBody, headers = {} } = {}) {
  const started = performance.now();
  const res = await fetch(`${env.apiUrl}${path}`, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const latencyMs = performance.now() - started;
  const text = await res.text();
  seenBodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, json, text, latencyMs };
}

const submitJob = (body = defaultJob()) => request('POST', '/api/jobs', { body });
const getJob = (id) => request('GET', `/api/jobs/${id}`);
const getEvents = (id) => request('GET', `/api/jobs/${id}/events`);
const health = () => request('GET', '/api/health');

async function waitForStatus(jobId, statuses, { timeoutMs = 90000 } = {}) {
  const wanted = [].concat(statuses);
  return waitFor(async () => {
    const r = await getJob(jobId);
    return r.status === 200 && wanted.includes(r.json.status) ? r.json : null;
  }, { timeoutMs, intervalMs: 300, description: `job ${jobId} to reach ${wanted.join('/')}` });
}

async function waitForAllStatus(jobIds, statuses, opts) {
  const out = [];
  for (const id of jobIds) out.push(await waitForStatus(id, statuses, opts));
  return out;
}

async function waitForApiHealthy(timeoutMs = 90000) {
  return waitFor(async () => {
    const r = await health();
    return r.status === 200 ? r.json : null;
  }, { timeoutMs, intervalMs: 500, description: 'API /api/health to return 200' });
}

module.exports = { UUID_V4_RE, seenBodies, defaultJob, request, submitJob, getJob, getEvents, health, waitForStatus, waitForAllStatus, waitForApiHealthy };
