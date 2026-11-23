'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `fn` until it returns a truthy value (which is returned) or the
 * timeout expires (throws with `description` and the last value/error seen).
 */
async function waitFor(fn, { timeoutMs = 60000, intervalMs = 250, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  const detail = lastErr ? ` (last error: ${lastErr.message})` : ` (last value: ${JSON.stringify(last)})`;
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}${detail}`);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

module.exports = { sleep, waitFor, percentile };
