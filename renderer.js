import { Terminal } from './node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from './node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const terminalListEl = document.getElementById('terminal-list');
const containerEl = document.getElementById('terminal-container');
const emptyStateEl = document.getElementById('empty-state');
const addBtn = document.getElementById('add-terminal');

// Map of id -> { xterm, fitAddon, wrapper, opened }
const termViews = new Map();
let activeId = null;

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

    li.appendChild(killBtn);
    terminalListEl.appendChild(li);
  }
}

async function refreshList() {
  const terminals = await window.termParty.getTerminals();
  renderList(terminals);
}

// ---- Terminal views ----

function createTermView(id) {
  const xterm = new Terminal({
    fontSize: 14,
    fontFamily: '"Fira Code", "Cascadia Code", Menlo, monospace',
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#cba6f7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
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
