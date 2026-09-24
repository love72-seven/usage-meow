const fs = require('node:fs/promises');
const path = require('node:path');
const { PriceReferences, PROVIDERS } = require('./pricing-resolver');

const SOURCES = {
  openai: 'https://developers.openai.com/api/docs/pricing.md',
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
};
const HOUR = 60 * 60 * 1000;
const RATE_FIELDS = {
  input_cost_per_token: 'inputCostPerToken',
  output_cost_per_token: 'outputCostPerToken',
  cache_read_input_token_cost: 'cacheReadInputTokenCost',
  cache_creation_input_token_cost: 'cacheCreationInputTokenCost',
  input_cost_per_token_above_200k_tokens: 'inputCostPerTokenAbove200kTokens',
  output_cost_per_token_above_200k_tokens: 'outputCostPerTokenAbove200kTokens',
  cache_read_input_token_cost_above_200k_tokens: 'cacheReadInputTokenCostAbove200kTokens',
  cache_creation_input_token_cost_above_200k_tokens: 'cacheCreationInputTokenCostAbove200kTokens',
};
const rate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const modelName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\r\n\x00]/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);

function parseLiteLLM(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('价格表格式不正确');
  const models = Object.create(null);
  for (const [name, entry] of Object.entries(raw).slice(0, 30000)) {
    if (!modelName(name) || !entry || typeof entry !== 'object' || !['chat', 'completion'].includes(entry.mode)) continue;
    if (!rate(entry.input_cost_per_token) || !rate(entry.output_cost_per_token)) continue;
    const prices = {};
    for (const [source, target] of Object.entries(RATE_FIELDS)) {
      if (rate(entry[source])) prices[target] = entry[source];
    }
    if (Number.isSafeInteger(entry.max_input_tokens) && entry.max_input_tokens > 0) prices.maxInputTokens = entry.max_input_tokens;
    const inputRatio = entry.input_cost_per_token_priority / entry.input_cost_per_token;
    const outputRatio = entry.output_cost_per_token_priority / entry.output_cost_per_token;
    if (Number.isFinite(inputRatio) && inputRatio >= 1 && inputRatio <= 10 && Math.abs(inputRatio - outputRatio) < 0.000001) {
      prices.fastMultiplier = inputRatio;
    }
    models[name] = { prices, provider: String(entry.litellm_provider || '').slice(0, 100), source: 'litellm',
      specialTiers: Object.keys(entry).some((key) => /above_(?!200k)\d+k_tokens/.test(key)) };
  }
  if (!Object.keys(models).length) throw new Error('公开价格表没有有效文本模型');
  return models;
}

function parseOpenAI(text) {
  // Only accept the explicitly labelled Standard table. Never confuse Batch/Flex discounts.
  const standard = text.split('### Standard pricing data')[1]?.split(/\r?\n\s*\r?\n/)[1];
  if (!standard?.includes('| Short context input |')) throw new Error('官方价格表结构已变化');
  const models = Object.create(null);
  for (const line of standard.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 9) continue;
    const name = cells[0].replace(/ \(<\d+K context length\)$/, '');
    if (!/^(gpt-|o\d|chatgpt-)[a-z0-9.-]+$/.test(name)) continue;
    const values = cells.slice(1).map((cell) => /^\$\d+(\.\d+)?$/.test(cell) ? Number(cell.slice(1)) / 1e6 : null);
    if (!rate(values[0]) || !rate(values[3])) continue;
    const prices = { inputCostPerToken: values[0], outputCostPerToken: values[3] };
    if (rate(values[1])) prices.cacheReadInputTokenCost = values[1];
    if (rate(values[2])) prices.cacheCreationInputTokenCost = values[2];
    models[name] = { prices, provider: 'openai', source: 'openai', specialTiers: values.slice(4).some(rate) };
  }
  if (!Object.keys(models).length) throw new Error('官方价格表没有可识别模型');
  return models;
}

function validSnapshot(value) {
  if (value?.version !== 1 || !Number.isFinite(Date.parse(value.checkedAt)) || !value.models || Array.isArray(value.models)) return false;
  const entries = Object.entries(value.models);
  if (!entries.length || entries.length > 30000) return false;
  return entries.every(([name, entry]) => modelName(name) && entry && Object.values(SOURCES).includes(entry.url)
    && rate(entry.prices?.inputCostPerToken) && rate(entry.prices?.outputCostPerToken)
    && Object.entries(entry.prices).every(([key, value]) => Object.values(RATE_FIELDS).includes(key) ? rate(value)
      : key === 'maxInputTokens' ? Number.isSafeInteger(value) && value > 0
        : key === 'fastMultiplier' && typeof value === 'number' && value >= 1 && value <= 10));
}

class PricingCatalog {
  constructor({ cwd, seedPath = path.join(__dirname, 'pricing-seed.json'), fetcher = globalThis.fetch,
    now = Date.now, onStatus = () => {}, timeout = 15000 }) {
    this.cwd = cwd;
    this.seedPath = seedPath;
    this.fetcher = fetcher;
    this.now = now;
    this.onStatus = onStatus;
    this.timeout = timeout;
    this.file = path.join(cwd, 'pricing-catalog-v1.json');
    this.snapshot = null;
    this.pending = null;
    this.closed = false;
    this.controllers = new Set();
    this.lastAttempt = 0;
    this.attemptedMissing = new Set();
    this.lastError = null;
    this.origin = 'none';
    this.references = new PriceReferences({ cwd });
    this.ready = Promise.all([this.initialize(), this.references.ready]).then(() => {});
    this.ready.catch(() => {});
  }

  async initialize() {
    for (const [file, origin] of [[this.file, 'cache'], [this.seedPath, 'bundled']]) {
      try {
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!validSnapshot(value)) continue;
        this.snapshot = value;
        this.origin = origin;
        return;
      } catch { /* A damaged snapshot must not disable usage collection. */ }
    }
  }

  status() {
    return { syncing: Boolean(this.pending), origin: this.origin, checkedAt: this.snapshot?.checkedAt || null,
      revision: this.snapshot ? `${this.snapshot.revision}:${this.references.revision}` : null, modelCount: Object.keys(this.snapshot?.models || {}).length,
      error: this.lastError, sources: this.snapshot?.sources || [], intervalMinutes: 60 };
  }

  publish() {
    if (this.closed) return;
    try { this.onStatus(this.status()); } catch { /* A closing renderer must not cancel persistence. */ }
  }

  async download(url) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('价格表过大');
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 8 * 1024 * 1024) throw new Error('价格表过大');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  sync({ force = false, missing = [] } = {}) {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve(this.status());
    const retryDelay = force ? 5000 : 15 * 60 * 1000;
    if (this.lastAttempt && this.now() - this.lastAttempt < retryDelay) return Promise.resolve(this.status());
    this.lastAttempt = this.now();
    for (const model of missing) this.attemptedMissing.add(model);
    this.pending = this.update().finally(() => { this.pending = null; this.publish(); });
    this.publish();
    return this.pending;
  }

  async update() {
    await this.ready;
    const checkedAt = new Date(this.now()).toISOString();
    const results = await Promise.allSettled(Object.entries(SOURCES).map(async ([id, url]) => {
      const text = await this.download(url);
      return { id, url, models: id === 'openai' ? parseOpenAI(text) : parseLiteLLM(text) };
    }));
    if (this.closed) return this.status();
    const successful = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (!successful.length) {
      this.lastError = '价格同步失败，继续使用上次有效价格；请检查网络后重试。';
      return this.status();
    }
    const models = { ...(this.snapshot?.models || {}) };
    // A successful official source wins conflicts. Unavailable sources retain their last validated entries.
    for (const result of successful.sort((a, b) => (a.id === 'openai') - (b.id === 'openai'))) {
      for (const [name, entry] of Object.entries(result.models)) {
        if (result.id === 'litellm' && models[name]?.source === 'openai'
          && !successful.some((source) => source.id === 'openai')) continue;
        const previous = models[name];
        models[name] = { ...entry, prices: { ...(previous?.prices || {}), ...entry.prices }, url: result.url, checkedAt };
      }
    }
    const snapshot = { version: 1, checkedAt, revision: String(this.now()), models,
      sources: Object.entries(SOURCES).map(([id, url]) => ({ id, url,
        checkedAt: successful.some((source) => source.id === id) ? checkedAt : this.snapshot?.sources?.find((source) => source.id === id)?.checkedAt || null,
        ok: successful.some((source) => source.id === id) })) };
    if (!validSnapshot(snapshot)) {
      this.lastError = '价格数据未通过校验，已保留旧价格。';
      return this.status();
    }
    try {
      await fs.mkdir(this.cwd, { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(snapshot), { mode: 0o600 });
      await fs.rename(this.file + '.tmp', this.file);
      this.snapshot = snapshot;
      this.origin = 'online';
      this.lastError = successful.length === Object.keys(SOURCES).length ? null : '部分价格源不可用，已保留该来源的旧价格。';
    } catch { this.lastError = '价格缓存无法保存，已保留旧价格。'; }
    return this.status();
  }

  async prepare(agent = null, frozenSnapshot = null) {
    await this.ready;
    const snapshot = frozenSnapshot || this.snapshot;
    const status = { ...this.status(), revision: snapshot ? `${snapshot.revision}:${this.references.revision}` : null };
    if (!snapshot) return { status, config: null, snapshot };
    const overrides = Object.fromEntries(Object.entries(snapshot.models).map(([name, entry]) => [name, entry.prices]));
    if (agent) Object.assign(overrides, this.references.config(snapshot.models)[agent]?.defaults.pricingOverrides || {});
    const config = path.join(this.cwd, 'pricing-runtime.json');
    await fs.mkdir(this.cwd, { recursive: true });
    await fs.writeFile(config + '.tmp', JSON.stringify({ defaults: { pricingOverrides: overrides } }), { mode: 0o600 });
    await fs.rename(config + '.tmp', config);
    return { status, config, snapshot };
  }

  observeMissing(models = []) {
    const unseen = models.filter((model) => modelName(model) && !this.attemptedMissing.has(model));
    if (unseen.length) void this.sync({ missing: unseen });
  }

  observeUsage(data) {
    const before = JSON.stringify(this.references.config(this.snapshot?.models || {}));
    this.references.observe(data);
    return before !== JSON.stringify(this.references.config(this.snapshot?.models || {}));
  }

  scopedAgents(data, snapshot = this.snapshot) {
    const present = new Set((data.daily || []).flatMap((day) => (day.agents || []).map((entry) => entry.agent)));
    return Object.keys(this.references.config(snapshot?.models || {})).filter((agent) => present.has(agent));
  }

  unitPrices(data, snapshot = this.snapshot) {
    const models = snapshot?.models || {};
    const results = Object.create(null);
    const providers = this.references.store.providers;
    const bindings = this.references.store.bindings;
    for (const day of data.daily || []) for (const agent of day.agents || []) {
      for (const model of agent.modelBreakdowns || []) {
        const agentName = agent.agent;
        const modelName = model.modelName;
        if (typeof agentName !== 'string' || typeof modelName !== 'string') continue;
        const identity = JSON.stringify([agentName, modelName]);
        if (results[identity]) continue;
        const channelSelected = Boolean(providers[agentName])
          || bindings.some((entry) => entry.agent === agentName && entry.model === modelName);
        const reference = this.references.resolve(models, agentName, modelName);
        const key = reference || (!channelSelected && Object.hasOwn(models, modelName) ? modelName : null);
        if (!key) continue;
        const entry = models[key];
        const prices = { ...entry.prices };
        if (agentName === 'zcode' && entry.provider === 'zai') {
          prices.cacheCreationInputTokenCost = prices.inputCostPerToken;
        }
        results[identity] = { key, provider: PROVIDERS[entry.provider] || entry.provider,
          source: entry.source, url: entry.url, checkedAt: entry.checkedAt,
          specialTiers: entry.specialTiers, prices, match: reference ? 'agent' : 'catalog' };
      }
    }
    return results;
  }

  async referenceSettings() {
    await this.ready;
    return { ...this.references.store, observed: [...this.references.observed.values()].map((entry) => ({ ...entry,
      key: this.references.resolve(this.snapshot?.models || {}, entry.agent, entry.model) })) };
  }

  async setReference(value) {
    await this.ready;
    await this.references.set(value, this.snapshot?.models || {});
    this.publish();
    return this.referenceSettings();
  }

  async query({ provider = '', search = '', page = 0 } = {}) {
    await this.ready;
    const query = String(search).slice(0, 150).trim().toLowerCase();
    const counts = Object.create(null);
    let entries = Object.entries(this.snapshot?.models || {});
    for (const [, entry] of entries) counts[entry.provider] = (counts[entry.provider] || 0) + 1;
    const providers = Object.entries(counts).map(([id, count]) => ({ id, name: PROVIDERS[id] || id, count })).sort((a, b) => a.name.localeCompare(b.name));
    entries = entries.filter(([key, entry]) => (!provider || entry.provider === provider)
      && (!query || `${key} ${entry.provider} ${PROVIDERS[entry.provider] || ''}`.toLowerCase().includes(query)))
      .sort(([a], [b]) => a.localeCompare(b));
    const total = entries.length;
    const currentPage = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, Math.max(0, Math.ceil(total / 50) - 1)));
    return { providers, total, page: currentPage, pages: Math.ceil(total / 50),
      rows: entries.slice(currentPage * 50, (currentPage + 1) * 50).map(([key, entry]) => ({ key, provider: entry.provider,
        providerName: PROVIDERS[entry.provider] || entry.provider, prices: entry.prices, source: entry.source, url: entry.url,
        checkedAt: entry.checkedAt, specialTiers: entry.specialTiers })) };
  }

  start() {
    void this.ready.then(() => this.sync());
    this.timer = setInterval(() => { void this.sync(); }, HOUR);
    this.timer.unref?.();
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
  }
}

module.exports = { PricingCatalog, parseLiteLLM, parseOpenAI, validSnapshot, SOURCES };
