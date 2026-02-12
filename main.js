const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');

let mainWindow;
const terminals = new Map(); // id -> { pty, cwd, title }
let nextId = 1;

function getShell() {
  return process.platform === 'win32'
    ? 'powershell.exe'
    : process.env.SHELL || '/bin/bash';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const [, term] of terminals) {
    term.pty.kill();
  }
  terminals.clear();
  app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('create-terminal', (_event, cwd) => {
  const id = nextId++;
  const shell = getShell();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: process.env,
  });

  const title = path.basename(cwd || os.homedir());

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  ptyProcess.onExit(() => {
    terminals.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exited', { id });
    }
  });

  terminals.set(id, { pty: ptyProcess, cwd, title });
  return { id, cwd, title };
});

ipcMain.on('terminal-input', (_event, { id, data }) => {
  const term = terminals.get(id);
  if (term) term.pty.write(data);
});

ipcMain.on('terminal-resize', (_event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term) term.pty.resize(cols, rows);
});

ipcMain.handle('kill-terminal', (_event, id) => {
  const term = terminals.get(id);
  if (term) {
    term.pty.kill();
    terminals.delete(id);
  }
  return true;
});

ipcMain.handle('get-terminals', () => {
  const list = [];
  for (const [id, term] of terminals) {
    list.push({ id, cwd: term.cwd, title: term.title });
  }
  return list;
});
