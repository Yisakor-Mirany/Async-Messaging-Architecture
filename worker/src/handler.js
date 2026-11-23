'use strict';

/**
 * The message-handling state machine. It is transport-agnostic: `broker`
 * supplies ack/nack/publishRetry/deadLetter, so the logic can be unit tested
 * with fakes and the real amqplib wiring lives in index.js.
 *
 * Invariants:
 *   1. A message is ACKed only AFTER the resulting job state is durably
 *      committed in PostgreSQL (or after a retry/DLQ copy is confirmed by the
 *      broker). If the worker dies before the ACK, RabbitMQ redelivers.
 *   2. Every claim increments jobs.attempts; attempts are bounded by MAX_ATTEMPTS
 *      (crash-looping "poison" jobs are therefore also bounded).
 *   3. Completed/failed jobs are never processed again (idempotency).
 *   4. Infrastructure errors do not consume an attempt: the message is NACKed
 *      with requeue after a back-off delay.
 */
const {
  PoisonMessageError,
  LeaseLostError,
  isInfrastructureError,
  classifyError,
} = require('./errors');
const { parseJobMessage, tryExtractJobId } = require('./messages');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, max = 500) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function createMessageHandler({ repo, broker, generateReport, config, logger, workerId, sleep = defaultSleep }) {
  // Job IDs currently being processed by THIS process. Prevents two copies of
  // the same message (e.g. an outbox re-publish) running concurrently here when
  // prefetch > 1, since both copies would carry the same workerId.
  const inFlightJobs = new Set();

  function errorDetails(err, attempt) {
    return {
      category: classifyError(err),
      name: err.name,
      message: truncate(err.message),
      simulated: Boolean(err.simulated),
      attempt,
      workerId,
      at: new Date().toISOString(),
    };
  }

  async function handle(msg) {
    const props = msg.properties || {};
    const deliveryInfo = { messageId: props.messageId || null, redelivered: Boolean(msg.fields && msg.fields.redelivered) };

    // ---- 1. Parse. Malformed messages are poison: DLQ, never retried. ------
    let message;
    try {
      message = parseJobMessage(msg.content);
    } catch (err) {
      if (!(err instanceof PoisonMessageError)) throw err;
      logger.warn('Poison message dead-lettered', { ...deliveryInfo, reason: err.reason, error: err.message, jobId: tryExtractJobId(msg.content) });
      await broker.deadLetter(msg, { reason: err.reason, error: err.message, workerId });
      broker.ack(msg);
      return 'dead_lettered';
    }

    const { jobId } = message;
    const messageId = message.messageId || deliveryInfo.messageId;
    const log = { jobId, messageId, redelivered: deliveryInfo.redelivered };

    if (inFlightJobs.has(jobId)) {
      logger.info('Duplicate copy of an in-flight job; deferring', log);
      await broker.publishRetry(msg, { deferred: true });
      broker.ack(msg);
      return 'deferred';
    }

    inFlightJobs.add(jobId);
    try {
      return await processJob(msg, jobId, messageId, log);
    } catch (err) {
      if (isInfrastructureError(err)) {
        // Database/broker problem: this is not the job's fault. Wait, then
        // put the message back on the queue without consuming an attempt.
        logger.warn('Infrastructure error; NACK with requeue after back-off', { ...log, error: err.message, errorCode: err.code, backoffMs: config.infraBackoffMs });
        await sleep(config.infraBackoffMs);
        broker.nack(msg, true);
        return 'requeued';
      }
      throw err;
    } finally {
      inFlightJobs.delete(jobId);
    }
  }

  async function processJob(msg, jobId, messageId, log) {
    // ---- 2. Atomic claim (idempotency + concurrency guard). ---------------
    const claim = await repo.claimJob(jobId, {
      workerId,
      leaseMs: config.jobLeaseMs,
      messageId,
      redelivered: log.redelivered,
    });

    if (claim.outcome === 'not_found') {
      // The outbox guarantees the job row exists before its message; an
      // unknown ID therefore means a foreign or corrupted message.
      logger.warn('Message references unknown job; dead-lettering', log);
      await broker.deadLetter(msg, { reason: 'unknown_job', error: `No job with id ${jobId}`, workerId });
      broker.ack(msg);
      return 'dead_lettered';
    }

    if (claim.outcome === 'already_terminal') {
      // Duplicate delivery of finished work: acknowledge and do nothing.
      logger.info('Duplicate message for finished job ignored', { ...log, status: claim.job.status });
      await repo.recordEvent(jobId, 'duplicate_ignored', { attempt: claim.job.attempts, workerId, messageId, details: { status: claim.job.status, redelivered: log.redelivered } });
      broker.ack(msg);
      return 'duplicate';
    }

    if (claim.outcome === 'locked') {
      // Another live worker holds the lease (or a crashed worker's lease has
      // not expired yet). Re-check later via the delay queue.
      logger.info('Job leased by another worker; deferring', { ...log, lockedBy: claim.job.locked_by, leaseExpiresAt: claim.job.lease_expires_at });
      await broker.publishRetry(msg, { deferred: true });
      await repo.touchEnqueued(jobId);
      await repo.recordEvent(jobId, 'deferred', { attempt: claim.job.attempts, workerId, messageId, details: { lockedBy: claim.job.locked_by } });
      broker.ack(msg);
      return 'deferred';
    }

    const job = claim.job;
    const attempt = job.attempts;
    logger.info('Job claimed', { ...log, attempt, maxAttempts: config.maxAttempts });

    // ---- 3. Attempt budget exhausted by earlier interrupted attempts. -----
    if (attempt > config.maxAttempts) {
      const details = { category: 'attempts_exhausted', name: 'MaxAttemptsExceeded', message: `Job exceeded ${config.maxAttempts} attempts (previous attempts were interrupted)`, simulated: false, attempt, workerId, at: new Date().toISOString() };
      await repo.markFailed(jobId, { workerId, errorDetails: details, messageId });
      await broker.deadLetter(msg, { reason: 'max_attempts_exceeded', error: details.message, workerId, attempt });
      broker.ack(msg);
      logger.warn('Job failed: attempts exhausted by interrupted processing', { ...log, attempt });
      return 'failed';
    }

    // ---- 4. Do the work. ---------------------------------------------------
    let result;
    try {
      result = await generateReport(job, {
        minMs: config.processingMinMs,
        maxMs: config.processingMaxMs,
        onProgress: async (progress) => {
          const stillOwner = await repo.updateProgress(jobId, { workerId, leaseMs: config.jobLeaseMs, progress });
          if (!stillOwner) throw new LeaseLostError(jobId);
        },
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return onLeaseLost(msg, jobId, messageId, attempt, log);
      if (isInfrastructureError(err)) throw err; // handled by caller (NACK + requeue)
      return onProcessingFailure(msg, job, err, messageId, log);
    }

    // ---- 5. Durable completion BEFORE the ACK. -----------------------------
    const completed = await repo.markCompleted(jobId, { workerId, result, messageId });
    if (!completed) return onLeaseLost(msg, jobId, messageId, attempt, log);

    broker.ack(msg);
    logger.info('Job completed', { ...log, attempt, generationMs: result.generationMs });
    return 'completed';
  }

  async function onLeaseLost(msg, jobId, messageId, attempt, log) {
    // Our lease expired and another worker claimed the job; it now owns the
    // outcome. Our result is discarded (nothing was committed) and we ACK.
    logger.warn('Lease lost; abandoning attempt', { ...log, attempt });
    await repo.recordEvent(jobId, 'lease_lost', { attempt, workerId, messageId });
    broker.ack(msg);
    return 'lease_lost';
  }

  async function onProcessingFailure(msg, job, err, messageId, log) {
    const attempt = job.attempts;
    const details = errorDetails(err, attempt);
    const retryable = err.retryable !== false;

    if (retryable && attempt < config.maxAttempts) {
      // Commit "queued + error" first, then publish the delayed retry copy
      // (confirmed by the broker), then ACK the original.
      const released = await repo.releaseForRetry(job.id, { workerId, errorDetails: details, messageId, retryDelayMs: config.retryDelayMs });
      if (!released) return onLeaseLost(msg, job.id, messageId, attempt, log);
      await broker.publishRetry(msg, { attempt: attempt + 1, lastError: details.message });
      broker.ack(msg);
      logger.warn('Attempt failed; retry scheduled', { ...log, attempt, nextAttempt: attempt + 1, category: details.category, error: details.message, retryDelayMs: config.retryDelayMs });
      return 'retry_scheduled';
    }

    const failed = await repo.markFailed(job.id, { workerId, errorDetails: details, messageId });
    if (!failed) return onLeaseLost(msg, job.id, messageId, attempt, log);
    await broker.deadLetter(msg, { reason: retryable ? 'max_attempts_exhausted' : 'permanent_failure', error: details.message, workerId, attempt });
    broker.ack(msg);
    logger.error('Job failed permanently; message dead-lettered', { ...log, attempt, category: details.category, error: details.message });
    return 'failed';
  }

  return { handle, inFlightJobs };
}

module.exports = { createMessageHandler };
