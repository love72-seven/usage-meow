const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { replaceAgentReport } = require('./report-merge');

class UsageService {
  constructor({ binary, cwd, sources = null, agentSources = null, pricing = null, execute = execFile, timeout = 120000 }) {
    Object.assign(this, { binary, cwd, sources, agentSources, pricing, execute, timeout });
    this.pending = null;
    this.child = null;
    this.stopped = false;
    this.cachePath = path.join(cwd, 'usage-cache-v2.json');
  }

  async cached() {
    try {
      const cached = JSON.parse(await fs.readFile(this.cachePath, 'utf8'));
      if (!Array.isArray(cached.data?.daily) || !cached.updatedAt) return null;
      const source = this.sources ? await this.sources.resolve() : null;
      if (source && cached.source?.home !== source.home) return null;
      if (this.agentSources && cached.agentFingerprint !== (await this.agentSources.settings(source?.home)).fingerprint) return null;
      this.pricing?.observeUsage?.(cached.data);
      return { ...cached, ok: true, cached: true };
    } catch { return null; }
  }

  load() {
    if (this.pending) return this.pending;
    this.pending = this.collect().catch((error) => ({ ok: false, error: error.message }))
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  read(source, agents, prices, timezone) {
    if (this.stopped) return Promise.reject(new Error('用量读取已停止。'));
    return new Promise((resolve, reject) => {
      this.child = this.execute(this.binary, [
        'daily', '--json', '--last', '30', '--by-agent', '--offline', '--timezone', timezone,
        ...(prices?.config ? ['--config', prices.config] : []),
      ], {
        cwd: this.cwd, windowsHide: true, timeout: this.timeout,
        maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, ...(agents?.env || {}), ...(source ? { CODEX_HOME: source.home } : {}), NO_COLOR: '1', LOG_LEVEL: '0' },
      }, (error, stdout, stderr) => {
        this.child = null;
        if (error) {
          reject(new Error(error.killed ? '读取超过两分钟，请稍后重试。'
            : error.code === 'ENOENT' ? '缺少内置用量读取程序，请重新安装完整应用。'
              : (stderr?.trim() || error.message).slice(0, 1500)));
          return;
        }
        try {
          const data = JSON.parse(stdout.replace(/^\uFEFF/, ''));
          if (!Array.isArray(data.daily)) throw new Error('用量数据格式不正确');
          resolve(data);
        } catch (error) { reject(new Error(`无法解析用量数据：${error.message}`)); }
      });
    });
  }

  async collect() {
    const startedAt = Date.now();
    const source = this.sources ? await this.sources.resolve() : null;
    const agents = this.agentSources ? await this.agentSources.settings(source?.home) : null;
    await fs.mkdir(this.cwd, { recursive: true });
    const prices = this.pricing ? await this.pricing.prepare() : null;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let data = await this.read(source, agents, prices, timezone);
    this.pricing?.observeUsage?.(data);
    // Unified ccusage ignores agent-local pricing defaults. Isolate each explicit reference in a
    // separate pass, and take ONLY that agent's normalized rows. Never apply its rate to its peers.
    for (const agent of this.pricing?.scopedAgents?.(data, prices?.snapshot) || []) {
      const scopedPrices = await this.pricing.prepare(agent, prices.snapshot);
      const report = await this.read(source, agents, scopedPrices, timezone);
      data = replaceAgentReport(data, agent, report);
    }
    const result = { ok: true, data, source, agents: agents?.entries || [], agentFingerprint: agents?.fingerprint || null,
      pricing: prices?.status || null, timezone, updatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt };
    this.pricing?.observeMissing(data.totals?.unpricedModels);
    try {
      await fs.writeFile(this.cachePath + '.tmp', JSON.stringify(result), { mode: 0o600 });
      await fs.rename(this.cachePath + '.tmp', this.cachePath);
    } catch { /* An unwritable cache must not discard a successful report. */ }
    return result;
  }

  stop() { this.stopped = true; this.child?.kill(); }
}

module.exports = { UsageService };
