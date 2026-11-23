'use strict';

const { parseJobMessage } = require('../src/messages');
const { PoisonMessageError, SimulatedFailureError, PermanentProcessingError, isInfrastructureError, classifyError } = require('../src/errors');

const jobId = '7b6f2a64-2d4f-4c1e-9b8a-1f2e3d4c5b6a';
const buf = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

describe('parseJobMessage', () => {
  test('accepts a valid v1 message', () => {
    expect(parseJobMessage(buf({ schemaVersion: 1, jobId, reportType: 'sales_summary' })).jobId).toBe(jobId);
  });

  test.each([
    ['empty body', Buffer.alloc(0)],
    ['invalid JSON', buf('{not json')],
    ['JSON array', buf([1, 2])],
    ['missing schemaVersion', buf({ jobId })],
    ['unsupported schemaVersion', buf({ schemaVersion: 99, jobId })],
    ['non-UUID jobId', buf({ schemaVersion: 1, jobId: "1; DROP TABLE jobs" })],
    ['oversized body', Buffer.alloc(70 * 1024, 'a')],
  ])('rejects %s as a poison message', (_n, content) => {
    expect(() => parseJobMessage(content)).toThrow(PoisonMessageError);
  });
});

describe('error classification', () => {
  test('simulated failures are never infrastructure errors', () => {
    const err = new SimulatedFailureError('boom');
    expect(isInfrastructureError(err)).toBe(false);
    expect(classifyError(err)).toBe('simulated_failure');
  });

  test('database connection errors are infrastructure errors', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const shutdown = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    expect(isInfrastructureError(refused)).toBe(true);
    expect(isInfrastructureError(shutdown)).toBe(true);
    expect(isInfrastructureError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(classifyError(refused)).toBe('infrastructure_error');
  });

  test('constraint violations and bugs are processing errors', () => {
    const constraint = Object.assign(new Error('violates check constraint'), { code: '23514' });
    expect(isInfrastructureError(constraint)).toBe(false);
    expect(isInfrastructureError(new TypeError('x is undefined'))).toBe(false);
    expect(classifyError(new TypeError('x'))).toBe('processing_error');
    expect(classifyError(new PermanentProcessingError('x'))).toBe('permanent_processing_error');
  });
});
