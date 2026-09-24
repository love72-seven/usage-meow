(() => {
  const get = (selector) => document.querySelector(selector);
  const integer = (value) => new Intl.NumberFormat('zh-CN').format(Math.round(value));
  const money = (value) => {
    if (value > 0 && value < 0.000001) return '<$0.000001';
    const digits = value > 0 && value < 0.01 ? 6 : value < 1 ? 4 : 2;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
      minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  };
  const rate = (value) => typeof value === 'number' && Number.isFinite(value)
    ? `${money(value * 1e6)} / 百万` : '未提供单价';
  const text = (tag, content, className) => {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  let selectedDate = null;

  function render() {
    const payload = window.latestUsagePayload;
    if (!payload) return;
    const today = window.usageModel.localDate(new Date());
    const dates = [today, ...window.usageModel.summarize(payload).rows.map((row) => row.date)
      .filter((date) => date !== today)];
    const picker = get('#daily-detail-date');
    if (!dates.includes(selectedDate)) selectedDate = today;
    picker.replaceChildren(...dates.map((date) => new Option(date === today ? `今天 · ${date}` : date, date)));
    picker.value = selectedDate;
    get('#daily-detail-title').textContent = selectedDate === today ? '今天消耗明细' : `${selectedDate} 消耗明细`;

    const rows = window.usageModel.dailyBreakdown(payload, selectedDate);
    const unitPrices = window.latestUsageReport?.unitPrices || {};
    const host = get('#daily-detail-rows');
    host.replaceChildren();
    const tokenCount = rows.reduce((sum, row) => sum + row.tokens, 0);
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    const missing = rows.filter((row) => row.unpriced).length;
    get('#daily-detail-summary').textContent = rows.length
      ? `${rows.length} 个 Agent / 模型组合 · ${integer(tokenCount)} Token · ${money(cost)} 已估算${missing ? ` · ${missing} 项含未定价用量` : ''}`
      : `${selectedDate} · 暂无模型级用量`;

    for (const row of rows) {
      const item = document.createElement('article');
      item.className = 'daily-model';
      const heading = document.createElement('div');
      heading.className = 'daily-model-heading';
      const identity = document.createElement('div');
      identity.className = 'daily-model-identity';
      identity.append(text('span', row.agent, 'daily-agent'), text('strong', row.model, 'daily-model-name'));
      const total = document.createElement('div');
      total.className = 'daily-model-total';
      total.append(text('span', '该模型当日估算', 'daily-total-label'),
        text('strong', row.unpriced ? row.cost ? `${money(row.cost)} 已计` : '未定价' : money(row.cost)));
      heading.append(identity, total);
      item.append(heading);

      const reference = unitPrices[JSON.stringify([row.agent, row.model])];
      const buckets = [
        ['输入', row.input, 'inputCostPerToken'],
        ['输出', row.output, 'outputCostPerToken'],
        ['缓存读', row.cacheRead, 'cacheReadInputTokenCost'],
        ['缓存写', row.cacheWrite, 'cacheCreationInputTokenCost'],
      ];
      const grid = document.createElement('div');
      grid.className = 'daily-token-grid';
      for (const [label, tokens, priceKey] of buckets) {
        const cell = document.createElement('div');
        cell.className = 'daily-token-cell';
        cell.append(text('span', label, 'daily-token-label'), text('strong', `${integer(tokens)} Token`),
          text('small', rate(reference?.prices?.[priceKey])));
        grid.append(cell);
      }
      item.append(grid);
      const caption = reference
        ? `参考价：${reference.provider} · ${reference.key} · ${reference.source === 'openai' ? 'OpenAI 官方' : 'LiteLLM 公开价格表'}${reference.match === 'agent' ? ' · Agent 已匹配' : ' · 模型名匹配'}${reference.checkedAt ? ` · ${reference.checkedAt.slice(0, 10)}` : ''}`
        : '单价未匹配价格目录；可在“价格目录”为该 Agent / 模型选择参考价。';
      item.append(text('p', `${integer(row.tokens)} Token 合计 · ${caption}`, 'daily-model-caption'));
      host.append(item);
    }
    if (!rows.length) host.append(text('p', '当天尚无可显示的模型记录。运行编码助手后刷新用量，或在右上角选择其他日期。', 'daily-detail-empty'));
  }

  get('#daily-detail-date').addEventListener('change', (event) => {
    selectedDate = event.target.value;
    render();
  });
  window.selectDailyDetailDate = (date) => {
    selectedDate = date;
    render();
    get('#daily-detail-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  window.renderDailyDetail = render;
})();
