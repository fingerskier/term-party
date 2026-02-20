# Term-Party: Shared Terminal Sessions

## Feature Spec — Collaborative Terminal Sharing via PeerJS

---

## Overview

Add the ability for a term-party user to share a live terminal session with another user for real-time collaboration. The host's terminal (backed by `node-pty`) is streamed to one or more guests via WebRTC data channels, using PeerJS for peer discovery and connection management. The host retains full ownership — their file system, their shell, their session.

---

## Goals

- Allow a user to share any open terminal tab with a remote collaborator via a simple link or code
- Support real-time bidirectional terminal interaction (both users can type)
- Minimal infrastructure — PeerJS handles signaling, WebRTC handles transport
- No server-side relay of terminal data
- Clean UX: one click to share, one click to join

---

## Architecture

```
┌─────────────────────────┐         WebRTC DataChannel          ┌──────────────────────────┐
│       HOST (Electron)   │◄──────────────────────────────────►│      GUEST (Browser)      │
│                         │                                     │                           │
│  node-pty ◄──► xterm.js │   pty output ──────────────────►   │  xterm.js (render only*)  │
│       ▲                 │   ◄────────────────── keystrokes    │                           │
│       │                 │                                     │                           │
│  local filesystem       │         PeerJS (signaling)          │  Lightweight web client   │
└─────────────────────────┘                                     └──────────────────────────┘

* Guests can type if granted write permission by host
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Signaling | PeerJS (cloud or self-hosted) | Zero-config discovery, free tier sufficient, optional self-host later |
| Transport | WebRTC DataChannel | P2P, low latency, no relay server for terminal bytes |
| Guest client | Browser-based (xterm.js) | No install required for guests, maximum accessibility |
| Permission model | Host controls read/write per guest | Safety — it's the host's filesystem |

---

## User Flow

### Host (Sharing a Terminal)

1. User has a terminal tab open in term-party
2. Clicks **Share** button (or toolbar icon) on that terminal tab
3. App generates a PeerJS peer ID and registers with the signaling server
4. A shareable link is displayed: `https://termparty.app/join/<peer-id>` (or a short code)
5. User copies link / sends to collaborator
6. Host sees a "Waiting for connection..." indicator
7. When guest connects, host sees a notification and guest's name/identifier in a session panel
8. Host can toggle guest between **view-only** and **read-write** modes
9. Host can **kick** a guest or **end** the shared session at any time

### Guest (Joining a Terminal)

1. Guest opens the shared link in a browser
2. Browser client loads a lightweight page with a **name entry prompt** (required before connecting)
3. Guest enters their name and clicks "Join"
4. PeerJS connects to the host's peer ID via signaling server
5. WebRTC DataChannel is established
6. Guest's xterm.js begins rendering the host's terminal output in real time
7. If granted write access, guest's keystrokes are sent to the host and written to `pty.write()`
8. Guest sees a banner: "Connected to [host name]'s terminal — [view-only | read-write]"

---

## Data Protocol

All messages over the WebRTC DataChannel are framed as simple JSON or raw bytes:

### Channel: `terminal-data` (binary)

```
Host → Guest:  raw PTY output bytes (Uint8Array)
Guest → Host:  raw keystroke bytes (Uint8Array)
```

Binary channel for minimal overhead. This is the same data that flows between `node-pty` and `xterm.js` locally — no transformation needed.

### Channel: `control` (JSON)

```json
// Host → Guest: session metadata on connect
{
  "type": "session-info",
  "hostName": "Matt",
  "terminalTitle": "~/projects/osteostrong",
  "permissions": "read-write",
  "cols": 120,
  "rows": 40
}

// Host → Guest: permission change
{
  "type": "permission-change",
  "permissions": "view-only"
}

// Host → Guest: terminal resize
{
  "type": "resize",
  "cols": 120,
  "rows": 40
}

// Guest → Host: request resize (host decides whether to honor)
{
  "type": "resize-request",
  "cols": 100,
  "rows": 30
}

// Host → Guest: session ended
{
  "type": "session-end",
  "reason": "Host ended the session"
}

// Guest → Host: guest info on connect (name required)
{
  "type": "guest-info",
  "name": "Remote User",
  "clientVersion": "1.0.0"
}
```

---

## Terminal Sync Strategy

### Initial Sync (Scrollback Replay)

When a guest connects, they need to see the current terminal state, not a blank screen.

**Approach:** The host maintains a scrollback buffer (ring buffer of the last N bytes of PTY output, e.g. 100KB). On guest connect, the host sends the buffered output as the first message on the `terminal-data` channel before streaming live data.

```
[Guest connects]
  → Host sends: scrollback buffer (bulk replay)
  → Host sends: live PTY output (streaming)
```

This gives the guest immediate context without requiring terminal state serialization.

### Resize Handling

- The host's terminal dimensions are authoritative
- Guest's xterm.js is configured to match the host's `cols` and `rows`
- If the host resizes, a `resize` control message is sent and the guest's xterm adjusts
- Guest resize requests are advisory — the host can ignore them (since the PTY is sized to the host's terminal)

---

## PeerJS Integration

### Host Side

```js
import Peer from 'peerjs';

class TerminalShareHost {
  constructor(ptyProcess, options = {}) {
    this.pty = ptyProcess;
    this.peer = null;
    this.guests = new Map(); // peerId → { conn, permissions, name }
    this.scrollbackBuffer = new RingBuffer(options.scrollbackSize || 102400);

    // Capture PTY output into scrollback buffer
    this.pty.onData((data) => {
      this.scrollbackBuffer.write(data);
      this.broadcastToGuests(data);
    });
  }

  async startSharing() {
    // Generate a readable peer ID or use random
    const peerId = `tp-${generateShortId()}`;
    this.peer = new Peer(peerId, {
      // Optional: self-hosted PeerJS server
      // host: 'peer.termparty.app',
      // port: 9000,
      // path: '/signal'
    });

    return new Promise((resolve, reject) => {
      this.peer.on('open', (id) => {
        this.setupConnectionHandler();
        resolve(id); // Return peer ID for share link
      });
      this.peer.on('error', reject);
    });
  }

  setupConnectionHandler() {
    this.peer.on('connection', (conn) => {
      conn.on('open', () => {
        // Register guest
        this.guests.set(conn.peer, {
          conn,
          permissions: 'read-write', // default, host can change
          name: 'Unknown'
        });

        // Send session info
        conn.send(JSON.stringify({
          type: 'session-info',
          hostName: this.hostName,
          permissions: 'read-write',
          cols: this.pty.cols,
          rows: this.pty.rows
        }));

        // Send scrollback for initial sync
        const buffer = this.scrollbackBuffer.read();
        conn.send(buffer); // binary

        // Handle incoming data from guest
        conn.on('data', (data) => this.handleGuestData(conn.peer, data));
        conn.on('close', () => this.guests.delete(conn.peer));
      });
    });
  }

  handleGuestData(peerId, data) {
    // JSON control messages
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'guest-info') {
        this.guests.get(peerId).name = msg.name;
      }
      return;
    }

    // Binary keystroke data — only if guest has write permission
    const guest = this.guests.get(peerId);
    if (guest?.permissions === 'read-write') {
      this.pty.write(data);
    }
  }

  broadcastToGuests(data) {
    for (const [, guest] of this.guests) {
      if (guest.conn.open) {
        guest.conn.send(data);
      }
    }
  }

  setGuestPermission(peerId, permission) {
    const guest = this.guests.get(peerId);
    if (guest) {
      guest.permissions = permission;
      guest.conn.send(JSON.stringify({
        type: 'permission-change',
        permissions: permission
      }));
    }
  }

  stopSharing() {
    for (const [, guest] of this.guests) {
      guest.conn.send(JSON.stringify({
        type: 'session-end',
        reason: 'Host ended the session'
      }));
      guest.conn.close();
    }
    this.guests.clear();
    this.peer.destroy();
  }
}
```

### Guest Side (Browser Client)

```js
import Peer from 'peerjs';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

class TerminalShareGuest {
  constructor(hostPeerId, containerElement) {
    this.hostPeerId = hostPeerId;
    this.terminal = new Terminal({ cursorBlink: true });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(containerElement);
    this.permissions = 'view-only';
  }

  async connect() {
    this.peer = new Peer(); // anonymous peer ID

    return new Promise((resolve, reject) => {
      this.peer.on('open', () => {
        const conn = this.peer.connect(this.hostPeerId, {
          reliable: true,
          serialization: 'binary'
        });

        conn.on('open', () => {
          this.conn = conn;

          // Send guest info (name is required)
          conn.send(JSON.stringify({
            type: 'guest-info',
            name: this.guestName, // required before connect
            clientVersion: '1.0.0'
          }));

          // Handle incoming data
          conn.on('data', (data) => this.handleHostData(data));
          conn.on('close', () => this.onDisconnect());

          resolve();
        });

        conn.on('error', reject);
      });
    });
  }

  handleHostData(data) {
    // JSON control messages
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'session-info':
          this.terminal.resize(msg.cols, msg.rows);
          this.permissions = msg.permissions;
          break;
        case 'permission-change':
          this.permissions = msg.permissions;
          break;
        case 'resize':
          this.terminal.resize(msg.cols, msg.rows);
          break;
        case 'session-end':
          this.onSessionEnd(msg.reason);
          break;
      }
      return;
    }

    // Binary terminal output — render it
    this.terminal.write(new Uint8Array(data));
  }

  setupInput() {
    this.terminal.onData((data) => {
      if (this.permissions === 'read-write' && this.conn?.open) {
        // Send keystrokes as binary
        this.conn.send(new TextEncoder().encode(data));
      }
    });
  }
}
```

---

## Guest Web Client

A lightweight static page served by the host's Electron app (or hosted separately):

**Route:** `https://termparty.app/join/:peerId`

The page bundles only xterm.js, xterm CSS, PeerJS, and the `TerminalShareGuest` class. No server-side logic — it's purely a WebRTC client that connects to the host's peer.

### Electron-hosted option

The host's Electron app can optionally serve the guest page on a local port (e.g., `http://192.168.1.x:3456/join/tp-abc123`) for LAN-only sharing without any external infrastructure.

---

## UI Components (Host — Electron App)

### Share Button

Added to each terminal tab's toolbar. States:

- **Idle:** Share icon → click to start sharing
- **Sharing (no guests):** Pulsing indicator + "Copy Link" button + short code display
- **Sharing (guests connected):** Guest count badge, click to open session panel

### Session Panel

A slide-out or popover panel showing:

- Share link / short code with copy button
- List of connected guests with:
  - Name / identifier
  - Permission toggle (view-only ↔ read-write)
  - Kick button
- "Stop Sharing" button

### Guest Cursor Indicators (Stretch Goal)

Show where the remote user's cursor focus is in the terminal. This is non-trivial with terminal emulators and is a nice-to-have for a later iteration.

---

## Security Considerations

### What the guest can access

The guest can see everything the terminal outputs. If the host runs `cat /etc/passwd`, the guest sees it. If the host has environment variables with secrets, `env` would expose them.

**Mitigations:**

- Host must explicitly choose to share a specific terminal tab
- Clear visual indicator that a terminal is being shared (colored border, banner)
- Warning on first share: "Everything in this terminal will be visible to connected guests, including command output and any sensitive information displayed."
- Host can revoke access instantly

### WebRTC Security

- All WebRTC data channels are DTLS-encrypted by default
- No terminal data passes through the PeerJS signaling server (only SDP offers/answers and ICE candidates)
- PeerJS cloud server sees peer IDs and connection metadata but never terminal content

### Peer ID Guessability

- Use sufficiently random peer IDs (e.g., `tp-` + 8 random alphanumeric chars)
- Optional: require a session password that the guest must enter before the host accepts the connection
- Sessions are ephemeral — peer ID is invalidated when sharing stops

---

## Configuration

```json
{
  "sharing": {
    "enabled": true,
    "defaultPermission": "read-write",
    "scrollbackBufferSize": 102400,
    "maxGuests": 5,
    "peerServer": {
      "useCloud": true,
      "host": null,
      "port": null,
      "path": null
    },
    "requirePassword": false,
    "showWarningOnFirstShare": true
  }
}
```

---

## Implementation Plan

### Phase 1 — Core Sharing (MVP)

- [ ] PeerJS integration in the host Electron app
- [ ] `TerminalShareHost` class wrapping node-pty with scrollback buffer
- [ ] `TerminalShareGuest` browser client page with xterm.js
- [ ] Required guest name entry before connecting
- [ ] Share button on terminal tabs (generates link, copies to clipboard)
- [ ] Basic session management (connect, disconnect, stop sharing)
- [ ] Binary data channel for terminal I/O
- [ ] JSON control channel for metadata and resize

### Phase 2 — Permissions & UX

- [ ] Session panel UI with guest list
- [ ] Per-guest permission toggle (view-only / read-write)
- [ ] Kick guest functionality
- [ ] Visual indicator on shared terminal tabs (border color, banner)
- [ ] First-share security warning dialog

### Phase 3 — Audio & Hardening

- [ ] WebRTC audio channel (voice chat between host and guests)
- [ ] Audio mute/unmute controls in session panel
- [ ] Reconnection handling (guest disconnects and rejoins)
- [ ] Session password / PIN option
- [ ] LAN-only mode (Electron serves guest page locally)
- [ ] Connection quality indicator
- [ ] Multiple terminal tabs shared simultaneously
- [ ] Guest count limits

### Phase 4 — Stretch Goals

- [ ] Chat sidebar alongside shared terminal
- [ ] Session recording / playback
- [ ] Self-hosted PeerJS server option (for enterprise/restricted networks)
- [ ] Electron-to-Electron direct sharing (guest uses term-party too)
- [ ] Mobile guest support

---

## Dependencies

| Package | Purpose | Install |
|---------|---------|---------|
| `peerjs` | WebRTC signaling + connection | `npm install peerjs` |
| `xterm` | Terminal rendering (guest side) | `npm install xterm` |
| `xterm-addon-fit` | Terminal auto-sizing | `npm install xterm-addon-fit` |

Host already has `node-pty` and `xterm` — only PeerJS is new. Guest client is a standalone static page.

---

## Resolved Decisions

1. **Guest identity** — Required. Guests must enter a name before connecting. No anonymous access.
2. **Multi-cursor** — Not pursuing. Terminal cursor is program-controlled, not user-controlled — multi-cursor doesn't apply meaningfully here.
3. **PeerJS cloud vs self-hosted** — PeerJS cloud for now. Revisit self-hosting if needed for enterprise/network-restricted deployments later.
4. **Audio** — Yes, include a WebRTC audio channel. Added to Phase 3. Guests and host can voice chat alongside the shared terminal.
5. **Mobile guest** — Desktop only for now. No mobile optimization.
