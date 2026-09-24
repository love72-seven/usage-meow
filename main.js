const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('node:path');
const { UsageService } = require('./usage-service');
const { UsageSources } = require('./usage-sources');
const { AgentSources, AGENTS } = require('./agent-sources');
const { PricingCatalog } = require('./pricing-catalog');
const { AccountService } = require('./account-service');

app.setName('用量喵');
app.setAppUserModelId('com.local.usage-meow');
const diagnostic = process.argv.includes('--smoke-test');
if (diagnostic && process.env.USAGE_MEOW_TEST_OUTPUT) {
  const diagnosticProfile = path.join(process.env.USAGE_MEOW_TEST_OUTPUT, 'profile');
  require('node:fs').mkdirSync(diagnosticProfile, { recursive: true });
  app.setPath('userData', diagnosticProfile);
}
let service;
let accounts;
let pricing;

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 650,
    show: !diagnostic,
    backgroundColor: '#101923',
    title: '用量喵',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111c27', symbolColor: '#c6d3df', height: 48 },
    icon: path.join(__dirname, 'assets', 'usage-meow-icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !diagnostic,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.whenReady().then(async () => {
    const sources = new UsageSources({ cwd: app.getPath('userData'), userHome: app.getPath('home') });
    const agentSources = new AgentSources({ cwd: app.getPath('userData'), userHome: app.getPath('home') });
    pricing = new PricingCatalog({ cwd: app.getPath('userData'), fetcher: (url, options) => net.fetch(url, options),
      onStatus: (status) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send('pricing:status-changed', status);
        }
      },
    });
    service = new UsageService({
      sources,
      agentSources,
      pricing,
      binary: app.isPackaged
        ? path.join(process.resourcesPath, 'ccusage.exe')
        : path.join(__dirname, 'node_modules/@ccusage/ccusage-win32-x64/bin/ccusage.exe'),
      cwd: app.getPath('userData'),
    });
    accounts = new AccountService({
      cwd: app.getPath('userData'),
      userHome: app.getPath('home'),
      defaultHome: process.env.CODEX_HOME || undefined,
      onDiagnostic: diagnostic ? (detail) => console.log(JSON.stringify(detail)) : undefined,
    });
    const fixtureMode = diagnostic && process.argv.includes('--fixture') && !app.isPackaged;
    if (fixtureMode) {
      const fixture = require('./tests/fixtures.cjs');
      service = fixture.usage;
      accounts.stop();
      accounts = fixture.accounts;
    }
    const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted frame');
      try {
        return { ok: true, value: await action(...args) };
      } catch (error) {
        const messages = new Set([
          '请选择 Codex 配置目录。', '此目录没有 Codex 配置或日志，请选择实际的 CODEX_HOME 目录。',
          '该配置目录已接入。', '最多接入 8 个本机配置。', '配置不存在。', '请至少保留一个配置。',
          '名称需为 1–60 个字符。', '请选择已安装的 codex.exe。',
        ]);
        return { ok: false, error: messages.has(error.message) ? error.message : '操作未完成。请检查所选目录、名称或文件权限后重试。' };
      }
    });
    ipcMain.handle('usage:load', () => service.load());
    ipcMain.handle('usage:cached', () => service.cached());
    ipcMain.handle('pricing:status', async () => { await pricing.ready; return pricing.status(); });
    handle('pricing:query', (query) => pricing.query(query));
    handle('pricing:references', () => pricing.referenceSettings());
    handle('pricing:reference-set', async (value) => {
      if (service.pending) await service.pending;
      return pricing.setReference(value);
    });
    handle('agents:settings', async () => agentSources.settings((await sources.settings()).selected));
    handle('agents:choose', async (id) => {
      const agent = AGENTS.find((entry) => entry.id === id && id !== 'codex');
      if (!agent) throw new Error('未知 Agent');
      const result = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
        title: `选择 ${agent.name} 的日志目录`, properties: ['openDirectory', 'showHiddenFiles'],
      });
      if (result.canceled) return { canceled: true };
      if (service.pending) await service.pending;
      await agentSources.set(id, result.filePaths[0]);
      return { canceled: false };
    });
    handle('agents:reset', async (id) => {
      if (service.pending) await service.pending;
      await agentSources.set(id, null);
      return { canceled: false };
    });
    ipcMain.handle('pricing:sync', async (event) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted frame');
      await pricing.sync({ force: true });
      return pricing.status();
    });
    ipcMain.handle('usage:sources', async () => {
      try { return { ok: true, value: await sources.settings() }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('usage:source-select', async (event, home) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted frame');
      try {
        if (service.pending) throw new Error('正在读取用量，请稍后切换。');
        if (home === null) {
          const result = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
            title: '选择 Codex 日志目录（包含 sessions 文件夹）',
            properties: ['openDirectory', 'showHiddenFiles'],
          });
          if (result.canceled) return { ok: true, value: await sources.settings(), canceled: true };
          home = result.filePaths[0];
        } else {
          const settings = await sources.settings();
          if (!settings.sources.some((source) => source.home === home)) throw new Error('请通过选择目录添加新的数据源。');
        }
        if (service.pending) throw new Error('正在读取用量，请稍后切换。');
        return { ok: true, value: await sources.select(home) };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    handle('accounts:settings', () => accounts.settings());
    handle('accounts:load', () => accounts.load());
    handle('accounts:add', async () => {
      const result = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
        title: '选择实际使用的 Codex 配置目录（通常为 .codex）',
        properties: ['openDirectory', 'showHiddenFiles'],
      });
      return result.canceled ? null : accounts.addProfile(result.filePaths[0]);
    });
    handle('accounts:binary', async () => {
      const result = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
        title: '选择已安装的 codex.exe', properties: ['openFile'], filters: [{ name: 'Codex', extensions: ['exe'] }],
      });
      return result.canceled ? null : accounts.setBinary(result.filePaths[0]);
    });
    handle('accounts:rename', (id, name) => accounts.updateProfile(id, name));
    handle('accounts:remove', (id) => accounts.updateProfile(id, null, true));
    const window = createWindow();
    if (!fixtureMode && !process.argv.includes('--pricing-offline-test')) pricing.start();
    if (diagnostic) {
      try {
        const result = await require('./ui-smoke').runUiSmoke(window, {
          output: process.env.USAGE_MEOW_TEST_OUTPUT,
          fixtureMode,
        });
        service.stop();
        accounts.stop();
        pricing.stop();
        app.exit(result.ok ? 0 : 1);
      } catch (error) {
        console.error(error);
        service.stop();
        accounts.stop();
        pricing.stop();
        app.exit(1);
      }
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('before-quit', () => { service?.stop(); accounts?.stop(); pricing?.stop(); });
  app.on('window-all-closed', () => app.quit());
}
