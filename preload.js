const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termParty', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  createTerminal: (cwd) => ipcRenderer.invoke('create-terminal', cwd),
  killTerminal: (id) => ipcRenderer.invoke('kill-terminal', id),
  getTerminals: () => ipcRenderer.invoke('get-terminals'),
  removeSavedTerminal: (index) => ipcRenderer.invoke('remove-saved-terminal', index),
  renameTerminal: (id, newTitle) => ipcRenderer.invoke('rename-terminal', { id, newTitle }),
  setTerminalOrder: (order) => ipcRenderer.invoke('set-terminal-order', order),

  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  addFavorite: (name, cwd) => ipcRenderer.invoke('add-favorite', { name, cwd }),
  removeFavorite: (cwd) => ipcRenderer.invoke('remove-favorite', cwd),
  renameFavorite: (cwd, newName) => ipcRenderer.invoke('rename-favorite', { cwd, newName }),
  renameDirectory: (cwd, newName) => ipcRenderer.invoke('rename-directory', { cwd, newName }),

  // Dashboard
  getDashboardData: () => ipcRenderer.invoke('get-dashboard-data'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

  // Dude
  dudeCheckInstalled: () => ipcRenderer.invoke('dude-check-installed'),
  dudeListProjects: () => ipcRenderer.invoke('dude-list-projects'),
  dudeListRecords: (filters) => ipcRenderer.invoke('dude-list-records', filters),
  dudeGetRecord: (id) => ipcRenderer.invoke('dude-get-record', id),
  dudeSearch: (query, filters) => ipcRenderer.invoke('dude-search', { query, ...filters }),

  sendInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),

  onData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal-data', listener);
    return () => ipcRenderer.removeListener('terminal-data', listener);
  },

  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal-exited', listener);
    return () => ipcRenderer.removeListener('terminal-exited', listener);
  },

});
