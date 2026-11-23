'use strict';

const { createJobSchema, listJobsQuerySchema, isUuid } = require('../src/validation');

const valid = {
  reportType: 'sales_summary',
  parameters: { startDate: '2026-01-01', endDate: '2026-01-31' },
};

describe('createJobSchema', () => {
  test('accepts a minimal valid request and applies defaults', () => {
    const r = createJobSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data.parameters.format).toBe('pdf');
    expect(r.data.parameters.includeCharts).toBe(false);
  });

  test.each([
    ['missing reportType', { parameters: valid.parameters }],
    ['missing parameters', { reportType: 'sales_summary' }],
    ['missing startDate', { reportType: 'sales_summary', parameters: { endDate: '2026-01-31' } }],
    ['unknown reportType', { ...valid, reportType: 'payroll' }],
    ['bad date format', { ...valid, parameters: { startDate: '01/01/2026', endDate: '2026-01-31' } }],
    ['impossible date', { ...valid, parameters: { startDate: '2026-02-30', endDate: '2026-03-01' } }],
    ['end before start', { ...valid, parameters: { startDate: '2026-02-01', endDate: '2026-01-01' } }],
    ['range too long', { ...valid, parameters: { startDate: '2020-01-01', endDate: '2026-01-01' } }],
    ['unknown top-level field', { ...valid, isAdmin: true }],
    ['unknown parameters field', { ...valid, parameters: { ...valid.parameters, sql: 'DROP TABLE jobs' } }],
    ['bad simulate mode', { ...valid, simulate: { mode: 'explode' } }],
    ['requestedBy too long', { ...valid, requestedBy: 'x'.repeat(101) }],
    ['array body', [valid]],
    ['null body', null],
    ['string body', 'hello'],
  ])('rejects %s', (_name, body) => {
    expect(createJobSchema.safeParse(body).success).toBe(false);
  });

  test('keeps SQL-looking text as plain data (it is never interpolated into SQL)', () => {
    const r = createJobSchema.safeParse({ ...valid, requestedBy: "'; DROP TABLE jobs; --" });
    expect(r.success).toBe(true);
    expect(r.data.requestedBy).toBe("'; DROP TABLE jobs; --");
  });
});

describe('listJobsQuerySchema', () => {
  test('coerces and bounds limit', () => {
    expect(listJobsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(listJobsQuerySchema.parse({}).limit).toBe(25);
    expect(listJobsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(listJobsQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});

describe('isUuid', () => {
  test('validates UUIDs', () => {
    expect(isUuid('7b6f2a64-2d4f-4c1e-9b8a-1f2e3d4c5b6a')).toBe(true);
    expect(isUuid("1' OR '1'='1")).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
