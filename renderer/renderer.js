const $ = (selector) => document.querySelector(selector);
const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Math.round(value));
const formatMoney = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
let loading = false;
let loaded = false;
let latestPayload = null;
let latestSummary = null;
let showAllRecords = false;
let sourceSettings = null;
let sourceChanging = false;
let pricingStatus = null;
let appliedPriceRevision = null;
let repricePending = false;
window.activeView = 'usage';
window.viewStatuses = { usage: '正在准备…', accounts: '正在准备…', prices: '正在准备…' };

const views = {
  usage: { title: '用量概览', description: '本机日志中的消耗与趋势', source: 'ccusage 本机日志 · 成本为估算值' },
  models: { title: '模型明细', description: '按 Agent 和模型查看最近 30 天用量', source: 'ccusage 本机日志 · 历史账号归属未确认' },
  accounts: { title: '账号中心', description: '登录来源、官方统计与剩余额度', source: 'Codex 官方接口 · 与本机日志分开统计' },
  agents: { title: 'Agent 接入', description: '分工具查看用量、日志目录与价格匹配', source: '只读本机日志 · 目录识别不代表已产生用量' },
  prices: { title: '价格目录', description: '多厂商、多渠道公开 API 参考价格', source: 'USD / 百万 Token · 不等于订阅扣费' },
};

window.updateViewStatus = (source, message) => {
  if (message !== undefined) window.viewStatuses[source] = message;
  const currentSource = ['accounts', 'prices'].includes(window.activeView) ? window.activeView : 'usage';
  $('#last-updated').textContent = window.viewStatuses[currentSource];
  $('#refresh').disabled = currentSource === 'accounts' ? Boolean(window.accountsLoading)
    : currentSource === 'prices' ? Boolean(pricingStatus?.syncing) : loading || sourceChanging;
  $('#usage-source').disabled = loading || sourceChanging || !sourceSettings;
  $('#choose-usage-source').disabled = loading || sourceChanging;
};

function switchView(view) {
  if (!views[view]) return;
  window.activeView = view;
  for (const name of Object.keys(views)) {
    $(`#${name}-view`).hidden = name !== view;
    $(`#tab-${name}`).classList.toggle('active', name === view);
    $(`#tab-${name}`).setAttribute('aria-pressed', String(name === view));
  }
  $('#page-title').textContent = views[view].title;
  $('#page-description').textContent = views[view].description;
  $('#data-source').textContent = views[view].source;
  $('#refresh-label').textContent = view === 'accounts' ? '刷新账号' : view === 'prices' ? '同步价格' : '刷新用量';
  $('#usage-sourcebar').hidden = !['usage', 'models'].includes(view);
  window.updateViewStatus();
  window.onViewChanged?.(view);
}
window.showUsageView = switchView;
$('#tab-usage').addEventListener('click', () => switchView('usage'));
$('#tab-models').addEventListener('click', () => switchView('models'));
$('#tab-accounts').addEventListener('click', () => switchView('accounts'));
$('#tab-agents').addEventListener('click', () => switchView('agents'));
$('#tab-prices').addEventListener('click', () => switchView('prices'));
$('#open-agent-center').addEventListener('click', () => switchView('agents'));
window.showAgentModels = (agent) => { switchView('models'); $('#agent-filter').value = agent; renderModels(); };

function renderModels() {
  if (!latestPayload) return;
  const body = $('#model-rows');
  body.replaceChildren();
  const query = $('#model-search').value.trim().toLowerCase();
  const allRows = window.usageModel.breakdown(latestPayload, $('#agent-filter').value);
  const rows = allRows.filter((model) => model.model.toLowerCase().includes(query));
  $('#model-count').textContent = `${rows.length} 条明细`;
  for (const model of rows) {
    const row = body.insertRow();
    for (const value of [model.agent, model.model, formatNumber(model.input), formatNumber(model.output),
      `${formatNumber(model.cacheRead)} / ${formatNumber(model.cacheWrite)}`, model.unpriced ? '未定价' : formatMoney(model.cost)]) {
      row.insertCell().textContent = value;
    }
    row.cells[0].className = 'agent-cell';
  }
  if (!body.children.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 6;
    cell.className = 'empty-cell';
    cell.textContent = query || $('#agent-filter').value ? '没有匹配的模型，请调整搜索或 Agent 筛选。' : '暂无模型明细，运行编码助手后刷新用量。';
  }
}
$('#agent-filter').addEventListener('change', renderModels);
$('#model-search').addEventListener('input', renderModels);

function setState(message, kind = 'loading') {
  $('#state').className = `state visible ${kind}`;
  $('#state-text').textContent = message;
  $('.spinner').style.display = kind === 'loading' ? 'inline-block' : 'none';
  $('#models-state').className = `state visible ${kind}`;
  $('#models-state').textContent = message;
}

function render(payload) {
  latestPayload = payload;
  window.latestUsagePayload = payload;
  const selectedAgent = $('#agent-filter').value;
  $('#agent-filter').replaceChildren(new Option('全部', ''));
  for (const agent of [...new Set(window.usageModel.breakdown(payload).map((row) => row.agent))]) {
    $('#agent-filter').append(new Option(agent, agent));
  }
  $('#agent-filter').value = [...$('#agent-filter').options].some((option) => option.value === selectedAgent) ? selectedAgent : '';
  renderModels();
  const summary = window.usageModel.summarize(payload);
  latestSummary = summary;
  $('#today-cost').textContent = formatMoney(summary.today.cost);
  $('#today-date').textContent = `${summary.today.date} · ${formatNumber(summary.today.tokens)} Token`;
  $('#month-cost').textContent = formatMoney(summary.cost);
  $('#month-tokens').textContent = formatNumber(summary.tokens);
  $('#active-days').textContent = formatNumber(summary.activeDays);
  $('#chart-total').textContent = formatMoney(summary.chart.reduce((sum, row) => sum + row.cost, 0));

  const chart = $('#chart');
  chart.className = 'chart';
  chart.replaceChildren();
  const maximum = Math.max(...summary.chart.map((row) => row.cost), 0.01);
  for (const row of summary.chart) {
    const group = document.createElement('div');
    group.className = 'bar-group';
    group.title = `${row.date} · ${formatMoney(row.cost)}`;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.max(0, row.cost / maximum * 100)}%`;
    if (!row.cost) bar.style.opacity = '0.18';
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = row.date.slice(5);
    track.append(bar);
    group.append(track, label);
    chart.append(group);
  }
  renderRecent();
  window.renderDailyDetail?.();
  window.renderAgentOverview?.();
  return summary;
}

function renderRecent() {
  if (!latestSummary) return;
  const summary = latestSummary;
  const body = $('#recent-rows');
  body.replaceChildren();
  for (const row of showAllRecords ? summary.rows : summary.rows.slice(0, 7)) {
    const tr = document.createElement('tr');
    const dateCell = document.createElement('td');
    const dateButton = document.createElement('button');
    dateButton.className = 'recent-date-button';
    dateButton.type = 'button';
    dateButton.textContent = row.date;
    dateButton.title = `查看 ${row.date} 模型消耗明细`;
    dateButton.addEventListener('click', () => window.selectDailyDetailDate?.(row.date));
    dateCell.append(dateButton);
    tr.append(dateCell);
    for (const value of [formatNumber(row.tokens), formatMoney(row.cost)]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.append(cell);
    }
    body.append(tr);
  }
  if (!summary.rows.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = 'empty-cell';
    cell.textContent = '最近 30 天没有找到本机用量记录';
  }
  $('#show-all-records').textContent = showAllRecords ? '收起记录' : '查看全部';
  $('#show-all-records').setAttribute('aria-expanded', String(showAllRecords));
  $('#show-all-records').disabled = summary.rows.length <= 7;
  $('#recent-description').textContent = showAllRecords ? `最近 30 天，共 ${summary.rows.length} 个日期` : '最近 7 个有记录的日期';
}
$('#show-all-records').addEventListener('click', () => { showAllRecords = !showAllRecords; renderRecent(); });

function renderSources(settings) {
  sourceSettings = settings;
  $('#usage-source').replaceChildren(...settings.sources.map((source) =>
    new Option(`${source.home}（${source.available ? source.label : '暂无日志文件夹'}）`, source.home)));
  $('#usage-source').value = settings.selected;
  $('#usage-source').title = settings.selected;
  $('#source-note').textContent = settings.multiple
    ? '发现多个日志目录。只统计当前所选目录，不合并重复历史；其他 Agent 的统计路径不变。'
    : '仅影响本机 Codex 日志统计，不切换登录账号；其他 Agent 的统计路径不变。';
  window.updateViewStatus();
}

async function changeUsageSource(home) {
  if (loading || sourceChanging) return;
  sourceChanging = true;
  window.updateViewStatus();
  try {
    const result = await window.ccusage.selectSource(home);
    if (!result.ok) throw new Error(result.error);
    renderSources(result.value);
    if (result.canceled) return;
    // Never display one directory's totals beneath another directory's label.
    window.latestUsageReport = null;
    render({ daily: [] });
    for (const id of ['today-cost', 'month-cost', 'month-tokens', 'active-days']) $(`#${id}`).textContent = '—';
    loaded = false;
    await loadUsage();
  } catch (error) {
    if (sourceSettings) renderSources(sourceSettings);
    setState(`切换失败：${error.message}`, 'error');
  } finally {
    sourceChanging = false;
    window.updateViewStatus();
  }
}
$('#usage-source').addEventListener('change', () => changeUsageSource($('#usage-source').value));
$('#choose-usage-source').addEventListener('click', () => changeUsageSource(null));

async function loadUsage() {
  if (loading) return;
  loading = true;
  window.updateViewStatus('usage', '正在刷新…');
  delete document.body.dataset.loaded;
  setState('正在读取本机用量…');
  try {
    const result = await window.ccusage.load();
    if (!result.ok) throw new Error(result.error);
    window.latestUsageReport = result;
    const summary = render(result.data);
    window.onUsageReport?.(result);
    appliedPriceRevision = result.pricing?.revision || null;
    loaded = true;
    window.updateViewStatus('usage', `${new Date(result.updatedAt || Date.now()).toLocaleTimeString('zh-CN')} 已读取日志`);
    if (result.source) {
      $('#usage-source').value = result.source.home;
      $('#usage-source').title = result.source.home;
    }
    if (summary.unpriced.length) {
      setState(`以下模型未计入金额：${summary.unpriced.join('、')}。价格同步成功后会自动重算；未公开或未收录的模型仍显示为未定价。`, 'notice');
    } else {
      $('#state').className = 'state';
      $('#models-state').className = 'state';
    }
    document.body.dataset.loaded = 'success';
  } catch (error) {
    setState(`加载失败：${error.message}${loaded ? '（保留上次成功数据）' : ''}`, 'error');
    document.body.dataset.loaded = 'error';
    window.updateViewStatus('usage', loaded ? '刷新失败，保留上次数据' : '读取失败，请重试');
  } finally {
    loading = false;
    window.updateViewStatus();
    if (repricePending) {
      repricePending = false;
      if (pricingStatus?.revision && appliedPriceRevision !== pricingStatus.revision) void loadUsage();
    }
  }
}

function renderPricing(status) {
  pricingStatus = status;
  const checked = status.checkedAt ? new Date(status.checkedAt).toLocaleString('zh-CN') : '尚未同步';
  const origin = { bundled: '内置快照', cache: '本地缓存', online: '公开价格', none: '暂无价格' }[status.origin] || '价格表';
  $('#pricing-status').textContent = status.syncing ? '正在后台同步模型价格…'
    : status.error || `${origin} · ${status.modelCount} 个条目 · ${checked}`;
  $('#pricing-status').title = `${origin}；上次可用价格时间：${checked}`;
  window.updateViewStatus('prices', status.syncing ? '正在同步价格…' : status.error ? '部分价格源不可用' : `${status.modelCount} 个价格条目`);
  $('#sync-pricing').disabled = status.syncing;
  window.onPriceStatus?.(status);
  $('#pricing-sources').textContent = (status.sources || []).map((source) =>
    `${source.id === 'openai' ? 'OpenAI' : 'LiteLLM'}：${source.checkedAt ? new Date(source.checkedAt).toLocaleString('zh-CN') : '未同步'}${source.ok === false ? '（本次不可用）' : ''}`
  ).join('；');
  if (!status.syncing && status.revision && status.revision !== appliedPriceRevision) {
    if (loading || sourceChanging) repricePending = true;
    else if (loaded) void loadUsage();
  }
}
window.ccusage.onPricingStatus(renderPricing);
window.ccusage.pricingStatus().then(renderPricing).catch(() => { $('#pricing-status').textContent = '价格状态读取失败，可点击重试'; });
$('#sync-pricing').addEventListener('click', async () => {
  $('#sync-pricing').disabled = true;
  try { renderPricing(await window.ccusage.syncPricing()); }
  catch { $('#pricing-status').textContent = '同步失败，请稍后重试'; }
  finally { $('#sync-pricing').disabled = Boolean(pricingStatus?.syncing); }
});

window.reloadUsage = async () => {
  // A settings change may already have triggered repricing through the status event.
  // Wait for that pass before reading the saved settings; never report success mid-refresh.
  while (loading) await new Promise((resolve) => setTimeout(resolve, 50));
  return loadUsage();
};
$('#refresh').addEventListener('click', () => window.activeView === 'accounts' ? window.loadAccounts?.()
  : window.activeView === 'prices' ? $('#sync-pricing').click() : loadUsage());
(async () => {
  try {
    const settings = await window.ccusage.sources();
    if (!settings.ok) throw new Error(settings.error);
    renderSources(settings.value);
    const cache = await window.ccusage.cached();
    if (cache?.ok) {
      window.latestUsageReport = cache;
      render(cache.data);
      loaded = true;
      window.updateViewStatus('usage', `缓存 ${new Date(cache.updatedAt).toLocaleString('zh-CN')}`);
    }
  } catch (error) { setState(error.message, 'error'); }
  finally { loadUsage(); }
})();
setInterval(loadUsage, 5 * 60 * 1000);
