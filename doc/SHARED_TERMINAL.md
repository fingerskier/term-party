# Shared Terminal Sessions

Live terminal sharing via PeerJS/WebRTC. Host streams a `node-pty` session to browser-based guests over P2P data channels. Host owns the shell; guests view and optionally type.

## Architecture

```
HOST (Electron)                WebRTC DataChannel              GUEST (Browser)
┌──────────────────┐    pty output (binary) ──────────►    ┌─────────────────┐
│ node-pty ↔ xterm │    ◄────────── keystrokes (binary)    │ xterm (render)  │
│ local filesystem │         PeerJS (signaling only)       │ static web page │
└──────────────────┘                                       └─────────────────┘
```

| Decision | Choice | Why |
|---|---|---|
| Signaling | PeerJS cloud (self-host later) | Zero-config, free tier |
| Transport | WebRTC DataChannel | P2P, low latency, no relay |
| Guest client | Browser + xterm.js | No install for guests |
| Permissions | Host controls per-guest | Host's filesystem |

## Codebase Integration Points

| File | Role | What changes |
|---|---|---|
| `main.js` | Electron main process, PTY lifecycle | Add PeerJS host logic; hook into existing `ptyProcess.onData` (line ~355) and `tailBuffer` for scrollback replay |
| `renderer.js` | UI, xterm rendering | Add Share button to terminal toolbar; session panel UI; IPC calls for share/stop/kick/permissions |
| `preload.js` | IPC bridge (`window.termParty`) | Expose new IPC channels: `share-terminal`, `stop-sharing`, `set-guest-permission`, `kick-guest`, `on-guest-connect`, `on-guest-disconnect` |
| `index.html` / `style.css` | Layout, styles | Share button, session panel, shared-terminal visual indicator (border/banner) |
| **New:** `guest/index.html` | Guest web client | Static page: xterm.js + PeerJS. Served by host Electron (LAN) or hosted externally |

**Existing patterns to follow:**
- PTY data flow: `pty.onData → IPC 'terminal-data' → renderer` — sharing taps into the same `onData` handler
- Existing `tailBuffer` (4096 bytes, `main.js` ~355) can be expanded or replaced with a ring buffer for scrollback replay
- IPC pattern: `ipcMain.handle` / `ipcRenderer.invoke` for request-response; `webContents.send` / `ipcRenderer.on` for events

## Data Protocol

Two logical channels over a single WebRTC DataConnection:

### Binary — terminal I/O

```
Host → Guest:  raw PTY output (Uint8Array)
Guest → Host:  raw keystrokes (Uint8Array)
```

Same bytes that flow between node-pty and xterm locally. No transformation.

### JSON — control messages

**Host → Guest:**

| type | fields | when |
|---|---|---|
| `session-info` | `hostName`, `terminalTitle`, `permissions`, `cols`, `rows` | On connect |
| `permission-change` | `permissions` (`"read-write"` or `"view-only"`) | Host toggles |
| `resize` | `cols`, `rows` | Host terminal resizes |
| `session-end` | `reason` | Host stops sharing / kicks guest |

**Guest → Host:**

| type | fields | when |
|---|---|---|
| `guest-info` | `name` (required), `clientVersion` | On connect |
| `resize-request` | `cols`, `rows` | Advisory; host may ignore |

### Terminal Sync

On guest connect: host sends scrollback buffer (last ~100KB of PTY output) as the first binary message, then streams live. Host dimensions are authoritative; guest xterm matches host cols/rows.

## User Flow

**Host:** Click Share on terminal tab → peer ID generated → shareable link displayed → copy to clipboard → guests connect → manage via session panel → Stop Sharing to end.

**Guest:** Open link in browser → enter name → Join → WebRTC connects → terminal renders in real time → keystrokes sent if write-permitted.

## UI Components

**Share button** (per terminal tab toolbar):
- Idle: share icon
- Sharing, no guests: pulsing indicator + "Copy Link"
- Sharing, guests connected: guest count badge → opens session panel

**Session panel** (slide-out/popover):
- Share link with copy button
- Guest list: name, permission toggle (view-only ↔ read-write), kick button
- "Stop Sharing" button

**Shared indicator:** Colored border or banner on shared terminal tab.

## Security

- Guest sees all terminal output — host must opt in per tab
- First-share warning: *"Everything in this terminal will be visible to guests."*
- WebRTC data channels are DTLS-encrypted; terminal data never touches PeerJS signaling server
- Peer IDs: `tp-` + 8 random alphanumeric chars; ephemeral (invalidated on stop)
- Optional session password (Phase 3)

## Configuration

```json
{
  "sharing": {
    "enabled": true,
    "defaultPermission": "read-write",
    "scrollbackBufferSize": 102400,
    "maxGuests": 5,
    "peerServer": { "useCloud": true, "host": null, "port": null, "path": null },
    "requirePassword": false,
    "showWarningOnFirstShare": true
  }
}
```

## Implementation Phases

### Phase 1 — MVP

- `npm install peerjs` (only new dependency; xterm already present)
- `TerminalShareHost` class in main process: PeerJS peer, guest map, scrollback ring buffer, broadcast
- Guest static page (`guest/index.html`): xterm.js + PeerJS + `TerminalShareGuest` class
- Binary data channel (PTY I/O) + JSON control channel
- Share button in renderer, IPC wiring through preload
- Required guest name entry

### Phase 2 — Permissions & Polish

- Session panel UI with guest list
- Per-guest permission toggle, kick
- Visual shared-terminal indicator
- First-share security warning dialog

### Phase 3 — Audio & Hardening

- WebRTC audio channel (voice chat)
- Reconnection handling
- Session password/PIN
- LAN-only mode (Electron serves guest page)
- Connection quality indicator
- Multi-tab simultaneous sharing

### Phase 4 — Stretch

- Chat sidebar
- Session recording/playback
- Self-hosted PeerJS server
- Electron-to-Electron sharing
- Mobile guest support

## Resolved Decisions

1. **Guest identity** — Required name; no anonymous access
2. **Multi-cursor** — Not applicable (terminal cursor is program-controlled)
3. **PeerJS** — Cloud for now; self-host later if needed
4. **Audio** — Yes, Phase 3
5. **Mobile** — Not now
