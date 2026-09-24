const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AgentSources } = require('../agent-sources');
const { PriceReferences, resolveReference } = require('../pricing-resolver');
const { PricingCatalog } = require('../pricing-catalog');
const { replaceAgentReport } = require('../report-merge');
const { UsageService } = require('../usage-service');
const { agents, breakdown } = require('../renderer/usage-model');

async function temp(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'meow-agents-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const prices = { inputCostPerToken: 1.4e-6, outputCostPerToken: 4.4e-6, cacheCreationInputTokenCost: 0 };
const models = { 'zai/glm-5.3': { provider: 'zai', prices }, 'reseller/glm-5.3': { provider: 'reseller', prices } };
const entry = (agent, cost, missing = false) => ({ agent, totalTokens: 120, inputTokens: 100, outputTokens: 10, totalCost: cost,
  modelBreakdowns: [{ modelName: 'GLM-5.3', inputTokens: 100, outputTokens: 10, cost, missingPricing: missing }] });
const report = (...entries) => ({ daily: [{ period: '2026-09-23', agents: entries }], totals: {} });

test('provider references require exact identifiers, respect case and reject ambiguity and cross-vendor guesses', () => {
  assert.equal(resolveReference(models, 'GLM-5.3', 'zai'), 'zai/glm-5.3');
  assert.equal(resolveReference(models, '[pi] GLM-5.3', 'zai'), 'zai/glm-5.3');
  assert.equal(resolveReference(models, 'glm-5.3-latest', 'zai'), null);
  assert.equal(resolveReference(models, 'reseller/glm-5.3', 'zai'), null);
  assert.equal(resolveReference({ ...models, 'GLM-5.3': models['zai/glm-5.3'] }, 'GLM-5.3', 'zai'), null);
});

test('ZCode confirmed defaults, cache writes, persisted manual binding and removal', async (t) => {
  const cwd = await temp(t);
  const refs = new PriceReferences({ cwd });
  await refs.ready;
  refs.observe(report(entry('zcode', 0)));
  assert.equal(refs.config(models).zcode.defaults.pricingOverrides['GLM-5.3'].cacheCreationInputTokenCost, 1.4e-6);
  await refs.set({ agent: 'zcode', model: 'GLM-5.3', key: 'reseller/glm-5.3' }, models);
  assert.equal(refs.resolve(models, 'zcode', 'GLM-5.3'), 'reseller/glm-5.3');
  const restored = new PriceReferences({ cwd });
  await restored.ready;
  assert.equal(restored.resolve(models, 'zcode', 'GLM-5.3'), 'reseller/glm-5.3');
  await restored.set({ agent: 'zcode', model: 'GLM-5.3', key: null }, models);
  assert.equal(restored.resolve(models, 'zcode', 'GLM-5.3'), 'zai/glm-5.3');
  await restored.set({ agent: 'zcode', provider: '' }, models);
  assert.equal(restored.resolve(models, 'zcode', 'GLM-5.3'), null);
  await assert.rejects(restored.set({ agent: 'unknown', provider: 'zai' }, models));
  await assert.rejects(restored.set({ agent: 'zcode', model: 'GLM-5.3', key: 'unknown' }, models));
});

test('Agent discovery reports absent sources, validates ZCode DB and preserves native env', async (t) => {
  const cwd = await temp(t);
  const userHome = path.join(cwd, 'home');
  const root = path.join(userHome, '.zcode');
  await fs.mkdir(root, { recursive: true });
  const sources = new AgentSources({ cwd, userHome, environment: { OPENCODE_DATA_DIR: '' } });
  let settings = await sources.settings();
  assert.equal(settings.entries.length, 18);
  assert.deepEqual(settings.env, {});
  assert.equal(settings.entries.find((e) => e.id === 'opencode').roots.length, 0);
  assert.equal(settings.entries.find((e) => e.id === 'zcode').roots[0].exists, false);
  await assert.rejects(sources.set('zcode', root), /db.sqlite/);
  await fs.mkdir(path.join(root, 'cli/db'), { recursive: true });
  await fs.writeFile(path.join(root, 'cli/db/db.sqlite'), 'fixture');
  await sources.set('zcode', root);
  settings = await sources.settings();
  assert.equal(settings.entries.find((e) => e.id === 'zcode').custom, true);
  assert.equal(settings.env.ZCODE_HOME, await fs.realpath(root));
  const restored = new AgentSources({ cwd, userHome, environment: {} });
  assert.equal((await restored.settings()).env.ZCODE_HOME, settings.env.ZCODE_HOME);
  await assert.rejects(sources.set('zcode', 'relative'));
  await assert.rejects(sources.set('codex', root));
  await sources.set('zcode', null);
  assert.deepEqual((await sources.settings()).env, {});
});

test('changing Agent root invalidates cache fingerprint', async (t) => {
  const cwd = await temp(t);
  const sources = new AgentSources({ cwd, userHome: cwd, environment: {} });
  const initial = (await sources.settings()).fingerprint;
  const selected = path.join(cwd, 'custom');
  await fs.mkdir(selected);
  await sources.set('pi', selected);
  assert.notEqual((await sources.settings()).fingerprint, initial);
  const service = new UsageService({ cwd, binary: 'fixture', agentSources: sources });
  await fs.writeFile(service.cachePath, JSON.stringify({ data: report(), updatedAt: 'now', agentFingerprint: initial }));
  assert.equal(await service.cached(), null);
});

test('reprice replaces only target Agent, keeps extra tokens, missing flags and original report immutable', () => {
  const original = report(entry('zcode', 0, true), entry('pi', 7, true));
  const updated = replaceAgentReport(original, 'zcode', report(entry('zcode', 2), entry('pi', 99)));
  assert.equal(updated.totals.totalCost, 9);
  assert.equal(updated.totals.totalTokens, 240);
  assert.equal(updated.daily[0].agents.find((e) => e.agent === 'pi').totalCost, 7);
  assert.equal(updated.daily[0].modelBreakdowns[0].cost, 9);
  assert.deepEqual(updated.totals.unpricedModels, ['GLM-5.3']);
  assert.equal(original.daily[0].agents[0].totalCost, 0);
  const rows = breakdown(updated, '', new Date(2026, 8, 23));
  assert.equal(rows.find((e) => e.agent === 'zcode').unpriced, false);
  assert.equal(rows.find((e) => e.agent === 'pi').unpriced, true);
});

test('reprice can remove empty dates and introduce new dates without duplication', () => {
  const old = report(entry('zcode', 0));
  const next = report(entry('zcode', 2));
  next.daily[0].period = '2026-09-24';
  const merged = replaceAgentReport(old, 'zcode', next);
  assert.equal(merged.daily.length, 1);
  assert.equal(merged.daily[0].period, '2026-09-24');
  assert.equal(merged.totals.totalCost, 2);
  assert.equal(replaceAgentReport(old, 'zcode', { daily: [] }).daily.length, 0);
});

test('Agent overview counts parents once and retains zero-cost/unpriced agents', () => {
  const data = report(entry('zcode', 0, true), entry('pi', 4));
  data.daily[0].totalTokens = 240;
  const result = agents(data, new Date(2026, 8, 23));
  assert.equal(result.length, 2);
  assert.equal(result.reduce((sum, r) => sum + r.tokens, 0), 240);
  assert.equal(result.find((r) => r.id === 'zcode').todayTokens, 120);
  assert.deepEqual(result.find((r) => r.id === 'zcode').missing, ['GLM-5.3']);
});

test('catalog exposes multiple vendors and bounded filtered pagination', async (t) => {
  const catalog = new PricingCatalog({ cwd: await temp(t), seedPath: path.join(__dirname, '../pricing-seed.json') });
  t.after(() => catalog.stop());
  const all = await catalog.query({ page: -1 });
  for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'dashscope', 'zai', 'moonshot', 'minimax']) assert.ok(all.providers.some((p) => p.id === id), id);
  assert.equal(all.rows.length, 50);
  assert.equal(all.page, 0);
  const zai = await catalog.query({ provider: 'zai', search: 'GLM-5.3', page: 999 });
  assert.ok(zai.rows.length > 0);
  assert.ok(zai.rows.every((row) => row.provider === 'zai' && row.key.includes('glm-5.3')));
  assert.equal((await catalog.query({ search: 'no-such-model-987xyz' })).rows.length, 0);
});

test('service scopes native repricing and never applies ZCode reference to peers', async (t) => {
  const cwd = await temp(t);
  const catalog = new PricingCatalog({ cwd, seedPath: path.join(__dirname, '../pricing-seed.json') });
  t.after(() => catalog.stop());
  catalog.observeMissing = () => {};
  let passes = 0;
  const service = new UsageService({ cwd, binary: 'fixture', pricing: catalog, execute: (_, args, options, callback) => {
    const scoped = ++passes > 1;
    fs.readFile(args[args.indexOf('--config') + 1], 'utf8').then((text) => {
      const overrides = JSON.parse(text).defaults.pricingOverrides;
      assert.equal(Boolean(overrides['GLM-5.3']), scoped);
      callback(null, JSON.stringify(report(entry('zcode', scoped ? 2 : 0, !scoped), entry('pi', scoped ? 99 : 7))), '');
    }).catch((error) => callback(error, '', ''));
    return { kill() {} };
  } });
  const result = await service.load();
  assert.equal(result.ok, true, result.error);
  assert.equal(passes, 2);
  assert.equal(result.data.totals.totalCost, 9);
  assert.deepEqual(result.data.totals.unpricedModels, []);
});
