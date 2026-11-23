'use strict';

/**
 * Simulated report generation. A real system would query data sources and
 * render a file; here we sleep 3-5 seconds (configurable), report progress
 * to PostgreSQL in four steps, and return deterministic result metadata.
 *
 * Failure simulation (only when the API allowed it at submission time):
 *   simulate.mode = 'fail_then_succeed' -> throws on attempts 1..failAttempts
 *   simulate.mode = 'always_fail'       -> throws on every attempt
 * Simulated failures are SimulatedFailureError instances (err.simulated = true)
 * so they are never confused with genuine infrastructure errors.
 */
const crypto = require('crypto');
const { SimulatedFailureError, PermanentProcessingError } = require('./errors');

const SUPPORTED_REPORT_TYPES = new Set(['sales_summary', 'inventory_snapshot', 'user_activity', 'financial_statement']);
const STEPS = 4;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function maybeSimulateFailure(job) {
  const simulate = job.payload && job.payload.simulate;
  if (!simulate || simulate.mode === 'none') return;
  if (simulate.mode === 'always_fail') {
    throw new SimulatedFailureError(`Simulated persistent failure (attempt ${job.attempts})`);
  }
  if (simulate.mode === 'fail_then_succeed' && job.attempts <= (simulate.failAttempts || 1)) {
    throw new SimulatedFailureError(`Simulated transient failure (attempt ${job.attempts} of ${simulate.failAttempts} failing attempts)`);
  }
}

/** Deterministic pseudo-data derived from the job ID (same input => same output). */
function buildResult(job, generationMs) {
  const digest = crypto.createHash('sha256').update(`${job.id}:${job.report_type}:${JSON.stringify(job.payload.parameters)}`).digest('hex');
  const seed = parseInt(digest.slice(0, 8), 16);
  const params = job.payload.parameters || {};
  return {
    reportType: job.report_type,
    format: params.format || 'pdf',
    period: { startDate: params.startDate, endDate: params.endDate },
    rowCount: 500 + (seed % 9500),
    pages: 1 + (seed % 40),
    fileName: `${job.report_type}_${job.id.slice(0, 8)}.${params.format || 'pdf'}`,
    checksum: digest,
    generationMs,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @param {object} job            jobs row (already claimed)
 * @param {object} opts
 * @param {(pct:number)=>Promise<void>} opts.onProgress  persists progress / extends lease
 */
async function generateReport(job, { onProgress, minMs, maxMs, sleep = defaultSleep, random = Math.random }) {
  if (!SUPPORTED_REPORT_TYPES.has(job.report_type)) {
    throw new PermanentProcessingError(`Unsupported report type: ${job.report_type}`);
  }
  const totalMs = minMs + Math.floor(random() * (maxMs - minMs + 1));
  const stepMs = totalMs / STEPS;

  for (let step = 1; step <= STEPS; step += 1) {
    await sleep(stepMs);
    if (step === 2) maybeSimulateFailure(job); // fail midway, after real work started
    if (step < STEPS) await onProgress(Math.round((step / STEPS) * 100)); // 25, 50, 75
  }
  return buildResult(job, totalMs);
}

module.exports = { generateReport, maybeSimulateFailure, buildResult };
