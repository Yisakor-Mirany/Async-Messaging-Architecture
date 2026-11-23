'use strict';

const { generateReport } = require('../src/reportGenerator');
const { SimulatedFailureError, PermanentProcessingError } = require('../src/errors');

const noSleep = async () => {};

function job(overrides = {}) {
  return {
    id: '7b6f2a64-2d4f-4c1e-9b8a-1f2e3d4c5b6a',
    report_type: 'sales_summary',
    attempts: 1,
    payload: { parameters: { startDate: '2026-01-01', endDate: '2026-01-31', format: 'csv' } },
    ...overrides,
  };
}

test('takes between min and max ms, reports progress, returns deterministic metadata', async () => {
  const progress = [];
  const slept = [];
  const result = await generateReport(job(), {
    minMs: 3000, maxMs: 5000, random: () => 0.5,
    sleep: async (ms) => { slept.push(ms); },
    onProgress: async (p) => { progress.push(p); },
  });
  const total = slept.reduce((a, b) => a + b, 0);
  expect(total).toBeGreaterThanOrEqual(3000);
  expect(total).toBeLessThanOrEqual(5000);
  expect(progress).toEqual([25, 50, 75]);
  expect(result.fileName).toBe('sales_summary_7b6f2a64.csv');
  const again = await generateReport(job(), { minMs: 0, maxMs: 0, sleep: noSleep, onProgress: noSleep });
  expect(again.checksum).toBe(result.checksum);
});

test('fail_then_succeed fails only on the configured attempts', async () => {
  const payload = { ...job().payload, simulate: { mode: 'fail_then_succeed', failAttempts: 2 } };
  const opts = { minMs: 0, maxMs: 0, sleep: noSleep, onProgress: noSleep };
  await expect(generateReport(job({ attempts: 1, payload }), opts)).rejects.toThrow(SimulatedFailureError);
  await expect(generateReport(job({ attempts: 2, payload }), opts)).rejects.toThrow(SimulatedFailureError);
  await expect(generateReport(job({ attempts: 3, payload }), opts)).resolves.toHaveProperty('checksum');
});

test('always_fail fails on every attempt', async () => {
  const payload = { ...job().payload, simulate: { mode: 'always_fail' } };
  const opts = { minMs: 0, maxMs: 0, sleep: noSleep, onProgress: noSleep };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expect(generateReport(job({ attempts: attempt, payload }), opts)).rejects.toThrow(SimulatedFailureError);
  }
});

test('unsupported report types are permanent failures', async () => {
  await expect(generateReport(job({ report_type: 'payroll' }), { minMs: 0, maxMs: 0, sleep: noSleep, onProgress: noSleep }))
    .rejects.toThrow(PermanentProcessingError);
});
