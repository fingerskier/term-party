const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const os = require('os');

let mainWindow;
const terminals = new Map(); // id -> { pty, cwd, tailBuffer }
let nextId = 1;
let savedTerminals = []; // array of { cwd } — ghost entries not yet activated
let favorites = []; // array of { cwd }
let terminalOrder = []; // array of terminal ids in display order
let directoryNames = {}; // cwd -> display name (single source of truth)

// --- Dashboard: exit tracking ---
const recentExits = []; // { id, title, exitCode, timestamp } — last 20
const MAX_RECENT_EXITS = 20;
const TAIL_BUFFER_SIZE = 4096; // bytes

// --- Dude MCP client (lazy) ---
let dudeClient = null;
let dudeTransport = null;

function getSavePath() {
  return path.join(app.getPath('userData'), 'terminals.json');
}

function loadSavedTerminals() {
  try {
    const data = fs.readFileSync(getSavePath(), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistTerminals() {
  const entries = [];
  for (const [, term] of terminals) {
    entries.push({ cwd: term.cwd });
  }
  for (const ghost of savedTerminals) {
    entries.push({ cwd: ghost.cwd });
  }
  try {
    await fs.promises.writeFile(getSavePath(), JSON.stringify(entries, null, 2));
  } catch {
    // best-effort persistence
  }
}

function getFavoritesPath() {
  return path.join(app.getPath('userData'), 'favorites.json');
}

function loadFavorites() {
  try {
    const data = fs.readFileSync(getFavoritesPath(), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistFavorites() {
  try {
    await fs.promises.writeFile(getFavoritesPath(), JSON.stringify(favorites, null, 2));
  } catch {
    // best-effort persistence
  }
}

function getDirectoryNamesPath() {
  return path.join(app.getPath('userData'), 'directory-names.json');
}

function loadDirectoryNames() {
  try {
    const data = fs.readFileSync(getDirectoryNamesPath(), 'utf-8');
    const parsed = JSON.parse(data);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function persistDirectoryNames() {
  try {
    await fs.promises.writeFile(getDirectoryNamesPath(), JSON.stringify(directoryNames, null, 2));
  } catch {
    // best-effort persistence
  }
}

function migrateToDirectoryNames() {
  let migrated = false;
  // Seed from saved terminals that have a title different from basename
  for (const entry of savedTerminals) {
    if (entry.title && entry.cwd && entry.title !== path.basename(entry.cwd)) {
      if (!directoryNames[entry.cwd]) {
        directoryNames[entry.cwd] = entry.title;
        migrated = true;
      }
    }
  }
  // Seed from favorites that have a name different from basename
  for (const fav of favorites) {
    if (fav.name && fav.cwd && fav.name !== path.basename(fav.cwd)) {
      if (!directoryNames[fav.cwd]) {
        directoryNames[fav.cwd] = fav.name;
        migrated = true;
      }
    }
  }
  if (migrated) {
    persistDirectoryNames();
  }
}

function resolveDirectoryName(cwd) {
  return directoryNames[cwd] || path.basename(cwd || '');
}

function getShell() {
  return process.platform === 'win32'
    ? 'powershell.exe'
    : process.env.SHELL || '/bin/bash';
}

function getAppIcon() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'favicon.ico');
  }
  return path.join(__dirname, 'icon.icns');
}

// --- Dude MCP plugin detection and client ---

function findDudePlugin() {
  const baseDir = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'fingerskier-plugins', 'dude');
  try {
    const versions = fs.readdirSync(baseDir).sort().reverse();
    for (const ver of versions) {
      const candidate = path.join(baseDir, ver, 'bin', 'dude-claude.js');
      try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return candidate;
      } catch {}
    }
  } catch {}
  return null;
}

async function connectDudeClient() {
  if (dudeClient) return dudeClient;
  const pluginPath = findDudePlugin();
  if (!pluginPath) throw new Error('Dude plugin not installed');

  const { Client } = require('@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');

  dudeTransport = new StdioClientTransport({
    command: 'node',
    args: [pluginPath, 'mcp'],
    stderr: 'pipe',
  });
  dudeClient = new Client({ name: 'term-party', version: '1.0.0' }, { capabilities: {} });
  await dudeClient.connect(dudeTransport);
  return dudeClient;
}

async function callDudeTool(toolName, args = {}) {
  const client = await connectDudeClient();
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// --- System stats ---

function getSystemStats() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  const cpuPercent = Math.round((1 - totalIdle / totalTick) * 100);
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  return {
    cpuPercent,
    memUsed,
    memTotal,
    memUsedMB: Math.round(memUsed / 1024 / 1024),
    memTotalMB: Math.round(memTotal / 1024 / 1024),
  };
}

// --- Terminal env vars ---

function getTerminalEnv(terminalName) {
  const env = { ...process.env };
  if (terminalName) {
    env.TERM_PARTY_NAME = terminalName;
  }
  return env;
}

// --- Window creation ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'web-app-manifest-512x512.png'));
      app.dock.setIcon(icon);
    } catch (e) {
      console.warn('Failed to set dock icon:', e.message);
    }
  }
  createWindow();
  savedTerminals = loadSavedTerminals();
  favorites = loadFavorites();
  directoryNames = loadDirectoryNames();
  migrateToDirectoryNames();
  terminalOrder = [...terminals.keys()];
});

app.on('window-all-closed', async () => {
  await persistTerminals();
  for (const [, term] of terminals) {
    term.pty.kill();
  }
  terminals.clear();
  if (dudeTransport) {
    try { await dudeTransport.close(); } catch {}
    dudeTransport = null;
    dudeClient = null;
  }
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
  const resolvedCwd = cwd || os.homedir();
  const title = resolveDirectoryName(resolvedCwd);
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: getTerminalEnv(title),
  });
  let tailBuffer = '';

  ptyProcess.onData((data) => {
    // Append to tail buffer (keep last TAIL_BUFFER_SIZE chars)
    tailBuffer += data;
    if (tailBuffer.length > TAIL_BUFFER_SIZE) {
      tailBuffer = tailBuffer.slice(-TAIL_BUFFER_SIZE);
    }
    const term = terminals.get(id);
    if (term) {
      term.tailBuffer = tailBuffer;
      term.lastDataTime = Date.now();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const term = terminals.get(id);
    const exitTitle = term ? resolveDirectoryName(term.cwd) : title;
    terminals.delete(id);
    terminalOrder = terminalOrder.filter(oid => oid !== id);

    // Track exit
    recentExits.unshift({ id, title: exitTitle, exitCode, timestamp: Date.now() });
    if (recentExits.length > MAX_RECENT_EXITS) recentExits.pop();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exited', { id });
    }
  });

  terminals.set(id, { pty: ptyProcess, cwd: resolvedCwd, spawnName: title, tailBuffer: '', lastDataTime: Date.now() });
  terminalOrder.push(id);
  persistTerminals();
  return { id, cwd: resolvedCwd, title };
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
    terminalOrder = terminalOrder.filter(oid => oid !== id);
    persistTerminals();
  }
  return true;
});

ipcMain.handle('get-terminals', () => {
  const list = [];
  // Ordered terminals first
  for (const id of terminalOrder) {
    const term = terminals.get(id);
    if (term) list.push({ id, cwd: term.cwd, title: resolveDirectoryName(term.cwd), ghost: false, lastDataTime: term.lastDataTime });
  }
  // Any terminals not in order array (safety fallback)
  for (const [id, term] of terminals) {
    if (!terminalOrder.includes(id)) {
      list.push({ id, cwd: term.cwd, title: resolveDirectoryName(term.cwd), ghost: false, lastDataTime: term.lastDataTime });
    }
  }
  // Ghosts always last
  savedTerminals.forEach((ghost, i) => {
    list.push({ id: `ghost-${i}`, cwd: ghost.cwd, title: resolveDirectoryName(ghost.cwd), ghost: true });
  });
  return list;
});

ipcMain.handle('set-terminal-order', (_event, order) => {
  terminalOrder = order.filter(id => terminals.has(id));
  persistTerminals();
  return true;
});

ipcMain.handle('remove-saved-terminal', (_event, index) => {
  if (index >= 0 && index < savedTerminals.length) {
    savedTerminals.splice(index, 1);
    persistTerminals();
  }
  return true;
});

ipcMain.handle('rename-terminal', (_event, { id, newTitle }) => {
  // Find the cwd and update the directory names registry
  let cwd = null;
  if (typeof id === 'string' && id.startsWith('ghost-')) {
    const index = parseInt(id.replace('ghost-', ''), 10);
    if (index >= 0 && index < savedTerminals.length) {
      cwd = savedTerminals[index].cwd;
    }
  } else {
    const term = terminals.get(id);
    if (term) cwd = term.cwd;
  }
  if (cwd) {
    directoryNames[cwd] = newTitle;
    persistDirectoryNames();
  }
  return true;
});

ipcMain.handle('rename-directory', (_event, { cwd, newName }) => {
  if (cwd && newName) {
    directoryNames[cwd] = newName;
    persistDirectoryNames();
  }
  return true;
});

// --- Favorites IPC ---

ipcMain.handle('get-favorites', () => {
  return favorites.map(f => ({ name: resolveDirectoryName(f.cwd), cwd: f.cwd }));
});

ipcMain.handle('add-favorite', (_event, { name, cwd }) => {
  if (favorites.some(f => f.cwd === cwd)) return false;
  favorites.push({ cwd });
  // If a custom name was provided and no registry entry exists, add it
  if (name && name !== path.basename(cwd)) {
    if (!directoryNames[cwd]) {
      directoryNames[cwd] = name;
      persistDirectoryNames();
    }
  }
  persistFavorites();
  return true;
});

ipcMain.handle('remove-favorite', (_event, cwd) => {
  const before = favorites.length;
  favorites = favorites.filter(f => f.cwd !== cwd);
  if (favorites.length !== before) {
    persistFavorites();
  }
  return true;
});

ipcMain.handle('rename-favorite', (_event, { cwd, newName }) => {
  // Kept for backward compatibility — updates the directory names registry
  if (cwd && newName) {
    directoryNames[cwd] = newName;
    persistDirectoryNames();
  }
  return true;
});

// --- Dashboard IPC ---

ipcMain.handle('get-dashboard-data', () => {
  const termList = [];
  for (const [id, term] of terminals) {
    termList.push({
      id,
      title: resolveDirectoryName(term.cwd),
      cwd: term.cwd,
      tailText: term.tailBuffer || '',
      lastDataTime: term.lastDataTime || 0,
    });
  }
  return { terminals: termList, recentExits: [...recentExits] };
});

ipcMain.handle('get-system-stats', () => {
  return getSystemStats();
});

// --- Dude IPC ---

ipcMain.handle('dude-check-installed', () => {
  return findDudePlugin() !== null;
});

ipcMain.handle('dude-list-projects', async () => {
  try {
    return await callDudeTool('list_projects', {});
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('dude-list-records', async (_event, filters) => {
  try {
    return await callDudeTool('list_records', filters || {});
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('dude-get-record', async (_event, id) => {
  try {
    return await callDudeTool('get_record', { id });
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('dude-search', async (_event, params) => {
  try {
    const { query, ...filters } = params;
    return await callDudeTool('search', { query, ...filters });
  } catch (err) {
    return { error: err.message };
  }
});
