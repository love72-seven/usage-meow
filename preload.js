const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccusage', {
  load: () => ipcRenderer.invoke('usage:load'),
  cached: () => ipcRenderer.invoke('usage:cached'),
  sources: () => ipcRenderer.invoke('usage:sources'),
  selectSource: (home) => ipcRenderer.invoke('usage:source-select', home),
  pricingStatus: () => ipcRenderer.invoke('pricing:status'),
  priceQuery: (query) => ipcRenderer.invoke('pricing:query', query),
  priceReferences: () => ipcRenderer.invoke('pricing:references'),
  setPriceReference: (value) => ipcRenderer.invoke('pricing:reference-set', value),
  agentSettings: () => ipcRenderer.invoke('agents:settings'),
  chooseAgentDirectory: (id) => ipcRenderer.invoke('agents:choose', id),
  resetAgentDirectory: (id) => ipcRenderer.invoke('agents:reset', id),
  syncPricing: () => ipcRenderer.invoke('pricing:sync'),
  onPricingStatus: (callback) => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('pricing:status-changed', listener);
    return () => ipcRenderer.removeListener('pricing:status-changed', listener);
  },
});

contextBridge.exposeInMainWorld('accounts', {
  settings: () => ipcRenderer.invoke('accounts:settings'),
  load: () => ipcRenderer.invoke('accounts:load'),
  add: () => ipcRenderer.invoke('accounts:add'),
  chooseBinary: () => ipcRenderer.invoke('accounts:binary'),
  rename: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
});
