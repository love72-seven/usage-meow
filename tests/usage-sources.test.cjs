const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { UsageSources } = require('../usage-sources');
const { UsageService } = require('../usage-service');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-source-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const standard = path.join(root, '.codex');
  const legacy = path.join(root, 'old-codex');
  await fs.mkdir(path.join(standard, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(legacy, 'sessions'), { recursive: true });
  const environment = { CODEX_HOME: legacy };
  const create = () => new UsageSources({ cwd: root, userHome: root, environment });
  return { root, standard, legacy, environment, create };
}

test('standard logs are not hidden by a stale inherited CODEX_HOME; paths stay visible', async (t) => {
  const f = await fixture(t);
  const settings = await f.create().settings();
  assert.equal(settings.selected, f.standard);
  assert.equal(settings.sources.length, 2);
  assert.equal(settings.multiple, true);
  assert.equal(f.environment.CODEX_HOME, f.legacy);
});

test('source selection persists across launches; missing saved source is not silently replaced', async (t) => {
  const f = await fixture(t);
  await f.create().select(f.legacy);
  assert.equal((await f.create().resolve()).home, f.legacy);
  await fs.rename(path.join(f.legacy, 'sessions'), path.join(f.legacy, 'moved-sessions'));
  await assert.rejects(f.create().resolve(), /切换统计目录/);
});

test('source validation rejects invalid directories and preserves saved preferences', async (t) => {
  const f = await fixture(t);
  const sources = f.create();
  await sources.select(f.standard);
  for (const invalid of [null, '../relative', f.root, path.join(f.root, 'a,b')]) {
    await assert.rejects(sources.select(invalid));
  }
  assert.equal((await f.create().resolve()).home, f.standard);
});

test('corrupt source preferences are reported without overwriting them', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'usage-source.json'), 'bad-json');
  await assert.rejects(f.create().settings(), /未覆盖/);
  assert.equal(await fs.readFile(path.join(f.root, 'usage-source.json'), 'utf8'), 'bad-json');
});

test('refresh uses the selected source and new data, not the old 2.87 snapshot', async (t) => {
  const f = await fixture(t);
  const sources = f.create();
  await sources.select(f.legacy);
  let currentCost = 20.38;
  let calls = 0;
  const service = new UsageService({ cwd: f.root, binary: 'fixture', sources,
    execute: (_, args, options, callback) => {
      calls++;
      const cost = options.env.CODEX_HOME === f.legacy ? 2.87 : currentCost;
      setImmediate(() => callback(null, JSON.stringify({ daily: [{ period: '2026-09-23', totalCost: cost }] }), ''));
      return { kill() {} };
    },
  });
  assert.equal((await service.load()).data.daily[0].totalCost, 2.87);
  assert.equal((await service.cached()).source.home, f.legacy);
  await sources.select(f.standard);
  assert.equal(await service.cached(), null, 'old source cache must not be shown');
  assert.equal((await service.load()).data.daily[0].totalCost, 20.38);
  currentCost = 21.5;
  assert.equal((await service.load()).data.daily[0].totalCost, 21.5);
  assert.equal(calls, 3);
  assert.equal((await service.cached()).data.daily[0].totalCost, 21.5);
});

test('legacy unlabelled cache is ignored; canonical duplicate roots are listed only once', async (t) => {
  const f = await fixture(t);
  f.environment.CODEX_HOME = `${f.standard},${path.join(f.standard, 'sessions', '..')}`;
  const sources = f.create();
  assert.equal((await sources.settings()).sources.length, 1);
  await fs.writeFile(path.join(f.root, 'usage-cache-v2.json'), JSON.stringify({ data: { daily: [] }, updatedAt: '2026-09-23' }));
  const service = new UsageService({ cwd: f.root, binary: 'fixture', sources });
  assert.equal(await service.cached(), null);
});

test('without standard logs, use available custom logs; no Codex logs still allows other agents', async (t) => {
  const f = await fixture(t);
  await fs.rename(path.join(f.standard, 'sessions'), path.join(f.standard, 'moved-sessions'));
  assert.equal((await f.create().resolve()).home, f.legacy);
  delete f.environment.CODEX_HOME;
  assert.equal((await f.create().resolve()).home, f.standard);
});
