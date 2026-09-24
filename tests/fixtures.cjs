const { localDate } = require('../renderer/usage-model');
const now = new Date();
const dates = Array.from({ length: 30 }, (_, index) => {
  const day = new Date(now);
  day.setDate(day.getDate() - index);
  return localDate(day);
});
const models = Array.from({ length: 36 }, (_, index) => ({
  modelName: `example-model-${String(index + 1).padStart(2, '0')}`,
  inputTokens: 1600000 - index * 30000,
  outputTokens: 60000 - index * 1000,
  cacheReadTokens: 8000000 - index * 100000,
  cacheCreationTokens: index * 50,
  cost: (36 - index) * 1.25,
}));
const data = {
  daily: dates.map((period, index) => ({
    period,
    totalTokens: 4000000 + index * 125000,
    totalCost: [12.87, 8.42, 20.8, 32.1, 18.6, 24.7, 10.2][index % 7],
    agents: index === 0 ? [
      { agent: 'codex', modelBreakdowns: models.slice(0, 24) },
      { agent: 'pi', modelBreakdowns: models.slice(24) },
    ] : [],
  })),
};
const profiles = [
  { id: 'default', name: '默认 Codex 配置', home: 'C:\\Users\\Demo\\.codex' },
  { id: 'work', name: '工作账号', home: 'E:\\Codex工作配置' },
];
const account = { type: 'chatgpt', email: 'demo@example.test', planType: 'pro' };
const payload = {
  device: 'DESKTOP-DEMO', binary: 'C:\\Codex\\codex.exe', profiles, history: [], fetchedAt: now.toISOString(),
  results: [
    {
      profileId: 'default', status: 'connected', account, checkedAt: now.toISOString(), errors: {},
      usage: { summary: { lifetimeTokens: 123456789 }, daily: dates.slice(0, 14).map((date, index) => ({ date, tokens: 123456 + index * 2100 })) },
      limits: [{ id: 'codex', name: 'Codex', windows: [{ usedPercent: 27, durationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }] }],
    },
    { profileId: 'work', status: 'signed-out', account: null, checkedAt: now.toISOString(), usage: null, limits: [], errors: {} },
  ],
};
module.exports = {
  usage: { load: async () => {
    const snapshot = structuredClone(data);
    data.daily[0].totalCost += 1;
    return { ok: true, data: snapshot, updatedAt: new Date().toISOString() };
  }, cached: async () => null, stop() {} },
  accounts: { settings: async () => ({ ...payload, results: undefined }), load: async () => payload, stop() {} },
};
