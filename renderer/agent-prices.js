(() => {
  const get = (selector) => document.querySelector(selector);
  const integer = (value) => new Intl.NumberFormat('zh-CN').format(Math.round(value));
  const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
  const perMillion = (value) => typeof value === 'number' ? money(value * 1e6) : '—';
  let agentSettings = { entries: [] };
  let references = { providers: {}, bindings: [] };
  let providers = [];
  let pricePage = 0;
  let catalogueSequence = 0;
  let settingsSequence = 0;
  let selectedPrice = null;
  let busy = false;

  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (label, action, className = 'text-button') => {
    const node = element('button', label, className);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const unwrap = (result) => { if (!result.ok) throw new Error(result.error); return result.value; };
  const stats = () => window.latestUsagePayload ? window.usageModel.agents(window.latestUsagePayload) : [];
  const message = (id, text, error = false) => {
    const node = get(id);
    node.className = text ? `state visible ${error ? 'error' : 'notice'}` : 'state';
    node.textContent = text;
  };

  window.renderAgentOverview = () => {
    const host = get('#agent-overview-rows');
    host.replaceChildren();
    const rows = stats();
    for (const row of rows) {
      const name = agentSettings.entries.find((entry) => entry.id === row.id)?.name || row.id;
      const item = button('', () => window.showAgentModels(row.id), 'agent-overview-item');
      item.append(element('strong', name), element('span', `${integer(row.tokens)} Token`),
        element('span', row.missing.length ? `缺价 ${row.missing.length} 个模型` : `${money(row.cost)} 估算`, row.missing.length ? 'warning-text' : 'muted'));
      host.append(item);
    }
    if (!rows.length) host.append(element('p', '近 30 天暂无已读取的 Agent 用量', 'muted'));
  };

  async function runChange(action, target = '#agents-message') {
    if (busy) return;
    busy = true;
    message(target, '正在更新设置并重新读取用量…');
    try {
      const result = unwrap(await action());
      if (result?.canceled) { message(target, ''); return; }
      await window.reloadUsage();
      await loadSettings();
      if (document.body.dataset.loaded !== 'success') throw new Error('设置已保存，但用量读取失败，请到概览查看错误后重试。');
      message(target, '设置已保存，已重新读取用量；实际价格仍以提供方账单为准。');
    } catch (error) { message(target, error.message, true); }
    finally { busy = false; }
  }

  function renderAgents() {
    const rows = stats();
    get('#agents-summary').textContent = `${rows.length} 个 Agent 有近 30 天记录 / ${agentSettings.entries.length} 种接入类型`;
    const host = get('#agent-cards');
    host.replaceChildren();
    const entries = [...agentSettings.entries].sort((a, b) => Number(rows.some((row) => row.id === b.id)) - Number(rows.some((row) => row.id === a.id)) || a.name.localeCompare(b.name));
    for (const agent of entries) {
      const row = rows.find((value) => value.id === agent.id);
      const found = agent.roots.some((root) => root.exists);
      const card = element('article', undefined, 'panel agent-card');
      card.dataset.agent = agent.id;
      const heading = element('div', undefined, 'panel-heading');
      heading.append(element('h2', agent.name), element('span', row ? row.missing.length ? '已统计 · 有缺价' : '已统计' : found ? '目录存在 · 暂无记录' : '未发现可用目录', row?.missing.length ? 'warning-text' : 'muted'));
      const values = element('div', undefined, 'agent-statline');
      values.append(element('span', `今日 ${integer(row?.todayTokens || 0)} Token`), element('span', `30 天 ${integer(row?.tokens || 0)} Token`), element('span', row?.missing.length ? `${money(row.cost)}（仅已定价部分）` : `${money(row?.cost || 0)} 估算`));
      card.append(heading, values);
      if (row?.missing.length) card.append(element('p', `未定价：${row.missing.join('、')}`, 'warning-text'));
      const details = element('details', undefined, 'agent-paths');
      details.append(element('summary', `${agent.custom ? '已手动选择' : agent.inherited ? '启动环境目录' : '默认目录'} · ${agent.variable}`));
      for (const root of agent.roots) details.append(element('p', `${root.home}${root.issue ? `（${root.issue}）` : ''}`));
      details.append(element('p', agent.note));
      card.append(details);
      const controls = element('div', undefined, 'agent-actions');
      if (agent.id === 'codex') controls.append(button('选择统计目录', () => { window.showUsageView('usage'); get('#choose-usage-source').click(); }));
      else {
        controls.append(button('选择日志目录', () => runChange(() => window.ccusage.chooseAgentDirectory(agent.id))));
        if (agent.custom) controls.append(button('恢复自动发现', () => runChange(() => window.ccusage.resetAgentDirectory(agent.id))));
      }
      if (row) controls.append(button('查看模型用量', () => window.showAgentModels(agent.id)));
      card.append(controls);
      const label = element('label', '参考价厂商 ', 'agent-provider');
      const dropdown = document.createElement('select');
      dropdown.setAttribute('aria-label', `${agent.name} 参考价厂商`);
      dropdown.append(new Option('不指定（使用原有价格匹配）', ''));
      for (const provider of providers) dropdown.append(new Option(provider.name, provider.id));
      dropdown.value = references.providers[agent.id] || '';
      dropdown.addEventListener('change', () => runChange(() => window.ccusage.setPriceReference({ agent: agent.id, provider: dropdown.value })));
      label.append(dropdown);
      card.append(label, element('p', '仅在所选厂商内精确匹配模型，不切换 API、不推断登录或订阅。', 'profile-help'));
      host.append(card);
    }
    window.renderAgentOverview();
    const previous = get('#binding-model').value;
    get('#binding-model').replaceChildren(new Option('选择日志中的 Agent / 模型', ''));
    for (const row of window.latestUsagePayload ? window.usageModel.breakdown(window.latestUsagePayload) : []) {
      get('#binding-model').append(new Option(`${row.agent} / ${row.model}${row.unpriced ? '（未定价）' : ''}`, JSON.stringify({ agent: row.agent, model: row.model })));
    }
    if ([...get('#binding-model').options].some((option) => option.value === previous)) get('#binding-model').value = previous;
    updateBinding();
  }

  async function loadSettings() {
    const sequence = ++settingsSequence;
    const [sources, saved, directory] = await Promise.all([window.ccusage.agentSettings(), window.ccusage.priceReferences(), window.ccusage.priceQuery({})]);
    if (sequence !== settingsSequence) return;
    agentSettings = unwrap(sources);
    references = unwrap(saved);
    providers = unwrap(directory).providers;
    const selected = get('#price-provider').value;
    get('#price-provider').replaceChildren(new Option('全部厂商 / 渠道', ''));
    for (const provider of providers) get('#price-provider').append(new Option(`${provider.name} (${provider.count})`, provider.id));
    get('#price-provider').value = selected;
    renderAgents();
  }

  function updateBinding() {
    get('#apply-price-binding').disabled = !selectedPrice || !get('#binding-model').value;
    get('#binding-choice').textContent = selectedPrice ? `已选：${selectedPrice}` : '再从下方目录选择价格条目';
  }

  async function loadPrices() {
    const sequence = ++catalogueSequence;
    try {
      const result = unwrap(await window.ccusage.priceQuery({ provider: get('#price-provider').value, search: get('#price-search').value, page: pricePage }));
      if (sequence !== catalogueSequence) return;
      pricePage = result.page;
      get('#price-count').textContent = `${result.total} 个价格条目`;
      get('#price-page').textContent = result.pages ? `${result.page + 1} / ${result.pages} 页` : '无匹配结果';
      get('#price-prev').disabled = result.page === 0;
      get('#price-next').disabled = result.page + 1 >= result.pages;
      const body = get('#price-rows');
      body.replaceChildren();
      for (const row of result.rows) {
        const tr = body.insertRow();
        tr.insertCell().textContent = row.providerName;
        const model = tr.insertCell();
        model.textContent = row.key;
        model.className = 'price-model-name';
        model.title = `${row.url}\n${row.checkedAt || ''}${row.specialTiers ? '\n另有特殊上下文计费分档' : ''}`;
        for (const field of ['inputCostPerToken', 'outputCostPerToken', 'cacheReadInputTokenCost']) tr.insertCell().textContent = perMillion(row.prices[field]);
        const action = tr.insertCell();
        action.append(element('span', row.source === 'openai' ? 'OpenAI 官方' : 'LiteLLM', 'muted'), button('选择参考价', () => { selectedPrice = row.key; updateBinding(); }));
      }
      if (!result.rows.length) { const cell = body.insertRow().insertCell(); cell.colSpan = 6; cell.className = 'empty-cell'; cell.textContent = '没有匹配的价格条目'; }
    } catch (error) { message('#prices-message', error.message, true); }
  }

  get('#binding-model').addEventListener('change', updateBinding);
  get('#apply-price-binding').addEventListener('click', () => {
    const raw = get('#binding-model').value;
    if (raw && selectedPrice) void runChange(() => window.ccusage.setPriceReference({ ...JSON.parse(raw), key: selectedPrice }), '#prices-message');
  });
  get('#clear-price-binding').addEventListener('click', () => {
    const raw = get('#binding-model').value;
    if (raw) void runChange(() => window.ccusage.setPriceReference({ ...JSON.parse(raw), key: null }), '#prices-message');
  });
  let searchTimer;
  get('#price-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { pricePage = 0; void loadPrices(); }, 180); });
  get('#price-provider').addEventListener('change', () => { pricePage = 0; void loadPrices(); });
  get('#price-prev').addEventListener('click', () => { pricePage--; void loadPrices(); });
  get('#price-next').addEventListener('click', () => { pricePage++; void loadPrices(); });
  window.onUsageReport = () => { void loadSettings().catch((error) => message('#agents-message', error.message, true)); };
  window.onViewChanged = (view) => { if (view === 'prices') void loadPrices(); };
  window.onPriceStatus = (status) => {
    if (!status.syncing) {
      void loadSettings().catch((error) => message('#agents-message', error.message, true));
      if (window.activeView === 'prices') void loadPrices();
    }
  };
  void loadSettings().then(loadPrices).catch((error) => message('#agents-message', error.message, true));
})();
