const { spawn } = require('node:child_process');

const READ_METHODS = new Set(['account/read', 'account/rateLimits/read', 'account/usage/read']);

function publicError(error) {
  if (error.code === 'ENOENT') return '未找到 Codex 程序，请在账号中心选择 codex.exe。';
  if (error.code === 'TIMEOUT') return '连接超时，请检查网络后重试。';
  if (error.code === 'STOPPED') return '查询已结束，请重试。';
  if (error.code === -32601 || /unknown (variant|method)|method not found/i.test(error.message)) {
    return '当前 Codex 版本不支持此接口，请更新 Codex。';
  }
  if (/401|403|unauthorized|not authenticated|not logged|authentication/i.test(error.message)) {
    return '登录已失效或无权查询，请到对应 Codex 客户端检查登录状态。';
  }
  // Never expose backend messages, stderr, tokens or user configuration to logs/UI.
  return 'Codex 查询失败，请检查登录、网络或配置后重试。';
}

function isolatedEnvironment(profileHome, userHome, source = process.env) {
  const environment = {};
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|allusersprofile|http_proxy|https_proxy|all_proxy|no_proxy|lang|lc_all)$/i;
  for (const [key, value] of Object.entries(source)) {
    if (allowed.test(key)) environment[key] = value;
  }
  // This child reads only the selected profile, never parent-session API keys.
  return { ...environment, USERPROFILE: userHome, HOME: userHome, CODEX_HOME: profileHome, NO_COLOR: '1' };
}

class CodexClient {
  constructor({ binary, profileHome, userHome, cwd, spawnProcess = spawn, timeout = 20000 }) {
    this.options = { binary, profileHome, userHome, cwd };
    this.spawnProcess = spawnProcess;
    this.timeout = timeout;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.stopped = false;
    this.accountChanged = false;
  }

  async start() {
    const { binary, profileHome, userHome, cwd } = this.options;
    this.child = this.spawnProcess(binary, ['app-server'], {
      cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: isolatedEnvironment(profileHome, userHome),
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.stop());
    this.child.on('error', (error) => this.stop(error));
    this.child.on('exit', () => this.stop());
    await this.send('initialize', {
      clientInfo: { name: 'usage_meow', title: '用量喵', version: '0.2.0' },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }

  read(method, params = {}) {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error('Read-only client'));
    return this.send(method, params);
  }

  send(method, params) {
    if (this.stopped) return Promise.reject(Object.assign(new Error('Stopped'), { code: 'STOPPED' }));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Timeout'), { code: 'TIMEOUT' }));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) return this.stop(new Error('Response too large'));
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'account/updated') this.accountChanged = true;
      if (message.method && message.id != null) {
        // Refuse server-initiated actions (including auth-token supply and tools).
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only client' } }) + '\n');
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error(message.error.message || 'RPC failed'), { code: message.error.code }));
      else request.resolve(message.result);
    }
  }

  stop(error = Object.assign(new Error('Stopped'), { code: 'STOPPED' })) {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.child?.stdin.destroy();
    this.child?.kill();
  }
}

module.exports = { CodexClient, publicError, isolatedEnvironment };
