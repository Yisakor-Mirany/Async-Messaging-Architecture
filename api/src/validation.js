'use strict';

/**
 * Request validation schemas (zod). All input is validated before it touches
 * the database. Unknown properties are rejected (`.strict()`) so typos and
 * injection attempts in unexpected fields fail loudly with HTTP 400.
 */
const { z } = require('zod');

const REPORT_TYPES = ['sales_summary', 'inventory_snapshot', 'user_activity', 'financial_statement'];
const REPORT_FORMATS = ['pdf', 'csv', 'xlsx'];
const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'];
const SIMULATION_MODES = ['none', 'fail_then_succeed', 'always_fail'];
const MAX_RANGE_DAYS = 366;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isoDate = z
  .string({ required_error: 'is required', invalid_type_error: 'must be a string in YYYY-MM-DD format' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be in YYYY-MM-DD format')
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date');

const parametersSchema = z
  .object({
    startDate: isoDate,
    endDate: isoDate,
    format: z.enum(REPORT_FORMATS).default('pdf'),
    includeCharts: z.boolean().default(false),
  }, { required_error: 'is required', invalid_type_error: 'must be an object' })
  .strict()
  .superRefine((p, ctx) => {
    if (p.startDate > p.endDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'must be on or after startDate' });
      return;
    }
    const days = (Date.parse(p.endDate) - Date.parse(p.startDate)) / 86400000;
    if (days > MAX_RANGE_DAYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: `date range must not exceed ${MAX_RANGE_DAYS} days` });
    }
  });

const simulateSchema = z
  .object({
    mode: z.enum(SIMULATION_MODES).default('none'),
    failAttempts: z.number().int().min(1).max(10).default(1),
  })
  .strict();

const createJobSchema = z
  .object({
    reportType: z.enum(REPORT_TYPES, { required_error: 'is required' }),
    parameters: parametersSchema,
    requestedBy: z.string().trim().min(1).max(100).optional(),
    simulate: simulateSchema.optional(),
  }, { invalid_type_error: 'request body must be a JSON object' })
  .strict();

const listJobsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(JOB_STATUSES).optional(),
  })
  .strict();

/** Converts zod issues into a stable, client-friendly error list. */
function formatIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join('.') : '(body)',
    message: issue.message,
  }));
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = {
  REPORT_TYPES,
  REPORT_FORMATS,
  JOB_STATUSES,
  SIMULATION_MODES,
  createJobSchema,
  listJobsQuerySchema,
  formatIssues,
  isUuid,
};
