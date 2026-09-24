const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Source preferences are independent of account authentication and system variables.
class UsageSources {
  constructor({ cwd, userHome = os.homedir(), environment = process.env }) {
    this.file = path.join(cwd, 'usage-source.json');
    this.accountsFile = path.join(cwd, 'account-center.json');
    this.standardHome = path.join(userHome, '.codex');
    this.environment = environment;
    this.selected = null;
    this.ready = this.initialize();
    this.ready.catch(() => {}); // Requests report initialization errors without an unhandled rejection.
  }

  async canonical(home) {
    const absolute = path.resolve(home);
    try { return await fs.realpath(absolute); } catch { return absolute; }
  }

  async hasLogs(home) {
    for (const folder of ['sessions', 'archived_sessions']) {
      try { if ((await fs.stat(path.join(home, folder))).isDirectory()) return true; } catch {}
    }
    return false;
  }

  async initialize() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !path.isAbsolute(saved.home) || saved.home.includes(',')) throw new Error();
      this.selected = await this.canonical(saved.home);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('统计目录设置无法读取，请检查 usage-source.json；未覆盖原设置。');
    }
  }

  async settings() {
    await this.ready;
    const candidates = [{ home: this.standardHome, label: '标准日志目录' }];
    for (const home of (this.environment.CODEX_HOME || '').split(',').map((value) => value.trim()).filter(Boolean)) {
      if (path.isAbsolute(home)) candidates.push({ home, label: '启动环境目录' });
    }
    try {
      const accountSettings = JSON.parse(await fs.readFile(this.accountsFile, 'utf8'));
      for (const profile of accountSettings.profiles || []) {
        if (typeof profile.home === 'string' && path.isAbsolute(profile.home)) {
          candidates.push({ home: profile.home, label: '已接入配置目录' });
        }
      }
    } catch { /* Account settings are optional and are never modified here. */ }
    if (this.selected) candidates.unshift({ home: this.selected, label: '已选目录' });
    const sources = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (candidate.home.includes(',')) continue;
      const home = await this.canonical(candidate.home);
      const key = process.platform === 'win32' ? home.toLowerCase() : home;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ home, label: candidate.label, available: await this.hasLogs(home) });
    }
    // An inherited launcher variable must not silently hide the standard desktop logs.
    const selected = this.selected || sources.find((source) => source.available)?.home || sources[0]?.home;
    return { selected, sources, multiple: sources.filter((source) => source.available).length > 1 };
  }

  async resolve() {
    const settings = await this.settings();
    const source = settings.sources.find((entry) => entry.home === settings.selected);
    if (!source?.available && this.selected) throw new Error('所选 Codex 目录中没有日志文件夹，请切换统计目录。');
    return { home: source.home, multiple: settings.multiple };
  }

  async select(home) {
    await this.ready;
    if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes(',')) {
      throw new Error('请选择单个绝对路径，目录名不能包含逗号。');
    }
    const canonical = await this.canonical(home);
    if (!await this.hasLogs(canonical)) throw new Error('此目录没有 sessions 或 archived_sessions 日志文件夹。');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file + '.tmp', JSON.stringify({ version: 1, home: canonical }), { mode: 0o600 });
    await fs.rename(this.file + '.tmp', this.file);
    this.selected = canonical;
    return this.settings();
  }
}

module.exports = { UsageSources };
