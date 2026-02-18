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

// --- Dude database (lazy, read-only) ---
let dudeDb = null;
let embedderPromise = null;

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

// --- Dude database helpers ---

function getDudeDbPath() {
  return path.join(os.homedir(), '.dude-claude', 'dude-libsql.db');
}

function openDudeDb() {
  if (dudeDb) return dudeDb;
  const dbPath = getDudeDbPath();
  if (!fs.existsSync(dbPath)) return null;
  const Database = require('better-sqlite3');
  dudeDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  return dudeDb;
}

function closeDudeDb() {
  if (dudeDb) {
    try { dudeDb.close(); } catch {}
    dudeDb = null;
  }
}

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'));
  }
  return embedderPromise;
}

function embeddingBlobToFloat32Array(blob) {
  if (!blob) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.length % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  if (buffer.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
  }
  const copied = Buffer.from(buffer);
  return new Float32Array(copied.buffer, copied.byteOffset, copied.length / Float32Array.BYTES_PER_ELEMENT);
}

function cosineSimilarity(queryVector, recordEmbeddingBlob) {
  const recordVector = embeddingBlobToFloat32Array(recordEmbeddingBlob);
  if (!recordVector || queryVector.length !== recordVector.length) return null;

  let dot = 0;
  for (let i = 0; i < queryVector.length; i += 1) {
    dot += queryVector[i] * recordVector[i];
  }
  return dot;
}

function buildFilterSQL(filters, params = {}) {
  const conditions = [];
  if (filters?.kind && filters.kind !== 'all') {
    conditions.push('r.kind = @kind');
    params.kind = filters.kind;
  }
  if (filters?.status && filters.status !== 'all') {
    conditions.push('r.status = @status');
    params.status = filters.status;
  }
  if (filters?.project && filters.project !== '*') {
    conditions.push('p.name = @project');
    params.project = filters.project;
  }
  return {
    clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '',
    params,
  };
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
  closeDudeDb();
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
  return fs.existsSync(getDudeDbPath());
});

ipcMain.handle('dude-list-projects', () => {
  try {
    const db = openDudeDb();
    if (!db) return { error: 'Database not found' };
    return db.prepare('SELECT id, name FROM project ORDER BY name').all();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('dude-list-records', (_event, filters) => {
  try {
    const db = openDudeDb();
    if (!db) return { error: 'Database not found' };
    let sql = `SELECT r.id, r.kind, r.title, r.status, p.name AS project, r.updated_at
               FROM record r JOIN project p ON r.project_id = p.id`;
    const conditions = [];
    const params = {};
    if (filters?.kind && filters.kind !== 'all') {
      conditions.push('r.kind = @kind');
      params.kind = filters.kind;
    }
    if (filters?.status && filters.status !== 'all') {
      conditions.push('r.status = @status');
      params.status = filters.status;
    }
    if (filters?.project && filters.project !== '*') {
      conditions.push('p.name = @project');
      params.project = filters.project;
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY r.updated_at DESC LIMIT 100';
    return db.prepare(sql).all(params);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('dude-get-record', (_event, id) => {
  try {
    const db = openDudeDb();
    if (!db) return { error: 'Database not found' };
    return db.prepare(`SELECT r.id, r.kind, r.title, r.body, r.status, p.name AS project,
                        r.created_at, r.updated_at
                 FROM record r JOIN project p ON r.project_id = p.id
                 WHERE r.id = ?`).get(id) || { error: 'Record not found' };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('dude-search', async (_event, params) => {
  try {
    const db = openDudeDb();
    if (!db) return { error: 'Database not found' };

    const query = (params?.query || '').trim();
    const { query: _ignored, ...filters } = params || {};
    if (!query) return [];

    const filterState = buildFilterSQL(filters);

    const embedder = await getEmbedder();
    const queryEmbeddingResult = await embedder(query, { pooling: 'mean', normalize: true });
    const queryVector = queryEmbeddingResult?.data || queryEmbeddingResult;

    if (!(queryVector instanceof Float32Array)) {
      throw new Error('Failed to generate query embedding');
    }

    const semanticSql = `SELECT r.id, r.kind, r.title, r.status, p.name AS project, r.updated_at, r.embedding
                         FROM record r JOIN project p ON r.project_id = p.id
                         WHERE r.embedding IS NOT NULL${filterState.clause}`;
    const semanticRows = db.prepare(semanticSql).all(filterState.params);

    const semanticResults = semanticRows
      .map((row) => {
        const similarity = cosineSimilarity(queryVector, row.embedding);
        if (similarity === null || similarity < 0.3) return null;
        const { embedding, ...record } = row;
        return { ...record, similarity };
      })
      .filter(Boolean)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10)
      .map(({ similarity, ...record }) => record);

    const exactPattern = `%${query}%`;
    const exactFilterState = buildFilterSQL(filters, { pattern: exactPattern });
    const exactSql = `SELECT r.id, r.kind, r.title, r.status, p.name AS project, r.updated_at
                      FROM record r JOIN project p ON r.project_id = p.id
                      WHERE (r.title LIKE @pattern OR r.body LIKE @pattern)${exactFilterState.clause}
                      ORDER BY r.updated_at DESC
                      LIMIT 3`;
    const exactResults = db.prepare(exactSql).all(exactFilterState.params);

    const merged = [];
    const seenIds = new Set();

    for (const result of semanticResults) {
      merged.push(result);
      seenIds.add(result.id);
    }

    for (const result of exactResults) {
      if (seenIds.has(result.id)) continue;
      merged.push(result);
      seenIds.add(result.id);
    }

    return merged;
  } catch (err) {
    return { error: err.message };
  }
});
