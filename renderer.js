import { Terminal } from './node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from './node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const terminalListEl = document.getElementById('terminal-list');
const containerEl = document.getElementById('terminal-container');
const emptyStateEl = document.getElementById('empty-state');
const addBtn = document.getElementById('add-terminal');
const favoritesModalEl = document.getElementById('favorites-modal');
const favoritesListEl = document.getElementById('favorites-list');
const favoritesEmptyEl = document.getElementById('favorites-empty');
const openFavoritesBtn = document.getElementById('open-favorites');

// Map of id -> { xterm, fitAddon, wrapper, opened }
const termViews = new Map();
let activeId = null;
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

// ---- Favorites modal ----

function openFavoritesModal() {
  renderFavorites(currentFavorites);
  favoritesModalEl.style.display = '';
}

function closeFavoritesModal() {
  favoritesModalEl.style.display = 'none';
}

openFavoritesBtn.addEventListener('click', openFavoritesModal);

favoritesModalEl.addEventListener('click', (e) => {
  if (e.target === favoritesModalEl) {
    closeFavoritesModal();
  }
});

favoritesModalEl.querySelector('.modal-close-btn').addEventListener('click', closeFavoritesModal);

function startInlineRename(li, termId, titleSpan) {
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
      window.termParty.renameTerminal(termId, newName);
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

// ---- Sidebar rendering ----

function renderList(terminals) {
  terminalListEl.innerHTML = '';
  for (const t of terminals) {
    const li = document.createElement('li');
    li.classList.toggle('active', t.id === activeId);
    li.dataset.id = t.id;

    if (t.ghost) {
      li.classList.add('ghost');
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
        startInlineRename(li, t.id, title);
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
  await loadAndRenderFavorites();
  const terminals = await window.termParty.getTerminals();
  renderList(terminals);
}

// ---- Favorites ----

async function loadAndRenderFavorites() {
  currentFavorites = await window.termParty.getFavorites();
  favoriteCwds = new Set(currentFavorites.map(f => f.cwd));
  renderFavorites(currentFavorites);
}

function renderFavorites(favorites) {
  favoritesListEl.innerHTML = '';

  if (favorites.length === 0) {
    favoritesEmptyEl.style.display = '';
    return;
  }
  favoritesEmptyEl.style.display = 'none';

  for (const fav of favorites) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'fav-name';
    name.textContent = fav.name;
    li.appendChild(name);

    const cwdSpan = document.createElement('span');
    cwdSpan.className = 'fav-cwd';
    cwdSpan.textContent = fav.cwd;
    cwdSpan.title = fav.cwd;
    li.appendChild(cwdSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fav-remove-btn';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove favorite';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFavorite(fav.cwd);
    });
    li.appendChild(removeBtn);

    li.addEventListener('click', () => {
      closeFavoritesModal();
      spawnFromFavorite(fav.cwd);
    });

    favoritesListEl.appendChild(li);
  }
}

async function spawnFromFavorite(cwd) {
  const info = await window.termParty.createTerminal(cwd);
  activateTerminal(info.id);
  refreshList();
}

async function removeFavorite(cwd) {
  await window.termParty.removeFavorite(cwd);
  refreshList();
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

  // Re-render immediately with optimistic state
  renderFavorites(currentFavorites);
  const terminals = await window.termParty.getTerminals();
  renderList(terminals);

  // Fire IPC then reconcile with backend state
  try {
    if (isFav) {
      await window.termParty.removeFavorite(cwd);
    } else {
      await window.termParty.addFavorite(name, cwd);
    }
  } catch {
    // on failure, reconciliation below will correct the UI
  }

  // Reconcile from authoritative backend
  await loadAndRenderFavorites();
  const termsFinal = await window.termParty.getTerminals();
  renderList(termsFinal);
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

  // Intercept Ctrl+V for paste and Ctrl+C for copy (when selection exists)
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Ctrl+PageUp/PageDown → terminal switching (handled at document level)
    if (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      return false;
    }
    // Ctrl+V or Ctrl+Shift+V → paste from clipboard
    if (e.ctrlKey && e.key === 'v') {
      navigator.clipboard.readText().then(text => {
        if (text) window.termParty.sendInput(id, text);
      });
      return false;
    }
    // Ctrl+C with selection → copy to clipboard
    if (e.ctrlKey && e.key === 'c' && xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection());
      return false;
    }
    return true;
  });

  // Persistent wrapper — lives in the DOM until the terminal is killed
  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.display = 'none';
  containerEl.appendChild(wrapper);

  // Drag-and-drop support
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

function activateTerminal(id) {
  if (activeId === id) return;

  // Hide previous terminal's wrapper
  if (activeId !== null) {
    const prev = termViews.get(activeId);
    if (prev) {
      prev.wrapper.style.display = 'none';
    }
  }

  activeId = id;
  emptyStateEl.style.display = 'none';

  let view = termViews.get(id);
  if (!view) {
    createTermView(id);
    view = termViews.get(id);
  }

  // Show wrapper and open xterm only once
  view.wrapper.style.display = '';
  if (!view.opened) {
    view.xterm.open(view.wrapper);
    view.opened = true;
  }
  view.fitAddon.fit();
  view.xterm.focus();

  window.termParty.resize(id, view.xterm.cols, view.xterm.rows);
  refreshList();
}

async function killTerminal(id) {
  await window.termParty.killTerminal(id);
  const view = termViews.get(id);
  if (view) {
    view.xterm.dispose();
    view.wrapper.remove();
    termViews.delete(id);
  }
  if (activeId === id) {
    activeId = null;
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
  if (activeId === id) {
    activeId = null;
    emptyStateEl.style.display = '';
  }
  refreshList();
});

// ---- Resize handling ----

window.addEventListener('resize', () => {
  if (activeId !== null) {
    const view = termViews.get(activeId);
    if (view) {
      view.fitAddon.fit();
    }
  }
});

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && favoritesModalEl.style.display !== 'none') {
    closeFavoritesModal();
    return;
  }

  if (!e.ctrlKey) return;
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return;

  e.preventDefault();
  const ids = getTerminalIds();
  if (ids.length === 0) return;

  const idx = ids.indexOf(activeId);
  let next;
  if (e.key === 'PageUp') {
    next = idx <= 0 ? ids[ids.length - 1] : ids[idx - 1];
  } else {
    next = idx < 0 || idx >= ids.length - 1 ? ids[0] : ids[idx + 1];
  }
  activateTerminal(next);
});

// ---- Init ----

refreshList();
