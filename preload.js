const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termParty', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  createTerminal: (cwd) => ipcRenderer.invoke('create-terminal', cwd),
  killTerminal: (id) => ipcRenderer.invoke('kill-terminal', id),
  getTerminals: () => ipcRenderer.invoke('get-terminals'),
  removeSavedTerminal: (index) => ipcRenderer.invoke('remove-saved-terminal', index),
  renameTerminal: (id, newTitle) => ipcRenderer.invoke('rename-terminal', { id, newTitle }),

  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  addFavorite: (name, cwd) => ipcRenderer.invoke('add-favorite', { name, cwd }),
  removeFavorite: (index) => ipcRenderer.invoke('remove-favorite', index),

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
