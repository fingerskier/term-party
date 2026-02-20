# Performance TODO

Remaining performance recommendations that were identified during audit but
not yet implemented (require larger structural changes).

## 1. Add xterm WebGL renderer

**Impact**: High for terminals with heavy output (builds, logs, large file cats)

The app currently uses xterm.js's default DOM renderer, which creates a DOM node
per cell. The WebGL addon (`@xterm/addon-webgl`) renders the entire terminal on
a single `<canvas>` using GPU acceleration — typically 5-10x faster for
high-throughput output.

```bash
npm install @xterm/addon-webgl
```

```js
// renderer.js — when creating a terminal view
import { WebglAddon } from '@xterm/addon-webgl';

const webglAddon = new WebglAddon();
term.loadAddon(webglAddon);

// Fallback to canvas/DOM if WebGL context is lost
webglAddon.onContextLoss(() => {
  webglAddon.dispose();
});
```

**Files**: `package.json`, `renderer.js`

---

## 2. Introduce a bundler (esbuild or Vite)

**Impact**: Medium — faster startup, smaller footprint

The renderer currently loads modules directly from `node_modules/` with no
tree-shaking or minification:

```js
import { Terminal } from './node_modules/@xterm/xterm/lib/xterm.mjs';
```

Using esbuild (fast, zero-config) or Vite would:
- Tree-shake unused exports from xterm and other deps
- Minify JS + CSS for faster parse time
- Bundle into a single file, reducing Electron file-read overhead

Minimal esbuild setup:
```bash
npm install --save-dev esbuild
```
```json
// package.json scripts
"bundle": "esbuild renderer.js --bundle --outfile=dist/renderer.js --format=esm --platform=browser"
```

**Files**: `package.json`, `index.html` (update script src), new build step

---

## 3. Use event delegation on sidebar terminal list

**Impact**: Low-Medium — reduces memory allocations on every poll cycle

Currently each `<li>` in `#terminal-list` gets its own set of event listeners
(click, dragstart, dragover, dragleave, drop, dragend, contextmenu) — all
recreated every 5 seconds on refresh.

Event delegation attaches a single listener on the parent `<ul>` and uses
`e.target.closest('li')` to determine which item was interacted with. This
eliminates hundreds of listener allocations per refresh cycle.

```js
terminalListEl.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = li.dataset.id;
  // handle click for this terminal id...
});
```

**Files**: `renderer.js`

---

## 4. Replace tail buffer string concatenation with a ring buffer

**Impact**: Low — matters only for extremely high-throughput terminals

The current tail buffer implementation (`main.js`) does:
```js
tailBuffer += data;
if (tailBuffer.length > TAIL_BUFFER_SIZE) {
  tailBuffer = tailBuffer.slice(-TAIL_BUFFER_SIZE);
}
```

Every `onData` event creates a new string via concatenation, then potentially
another via `slice`. For a terminal streaming continuous output (e.g.
`yes | head -1000000`), this generates significant GC pressure.

A circular buffer using a fixed-size `Buffer` or array with head/tail pointers
would avoid all allocations in the hot path.

**Files**: `main.js`

---

## 5. Pause dashboard polling when panel is not visible

**Impact**: Low — saves 2 IPC round-trips + CPU stat computation every 2 seconds

`refreshDashboard()` runs on a 2-second interval regardless of whether the
dashboard panel is currently visible. When the user is viewing a terminal or
the favorites panel, these IPC calls and DOM updates are wasted.

```js
// Only poll when dashboard is the active view
let dashboardInterval = null;

function startDashboardPolling() {
  if (!dashboardInterval) {
    dashboardInterval = setInterval(refreshDashboard, 2000);
    refreshDashboard(); // immediate first refresh
  }
}

function stopDashboardPolling() {
  if (dashboardInterval) {
    clearInterval(dashboardInterval);
    dashboardInterval = null;
  }
}
```

**Files**: `renderer.js`
