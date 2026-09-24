const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { AccountService, sanitizeUsage, sanitizeLimits, sanitizeAccount, discoverBinary } = require('../account-service');
const { CodexClient, publicError, isolatedEnvironment } = require('../codex-client');
const { todayUsage, quotaView, maskEmail, durationLabel } = require('../renderer/account-model');
const { breakdown } = require('../renderer/usage-model');
const { UsageService } = require('../usage-service');

test('null usage is unknown, explicit zero stays zero, fields are allowlisted', () => {
  const usage = sanitizeUsage({ summary: { lifetimeTokens: null, secret: 'credential' }, dailyUsageBuckets: null });
  assert.equal(usage.summary.lifetimeTokens, null);
  assert.equal(usage.daily, null);
  assert.equal(todayUsage(usage).tokens, null);
  const dated = sanitizeUsage({ dailyUsageBuckets: [{ startDate: '2026-09-23', tokens: 0 }, { startDate: '<script>', tokens: 22 }] });
  assert.equal(todayUsage(dated, new Date(2026, 8, 23)).tokens, 0);
  assert.equal(todayUsage(dated, new Date(2026, 8, 24)).tokens, null);
  assert.ok(!JSON.stringify(usage).includes('credential'));
  assert.deepEqual(sanitizeAccount({ type: 'chatgpt', email: null, accessToken: 'credential' }), { type: 'chatgpt', email: null, planType: null });
});

test('multi-bucket quota preferred, unknown percent not 100%, expired reset not recovery', () => {
  const limits = sanitizeLimits({ rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: { weekly: { primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1 }, secondary: { usedPercent: null } } } });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].id, 'weekly');
  const view = quotaView(limits[0].windows[0], 2000);
  assert.equal(view.remaining, 75);
  assert.equal(view.expired, true);
  assert.equal(view.label, '7 天窗口');
  assert.equal(quotaView(limits[0].windows[1]).remaining, null);
  assert.equal(durationLabel(null), '未知窗口');
  assert.equal(durationLabel(300), '5 小时窗口');
  assert.equal(durationLabel(15), '15 分钟窗口');
  assert.equal(sanitizeLimits({ rateLimitsByLimitId: {}, rateLimits: { primary: { usedPercent: 120 } } })[0].windows[0].usedPercent, 100);
});

test('identity is masked by default and no inherited credentials reach profile child', () => {
  assert.equal(maskEmail('person@example.test'), 'p***@example.test');
  assert.equal(maskEmail('person@example.test', true), 'person@example.test');
  const env = isolatedEnvironment('selected', 'person-home', {
    Path: 'bin', TEMP: 'tmp', OPENAI_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret',
    CODEX_HOME: 'other', CODEX_API_KEY: 'secret', CODEX_WIF_SOURCE: 'secret', HTTPS_PROXY: 'proxy',
  });
  assert.equal(env.CODEX_HOME, 'selected');
  assert.equal(env.HOME, 'person-home');
  assert.equal(env.HTTPS_PROXY, 'proxy');
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.ok(!publicError(new Error('secret bearer token')).includes('secret'));
  assert.match(publicError({ code: -32601 }), /不支持/);
});

test('Agent/model breakdown sums only leaf fields, never double-counts daily totals', () => {
  const payload = { daily: [{ period: '2026-09-23', totalTokens: 999, totalCost: 50, agents: [
    { agent: 'codex', totalCost: 50, modelBreakdowns: [{ modelName: 'model-a', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cost: 1 }] },
    { agent: 'pi', modelBreakdowns: [{ modelName: 'model-a', inputTokens: 5, cost: 2 }] },
  ] }] };
  const rows = breakdown(payload, '', new Date(2026, 8, 23));
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.cost, 0), 3);
  assert.equal(breakdown(payload, 'codex', new Date(2026, 8, 23))[0].input, 10);
});

async function fixture(t, behavior = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-meow-account-test-'));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'config.toml'), '');
  let current = { type: 'chatgpt', email: 'first@example.test', planType: 'pro', token: 'never-store-me' };
  let created = 0;
  let stopped = 0;
  const methods = [];
  const service = new AccountService({ cwd: path.join(root, 'app'), userHome: root, defaultHome: profile,
    findBinary: async () => 'codex.exe', clientFactory: () => {
      created++;
      const client = {
        accountChanged: false,
        start: async () => {},
        stop: () => stopped++,
        read: async (method) => {
          methods.push(method);
          if (behavior.read) return behavior.read(method, client);
          if (method === 'account/read') return { account: current };
          if (method === 'account/usage/read') return { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: null };
          return { rateLimits: { primary: { usedPercent: 10 } } };
        },
      };
      return client;
    },
  });
  t.after(async () => { service.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { service, root, profile, methods, setAccount: (value) => { current = value; }, counts: () => ({ created, stopped }) };
}

test('account service coalesces refreshes, observes changes, never stores auth or raw payload', async (t) => {
  const fx = await fixture(t);
  const first = fx.service.load();
  assert.equal(first, fx.service.load());
  const result = await first;
  assert.equal(result.results[0].status, 'connected');
  assert.equal(result.results[0].usage.summary.lifetimeTokens, 100);
  fx.setAccount({ type: 'chatgpt', email: 'second@example.test', planType: 'plus' });
  const second = await fx.service.load();
  assert.equal(second.history.length, 1);
  assert.equal(second.history[0].before.email, 'first@example.test');
  assert.equal(second.history[0].after.email, 'second@example.test');
  const stored = await fs.readFile(path.join(fx.root, 'app', 'account-center.json'), 'utf8');
  assert.ok(!stored.includes('never-store-me'));
  assert.ok(!stored.includes('lifetimeTokens'));
  assert.deepEqual(fx.counts(), { created: 2, stopped: 2 });
  assert.ok(fx.methods.every((method) => ['account/read', 'account/usage/read', 'account/rateLimits/read'].includes(method)));
});

test('API key and signed out profiles skip official usage, never impersonate prior account', async (t) => {
  const fx = await fixture(t);
  fx.setAccount({ type: 'apiKey' });
  const api = await fx.service.load();
  assert.equal(api.results[0].status, 'unsupported');
  assert.equal(api.results[0].usage, null);
  assert.ok(fx.methods.every((method) => method === 'account/read'));
  fx.setAccount(null);
  assert.equal((await fx.service.load()).results[0].status, 'signed-out');
});

test('mid-query auth change discards usage; partial unsupported endpoint preserves quota', async (t) => {
  let changed = true;
  const fx = await fixture(t, { read: async (method, client) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'demo@example.test' } };
    if (method === 'account/usage/read') {
      if (changed) client.accountChanged = true;
      throw Object.assign(new Error('unknown method'), { code: -32601 });
    }
    return { rateLimits: { primary: { usedPercent: 50 } } };
  } });
  const discarded = (await fx.service.load()).results[0];
  assert.equal(discarded.status, 'error');
  assert.equal(discarded.account, null);
  assert.deepEqual(discarded.limits, []);
  changed = false;
  const partial = (await fx.service.load()).results[0];
  assert.equal(partial.status, 'connected');
  assert.equal(partial.limits.length, 1);
  assert.match(partial.errors.usage, /不支持/);
});

test('adding, renaming and removing profile touches only app metadata and rejects duplicate paths', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(fx.service.addProfile(fx.profile), /已接入/);
  const other = path.join(fx.root, 'other');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'config.toml'), 'untouched');
  const added = await fx.service.addProfile(other);
  const id = added.profiles[1].id;
  await fx.service.updateProfile(id, '工作账号');
  assert.equal((await fx.service.settings()).profiles[1].name, '工作账号');
  await fx.service.updateProfile(id, null, true);
  assert.equal(await fs.readFile(path.join(other, 'config.toml'), 'utf8'), 'untouched');
  await assert.rejects(fx.service.updateProfile('default', null, true), /至少/);
});

test('binary discovery finds desktop native executable without executing shell wrappers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-meow-binary-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'OpenAI', 'Codex', 'bin', 'version');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'codex.exe'), 'test');
  assert.equal(await discoverBinary(root, { LOCALAPPDATA: root, PATH: '' }), path.join(dir, 'codex.exe'));
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const messages = [];
  child.stdin.on('data', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    if (message.method === 'initialize') setImmediate(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n'));
  });
  return { child, messages };
}

test('RPC handles fragmented messages, refuses writes and rejects unexpected server actions', async () => {
  const { child, messages } = fakeProcess();
  const client = new CodexClient({ binary: 'codex.exe', profileHome: 'profile', userHome: 'home', cwd: '.', spawnProcess: () => child, timeout: 500 });
  await client.start();
  const pending = client.read('account/read');
  const id = messages.at(-1).id;
  child.stdout.write('not-json\n{"id":');
  child.stdout.write(`${id},"result":{"account":null}}\n`);
  assert.deepEqual(await pending, { account: null });
  child.stdout.write('{"method":"account/chatgptAuthTokens/refresh","id":100}\n');
  assert.equal(messages.at(-1).error.code, -32601);
  await assert.rejects(client.read('account/logout'), /Read-only/);
  client.stop();
  assert.equal(child.killed, true);
});

test('RPC timeout and process exit settle pending calls and release resources', async () => {
  const { child } = fakeProcess();
  const client = new CodexClient({ binary: 'codex.exe', profileHome: 'profile', userHome: 'home', cwd: '.', spawnProcess: () => child, timeout: 30 });
  await client.start();
  await assert.rejects(client.read('account/usage/read'), { code: 'TIMEOUT' });
  const pending = client.read('account/read');
  child.emit('exit', 1);
  await assert.rejects(pending, { code: 'STOPPED' });
  assert.equal(client.pending.size, 0);
});

test('successful usage saves a readable cache; failed reload leaves previous snapshot intact', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-meow-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let fail = false;
  const service = new UsageService({ cwd: root, binary: 'fixture', execute: (binary, args, options, callback) => {
    assert.ok(args.includes('--by-agent'));
    setImmediate(() => callback(fail ? { code: 'ENOENT' } : null, '{"daily":[],"totals":{}}', ''));
    return { kill() {} };
  } });
  assert.equal(await service.cached(), null);
  await service.load();
  const first = await service.cached();
  assert.equal(first.cached, true);
  assert.ok(first.updatedAt);
  fail = true;
  assert.equal((await service.load()).ok, false);
  assert.equal((await service.cached()).updatedAt, first.updatedAt);
});
