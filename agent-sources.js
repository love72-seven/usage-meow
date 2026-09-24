const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

// Data directories only: never inspect authentication files or request bodies.
const AGENTS = [
  ['codex', 'Codex', 'CODEX_HOME', ['.codex']],
  ['zcode', 'ZCode', 'ZCODE_HOME', ['.zcode']],
  ['claude', 'Claude Code', 'CLAUDE_CONFIG_DIR', ['.config/claude', '.claude']],
  ['opencode', 'OpenCode', 'OPENCODE_DATA_DIR', ['.local/share/opencode']],
  ['pi', 'pi-agent', 'PI_AGENT_DIR', ['.pi/agent/sessions']],
  ['gemini', 'Gemini CLI', 'GEMINI_DATA_DIR', ['.gemini/tmp']],
  ['kimi', 'Kimi Code', 'KIMI_DATA_DIR', ['.kimi', '.kimi-code']],
  ['qwen', 'Qwen Code', 'QWEN_DATA_DIR', ['.qwen']],
  ['copilot', 'GitHub Copilot CLI', 'COPILOT_HOME', ['.copilot']],
  ['droid', 'Droid', 'DROID_SESSIONS_DIR', ['.factory/sessions']],
  ['amp', 'Amp', 'AMP_DATA_DIR', ['.local/share/amp']],
  ['codebuff', 'Codebuff', 'CODEBUFF_DATA_DIR', ['.config/manicode']],
  ['hermes', 'Hermes Agent', 'HERMES_HOME', ['.hermes']],
  ['goose', 'Goose', 'GOOSE_PATH_ROOT', ['.local/share/goose', 'Library/Application Support/goose', '.local/share/Block/goose']],
  ['openclaw', 'OpenClaw', 'OPENCLAW_DIR', ['.openclaw']],
  ['kilo', 'Kilo', 'KILO_DATA_DIR', ['.local/share/kilo']],
  ['antigravity', 'Antigravity', 'ANTIGRAVITY_DATA_DIR', ['.gemini/antigravity', '.gemini/antigravity-cli', '.gemini/antigravity-ide', '.gemini/antigravity-backup', '.config/antigravity']],
  ['grok', 'Grok Build CLI', 'GROK_HOME', ['.grok']],
].map(([id, name, variable, defaults]) => ({ id, name, variable, defaults }));

class AgentSources {
  constructor({ cwd, userHome = os.homedir(), environment = process.env }) {
    this.cwd = cwd;
    this.userHome = userHome;
    this.environment = environment;
    this.file = path.join(cwd, 'agent-sources-v1.json');
    this.overrides = {};
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  async initialize() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.overrides || typeof saved.overrides !== 'object') throw new Error('Invalid settings');
      for (const [id, home] of Object.entries(saved.overrides)) {
        if (!AGENTS.some((agent) => agent.id === id && id !== 'codex') || typeof home !== 'string' || !path.isAbsolute(home) || home.includes(',')) throw new Error('Invalid directory');
      }
      this.overrides = saved.overrides;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Agent 目录设置无法读取，已保留原文件。');
    }
  }

  async inspect(home, agent) {
    try {
      const canonical = await fs.realpath(home);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) return { home, exists: false, issue: '不是文件夹' };
      if (agent.id === 'zcode') {
        try {
          const database = await fs.stat(path.join(canonical, 'cli/db/db.sqlite'));
          return { home: canonical, exists: database.isFile(), issue: database.isFile() ? null : '缺少用量数据库' };
        } catch { return { home: canonical, exists: false, issue: '缺少 cli/db/db.sqlite' }; }
      }
      return { home: canonical, exists: true, issue: null };
    } catch (error) { return { home, exists: false, issue: error.code === 'ENOENT' ? '目录不存在' : '目录不可读' }; }
  }

  async settings(codexHome) {
    await this.ready;
    const entries = await Promise.all(AGENTS.map(async (agent) => {
      const override = this.overrides[agent.id];
      const inherited = this.environment[agent.variable];
      let directories = override ? [override] : inherited ? inherited.split(',').map((value) => value.trim()).filter(Boolean)
        : agent.defaults.map((relative) => path.join(this.userHome, relative));
      if (!override && !inherited && agent.id === 'opencode' && this.environment.XDG_DATA_HOME) {
        directories = [path.join(this.environment.XDG_DATA_HOME, 'opencode')];
      }
      if (agent.id === 'codex' && codexHome) directories = [codexHome];
      // Explicit empty OpenCode source disables ccusage fallback; retain that meaning.
      if (!override && agent.id === 'opencode' && inherited === '') directories = [];
      const found = await Promise.all(directories.map((directory) => this.inspect(directory, agent)));
      const seen = new Set();
      const roots = found.filter((entry) => {
        const key = process.platform === 'win32' ? entry.home.toLowerCase() : entry.home;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...agent, roots, custom: Boolean(override), inherited: !override && Boolean(inherited),
        note: agent.id === 'zcode' ? '仅统计 completed 的本机用量；不等于 Coding Plan 配额。'
          : agent.id === 'goose' ? '实验性支持。自选根目录须包含 data/sessions/sessions.db。'
            : '目录存在不代表已记录用量；统计以日志读取结果为准。' };
    }));
    const env = Object.fromEntries(AGENTS.filter((agent) => this.overrides[agent.id])
      .map((agent) => [agent.variable, this.overrides[agent.id]]));
    const fingerprint = createHash('sha256').update(JSON.stringify(entries.map((entry) => [entry.id, entry.roots.map((root) => root.home)]))).digest('hex');
    return { entries, env, fingerprint };
  }

  async set(id, home) {
    await this.ready;
    const agent = AGENTS.find((entry) => entry.id === id && id !== 'codex');
    if (!agent) throw new Error('请选择支持的 Agent；Codex 请使用原有统计目录入口。');
    const next = { ...this.overrides };
    if (home === null) delete next[id];
    else {
      if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes(',')) throw new Error('请选择单个绝对目录，路径不能包含逗号。');
      const inspected = await this.inspect(home, agent);
      if (!inspected.exists) throw new Error(inspected.issue);
      next[id] = inspected.home;
    }
    await fs.mkdir(this.cwd, { recursive: true });
    await fs.writeFile(this.file + '.tmp', JSON.stringify({ version: 1, overrides: next }), { mode: 0o600 });
    await fs.rename(this.file + '.tmp', this.file);
    this.overrides = next;
  }
}

module.exports = { AgentSources, AGENTS };
