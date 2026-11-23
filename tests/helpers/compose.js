'use strict';

/**
 * Thin wrapper around the Docker Compose CLI used by the resilience tests
 * (kill/stop/start/restart containers). Runs from the repository root, so
 * the project's docker-compose.yml and .env are used.
 */
const { execFileSync } = require('child_process');
const { env } = require('./env');
const { waitFor } = require('./wait');

function compose(...args) {
  return execFileSync('docker', ['compose', ...args], {
    cwd: env.repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });
}

function containerIds(service) {
  return compose('ps', '-q', service).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Returns { running, health } of the first container of a service. */
function serviceState(service) {
  const ids = compose('ps', '-a', '-q', service).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { running: false, health: 'missing' };
  const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', ids[0]], { encoding: 'utf8' }).trim();
  const [running, health] = out.split('|');
  return { running: running === 'true', health };
}

async function waitForHealthy(service, timeoutMs = 120000) {
  return waitFor(() => {
    const s = serviceState(service);
    return s.running && (s.health === 'healthy' || s.health === 'none');
  }, { timeoutMs, intervalMs: 1000, description: `${service} to become healthy` });
}

/** Makes sure every long-running service is up (used in beforeAll/afterAll). */
async function ensureStackRunning() {
  compose('start', 'postgres', 'rabbitmq');
  await waitForHealthy('postgres');
  await waitForHealthy('rabbitmq');
  compose('start', 'api', 'outbox-publisher', 'worker');
  await waitForHealthy('api');
  await waitForHealthy('outbox-publisher');
  await waitForHealthy('worker');
}

module.exports = { compose, containerIds, serviceState, waitForHealthy, ensureStackRunning };
