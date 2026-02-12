const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const terminalListEl = document.getElementById('terminal-list');
const containerEl = document.getElementById('terminal-container');
const emptyStateEl = document.getElementById('empty-state');
const addBtn = document.getElementById('add-terminal');

// Map of id -> { xterm, fitAddon, disposeData }
const termViews = new Map();
let activeId = null;

// ---- Sidebar rendering ----

function renderList(terminals) {
  terminalListEl.innerHTML = '';
  for (const t of terminals) {
    const li = document.createElement('li');
    li.classList.toggle('active', t.id === activeId);
    li.dataset.id = t.id;

    const title = document.createElement('span');
    title.className = 'term-title';
    title.textContent = t.title || t.cwd;
    li.appendChild(title);

    const killBtn = document.createElement('button');
    killBtn.className = 'kill-btn';
    killBtn.title = 'Kill terminal';
    killBtn.textContent = '\u00d7';
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      killTerminal(t.id);
    });
    li.appendChild(killBtn);

    li.addEventListener('click', () => activateTerminal(t.id));
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

  termViews.set(id, { xterm, fitAddon });
}

function activateTerminal(id) {
  if (activeId === id) return;

  // Detach current terminal view
  if (activeId !== null) {
    const prev = termViews.get(activeId);
    if (prev) {
      // xterm doesn't have a native detach, so we just clear the container
      containerEl.innerHTML = '';
    }
  }

  activeId = id;
  emptyStateEl.style.display = 'none';

  let view = termViews.get(id);
  if (!view) {
    createTermView(id);
    view = termViews.get(id);
  }

  // Create a wrapper div and open xterm into it
  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  containerEl.innerHTML = '';
  containerEl.appendChild(wrapper);
  view.xterm.open(wrapper);
  view.fitAddon.fit();
  view.xterm.focus();

  // Send initial resize to backend
  window.termParty.resize(id, view.xterm.cols, view.xterm.rows);

  refreshList();
}

async function killTerminal(id) {
  await window.termParty.killTerminal(id);
  const view = termViews.get(id);
  if (view) {
    view.xterm.dispose();
    termViews.delete(id);
  }
  if (activeId === id) {
    activeId = null;
    containerEl.innerHTML = '';
    emptyStateEl.style.display = '';
  }
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
    termViews.delete(id);
  }
  if (activeId === id) {
    activeId = null;
    containerEl.innerHTML = '';
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

// ---- Init ----

refreshList();
