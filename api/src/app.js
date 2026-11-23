'use strict';

/**
 * Express application factory. Dependencies (repository, config, logger) are
 * injected so the app can be unit-tested without PostgreSQL.
 */
const express = require('express');
const helmet = require('helmet');
const { createJobsRouter, asyncRoute } = require('./routes/jobs');
const { isDatabaseUnavailableError } = require('./db');

function createApp({ repo, config, logger }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'upgrade-insecure-requests': null, // local development runs over plain HTTP
      },
    },
    strictTransportSecurity: false,
  }));

  // Small body limit: report requests are tiny; large bodies are rejected with 413.
  app.use('/api', express.json({ limit: '16kb', strict: true }));

  app.use('/api/jobs', createJobsRouter({ repo, config, logger }));

  /** Aggregated counters for the dashboard (buffering visualisation). */
  app.get('/api/stats', asyncRoute(async (_req, res) => {
    const s = await repo.getStats();
    res.set('Cache-Control', 'no-store').json({
      jobs: { queued: s.queued, processing: s.processing, completed: s.completed, failed: s.failed },
      outbox: { pending: s.outbox_pending, oldestPendingMs: s.outbox_oldest_pending_ms === null ? null : Math.round(s.outbox_oldest_pending_ms) },
    });
  }));

  /**
   * Health check. 503 when PostgreSQL is unreachable (the API cannot accept
   * jobs). "degraded" (still 200) when the outbox is backing up, which usually
   * means RabbitMQ or the outbox-publisher is down - ingestion still works.
   */
  app.get('/api/health', async (_req, res) => {
    const body = { status: 'ok', service: 'api', uptimeSeconds: Math.round(process.uptime()), checks: {} };
    try {
      const latencyMs = await repo.ping();
      body.checks.database = { status: 'up', latencyMs: Math.round(latencyMs * 100) / 100 };
      const s = await repo.getStats();
      const oldest = s.outbox_oldest_pending_ms === null ? null : Math.round(s.outbox_oldest_pending_ms);
      const backlogged = oldest !== null && oldest > config.outboxDegradedAfterMs;
      body.checks.outbox = { status: backlogged ? 'backlogged' : 'ok', pending: s.outbox_pending, oldestPendingMs: oldest };
      if (backlogged) body.status = 'degraded';
      res.set('Cache-Control', 'no-store').status(200).json(body);
    } catch (err) {
      logger.warn('Health check failed', { error: err.message, errorCode: err.code });
      body.status = 'unavailable';
      body.checks.database = { status: 'down' };
      res.set('Cache-Control', 'no-store').status(503).json(body);
    }
  });

  // Unknown API routes return JSON 404 instead of the HTML page.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found', message: 'Route not found' }));

  // Static dashboard (index.html, app.js, styles.css).
  app.use(express.static(config.frontendDir, { index: 'index.html', maxAge: 0 }));

  // Central error handler: map known failures to HTTP codes; never leak internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds 16kb' });
    }
    if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
      return res.status(415).json({ error: 'unsupported_media_type', message: 'Unsupported body encoding' });
    }
    if (isDatabaseUnavailableError(err)) {
      logger.error('Database unavailable', { path: req.path, error: err.message, errorCode: err.code });
      return res.status(503).set('Retry-After', '5').json({
        error: 'service_unavailable',
        message: 'The job store is temporarily unavailable. Please retry shortly.',
      });
    }
    logger.error('Unhandled error', { path: req.path, error: err.message, errorCode: err.code, stack: err.stack });
    return res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
  });

  return app;
}

module.exports = { createApp };
