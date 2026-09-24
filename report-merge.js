const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'totalCost'];
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function replaceAgentReport(original, agent, replacement) {
  const result = structuredClone(original);
  const days = new Map(result.daily.map((day) => [day.period ?? day.date, day]));
  for (const day of days.values()) day.agents = (day.agents || []).filter((entry) => entry.agent !== agent);
  for (const day of replacement.daily) {
    const entries = (day.agents || []).filter((entry) => entry.agent === agent);
    if (!entries.length) continue;
    const date = day.period ?? day.date;
    if (!days.has(date)) days.set(date, { agent: 'all', period: date, agents: [] });
    days.get(date).agents.push(...structuredClone(entries));
  }
  const totals = Object.fromEntries(FIELDS.map((field) => [field, 0]));
  const missing = new Set();
  result.daily = [...days.values()].filter((day) => day.agents.length).sort((a, b) => (a.period ?? a.date).localeCompare(b.period ?? b.date));
  for (const day of result.daily) {
    const models = new Map();
    for (const field of FIELDS) {
      day[field] = day.agents.reduce((sum, entry) => sum + numeric(entry[field]), 0);
      totals[field] += day[field];
    }
    for (const entry of day.agents) for (const model of entry.modelBreakdowns || []) {
      model.missingPricing = Boolean(model.missingPricing);
      if (model.missingPricing) missing.add(model.modelName);
      const combined = models.get(model.modelName) || { modelName: model.modelName, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0, missingPricing: false };
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'cost']) combined[field] += numeric(model[field]);
      combined.missingPricing ||= model.missingPricing;
      models.set(model.modelName, combined);
    }
    day.modelBreakdowns = [...models.values()];
    day.modelsUsed = [...models.keys()].sort();
    day.metadata = { ...(day.metadata || {}), agents: day.agents.map((entry) => entry.agent) };
  }
  result.totals = { ...totals, unpricedModels: [...missing].sort() };
  return result;
}

module.exports = { replaceAgentReport };
