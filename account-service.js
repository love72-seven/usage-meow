const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexClient, publicError } = require('./codex-client');

const safeText = (value, limit = 180) => typeof value === 'string' ? value.slice(0, limit) : null;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function sanitizeAccount(account) {
  if (!account || typeof account.type !== 'string') return null;
  return { type: safeText(account.type, 40), email: safeText(account.email), planType: safeText(account.planType, 80) };
}

function sanitizeUsage(payload) {
  const summary = {};
  for (const key of ['lifetimeTokens', 'peakDailyTokens', 'currentStreakDays', 'longestStreakDays']) {
    summary[key] = numeric(payload?.summary?.[key]);
  }
  const daily = Array.isArray(payload?.dailyUsageBuckets) ? payload.dailyUsageBuckets
    .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket?.startDate) && numeric(bucket.tokens) !== null)
    .map((bucket) => ({ date: bucket.startDate, tokens: bucket.tokens }))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 366) : null;
  return { summary, daily };
}

function sanitizeLimits(payload) {
  const byId = payload?.rateLimitsByLimitId;
  const entries = byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.entries(byId) : payload?.rateLimits ? [['codex', payload.rateLimits]] : [];
  return entries.slice(0, 30).map(([id, bucket]) => {
    const windows = ['primary', 'secondary'].flatMap((key) => {
      const value = bucket?.[key];
      if (!value) return [];
      const used = numeric(value.usedPercent);
      return [{ key, usedPercent: used === null ? null : Math.min(100, used),
        durationMins: numeric(value.windowDurationMins), resetsAt: numeric(value.resetsAt) }];
    });
    return { id: safeText(id, 100), name: safeText(bucket?.limitName, 100) || safeText(id, 100), windows,
      reached: safeText(bucket?.rateLimitReachedType, 100) };
  });
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function discoverBinary(userHome, environment = process.env) {
  const local = environment.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local');
  const roaming = environment.APPDATA || path.join(userHome, 'AppData', 'Roaming');
  const desktopRoot = path.join(local, 'OpenAI', 'Codex', 'bin');
  let versions = [];
  try {
    versions = await Promise.all((await fs.readdir(desktopRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const file = path.join(desktopRoot, entry.name, 'codex.exe');
        try { return { file, modified: (await fs.stat(file)).mtimeMs }; } catch { return null; }
      }));
  } catch { /* Codex desktop may not be installed. */ }
  const candidates = versions.filter(Boolean).sort((a, b) => b.modified - a.modified).map((entry) => entry.file);
  for (const directory of (environment.PATH || environment.Path || '').split(path.delimiter)) {
    if (path.isAbsolute(directory)) candidates.push(path.join(directory, 'codex.exe'));
  }
  const nativeSuffix = path.join('vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
  const npmRoot = path.join(roaming, 'npm', 'node_modules', '@openai');
  candidates.push(path.join(npmRoot, 'codex', nativeSuffix));
  candidates.push(path.join(npmRoot, 'codex', 'node_modules', '@openai', 'codex-win32-x64', nativeSuffix));
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

class AccountService {
  constructor({ cwd, userHome = os.homedir(), defaultHome, clientFactory = (options) => new CodexClient(options), findBinary = discoverBinary, onDiagnostic = () => {} }) {
    this.cwd = cwd;
    this.userHome = userHome;
    this.defaultHome = defaultHome || path.join(userHome, '.codex');
    this.clientFactory = clientFactory;
    this.findBinary = findBinary;
    this.onDiagnostic = onDiagnostic;
    this.clients = new Set();
    this.pending = null;
    this.closed = false;
    this.store = { version: 1, binary: null, profiles: [], history: [] };
    this.ready = this.initialize();
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.cwd, { recursive: true });
    try {
      const stored = JSON.parse(await fs.readFile(path.join(this.cwd, 'account-center.json'), 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.profiles)) throw new Error('Invalid settings');
      this.store.binary = typeof stored.binary === 'string' && path.isAbsolute(stored.binary) ? stored.binary : null;
      this.store.profiles = stored.profiles.filter((entry) => typeof entry.id === 'string' &&
        typeof entry.home === 'string' && path.isAbsolute(entry.home)).slice(0, 8)
        .map((entry) => ({ id: entry.id.slice(0, 80), name: safeText(entry.name, 60) || 'Codex 配置', home: entry.home,
          lastIdentity: sanitizeAccount(entry.lastIdentity), lastCheckedAt: safeText(entry.lastCheckedAt, 40) }));
      this.store.history = Array.isArray(stored.history) ? stored.history.slice(0, 100).map((event) => ({
        profileId: safeText(event.profileId, 80), at: safeText(event.at, 40),
        before: sanitizeAccount(event.before), after: sanitizeAccount(event.after),
      })) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const target = path.join(this.cwd, 'account-center.json');
        await fs.copyFile(target, `${target}.backup-${Date.now()}`);
        this.warning = '账号设置文件无法读取，已保留备份并使用默认配置。';
      }
    }
    if (!this.store.profiles.length) {
      this.store.profiles.push({ id: 'default', name: '默认 Codex 配置', home: this.defaultHome });
    }
    for (const profile of this.store.profiles) {
      try { profile.home = await fs.realpath(profile.home); } catch { /* Keep missing paths visible for repair. */ }
    }
  }

  snapshot() {
    return { device: os.hostname(), binary: this.binary || this.store.binary || null, warning: this.warning || null,
      profiles: this.store.profiles.map((profile) => ({ id: profile.id, name: profile.name, home: profile.home,
        lastIdentity: profile.lastIdentity || null, lastCheckedAt: profile.lastCheckedAt || null })),
      history: this.store.history };
  }

  async settings() {
    await this.ready;
    return this.snapshot();
  }

  async save() {
    const serialized = JSON.stringify(this.store, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const target = path.join(this.cwd, 'account-center.json');
      await fs.mkdir(this.cwd, { recursive: true });
      await fs.writeFile(target + '.tmp', serialized, { mode: 0o600 });
      await fs.rename(target + '.tmp', target);
    });
    await this.writeQueue;
  }

  async addProfile(home) {
    await this.ready;
    if (this.pending) await this.pending;
    const canonical = await fs.realpath(home);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('请选择 Codex 配置目录。');
    const matches = await Promise.all(['config.toml', 'auth.json', 'sessions'].map(async (name) => {
      try { await fs.access(path.join(canonical, name)); return true; } catch { return false; }
    }));
    if (!matches.some(Boolean)) throw new Error('此目录没有 Codex 配置或日志，请选择实际的 CODEX_HOME 目录。');
    if (this.store.profiles.some((entry) => entry.home.toLowerCase() === canonical.toLowerCase())) {
      throw new Error('该配置目录已接入。');
    }
    if (this.store.profiles.length >= 8) throw new Error('最多接入 8 个本机配置。');
    this.store.profiles.push({ id: randomUUID(), name: `Codex · ${path.basename(canonical)}`, home: canonical });
    await this.save();
    return this.snapshot();
  }

  async updateProfile(id, name, remove = false) {
    await this.ready;
    if (this.pending) await this.pending;
    const profile = this.store.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('配置不存在。');
    if (remove) {
      if (this.store.profiles.length === 1) throw new Error('请至少保留一个配置。');
      this.store.profiles = this.store.profiles.filter((entry) => entry.id !== id);
      this.store.history = this.store.history.filter((entry) => entry.profileId !== id);
    } else {
      if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('名称需为 1–60 个字符。');
      profile.name = name.trim();
    }
    await this.save();
    return this.snapshot();
  }

  async setBinary(binary) {
    await this.ready;
    if (this.pending) await this.pending;
    if (path.basename(binary).toLowerCase() !== 'codex.exe' || !await isFile(binary)) {
      throw new Error('请选择已安装的 codex.exe。');
    }
    this.store.binary = await fs.realpath(binary);
    await this.save();
    return this.snapshot();
  }

  load() {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async collect() {
    await this.ready;
    this.binary = this.store.binary || await this.findBinary(this.userHome);
    // Limit process count on machines with several profiles; the UI stays responsive.
    const results = [];
    for (let index = 0; index < this.store.profiles.length && !this.closed; index += 2) {
      results.push(...await Promise.all(this.store.profiles.slice(index, index + 2).map((profile) => this.readProfile(profile))));
    }
    try { await this.save(); } catch { this.warning = '账号信息已读取，但本机设置保存失败。'; }
    return { ...this.snapshot(), results, fetchedAt: new Date().toISOString() };
  }

  async readProfile(profile) {
    const base = { profileId: profile.id, account: null, usage: null, limits: [], errors: {} };
    if (!this.binary) return { ...base, status: 'error', error: '未检测到 Codex。请安装 Codex，或选择已有的 codex.exe。' };
    try {
      if (!(await fs.stat(profile.home)).isDirectory()) throw new Error('Missing profile');
    } catch { return { ...base, status: 'error', error: '配置目录不存在，请先在 Codex 登录，或接入正确的配置目录。' }; }
    const client = this.clientFactory({ binary: this.binary, profileHome: profile.home, userHome: this.userHome, cwd: this.cwd });
    this.clients.add(client);
    const deadline = setTimeout(() => client.stop(Object.assign(new Error('Timeout'), { code: 'TIMEOUT' })), 45000);
    let phase = 'initialize';
    try {
      await client.start();
      phase = 'account/read';
      const first = sanitizeAccount((await client.read('account/read', { refreshToken: false }))?.account);
      client.accountChanged = false;
      base.account = first;
      if (first?.type === 'chatgpt') {
        phase = 'usage-and-limits';
        const results = await Promise.allSettled([client.read('account/usage/read'), client.read('account/rateLimits/read')]);
        if (results[0].status === 'fulfilled') base.usage = sanitizeUsage(results[0].value);
        else base.errors.usage = publicError(results[0].reason);
        if (results[1].status === 'fulfilled') base.limits = sanitizeLimits(results[1].value);
        else base.errors.limits = publicError(results[1].reason);
      }
      phase = 'account/recheck';
      const final = sanitizeAccount((await client.read('account/read', { refreshToken: false }))?.account);
      if (client.accountChanged || JSON.stringify(first) !== JSON.stringify(final)) {
        return { ...base, account: null, usage: null, limits: [], status: 'error', error: '查询期间账号发生变化，本次数据已丢弃，请重新刷新。' };
      }
      const checkedAt = new Date().toISOString();
      if (profile.lastCheckedAt && JSON.stringify(profile.lastIdentity) !== JSON.stringify(first)) {
        this.store.history.unshift({ profileId: profile.id, at: checkedAt, before: profile.lastIdentity || null, after: first });
        this.store.history = this.store.history.slice(0, 100);
      }
      profile.lastIdentity = first;
      profile.lastCheckedAt = checkedAt;
      return { ...base, status: !first ? 'signed-out' : first.type === 'chatgpt' ? 'connected' : 'unsupported', checkedAt };
    } catch (error) {
      this.onDiagnostic({ phase, code: error.code ?? null, type: error.name });
      return { ...base, account: null, usage: null, limits: [], status: 'error', error: publicError(error) };
    } finally {
      clearTimeout(deadline);
      client.stop();
      this.clients.delete(client);
    }
  }

  stop() {
    this.closed = true;
    for (const client of this.clients) client.stop();
  }
}

module.exports = { AccountService, sanitizeAccount, sanitizeUsage, sanitizeLimits, discoverBinary };
