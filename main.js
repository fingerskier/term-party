const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const os = require('os');

let mainWindow;
const terminals = new Map(); // id -> { pty, cwd, title, tailBuffer }
let nextId = 1;
let savedTerminals = []; // array of { cwd, title } — ghost entries not yet activated
let favorites = []; // array of { name, cwd }

// --- Dashboard: exit tracking ---
const recentExits = []; // { id, title, exitCode, timestamp } — last 20
const MAX_RECENT_EXITS = 20;
const TAIL_BUFFER_SIZE = 4096; // bytes

// --- Scratchpad ---
let scratchpadDir;
const scratchpadIndex = new Map(); // relativePath -> { name, size, mtime, content }
let scratchpadWatcher = null;

// --- LanceDB (lazy) ---
let lanceDb = null;
let lanceTable = null;
const VECTOR_DIM = 128;

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
    entries.push({ cwd: term.cwd, title: term.title });
  }
  for (const ghost of savedTerminals) {
    entries.push({ cwd: ghost.cwd, title: ghost.title });
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

// --- Scratchpad: file index management ---

function initScratchpad() {
  scratchpadDir = path.join(app.getPath('userData'), 'scratchpad');
  try {
    fs.mkdirSync(scratchpadDir, { recursive: true });
  } catch {
    // already exists
  }

  // Create .claude/mcp.json so Claude Code agents auto-discover the MCP server
  const mcpServerPath = path.join(__dirname, 'mcp-server.js');
  const claudeDir = path.join(scratchpadDir, '.claude');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    const mcpConfig = {
      mcpServers: {
        'term-party-scratchpad': {
          command: 'node',
          args: [mcpServerPath],
          env: { TERM_PARTY_SCRATCHPAD: scratchpadDir },
        },
      },
    };
    fs.writeFileSync(path.join(claudeDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
  } catch {}

  indexScratchpadDir();
  try {
    scratchpadWatcher = fs.watch(scratchpadDir, { recursive: true }, (eventType, filename) => {
      if (filename) {
        reindexFile(filename);
      } else {
        indexScratchpadDir();
      }
    });
  } catch {
    // watcher not supported on all platforms with recursive
    // fallback: re-index on each list/search call
  }
}

function indexScratchpadDir() {
  scratchpadIndex.clear();
  try {
    indexDirRecursive(scratchpadDir, '');
  } catch {
    // empty or inaccessible
  }
}

function indexDirRecursive(dirPath, relativeTo) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relativeTo ? `${relativeTo}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      indexDirRecursive(fullPath, relPath);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        scratchpadIndex.set(relPath, {
          name: entry.name,
          size: stat.size,
          mtime: stat.mtimeMs,
          content,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
}

function reindexFile(filename) {
  const normalizedFilename = filename.replace(/\\/g, '/');
  const fullPath = path.join(scratchpadDir, normalizedFilename);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      scratchpadIndex.set(normalizedFilename, {
        name: path.basename(normalizedFilename),
        size: stat.size,
        mtime: stat.mtimeMs,
        content,
      });
      // Update lancedb async if available
      upsertLanceDoc(normalizedFilename, path.basename(normalizedFilename), content, stat.mtimeMs).catch(() => {});
    }
  } catch {
    // File may have been deleted
    scratchpadIndex.delete(normalizedFilename);
    removeLanceDoc(normalizedFilename).catch(() => {});
  }
}

function searchScratchpadText(query) {
  const lower = query.toLowerCase();
  const results = [];
  for (const [relPath, file] of scratchpadIndex) {
    const nameMatch = file.name.toLowerCase().includes(lower);
    const contentMatch = file.content.toLowerCase().includes(lower);
    if (nameMatch || contentMatch) {
      let snippet = '';
      if (contentMatch) {
        const idx = file.content.toLowerCase().indexOf(lower);
        const start = Math.max(0, idx - 40);
        const end = Math.min(file.content.length, idx + query.length + 40);
        snippet = (start > 0 ? '...' : '') + file.content.slice(start, end) + (end < file.content.length ? '...' : '');
      }
      results.push({ path: relPath, name: file.name, mtime: file.mtime, snippet, score: nameMatch ? 1.0 : 0.5 });
    }
  }
  return results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
}

// --- LanceDB vector search ---

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

function hashVector(text) {
  const vec = new Float32Array(VECTOR_DIM);
  const tokens = tokenize(text);
  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    const bucket = ((hash % VECTOR_DIM) + VECTOR_DIM) % VECTOR_DIM;
    vec[bucket] += 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  }
  return vec;
}

async function initLanceDb() {
  try {
    const lancedb = require('@lancedb/lancedb');
    const dbPath = path.join(app.getPath('userData'), 'scratchpad.lance');
    lanceDb = await lancedb.connect(dbPath);
    const tableNames = await lanceDb.tableNames();
    if (tableNames.includes('documents')) {
      lanceTable = await lanceDb.openTable('documents');
    } else {
      // Create with a dummy row then delete it
      lanceTable = await lanceDb.createTable('documents', [{
        path: '__init__',
        name: '__init__',
        content: '',
        mtime: 0,
        vector: Array.from(new Float32Array(VECTOR_DIM)),
      }]);
      try { await lanceTable.delete('path = "__init__"'); } catch {}
    }
    // Index existing scratchpad files
    for (const [relPath, file] of scratchpadIndex) {
      await upsertLanceDoc(relPath, file.name, file.content, file.mtime);
    }
  } catch (err) {
    console.warn('LanceDB not available, semantic search disabled:', err.message);
    lanceDb = null;
    lanceTable = null;
  }
}

async function upsertLanceDoc(relPath, name, content, mtime) {
  if (!lanceTable) return;
  try {
    try { await lanceTable.delete(`path = "${relPath.replace(/"/g, '\\"')}"`); } catch {}
    const vector = Array.from(hashVector(name + ' ' + content));
    await lanceTable.add([{ path: relPath, name, content, mtime, vector }]);
  } catch {}
}

async function removeLanceDoc(relPath) {
  if (!lanceTable) return;
  try { await lanceTable.delete(`path = "${relPath.replace(/"/g, '\\"')}"`); } catch {}
}

async function semanticSearch(query, limit = 10) {
  if (!lanceTable) return [];
  try {
    const qVec = Array.from(hashVector(query));
    const results = await lanceTable.search(qVec).limit(limit).toArray();
    return results.map(r => ({
      path: r.path,
      name: r.name,
      mtime: r.mtime,
      snippet: r.content ? r.content.slice(0, 120) : '',
      score: r._distance != null ? 1 / (1 + r._distance) : 0,
    }));
  } catch {
    return [];
  }
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

function getTerminalEnv() {
  const env = { ...process.env };
  if (scratchpadDir) {
    env.TERM_PARTY_SCRATCHPAD = scratchpadDir;
  }
  const mcpServerPath = path.join(__dirname, 'mcp-server.js');
  try {
    fs.accessSync(mcpServerPath, fs.constants.R_OK);
    env.TERM_PARTY_MCP_SERVER = mcpServerPath;
  } catch {
    // mcp-server.js not yet created
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
  initScratchpad();
  await initLanceDb();
});

app.on('window-all-closed', async () => {
  await persistTerminals();
  for (const [, term] of terminals) {
    term.pty.kill();
  }
  terminals.clear();
  if (scratchpadWatcher) {
    scratchpadWatcher.close();
    scratchpadWatcher = null;
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
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: getTerminalEnv(),
  });

  const title = path.basename(cwd || os.homedir());
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
    const exitTitle = term ? term.title : title;
    terminals.delete(id);

    // Track exit
    recentExits.unshift({ id, title: exitTitle, exitCode, timestamp: Date.now() });
    if (recentExits.length > MAX_RECENT_EXITS) recentExits.pop();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exited', { id });
    }
  });

  terminals.set(id, { pty: ptyProcess, cwd, title, tailBuffer: '', lastDataTime: Date.now() });
  persistTerminals();
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
    persistTerminals();
  }
  return true;
});

ipcMain.handle('get-terminals', () => {
  const list = [];
  for (const [id, term] of terminals) {
    list.push({ id, cwd: term.cwd, title: term.title, ghost: false });
  }
  savedTerminals.forEach((ghost, i) => {
    list.push({ id: `ghost-${i}`, cwd: ghost.cwd, title: ghost.title, ghost: true });
  });
  return list;
});

ipcMain.handle('remove-saved-terminal', (_event, index) => {
  if (index >= 0 && index < savedTerminals.length) {
    savedTerminals.splice(index, 1);
    persistTerminals();
  }
  return true;
});

ipcMain.handle('rename-terminal', (_event, { id, newTitle }) => {
  if (typeof id === 'string' && id.startsWith('ghost-')) {
    const index = parseInt(id.replace('ghost-', ''), 10);
    if (index >= 0 && index < savedTerminals.length) {
      savedTerminals[index].title = newTitle;
      persistTerminals();
    }
  } else {
    const term = terminals.get(id);
    if (term) {
      term.title = newTitle;
      persistTerminals();
    }
  }
  return true;
});

// --- Favorites IPC ---

ipcMain.handle('get-favorites', () => {
  return favorites.map(f => ({ name: f.name, cwd: f.cwd }));
});

ipcMain.handle('add-favorite', (_event, { name, cwd }) => {
  if (favorites.some(f => f.cwd === cwd)) return false;
  favorites.push({ name, cwd });
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

// --- Dashboard IPC ---

ipcMain.handle('get-dashboard-data', () => {
  const termList = [];
  for (const [id, term] of terminals) {
    termList.push({
      id,
      title: term.title,
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

// --- Scratchpad IPC ---

ipcMain.handle('get-scratchpad-path', () => {
  return scratchpadDir;
});

ipcMain.handle('list-scratchpad-files', () => {
  const files = [];
  for (const [relPath, file] of scratchpadIndex) {
    files.push({ path: relPath, name: file.name, size: file.size, mtime: file.mtime });
  }
  return files.sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('read-scratchpad-file', (_event, relativePath) => {
  const file = scratchpadIndex.get(relativePath);
  if (!file) return null;
  return { path: relativePath, name: file.name, content: file.content, size: file.size, mtime: file.mtime };
});

ipcMain.handle('search-scratchpad', (_event, query) => {
  if (!query || !query.trim()) {
    const files = [];
    for (const [relPath, file] of scratchpadIndex) {
      files.push({ path: relPath, name: file.name, mtime: file.mtime, snippet: '', score: 0 });
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }
  return searchScratchpadText(query);
});

ipcMain.handle('search-scratchpad-semantic', async (_event, query) => {
  if (!query || !query.trim()) {
    const files = [];
    for (const [relPath, file] of scratchpadIndex) {
      files.push({ path: relPath, name: file.name, mtime: file.mtime, snippet: '', score: 0 });
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  // Combine text + vector results
  const textResults = searchScratchpadText(query);
  const vectorResults = await semanticSearch(query);

  // Merge: deduplicate by path, boost score for items found in both
  const merged = new Map();
  for (const r of textResults) {
    merged.set(r.path, { ...r, score: r.score });
  }
  for (const r of vectorResults) {
    if (merged.has(r.path)) {
      merged.get(r.path).score += r.score;
    } else {
      merged.set(r.path, { ...r });
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
});
