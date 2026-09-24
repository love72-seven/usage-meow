const fs = require('node:fs/promises');
const path = require('node:path');

const PROVIDERS = {
  openai: 'OpenAI', anthropic: 'Anthropic / Claude', gemini: 'Google Gemini', deepseek: 'DeepSeek',
  dashscope: '阿里云百炼', qwencloud: 'Qwen Cloud', qwen_ai_platform: '通义千问', zai: 'Z.ai 国际版',
  moonshot: 'Moonshot / Kimi', minimax: 'MiniMax', mistral: 'Mistral', xai: 'xAI / Grok',
  openrouter: 'OpenRouter', azure: 'Azure OpenAI', bedrock: 'Amazon Bedrock', volcengine: '火山引擎',
  tencent: '腾讯', xiaomi_mimo: '小米 MiMo', ollama: 'Ollama（本地）',
};
const safeName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\x00-\x1f]/.test(value);
const identity = (agent, model) => JSON.stringify([agent, model]);

function resolveReference(models, model, provider) {
  if (!provider) return null;
  // Match only a chosen provider and exact model id, ignoring case and ccusage's agent annotation.
  // Do not strip release suffixes, guess similar names, or take a reseller's rate.
  const normalized = model.replace(/^\[[a-z][a-z0-9_-]*\]\s*/i, '').toLowerCase();
  const matches = Object.entries(models).filter(([key, entry]) => {
    if (entry.provider !== provider) return false;
    const short = key.startsWith(provider + '/') ? key.slice(provider.length + 1) : key;
    return key.toLowerCase() === normalized || short.toLowerCase() === normalized;
  });
  return matches.length === 1 ? matches[0][0] : null;
}

class PriceReferences {
  constructor({ cwd, defaultProviders = { zcode: 'zai' } }) {
    this.file = path.join(cwd, 'price-references-v1.json');
    this.store = { version: 1, providers: { ...defaultProviders }, bindings: [] };
    this.observed = new Map();
    this.revision = 0;
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  async initialize() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.providers || !Array.isArray(saved.bindings)
        || saved.bindings.length > 1000 || Object.keys(saved.providers).length > 50
        || !Object.entries(saved.providers).every(([agent, provider]) => /^[a-z][a-z0-9_-]{0,31}$/.test(agent) && safeName(provider))
        || !saved.bindings.every((binding) => /^[a-z][a-z0-9_-]{0,31}$/.test(binding.agent) && safeName(binding.model) && safeName(binding.key))) throw new Error();
      this.store = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('价格参考设置无法读取，已保留原文件。');
    }
  }

  observe(data) {
    let changed = false;
    for (const day of data?.daily || []) for (const agent of day.agents || []) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent.agent)) continue;
      for (const model of agent.modelBreakdowns || []) {
        if (!safeName(model.modelName)) continue;
        const key = identity(agent.agent, model.modelName);
        if (!this.observed.has(key)) {
          this.observed.set(key, { agent: agent.agent, model: model.modelName });
          changed = true;
        }
      }
    }
    return changed;
  }

  resolve(models, agent, model) {
    const binding = this.store.bindings.find((entry) => entry.agent === agent && entry.model === model);
    if (binding) return models[binding.key] ? binding.key : null;
    return resolveReference(models, model, this.store.providers[agent]);
  }

  config(models) {
    const config = {};
    for (const { agent, model } of this.observed.values()) {
      const key = this.resolve(models, agent, model);
      if (!key) continue;
      const prices = { ...models[key].prices };
      if (agent === 'zcode' && models[key].provider === 'zai') prices.cacheCreationInputTokenCost = prices.inputCostPerToken;
      config[agent] ||= { defaults: { pricingOverrides: {} } };
      config[agent].defaults.pricingOverrides[model] = prices;
    }
    return config;
  }

  async set({ agent, provider, model, key }, models) {
    await this.ready;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent) || !['codex','zcode','claude','opencode','pi','gemini','kimi','qwen','copilot','droid','amp','codebuff','hermes','goose','openclaw','kilo','antigravity','grok'].includes(agent)) throw new Error('未知 Agent');
    const next = structuredClone(this.store);
    if (model !== undefined) {
      if (!safeName(model) || (key !== null && !Object.hasOwn(models, key))) throw new Error('请选择日志模型和有效的价格条目。');
      next.bindings = next.bindings.filter((entry) => entry.agent !== agent || entry.model !== model);
      if (key !== null) next.bindings.push({ agent, model, key });
      if (next.bindings.length > 1000) throw new Error('价格匹配数量已达上限。');
    } else {
      if (provider !== '' && !Object.values(models).some((entry) => entry.provider === provider)) throw new Error('未知价格厂商');
      if (provider) next.providers[agent] = provider;
      else delete next.providers[agent];
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await fs.rename(this.file + '.tmp', this.file);
    this.store = next;
    this.revision++;
  }
}

module.exports = { PriceReferences, resolveReference, PROVIDERS };
