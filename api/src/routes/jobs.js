'use strict';

const crypto = require('crypto');
const express = require('express');
const { createJobSchema, listJobsQuerySchema, formatIssues, isUuid } = require('../validation');
const { serializeJob, serializeEvent } = require('../serializers');

/** Small helper so async route errors reach the central error handler. */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validationError(res, details) {
  return res.status(400).json({ error: 'validation_error', message: 'Request validation failed', details });
}

function createJobsRouter({ repo, config, logger }) {
  const router = express.Router();

  /**
   * POST /api/jobs
   * Validates, persists (job + outbox in one transaction) and returns 202.
   * It deliberately does NOT wait for the worker - processing happens later.
   */
  router.post('/', asyncRoute(async (req, res) => {
    const started = process.hrtime.bigint();

    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'unsupported_media_type', message: 'Content-Type must be application/json' });
    }

    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, formatIssues(parsed.error));

    const body = parsed.data;
    if (body.simulate && body.simulate.mode !== 'none' && !config.allowFailureSimulation) {
      return validationError(res, [{ field: 'simulate', message: 'failure simulation is disabled on this server' }]);
    }

    const id = crypto.randomUUID();
    const job = await repo.createJob({ id, reportType: body.reportType, payload: body });

    const statusUrl = `/api/jobs/${job.id}`;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info('Job accepted', { jobId: job.id, reportType: job.report_type, elapsedMs: Math.round(elapsedMs * 100) / 100 });

    res
      .status(202)
      .location(statusUrl)
      .set('Server-Timing', `app;dur=${elapsedMs.toFixed(2)}`)
      .json({
        jobId: job.id,
        status: job.status,
        statusUrl,
        submittedAt: new Date(job.created_at).toISOString(),
        message: 'Job accepted for asynchronous processing. Poll statusUrl for progress.',
      });
  }));

  /** GET /api/jobs?limit=25&status=queued - most recent jobs first. */
  router.get('/', asyncRoute(async (req, res) => {
    const parsed = listJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, formatIssues(parsed.error));
    const rows = await repo.listJobs(parsed.data);
    const now = new Date();
    res.json({ count: rows.length, jobs: rows.map((r) => serializeJob(r, now)) });
  }));

  /** GET /api/jobs/:id - current status of one job. */
  router.get('/:id', asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return validationError(res, [{ field: 'id', message: 'must be a valid UUID' }]);
    }
    const row = await repo.getJob(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Job not found' });
    res.set('Cache-Control', 'no-store').json(serializeJob(row));
  }));

  /** GET /api/jobs/:id/events - audit trail of state transitions. */
  router.get('/:id/events', asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return validationError(res, [{ field: 'id', message: 'must be a valid UUID' }]);
    }
    const row = await repo.getJob(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Job not found' });
    const events = await repo.getJobEvents(req.params.id);
    res.json({ jobId: row.id, events: events.map(serializeEvent) });
  }));

  return router;
}

module.exports = { createJobsRouter, asyncRoute };
