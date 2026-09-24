const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PricingCatalog, parseOpenAI, parseLiteLLM, validSnapshot, SOURCES } = require('../pricing-catalog');
const { UsageService } = require('../usage-service');
const { breakdown } = require('../renderer/usage-model');

const markdown = '# Pricing\n\n### Standard pricing data\n\n'
  + '| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n'
  + '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
  + '| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |\n\n'
  + '### Batch pricing data\n\n| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |';
const raw = JSON.stringify({ 'gpt-6-sol': { mode: 'chat', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, litellm_provider: 'openai' },
  'future-model': { mode: 'chat', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, litellm_provider: 'test' } });
const response = (body) => new Response(body);

async function setup(t, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-pricing-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const catalog = new PricingCatalog({ cwd, seedPath: path.join(cwd, 'no-seed.json'),
    fetcher: async (url) => response(url === SOURCES.openai ? markdown : raw), ...options });
  t.after(() => catalog.stop());
  return { cwd, catalog };
}

test('official parser keeps Standard rates, never picks Batch discounts; malformed pages fail closed', () => {
  const entry = parseOpenAI(markdown)['gpt-6-sol'];
  assert.equal(entry.prices.inputCostPerToken, 2e-6);
  assert.equal(entry.prices.outputCostPerToken, 10e-6);
  assert.ok(Math.abs(entry.prices.cacheReadInputTokenCost - 0.2e-6) < 1e-20);
  assert.equal(entry.specialTiers, true);
  assert.throws(() => parseOpenAI(markdown.replace('Standard pricing data', 'Unrecognized data')));
  assert.throws(() => parseOpenAI('<html>denied</html>'));
});

test('catalog validates numeric prices, text modes, exact names, zero rates and rejects invalid input', () => {
  const values = JSON.parse(raw);
  values.zero = { mode: 'chat', input_cost_per_token: 0, output_cost_per_token: 0 };
  values.bad = { mode: 'chat', input_cost_per_token: -1, output_cost_per_token: 1 };
  values.string = { mode: 'chat', input_cost_per_token: '0.0001', output_cost_per_token: 0.0002 };
  values.image = { mode: 'image_generation', input_cost_per_token: 0.01, output_cost_per_token: 0.02 };
  const parsed = parseLiteLLM(JSON.stringify(values));
  assert.equal(parsed.zero.prices.inputCostPerToken, 0);
  assert.equal(parsed.bad, undefined);
  assert.equal(parsed.string, undefined);
  assert.equal(parsed.image, undefined);
  assert.equal(parsed['future-mode'], undefined);
  assert.throws(() => parseLiteLLM('{}'));
  assert.throws(() => parseLiteLLM('not-json'));
});

test('sync coalesces, official wins, future models appear and only fixed public GETs are sent', async (t) => {
  const requests = [];
  const { catalog, cwd } = await setup(t, { fetcher: async (url, options) => {
    requests.push({ url, options });
    return response(url === SOURCES.openai ? markdown : raw);
  } });
  const first = catalog.sync();
  assert.equal(first, catalog.sync());
  await first;
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.ok(Object.values(SOURCES).includes(request.url));
    assert.equal(request.options.body, undefined);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
  }
  assert.equal(catalog.snapshot.models['gpt-6-sol'].source, 'openai');
  assert.equal(catalog.snapshot.models['gpt-6-sol'].prices.inputCostPerToken, 2e-6);
  assert.ok(catalog.snapshot.models['future-model']);
  const prepared = await catalog.prepare();
  const config = JSON.parse(await fs.readFile(prepared.config));
  assert.equal(config.defaults.pricingOverrides['gpt-6-sol'].inputCostPerToken, 2e-6);
  assert.equal(validSnapshot(JSON.parse(await fs.readFile(path.join(cwd, 'pricing-catalog-v1.json')))), true);
});

test('unit prices respect Agent channel and report the frozen catalogue reference', async (t) => {
  const { catalog } = await setup(t);
  await catalog.ready;
  const base = { inputCostPerToken: 2e-6, outputCostPerToken: 10e-6 };
  catalog.snapshot = { models: {
    'gpt-6-sol': { provider: 'openai', source: 'openai', url: SOURCES.openai, checkedAt: '2026-09-22', prices: base },
    'zai/glm-5.3': { provider: 'zai', source: 'litellm', url: SOURCES.litellm, checkedAt: '2026-09-22',
      prices: { inputCostPerToken: 1e-6, outputCostPerToken: 4e-6 } },
  } };
  const data = { daily: [{ agents: [
    { agent: 'codex', modelBreakdowns: [{ modelName: 'gpt-6-sol' }] },
    { agent: 'zcode', modelBreakdowns: [{ modelName: 'glm-5.3' }, { modelName: 'gpt-6-sol' }] },
  ] }] };
  const references = catalog.unitPrices(data);
  assert.equal(references[JSON.stringify(['codex', 'gpt-6-sol'])].prices.inputCostPerToken, 2e-6);
  assert.equal(references[JSON.stringify(['zcode', 'glm-5.3'])].prices.cacheCreationInputTokenCost, 1e-6);
  assert.equal(references[JSON.stringify(['zcode', 'glm-5.3'])].match, 'agent');
  assert.equal(references[JSON.stringify(['zcode', 'gpt-6-sol'])], undefined);
});

test('network failure preserves good cache across restarts; retry cooldown prevents request loops', async (t) => {
  let clock = 1800000000000;
  const { catalog, cwd } = await setup(t, { now: () => clock });
  await catalog.sync();
  const previous = catalog.snapshot.revision;
  let calls = 0;
  catalog.fetcher = async () => { calls++; throw new Error('offline'); };
  clock += 3600000;
  await catalog.sync();
  assert.equal(catalog.snapshot.revision, previous);
  assert.match(catalog.status().error, /同步失败/);
  await catalog.sync();
  assert.equal(calls, 2);
  const restored = new PricingCatalog({ cwd, seedPath: 'missing', fetcher: catalog.fetcher });
  t.after(() => restored.stop());
  await restored.ready;
  assert.equal(restored.status().origin, 'cache');
  assert.equal(restored.snapshot.revision, previous);
});

test('partial source failure retains official values and marks the unavailable source', async (t) => {
  let clock = 1800000000000;
  const { catalog } = await setup(t, { now: () => clock });
  await catalog.sync();
  clock += 3600000;
  catalog.fetcher = async (url) => { if (url === SOURCES.openai) throw new Error('offline'); return response(raw); };
  await catalog.sync();
  assert.equal(catalog.snapshot.models['gpt-6-sol'].prices.inputCostPerToken, 2e-6);
  assert.match(catalog.status().error, /部分价格源/);
  assert.equal(catalog.status().sources.find((source) => source.id === 'openai').ok, false);
});

test('malformed or oversized downloads preserve the old catalog; timeouts settle', async (t) => {
  const { catalog } = await setup(t, { timeout: 20,
    fetcher: async () => new Response('bad', { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  await catalog.sync();
  assert.equal(catalog.snapshot, null);
  assert.match(catalog.status().error, /同步失败/);
  catalog.lastAttempt = 0;
  catalog.fetcher = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  await catalog.sync();
  assert.equal(catalog.pending, null);
});

test('service passes a runtime config to offline reads, reports revision and discovers unknown models', async (t) => {
  const { catalog, cwd } = await setup(t);
  await catalog.sync();
  let missing;
  catalog.observeMissing = (models) => { missing = models; };
  const service = new UsageService({ cwd, binary: 'fixture', pricing: catalog, execute: (_, args, options, callback) => {
    assert.ok(args.includes('--offline'));
    assert.equal(args[args.indexOf('--config') + 1], path.join(cwd, 'pricing-runtime.json'));
    setImmediate(() => callback(null, JSON.stringify({ daily: [], totals: { unpricedModels: ['unknown-new-model'] } }), ''));
    return { kill() {} };
  } });
  const result = await service.load();
  assert.equal(result.ok, true);
  assert.equal(result.pricing.revision, catalog.status().revision);
  assert.deepEqual(missing, ['unknown-new-model']);
});

test('unknown model cost is flagged rather than presented as a free model', () => {
  const result = breakdown({ daily: [{ period: '2026-09-23', agents: [{ agent: 'codex', modelBreakdowns: [{ modelName: 'new-model', cost: 0 }] }] }],
    totals: { unpricedModels: ['new-model'] } }, '', new Date(2026, 8, 23));
  assert.equal(result[0].unpriced, true);
});
