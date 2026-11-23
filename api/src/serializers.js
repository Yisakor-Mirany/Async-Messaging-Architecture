'use strict';

/** Converts a database row into the public JSON representation of a job. */
function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function serializeJob(row, now = new Date()) {
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const startedAt = row.started_at ? new Date(row.started_at) : null;
  const finishedAt = row.completed_at || row.failed_at ? new Date(row.completed_at || row.failed_at) : null;

  let processingMs = null;
  if (startedAt && finishedAt) processingMs = finishedAt - startedAt;
  else if (startedAt && row.status === 'processing') processingMs = now - startedAt;

  return {
    jobId: row.id,
    reportType: row.report_type,
    status: row.status,
    progress: row.progress,
    attempts: row.attempts,
    request: row.payload,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    failedAt: toIso(row.failed_at),
    // Time spent waiting in the queue before the first worker picked it up.
    queueWaitMs: createdAt && startedAt ? startedAt - createdAt : null,
    // Time from first claim until completion/failure (includes retries).
    processingMs,
    // End-to-end time from submission until a terminal state.
    totalDurationMs: createdAt && finishedAt ? finishedAt - createdAt : null,
    error: row.error_details || null,
    result: row.result || null,
  };
}

function serializeEvent(row) {
  return {
    type: row.event_type,
    attempt: row.attempt,
    workerId: row.worker_id,
    messageId: row.message_id,
    details: row.details,
    at: toIso(row.created_at),
  };
}

module.exports = { serializeJob, serializeEvent };
