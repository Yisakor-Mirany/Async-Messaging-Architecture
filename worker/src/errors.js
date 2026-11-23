'use strict';

/**
 * Error taxonomy. The worker reacts differently to each category:
 *
 * | Category                    | Example                         | Reaction                                      |
 * |-----------------------------|---------------------------------|-----------------------------------------------|
 * | PoisonMessageError          | invalid JSON, unknown job ID    | straight to DLQ, never retried                |
 * | SimulatedFailureError       | demo "fail_then_succeed"        | bounded retry via retry queue, then DLQ       |
 * | PermanentProcessingError    | unsupported report definition   | mark failed + DLQ immediately                 |
 * | other application errors    | unexpected bug (TypeError ...)  | bounded retry via retry queue, then DLQ       |
 * | infrastructure errors       | PostgreSQL / RabbitMQ down      | back off, NACK with requeue, NOT an attempt   |
 * | LeaseLostError              | another worker took over        | stop work, ACK (the new owner has the job)    |
 */

class PoisonMessageError extends Error {
  constructor(message, reason = 'invalid_message') {
    super(message);
    this.name = 'PoisonMessageError';
    this.reason = reason;
  }
}

class SimulatedFailureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulatedFailureError';
    this.simulated = true;
    this.retryable = true;
  }
}

class PermanentProcessingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentProcessingError';
    this.retryable = false;
  }
}

class LeaseLostError extends Error {
  constructor(jobId) {
    super(`Lease lost for job ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

const INFRA_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  '57P01', '57P02', '57P03', '53300', '40001', '40P01', // shutdowns, too many conns, serialization/deadlock
]);

/** True for failures of PostgreSQL/RabbitMQ themselves (not of the job). */
function isInfrastructureError(err) {
  if (!err || err.simulated) return false;
  if (err instanceof PoisonMessageError || err instanceof PermanentProcessingError || err instanceof LeaseLostError) return false;
  if (INFRA_CODES.has(err.code)) return true;
  if (typeof err.code === 'string' && err.code.startsWith('08')) return true;
  if (err.name === 'IllegalOperationError') return true; // amqplib: channel/connection closed
  const msg = String(err.message || '');
  return /timeout exceeded when trying to connect|Connection terminated|Query read timeout|Channel closed|Connection closed|socket hang up/i.test(msg);
}

/** Classification stored in jobs.error_details.category. */
function classifyError(err) {
  if (err && err.simulated) return 'simulated_failure';
  if (err instanceof PermanentProcessingError) return 'permanent_processing_error';
  if (err instanceof PoisonMessageError) return 'poison_message';
  if (isInfrastructureError(err)) return 'infrastructure_error';
  return 'processing_error';
}

module.exports = {
  PoisonMessageError,
  SimulatedFailureError,
  PermanentProcessingError,
  LeaseLostError,
  isInfrastructureError,
  classifyError,
};
