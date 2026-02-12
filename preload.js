const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('termParty', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  createTerminal: (cwd) => ipcRenderer.invoke('create-terminal', cwd),
  killTerminal: (id) => ipcRenderer.invoke('kill-terminal', id),
  getTerminals: () => ipcRenderer.invoke('get-terminals'),

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
