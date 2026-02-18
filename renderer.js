import { Terminal } from './node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from './node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const terminalListEl = document.getElementById('terminal-list');
const containerEl = document.getElementById('terminal-container');
const emptyStateEl = document.getElementById('empty-state');
const addBtn = document.getElementById('add-terminal');
const openFavoritesBtn = document.getElementById('open-favorites');
const openDudeBtn = document.getElementById('open-dude');
const appTitleEl = document.getElementById('app-title');
const viewerEl = document.getElementById('viewer');

// Map of id -> { xterm, fitAddon, wrapper, opened }
const termViews = new Map();
// Map of string -> { wrapper, onActivate?, onDeactivate? }
const specialViews = new Map();

let activeViewId = null; // number (terminal) or string ('dashboard', 'favorites', 'dude')
let currentFavorites = [];
let favoriteCwds = new Set();

// ---- Context menu ----

const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
ctxMenu.style.display = 'none';
document.body.appendChild(ctxMenu);

document.addEventListener('click', () => {
  ctxMenu.style.display = 'none';
});

// ---- Special view system ----

function registerSpecialView(id, { buildFn, onActivate, onDeactivate }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'view-panel';
  wrapper.dataset.viewId = id;
  viewerEl.appendChild(wrapper);

  let built = false;
  const view = {
    wrapper,
    onActivate: () => {
      if (!built) {
        buildFn(wrapper);
        built = true;
      }
      if (onActivate) onActivate(wrapper);
    },
    onDeactivate: onDeactivate || null,
  };
  specialViews.set(id, view);
}

function activateView(viewId) {
  if (activeViewId === viewId) return;

  // Deactivate previous view
  if (activeViewId !== null) {
    if (typeof activeViewId === 'number') {
      const prev = termViews.get(activeViewId);
      if (prev) prev.wrapper.style.display = 'none';
    } else {
      const prev = specialViews.get(activeViewId);
      if (prev) {
        prev.wrapper.classList.remove('active');
        if (prev.onDeactivate) prev.onDeactivate(prev.wrapper);
      }
    }
  }

  // Hide empty state and terminal container when showing special views
  if (typeof viewId === 'string') {
    emptyStateEl.style.display = 'none';
    containerEl.style.display = 'none';
    const view = specialViews.get(viewId);
    if (view) {
      view.wrapper.classList.add('active');
      view.onActivate(view.wrapper);
    }
  } else {
    containerEl.style.display = '';
  }

  activeViewId = viewId;
  updateSidebarActiveStates();
}

function activateTerminal(id) {
  // If coming from a special view, hide it first
  if (typeof activeViewId === 'string') {
    const prev = specialViews.get(activeViewId);
    if (prev) {
      prev.wrapper.classList.remove('active');
      if (prev.onDeactivate) prev.onDeactivate(prev.wrapper);
    }
    containerEl.style.display = '';
  }

  if (activeViewId === id) return;

  // Hide previous terminal wrapper
  if (typeof activeViewId === 'number') {
    const prev = termViews.get(activeViewId);
    if (prev) prev.wrapper.style.display = 'none';
  }

  activeViewId = id;
  emptyStateEl.style.display = 'none';

  let view = termViews.get(id);
  if (!view) {
    createTermView(id);
    view = termViews.get(id);
  }

  view.wrapper.style.display = '';
  if (!view.opened) {
    view.xterm.open(view.wrapper);
    view.opened = true;
  }
  view.fitAddon.fit();
  view.xterm.focus();

  window.termParty.resize(id, view.xterm.cols, view.xterm.rows);
  updateSidebarActiveStates();
  refreshList();
}

function updateSidebarActiveStates() {
  // Sidebar buttons
  openFavoritesBtn.classList.toggle('active', activeViewId === 'favorites');
  openDudeBtn.classList.toggle('active', activeViewId === 'dude');

  // Terminal list items
  for (const li of terminalListEl.querySelectorAll('li')) {
    const liId = li.dataset.id;
    if (liId && !li.classList.contains('ghost')) {
      li.classList.toggle('active', Number(liId) === activeViewId);
    }
  }
}

// ---- Sidebar rendering ----

function startInlineRename(li, termId, titleSpan, termCwd) {
  const original = titleSpan.textContent;
  titleSpan.style.display = 'none';

  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = original;
  li.insertBefore(input, titleSpan.nextSibling);
  input.focus();
  input.select();

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.remove();
    titleSpan.style.display = '';
    if (newName && newName !== original) {
      titleSpan.textContent = newName;
      window.termParty.renameDirectory(termCwd, newName);
      // Refresh both terminal list and favorites panel
      refreshList();
      if (activeViewId === 'favorites') {
        const view = specialViews.get('favorites');
        if (view) renderFavoritesPanel(view.wrapper);
      }
    }
  }
  function cancel() {
    if (committed) return;
    committed = true;
    input.remove();
    titleSpan.style.display = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

function getTerminalIds() {
  return [...terminalListEl.querySelectorAll('li:not(.ghost)')]
    .map(li => Number(li.dataset.id));
}

function renderList(terminals) {
  terminalListEl.innerHTML = '';
  for (const t of terminals) {
    const li = document.createElement('li');
    li.classList.toggle('active', t.id === activeViewId);
    li.dataset.id = t.id;

    if (t.ghost) {
      li.classList.add('ghost');
    } else {
      const isActive = (Date.now() - t.lastDataTime) < 3000;
      li.classList.add(isActive ? 'term-active' : 'term-idle');
    }

    // Drag-and-drop for non-ghost terminals
    if (!t.ghost) {
      li.draggable = true;

      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-term-id', String(t.id));
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('dragging');
      });

      li.addEventListener('dragover', (e) => {
        // Only handle sidebar reorder drags (not file drops)
        if (!e.dataTransfer.types.includes('text/x-term-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        li.classList.remove('drop-before', 'drop-after');
        if (e.clientY < midY) {
          li.classList.add('drop-before');
        } else {
          li.classList.add('drop-after');
        }
      });

      li.addEventListener('dragleave', () => {
        li.classList.remove('drop-before', 'drop-after');
      });

      li.addEventListener('drop', (e) => {
        if (!e.dataTransfer.types.includes('text/x-term-id')) return;
        e.preventDefault();
        const draggedId = Number(e.dataTransfer.getData('text/x-term-id'));
        if (draggedId === t.id) return;

        // Compute new order from current DOM
        const ids = [...terminalListEl.querySelectorAll('li:not(.ghost)')]
          .map(el => Number(el.dataset.id))
          .filter(id => id !== draggedId);

        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const targetIdx = ids.indexOf(t.id);
        const insertIdx = e.clientY < midY ? targetIdx : targetIdx + 1;
        ids.splice(insertIdx, 0, draggedId);

        window.termParty.setTerminalOrder(ids).then(() => refreshList());
      });

      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        for (const el of terminalListEl.querySelectorAll('li')) {
          el.classList.remove('drop-before', 'drop-after', 'dragging');
        }
      });
    }

    const title = document.createElement('span');
    title.className = 'term-title';
    title.textContent = t.title || t.cwd;
    li.appendChild(title);

    const killBtn = document.createElement('button');
    killBtn.className = 'kill-btn';
    killBtn.title = t.ghost ? 'Remove saved terminal' : 'Kill terminal';
    killBtn.textContent = '\u00d7';

    if (t.ghost) {
      const ghostIndex = parseInt(t.id.replace('ghost-', ''), 10);
      killBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSavedTerminal(ghostIndex);
      });
      li.addEventListener('click', () => spawnGhost(ghostIndex, t.cwd));
    } else {
      killBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        killTerminal(t.id);
      });
      li.addEventListener('click', () => activateTerminal(t.id));
    }

    // Star button for non-ghost terminals
    if (!t.ghost) {
      const isFav = favoriteCwds.has(t.cwd);
      const starBtn = document.createElement('button');
      starBtn.className = 'star-btn' + (isFav ? ' is-favorite' : '');
      starBtn.textContent = isFav ? '\u2605' : '\u2606';
      starBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
      starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(t.title, t.cwd, isFav);
      });
      li.appendChild(starBtn);
    }

    li.appendChild(killBtn);

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxMenu.innerHTML = '';
      const renameItem = document.createElement('div');
      renameItem.className = 'ctx-menu-item';
      renameItem.textContent = 'Rename';
      renameItem.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctxMenu.style.display = 'none';
        startInlineRename(li, t.id, title, t.cwd);
      });
      ctxMenu.appendChild(renameItem);
      ctxMenu.style.left = e.clientX + 'px';
      ctxMenu.style.top = e.clientY + 'px';
      ctxMenu.style.display = '';
    });

    terminalListEl.appendChild(li);
  }
}

async function refreshList() {
  // Skip refresh while an inline rename is active to avoid destroying the input
  if (document.querySelector('.rename-input')) return;
  await loadAndRenderFavorites();
  const terminals = await window.termParty.getTerminals();
  renderList(terminals);
}

// ---- Favorites ----

async function loadAndRenderFavorites() {
  currentFavorites = await window.termParty.getFavorites();
  favoriteCwds = new Set(currentFavorites.map(f => f.cwd));
}

function renderFavoritesPanel(container) {
  const gridEl = container.querySelector('.fav-grid');
  const emptyEl = container.querySelector('.panel-empty');
  if (!gridEl || !emptyEl) return;

  gridEl.innerHTML = '';
  if (currentFavorites.length === 0) {
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  const sorted = [...currentFavorites].sort((a, b) =>
    (a.name || a.cwd).localeCompare(b.name || b.cwd, undefined, { sensitivity: 'base' })
  );

  for (const fav of sorted) {
    const card = document.createElement('div');
    card.className = 'fav-card';

    const name = document.createElement('div');
    name.className = 'fav-name';
    name.textContent = fav.name;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startFavoriteRename(card, fav, name);
    });
    card.appendChild(name);

    const cwdSpan = document.createElement('div');
    cwdSpan.className = 'fav-cwd';
    cwdSpan.textContent = fav.cwd;
    cwdSpan.title = fav.cwd;
    card.appendChild(cwdSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fav-remove-btn';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove favorite';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFavorite(fav.cwd);
    });
    card.appendChild(removeBtn);

    card.addEventListener('click', () => {
      spawnFromFavorite(fav.cwd);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxMenu.innerHTML = '';
      const renameItem = document.createElement('div');
      renameItem.className = 'ctx-menu-item';
      renameItem.textContent = 'Rename';
      renameItem.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctxMenu.style.display = 'none';
        startFavoriteRename(card, fav, name);
      });
      ctxMenu.appendChild(renameItem);
      ctxMenu.style.left = e.clientX + 'px';
      ctxMenu.style.top = e.clientY + 'px';
      ctxMenu.style.display = '';
    });

    gridEl.appendChild(card);
  }
}

async function spawnFromFavorite(cwd) {
  const info = await window.termParty.createTerminal(cwd);
  activateTerminal(info.id);
  refreshList();
}

function startFavoriteRename(card, fav, nameEl) {
  const original = nameEl.textContent;
  nameEl.style.display = 'none';

  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = original;
  card.insertBefore(input, nameEl.nextSibling);
  input.focus();
  input.select();

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.remove();
    nameEl.style.display = '';
    if (newName && newName !== original) {
      nameEl.textContent = newName;
      window.termParty.renameDirectory(fav.cwd, newName);
      // Refresh both favorites and terminal list so both reflect the new name
      loadAndRenderFavorites().then(() => {
        const view = specialViews.get('favorites');
        if (view) renderFavoritesPanel(view.wrapper);
      });
      refreshList();
    }
  }
  function cancel() {
    if (committed) return;
    committed = true;
    input.remove();
    nameEl.style.display = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function removeFavorite(cwd) {
  await window.termParty.removeFavorite(cwd);
  refreshList();
  // Re-render favorites panel if it's the active view
  if (activeViewId === 'favorites') {
    const view = specialViews.get('favorites');
    if (view) renderFavoritesPanel(view.wrapper);
  }
}

async function toggleFavorite(name, cwd, isFav) {
  // Optimistic UI update
  if (isFav) {
    favoriteCwds.delete(cwd);
    currentFavorites = currentFavorites.filter(f => f.cwd !== cwd);
  } else {
    favoriteCwds.add(cwd);
    currentFavorites.push({ name, cwd });
  }

  const terminals = await window.termParty.getTerminals();
  renderList(terminals);

  try {
    if (isFav) {
      await window.termParty.removeFavorite(cwd);
    } else {
      await window.termParty.addFavorite(name, cwd);
    }
  } catch {
    // on failure, reconciliation below will correct the UI
  }

  await loadAndRenderFavorites();
  const termsFinal = await window.termParty.getTerminals();
  renderList(termsFinal);

  // Re-render favorites panel if visible
  if (activeViewId === 'favorites') {
    const view = specialViews.get('favorites');
    if (view) renderFavoritesPanel(view.wrapper);
  }
}

// ---- Terminal views ----

function createTermView(id) {
  const xterm = new Terminal({
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Menlo, monospace',
    theme: {
      background: '#08080c',
      foreground: '#c8ccd8',
      cursor: '#c8ff00',
      selectionBackground: '#2a2a3a',
      black: '#1a1a28',
      red: '#ef4444',
      green: '#c8ff00',
      yellow: '#f9e2af',
      blue: '#60a5fa',
      magenta: '#a855f7',
      cyan: '#22d3ee',
      white: '#c8ccd8',
      brightBlack: '#585868',
      brightRed: '#f87171',
      brightGreen: '#d4ff33',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#c084fc',
      brightCyan: '#67e8f9',
      brightWhite: '#e2e8f0',
    },
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);

  xterm.onData((data) => {
    window.termParty.sendInput(id, data);
  });

  xterm.onResize(({ cols, rows }) => {
    window.termParty.resize(id, cols, rows);
  });

  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      return false;
    }
    if (e.ctrlKey && e.key === 'v') {
      navigator.clipboard.readText().then(text => {
        if (text) window.termParty.sendInput(id, text);
      });
      return false;
    }
    if (e.ctrlKey && e.key === 'c' && xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection());
      return false;
    }
    return true;
  });

  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.display = 'none';
  containerEl.appendChild(wrapper);

  wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      const paths = [...e.dataTransfer.files].map(f => `"${f.path}"`).join(' ');
      window.termParty.sendInput(id, paths);
    } else {
      const text = e.dataTransfer.getData('text/plain');
      if (text) window.termParty.sendInput(id, text);
    }
    xterm.focus();
  });

  termViews.set(id, { xterm, fitAddon, wrapper, opened: false });
}

async function killTerminal(id) {
  await window.termParty.killTerminal(id);
  const view = termViews.get(id);
  if (view) {
    view.xterm.dispose();
    view.wrapper.remove();
    termViews.delete(id);
  }
  if (activeViewId === id) {
    activeViewId = null;
    emptyStateEl.style.display = '';
  }
  refreshList();
}

async function removeSavedTerminal(index) {
  await window.termParty.removeSavedTerminal(index);
  refreshList();
}

async function spawnGhost(index, cwd) {
  await window.termParty.removeSavedTerminal(index);
  const info = await window.termParty.createTerminal(cwd);
  activateTerminal(info.id);
  refreshList();
}

// ---- Add terminal ----

addBtn.addEventListener('click', async () => {
  const dir = await window.termParty.selectDirectory();
  if (!dir) return;
  const info = await window.termParty.createTerminal(dir);
  activateTerminal(info.id);
  refreshList();
});

// ---- Incoming data from pty ----

window.termParty.onData(({ id, data }) => {
  const view = termViews.get(id);
  if (view) {
    view.xterm.write(data);
  }
});

window.termParty.onExit(({ id }) => {
  const view = termViews.get(id);
  if (view) {
    view.xterm.dispose();
    view.wrapper.remove();
    termViews.delete(id);
  }
  if (activeViewId === id) {
    activeViewId = null;
    emptyStateEl.style.display = '';
  }
  refreshList();
});

// ---- Resize handling ----

window.addEventListener('resize', () => {
  if (typeof activeViewId === 'number') {
    const view = termViews.get(activeViewId);
    if (view) {
      view.fitAddon.fit();
    }
  }
});

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return;

  e.preventDefault();
  const ids = getTerminalIds();

  if (e.key === 'PageUp') {
    if (activeViewId === 'dashboard') {
      // Dashboard → last terminal (wrap around)
      if (ids.length > 0) activateTerminal(ids[ids.length - 1]);
    } else if (typeof activeViewId === 'number') {
      const idx = ids.indexOf(activeViewId);
      if (idx <= 0) {
        // First terminal → Dashboard
        activateView('dashboard');
      } else {
        activateTerminal(ids[idx - 1]);
      }
    } else {
      // On another special view, go to dashboard
      activateView('dashboard');
    }
  } else {
    if (activeViewId === 'dashboard') {
      // Dashboard → first terminal
      if (ids.length > 0) activateTerminal(ids[0]);
    } else if (typeof activeViewId === 'number') {
      const idx = ids.indexOf(activeViewId);
      if (idx < 0 || idx >= ids.length - 1) {
        // Last terminal → Dashboard
        activateView('dashboard');
      } else {
        activateTerminal(ids[idx + 1]);
      }
    } else {
      // On another special view, go to dashboard
      activateView('dashboard');
    }
  }
});

// ---- Sidebar button handlers ----

openFavoritesBtn.addEventListener('click', () => activateView('favorites'));
openDudeBtn.addEventListener('click', () => activateView('dude'));
appTitleEl.addEventListener('click', () => activateView('dashboard'));

// ========================================================
// Register special views
// ========================================================

// ---- Favorites panel ----

registerSpecialView('favorites', {
  buildFn(wrapper) {
    wrapper.classList.add('favorites-panel');
    wrapper.innerHTML = `
      <div class="view-panel-header">Favorites</div>
      <div class="fav-grid"></div>
      <div class="panel-empty" style="display:none;">No favorites yet. Star a terminal to add it here.</div>
    `;
  },
  onActivate(wrapper) {
    renderFavoritesPanel(wrapper);
  },
});

// ---- Dashboard panel ----

let dashboardPollInterval = null;

registerSpecialView('dashboard', {
  buildFn(wrapper) {
    wrapper.classList.add('dashboard-panel');
    wrapper.innerHTML = `
      <div class="view-panel-header">Dashboard</div>
      <div class="dash-stat-bar">
        <div class="dash-stat">
          <span class="dash-stat-label">CPU</span>
          <span class="dash-stat-value" id="dash-cpu">--</span>
        </div>
        <div class="dash-stat">
          <span class="dash-stat-label">Memory</span>
          <span class="dash-stat-value" id="dash-mem">--</span>
        </div>
        <div class="dash-stat">
          <span class="dash-stat-label">Terminals</span>
          <span class="dash-stat-value" id="dash-term-count">0</span>
        </div>
      </div>
      <div class="dash-section-title">Recent Exits</div>
      <ul class="dash-exits" id="dash-exits"></ul>
      <div class="dash-section-title">Active Terminals</div>
      <div class="dash-tail-grid" id="dash-tail-grid"></div>
    `;
  },
  onActivate() {
    refreshDashboard();
    dashboardPollInterval = setInterval(refreshDashboard, 2000);
  },
  onDeactivate() {
    if (dashboardPollInterval) {
      clearInterval(dashboardPollInterval);
      dashboardPollInterval = null;
    }
  },
});

async function refreshDashboard() {
  const [dashData, stats] = await Promise.all([
    window.termParty.getDashboardData(),
    window.termParty.getSystemStats(),
  ]);

  const cpuEl = document.getElementById('dash-cpu');
  const memEl = document.getElementById('dash-mem');
  const countEl = document.getElementById('dash-term-count');
  const exitsEl = document.getElementById('dash-exits');
  const gridEl = document.getElementById('dash-tail-grid');

  if (!cpuEl) return; // panel not built yet

  cpuEl.textContent = stats.cpuPercent + '%';
  memEl.textContent = `${stats.memUsedMB} / ${stats.memTotalMB} MB`;
  countEl.textContent = dashData.terminals.length;

  // Recent exits
  exitsEl.innerHTML = '';
  if (dashData.recentExits.length === 0) {
    exitsEl.innerHTML = '<div class="panel-empty">No recent exits</div>';
  } else {
    for (const exit of dashData.recentExits) {
      const item = document.createElement('div');
      item.className = 'dash-exit-item';

      const code = document.createElement('span');
      code.className = 'exit-code ' + (exit.exitCode === 0 ? 'success' : 'failure');
      code.textContent = exit.exitCode ?? '?';
      item.appendChild(code);

      const title = document.createElement('span');
      title.className = 'exit-title';
      title.textContent = exit.title;
      item.appendChild(title);

      const time = document.createElement('span');
      time.className = 'exit-time';
      time.textContent = formatTime(exit.timestamp);
      item.appendChild(time);

      exitsEl.appendChild(item);
    }
  }

  // Terminal tail cards
  gridEl.innerHTML = '';
  if (dashData.terminals.length === 0) {
    gridEl.innerHTML = '<div class="panel-empty">No active terminals</div>';
  } else {
    for (const term of dashData.terminals) {
      const card = document.createElement('div');
      const isActive = (Date.now() - term.lastDataTime) < 3000;
      card.className = 'dash-tail-card ' + (isActive ? 'term-active' : 'term-idle');

      const header = document.createElement('div');
      header.className = 'dash-tail-card-header';

      const titleEl = document.createElement('span');
      titleEl.className = 'dash-tail-card-title';
      titleEl.textContent = term.title || term.cwd;
      header.appendChild(titleEl);

      const gotoBtn = document.createElement('button');
      gotoBtn.className = 'dash-tail-card-goto';
      gotoBtn.textContent = 'Go to';
      gotoBtn.addEventListener('click', () => activateTerminal(term.id));
      header.appendChild(gotoBtn);

      card.appendChild(header);

      const content = document.createElement('div');
      content.className = 'dash-tail-card-content';
      // Show last ~20 lines of tail text
      const lines = stripAnsi(term.tailText).split('\n');
      content.textContent = lines.slice(-20).join('\n');
      card.appendChild(content);

      gridEl.appendChild(card);
    }
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString();
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ---- Dude browser panel ----

let dudeSelectedRecordId = null;
let dudeProjects = [];

registerSpecialView('dude', {
  buildFn(wrapper) {
    wrapper.classList.add('dude-panel');
    wrapper.innerHTML = `
      <div class="dude-sidebar">
        <div class="dude-controls">
          <div class="view-panel-header">Dude</div>
          <input type="text" class="dude-search" placeholder="Search records...">
          <div class="dude-filters">
            <select class="dude-filter-kind">
              <option value="all">All Kinds</option>
              <option value="issue">Issue</option>
              <option value="spec">Spec</option>
              <option value="arch">Arch</option>
              <option value="update">Update</option>
            </select>
            <select class="dude-filter-status">
              <option value="all">All Status</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <select class="dude-filter-project">
            <option value="*">All Projects</option>
          </select>
        </div>
        <ul class="dude-record-list"></ul>
      </div>
      <div class="dude-main">
        <div class="dude-detail" style="display:none"></div>
        <div class="dude-empty">Select a record to view</div>
        <div class="dude-not-installed" style="display:none">
          <div class="dude-not-installed-card">
            <div class="icon">&#128218;</div>
            <h3>Dude plugin not found</h3>
            <p>Install the dude-claude-plugin to browse your project records, issues, and specifications.</p>
            <a href="https://github.com/fingerskier/claude-plugins" target="_blank">View on GitHub</a>
          </div>
        </div>
      </div>
    `;

    const searchInput = wrapper.querySelector('.dude-search');
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => dudeLoadRecords(wrapper), 500);
    });

    const kindSelect = wrapper.querySelector('.dude-filter-kind');
    const statusSelect = wrapper.querySelector('.dude-filter-status');
    const projectSelect = wrapper.querySelector('.dude-filter-project');

    kindSelect.addEventListener('change', () => dudeLoadRecords(wrapper));
    statusSelect.addEventListener('change', () => dudeLoadRecords(wrapper));
    projectSelect.addEventListener('change', () => dudeLoadRecords(wrapper));
  },
  async onActivate(wrapper) {
    const installed = await window.termParty.dudeCheckInstalled();
    const notInstalledEl = wrapper.querySelector('.dude-not-installed');
    const emptyEl = wrapper.querySelector('.dude-empty');
    const sidebarEl = wrapper.querySelector('.dude-sidebar');

    if (!installed) {
      notInstalledEl.style.display = '';
      emptyEl.style.display = 'none';
      sidebarEl.style.display = 'none';
      return;
    }

    notInstalledEl.style.display = 'none';
    sidebarEl.style.display = '';

    // Load projects into dropdown
    const projectSelect = wrapper.querySelector('.dude-filter-project');
    const projects = await window.termParty.dudeListProjects();
    if (projects && !projects.error && Array.isArray(projects)) {
      dudeProjects = projects;
      // Rebuild options keeping the current selection
      const current = projectSelect.value;
      projectSelect.innerHTML = '<option value="*">All Projects</option>';
      for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = p.name || p.directory || '';
        opt.textContent = p.name || p.directory || 'Unknown';
        projectSelect.appendChild(opt);
      }
      if (current && current !== '*') projectSelect.value = current;
    }

    dudeLoadRecords(wrapper);
  },
});

function dudeGetFilters(wrapper) {
  const kind = wrapper.querySelector('.dude-filter-kind').value;
  const status = wrapper.querySelector('.dude-filter-status').value;
  const project = wrapper.querySelector('.dude-filter-project').value;
  const filters = {};
  if (kind !== 'all') filters.kind = kind;
  if (status !== 'all') filters.status = status;
  if (project !== '*') filters.project = project;
  return filters;
}

async function dudeLoadRecords(wrapper) {
  const listEl = wrapper.querySelector('.dude-record-list');
  if (!listEl) return;

  const searchInput = wrapper.querySelector('.dude-search');
  const query = searchInput ? searchInput.value.trim() : '';
  const filters = dudeGetFilters(wrapper);

  let records;
  if (query) {
    records = await window.termParty.dudeSearch(query, filters);
  } else {
    records = await window.termParty.dudeListRecords(filters);
  }

  listEl.innerHTML = '';

  if (!records || records.error) {
    listEl.innerHTML = `<div class="panel-empty">${records?.error || 'Failed to load records'}</div>`;
    return;
  }

  const items = Array.isArray(records) ? records : (records.results || []);

  if (items.length === 0) {
    listEl.innerHTML = '<div class="panel-empty">No records found</div>';
    return;
  }

  for (const rec of items) {
    const li = document.createElement('li');
    li.dataset.recordId = String(rec.id);
    if (dudeSelectedRecordId === rec.id) li.classList.add('selected');

    const titleRow = document.createElement('div');
    titleRow.className = 'dude-record-title-row';

    const kindBadge = document.createElement('span');
    kindBadge.className = `kind-badge kind-${rec.kind || 'issue'}`;
    kindBadge.textContent = rec.kind || 'issue';
    titleRow.appendChild(kindBadge);

    const title = document.createElement('span');
    title.className = 'dude-record-title';
    title.textContent = rec.title || '(untitled)';
    titleRow.appendChild(title);

    li.appendChild(titleRow);

    const meta = document.createElement('div');
    meta.className = 'dude-record-meta';
    const parts = [];
    if (rec.project) parts.push(rec.project);
    if (rec.status) parts.push(rec.status);
    if (rec.updated_at) parts.push(formatTime(new Date(rec.updated_at).getTime()));
    meta.textContent = parts.join(' \u00b7 ');
    li.appendChild(meta);

    li.addEventListener('click', () => dudeSelectRecord(rec.id, wrapper));
    listEl.appendChild(li);
  }
}

async function dudeSelectRecord(id, wrapper) {
  dudeSelectedRecordId = id;
  const detailEl = wrapper.querySelector('.dude-detail');
  const emptyEl = wrapper.querySelector('.dude-empty');

  const record = await window.termParty.dudeGetRecord(id);

  if (!record || record.error) {
    detailEl.style.display = 'none';
    emptyEl.style.display = '';
    emptyEl.textContent = record?.error || 'Failed to load record';
    return;
  }

  emptyEl.style.display = 'none';
  detailEl.style.display = '';

  detailEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'dude-detail-header';

  const kindBadge = document.createElement('span');
  kindBadge.className = `kind-badge kind-${record.kind || 'issue'}`;
  kindBadge.textContent = record.kind || 'issue';
  header.appendChild(kindBadge);

  const statusBadge = document.createElement('span');
  statusBadge.className = `status-badge status-${record.status || 'open'}`;
  statusBadge.textContent = record.status || 'open';
  header.appendChild(statusBadge);

  detailEl.appendChild(header);

  const title = document.createElement('div');
  title.className = 'dude-detail-title';
  title.textContent = record.title || '(untitled)';
  detailEl.appendChild(title);

  if (record.project) {
    const project = document.createElement('div');
    project.className = 'dude-detail-project';
    project.textContent = record.project;
    detailEl.appendChild(project);
  }

  const dates = document.createElement('div');
  dates.className = 'dude-detail-dates';
  const dateParts = [];
  if (record.created_at) dateParts.push('Created: ' + new Date(record.created_at).toLocaleString());
  if (record.updated_at) dateParts.push('Updated: ' + formatTime(new Date(record.updated_at).getTime()));
  dates.textContent = dateParts.join(' \u00b7 ');
  detailEl.appendChild(dates);

  if (record.body) {
    const body = document.createElement('div');
    body.className = 'dude-detail-body';
    body.textContent = record.body;
    detailEl.appendChild(body);
  }

  // Update selected state in list
  const listEl = wrapper.querySelector('.dude-record-list');
  for (const li of listEl.querySelectorAll('li')) {
    li.classList.toggle('selected', li.dataset.recordId === String(id));
  }
}

// ---- Init ----

refreshList();

// Periodically refresh terminal list to update active/idle border indicators
setInterval(refreshList, 3000);
