'use strict';

/**
 * Parsing/validation of broker messages. Anything that is not a well-formed
 * v1 job message is a poison message: retrying it can never succeed.
 */
const { PoisonMessageError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);
const MAX_MESSAGE_BYTES = 64 * 1024;

function parseJobMessage(content) {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new PoisonMessageError('Message body is empty');
  }
  if (content.length > MAX_MESSAGE_BYTES) {
    throw new PoisonMessageError(`Message body exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  let data;
  try {
    data = JSON.parse(content.toString('utf8'));
  } catch {
    throw new PoisonMessageError('Message body is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PoisonMessageError('Message body must be a JSON object');
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(data.schemaVersion)) {
    throw new PoisonMessageError(`Unsupported schemaVersion: ${JSON.stringify(data.schemaVersion)}`);
  }
  if (typeof data.jobId !== 'string' || !UUID_RE.test(data.jobId)) {
    throw new PoisonMessageError('jobId must be a UUID');
  }
  if (data.messageId !== undefined && (typeof data.messageId !== 'string' || !UUID_RE.test(data.messageId))) {
    throw new PoisonMessageError('messageId must be a UUID when present');
  }
  return { schemaVersion: data.schemaVersion, jobId: data.jobId, messageId: data.messageId || null, reportType: data.reportType };
}

/** Best effort extraction of a job ID from a poison message (for diagnostics). */
function tryExtractJobId(content) {
  try {
    const data = JSON.parse(content.toString('utf8'));
    return typeof data.jobId === 'string' && UUID_RE.test(data.jobId) ? data.jobId : null;
  } catch {
    return null;
  }
}

module.exports = { parseJobMessage, tryExtractJobId, UUID_RE };
