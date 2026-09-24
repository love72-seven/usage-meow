const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../renderer/usage-model');
const { UsageService } = require('../usage-service');

test('today stays zero when latest data is yesterday; chart has 14 calendar days', () => {
  const result = summarize({ daily: [{ period: '2026-09-21', totalCost: 12, totalTokens: 100 }] }, new Date(2026, 8, 22));
  assert.equal(result.today.cost, 0);
  assert.equal(result.cost, 12);
  assert.equal(result.chart.length, 14);
  assert.equal(result.chart.at(-1).date, '2026-09-22');
});

test('30-day window ignores older/future/malicious dates and aggregates same-day rows', () => {
  const result = summarize({ daily: [
    { date: '2026-08-23', totalCost: 999 },
    { date: '2026-08-24', totalCost: 2, inputTokens: 10, outputTokens: 5 },
    { period: '2026-09-22', totalCost: 3, totalTokens: 20 },
    { date: '2026-09-22', totalCost: 4, totalTokens: 30 },
    { date: '2026-09-23', totalCost: 999 },
    { date: '<img src=x onerror=alert(1)>', totalCost: 999 },
  ], totals: { totalCost: 99999 } }, new Date(2026, 8, 22));
  assert.equal(result.cost, 9);
  assert.equal(result.tokens, 65);
  assert.equal(result.today.cost, 7);
  assert.equal(result.activeDays, 2);
});

test('empty report is valid; malformed report is rejected', () => {
  assert.equal(summarize({ daily: [] }).cost, 0);
  assert.throws(() => summarize({ nonsense: [] }));
});

test('concurrent refreshes share a process and release it for later retries', async () => {
  let calls = 0;
  const service = new UsageService({ binary: 'test', cwd: '.', execute: (binary, args, options, callback) => {
    calls++;
    assert.equal(options.windowsHide, true);
    assert.ok(args.includes('--offline'));
    setImmediate(() => callback(null, '{"daily":[]}', ''));
    return { kill() {} };
  } });
  const first = service.load();
  assert.equal(first, service.load());
  assert.equal((await first).ok, true);
  await service.load();
  assert.equal(calls, 2);
});

test('timeout, missing binary and invalid JSON provide recoverable failures', async () => {
  for (const failure of [{ killed: true }, { code: 'ENOENT' }, null]) {
    const service = new UsageService({ binary: 'test', cwd: '.', execute: (_, args, options, callback) => {
      setImmediate(() => callback(failure, 'not json', ''));
      return { kill() {} };
    } });
    const result = await service.load();
    assert.equal(result.ok, false);
    assert.ok(result.error.length > 0);
  }
});
