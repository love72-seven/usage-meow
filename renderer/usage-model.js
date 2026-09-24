(function (root) {
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function summarize(payload, now = new Date()) {
    if (!Array.isArray(payload?.daily)) throw new Error('未识别的用量数据格式');
    const dates = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(now);
      date.setDate(now.getDate() - index);
      return localDate(date);
    });
    const days = new Map();
    for (const row of payload.daily) {
      const date = row?.date ?? row?.period;
      if (!dates.includes(date)) continue;
      const tokens = row.totalTokens == null
        ? ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].reduce((sum, key) => sum + number(row[key]), 0)
        : number(row.totalTokens);
      const existing = days.get(date) || { date, cost: 0, tokens: 0 };
      existing.cost += number(row.totalCost ?? row.costUSD);
      existing.tokens += tokens;
      days.set(date, existing);
    }
    const rows = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
    return {
      rows,
      today: days.get(dates[0]) || { date: dates[0], cost: 0, tokens: 0 },
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      activeDays: rows.filter((row) => row.tokens > 0 || row.cost > 0).length,
      chart: dates.slice(0, 14).reverse().map((date) => days.get(date) || { date, cost: 0, tokens: 0 }),
      unpriced: Array.isArray(payload.totals?.unpricedModels) ? payload.totals.unpricedModels : [],
    };
  }
  function breakdown(payload, agentFilter = '', now = new Date()) {
    const unpriced = new Set(payload.totals?.unpricedModels || []);
    const dates = new Set(summarize(payload, now).rows.map((row) => row.date));
    const models = new Map();
    for (const day of payload.daily) {
      if (!dates.has(day.date ?? day.period)) continue;
      for (const agent of Array.isArray(day.agents) ? day.agents : []) {
        if (agentFilter && agent.agent !== agentFilter) continue;
        for (const model of Array.isArray(agent.modelBreakdowns) ? agent.modelBreakdowns : []) {
          const name = String(model.modelName || '未知模型');
          const agentName = String(agent.agent || '未知 Agent');
          const key = JSON.stringify([agentName, name]);
          const row = models.get(key) || { agent: agentName, model: name, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: false };
          row.unpriced ||= typeof model.missingPricing === 'boolean' ? model.missingPricing : unpriced.has(name);
          row.input += number(model.inputTokens);
          row.output += number(model.outputTokens);
          row.cacheRead += number(model.cacheReadTokens);
          row.cacheWrite += number(model.cacheCreationTokens);
          row.cost += number(model.cost ?? model.totalCost);
          models.set(key, row);
        }
      }
    }
    return [...models.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  }
  function dailyBreakdown(payload, date, now = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const windowDates = new Set(Array.from({ length: 30 }, (_, index) => {
      const day = new Date(now);
      day.setDate(now.getDate() - index);
      return localDate(day);
    }));
    if (!windowDates.has(date)) return [];
    const rows = new Map();
    const globallyUnpriced = new Set(payload.totals?.unpricedModels || []);
    for (const day of payload.daily || []) {
      if ((day.date ?? day.period) !== date) continue;
      for (const agent of Array.isArray(day.agents) ? day.agents : []) {
        for (const model of Array.isArray(agent.modelBreakdowns) ? agent.modelBreakdowns : []) {
          const agentName = String(agent.agent || '未知 Agent');
          const modelName = String(model.modelName || '未知模型');
          const key = JSON.stringify([agentName, modelName]);
          const row = rows.get(key) || { agent: agentName, model: modelName, input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: false };
          row.input += number(model.inputTokens);
          row.output += number(model.outputTokens);
          row.cacheRead += number(model.cacheReadTokens);
          row.cacheWrite += number(model.cacheCreationTokens);
          row.cost += number(model.cost ?? model.totalCost);
          row.unpriced ||= typeof model.missingPricing === 'boolean' ? model.missingPricing : globallyUnpriced.has(modelName);
          rows.set(key, row);
        }
      }
    }
    return [...rows.values()].map((row) => ({ ...row,
      tokens: row.input + row.output + row.cacheRead + row.cacheWrite }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model));
  }
  function agents(payload, now = new Date()) {
    const dates = new Set(summarize(payload, now).rows.map((row) => row.date));
    const today = localDate(now);
    const results = new Map();
    for (const day of payload.daily) {
      const date = day.date ?? day.period;
      if (!dates.has(date)) continue;
      for (const agent of day.agents || []) {
        const row = results.get(agent.agent) || { id: agent.agent, tokens: 0, cost: 0, todayTokens: 0, todayCost: 0, models: new Set(), missing: new Set() };
        const models = agent.modelBreakdowns || [];
        const tokens = agent.totalTokens == null ? models.reduce((sum, model) => sum + ['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'].reduce((total, key) => total + number(model[key]), 0), 0) : number(agent.totalTokens);
        const cost = agent.totalCost == null ? models.reduce((sum, model) => sum + number(model.cost), 0) : number(agent.totalCost);
        row.tokens += tokens;
        row.cost += cost;
        if (date === today) { row.todayTokens += tokens; row.todayCost += cost; }
        for (const model of models) {
          row.models.add(model.modelName);
          if (typeof model.missingPricing === 'boolean' ? model.missingPricing : (payload.totals?.unpricedModels || []).includes(model.modelName)) row.missing.add(model.modelName);
        }
        results.set(agent.agent, row);
      }
    }
    return [...results.values()].map((row) => ({ ...row, models: [...row.models], missing: [...row.missing] })).sort((a, b) => b.tokens - a.tokens);
  }
  const api = { summarize, localDate, breakdown, dailyBreakdown, agents };
  if (typeof module !== 'undefined') module.exports = api;
  else root.usageModel = api;
})(globalThis);
