# gproxy spec — v1

Remotely view and drive a Chrome tab that runs on the **work Mac**, rendered
inside a tab of your own Chrome on the **personal Mac**, connected over
Tailscale.

Purpose: Google Workspace context-aware access blocks the personal Mac by
device posture. The Google session therefore lives in a dedicated
**"appliance" Chrome** instance on the work Mac (which passes the posture
check). The personal Mac streams that tab's pixels and sends input back. The
session never leaves the work Mac.

## Topology

```
personal Mac                             work Mac
┌──────────────────────┐   Tailscale    ┌─────────────────────────────┐
│ Chrome extension     │                │ agent (Node, launchd)       │
│  - action button     │── HTTP :7654 ─▶│   :7654 HTTP + WebSocket    │
│  - viewer.html tab   │◀─ WS frames ── │        │                    │
│    (canvas + input)  │── WS input ──▶ │        │ CDP ws://127.0.0.1 │
└──────────────────────┘                │        ▼ :7655              │
                                        │ appliance Chrome            │
                                        │  ~/.local/share/gproxy/     │
                                        │  chrome-profile (own        │
                                        │  user-data-dir, signed into │
                                        │  the work Google account)   │
                                        └─────────────────────────────┘
```

## File ownership (hard boundaries — do not write outside your own)

- `agent/` — Node server, owned by the agent-builder. `agent/package.json`,
  `agent/src/*.js`, `agent/test/smoke.mjs`.
- `extension/` — Chrome MV3 extension, owned by the extension-builder.
  `manifest.json`, `background.js`, `viewer.html`, `viewer.js`,
  `options.html`, `options.js`.
- `mise.toml`, `README.md`, `.gitignore`, `deploy/` — owned by the
  scaffold-builder. `deploy/com.gproxy.agent.plist`, `deploy/install.sh`,
  `deploy/uninstall.sh`.
- Agent entrypoint (referenced by deploy + mise): `agent/src/index.js`.

## Config (work Mac, agent side)

File `~/.config/gproxy/config.json`, all keys optional, env vars override:

```json
{
  "port": 7654,
  "cdpPort": 7655,
  "token": "<32-hex, generated on first run if missing, printed to stdout>",
  "chromePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "profileDir": "~/.local/share/gproxy/chrome-profile",
  "quality": 70,
  "staleMin": 10
}
```

`staleMin`: minutes a tab with no connected viewer survives before the agent
closes it via CDP.

## Auth

- HTTP: `Authorization: Bearer <token>` on every non-`/health` route.
- WebSocket: `?token=<token>` query param (browser WS cannot set headers).
- Wrong token → HTTP 401 / WS close code 4001.
- The agent binds `0.0.0.0:port` (reachable over Tailscale; Tailscale
  provides the network isolation, the token is defense-in-depth).
- CDP debug port stays bound to 127.0.0.1; the agent is the only bridge.

## HTTP API (agent)

- `GET /health` → `200 {"ok":true,"chrome":true,"version":"1.0.0"}`
  (`chrome:false` if CDP is unreachable)
- `POST /v1/open` body `{"url":"https://..."}` → `200 {"tabId":"<targetId>","url":"..."}`
  — creates a tab in appliance Chrome, applies default device metrics
  (1280×800, dpr 1), returns its targetId. Reject non-http(s) URLs with 400.
- `POST /v1/close` body `{"tabId":"..."}` → `{"ok":true}` (404 if unknown)
- `GET /v1/tabs` → `{"tabs":[{"tabId":"...","title":"...","url":"..."}]}`

## WebSocket protocol — `ws://<agent>:<port>/v1/stream/<tabId>?token=...`

All messages are JSON text frames. Exactly **one viewer per tab**: a second
connection for the same tabId kicks the first (the kicked socket gets
`{"t":"closed"}` then close). The viewer auto-reconnects (backoff 1s→5s) and
re-sends `hello`.

Client → server:

- `{"t":"hello","w":<int>,"h":<int>,"dpr":<int>}` — w/h are CSS px of the
  viewer viewport, dpr is `devicePixelRatio` clamped to 1 or 2. Agent applies
  `Emulation.setDeviceMetricsOverride({width:w,height:h,deviceScaleFactor:dpr,mobile:false})`
  and replies `{"t":"ready","w":w,"h":h,"dpr":dpr}` (effective values, after
  clamping w to [500,2560], h to [400,1600]).
- `{"t":"resize","w","h","dpr"}` — same effect, same reply.
- `{"t":"mouse","a":"move"|"down"|"up"|"wheel","x":<num>,"y":<num>,
  "btn":"left"|"right"|"middle" (down/up only, default "left"),
  "dx":<num>,"dy":<num> (wheel only),
  "clicks":<int> (down/up only, default 1),
  "mods":<int>}` — x/y are in **remote CSS px**: the viewer maps its clicks
  against the frame message's w/h, which are the remote viewport's DIP (CSS)
  dims — exactly the coordinate space `Input.dispatchMouseEvent` takes.
- `{"t":"key","a":"down"|"up","key":<str>,"code":<str>,"vk":<int>,
  "mods":<int>,"text":<str|null>}` — vk is the Windows virtual-key code.
  `text` is non-null only on "down" for printable single chars without
  ctrl/meta modifiers.
- `{"t":"text","text":<str>}` → `Input.insertText` (paste / IME).
- `{"t":"nav","url":<str>}` → `Page.navigate`.
- `{"t":"back"}` / `{"t":"forward"}` → history navigation via
  `Page.getNavigationHistory` + `Page.navigate`.
- `{"t":"ping"}` → `{"t":"pong"}` (keepalive, sent every 20s by viewer).

Server → client:

- `{"t":"ready","w","h","dpr"}`
- `{"t":"frame","d":"<base64 jpeg>","w":<int>,"h":<int>}` — w/h are the
  remote viewport's DIP (CSS) dims (screencast metadata; the jpeg itself may
  be dpr× larger or clamped, same aspect). Trust these for letterboxing and
  input mapping, not `ready`. Last-frame-wins on the viewer; coalesce draws.
  On viewer connect and after every hello/resize the agent also sends one
  synthetic frame via `Page.captureScreenshot` — an idle page may otherwise
  emit no compositor frames for minutes and the viewer would hang on
  "loading".
- `{"t":"title","title":<str>,"url":<str>}`
- `{"t":"closed"}` — tab was closed or GC'd, viewer shows "closed" state.
- `{"t":"error","msg":<str>}`
- `{"t":"pong"}`

## CDP usage (agent, exact commands)

Appliance Chrome launch (spawn detached if `http://127.0.0.1:cdpPort/json/version`
is down, respawn if it dies; log to stdout):

```
<chromePath> --user-data-dir <profileDir> --remote-debugging-port <cdpPort> \
  --no-first-run --no-default-browser-check about:blank
```

- Browser WS endpoint: from `/json/version` → `webSocketDebuggerUrl`.
- All page-domain commands use **flat sessions**: `Target.createTarget({url})`
  → targetId; `Target.attachToTarget({targetId, flatten:true})` → sessionId.
  Page commands/events carry that `sessionId`.
- On tab create: `Page.enable`, `Emulation.setDeviceMetricsOverride` (above),
  and on first viewer connect `Page.startScreencast({format:"jpeg", quality:
  <config>, maxWidth:2560, maxHeight:1600, everyFrame:true})`. On last viewer
  disconnect: `Page.stopScreencast`.
- `Page.screencastFrame` events: `{data:<base64>, metadata:{deviceWidth,
  deviceHeight,...}, sessionId:<screencastSessionId>}` — relay as
  `{"t":"frame"}` with metadata.deviceWidth/Height, **then**
  `Page.screencastFrameAck({sessionId:<screencastSessionId>})`. Ack after
  relay.
- Input:
  - mouse move → `Input.dispatchMouseEvent({type:"mouseMoved",x,y,button:"none",modifiers})`
  - down/up → `{type:"mousePressed"|"mouseReleased",x,y,button:<btn>,clickCount:<clicks>,modifiers}`
  - wheel → `{type:"mouseWheel",x,y,deltaX:dx,deltaY:dy}`
  - key down with text → `Input.dispatchKeyEvent({type:"keyDown",key,text,
    code,windowsVirtualKeyCode:nativeVirtualKeyCode:vk,modifiers})`
  - key down without text → same but `type:"rawKeyDown"`, no text
  - key up → `{type:"keyUp",key,code,windowsVirtualKeyCode,nativeVirtualKeyCode,modifiers}`
  - `text` msg → `Input.insertText({text})`
  - modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
- Title/url: on `Page.loadEventFired` and every 3s while streamed, call
  `Target.getTargetInfo(targetId)` and push `{"t":"title"}` (skip if unchanged).
- Tab lifecycle: on `Target.targetDestroyed` → push `{"t":"closed"}`, drop
  registry entry. On agent startup, `Target.getTargets` and **adopt** existing
  page targets into the registry (the appliance Chrome is dedicated — all its
  tabs are ours).
- Stale GC: a tab with zero connected viewers for `staleMin` minutes →
  `Target.closeTarget`.

## Extension behavior (personal Mac)

MV3, classic service worker, no build step, no external libs. Files:
`manifest.json`, `background.js`, `viewer.html` + `viewer.js`,
`options.html` + `options.js`.

- `manifest.json`: permissions `["tabs","storage","contextMenus"]`;
  host_permissions `["http://*/*"]`; action with default title
  "Open on work Mac"; `options_page`; `background.service_worker`.
- Options (chrome.storage.local): `agentUrl` (default
  `http://work-mac:7654`, user edits), `token` (string), `mode`
  (`"replace"` default, or `"newtab"`).
- Action click on a tab with an http(s) URL → `POST /v1/open` with the
  current URL → then **replace** the current tab (or create a new one,
  per `mode`) with
  `chrome.runtime.getURL("viewer.html") + "?tab=" + encodeURIComponent(tabId)`.
  Agent URL + token are read from storage inside the viewer — never put the
  token in a URL. Errors (agent unreachable, 401) → `chrome.notifications`?
  No: v1 surface errors as the viewer page's error state, or a badge
  (`chrome.action.setBadgeText` "!" ) on failure.
- Context menu (contexts `["link"]`): "Open link on work Mac" → always opens
  a **new** viewer tab for `info.linkUrl`.
- Viewer page (`viewer.html?tab=<tabId>`), config resolution order:
  1. query params `tab`, `agent`, `token` (enables testing the viewer as a
     plain non-extension web page), 2. `chrome.storage.local` (guard with
     `typeof chrome !== "undefined" && chrome.storage`).
- Viewer logic:
  - Full-window canvas (CSS 100vw/100vh, margin 0, no scrollbars), centered
    content; on load send `hello` with `innerWidth/innerHeight` (floored) and
    dpr; on window resize (debounced ~300ms) send `resize` with new values.
  - Draw: keep only the newest frame, draw on rAF. `img.src =
    "data:image/jpeg;base64," + d`, draw at natural size. Set
    `document.title` from `title` events; set favicon to
    `https://www.google.com/s2/favicons?domain=<host>&sz=64`.
  - Mouse: `mousemove` (throttle ~60/s) → `a:"move"`; `mousedown`/`mouseup`
    → `a:"down"/"up"` with `btn` from `e.button` (0 left, 1 middle, 2 right),
    `clicks` 2 on `dblclick` else 1; `wheel` (listener non-passive,
    preventDefault) → `a:"wheel"` with normalized `deltaX/deltaY`;
    `contextmenu` → preventDefault (right-click flows via mouse events).
    Coordinates (remote CSS px, letterbox-aware):
    `x = (clientX - rect.left - letterboxDx) * frame.w / displayedWidth`
    (clamped to `[0, frame.w - 1]`), y likewise.
  - Keys (only when `document.hasFocus()`): on keydown/keyup send `key` msg
    with `key: e.key`, `code: e.code`, `vk` from a code→VK table (Backspace 8,
    Tab 9, Enter 13, Shift 16, Control 17, Alt 18, Escape 27, Space 32,
    Arrows 37–40, Digit0–9 → 48–57, KeyA–Z → 65–90, `Semicolon`→186,
    `Equal`→187, `Comma`→188, `Minus`→189, `Period`→190, `Slash`→191,
    `Backquote`→192, `BracketLeft`→219, `Backslash`→220,
    `BracketRight`→221, `Quote`→222, and fallback `e.keyCode`), `mods`
    bitmask (alt 1, ctrl 2, meta 4, shift 8), and `text =
    (e.key.length===1 && !e.ctrlKey && !e.metaKey) ? e.key : null`.
  - preventDefault on keydown for everything EXCEPT browser-reserved combos
    (Cmd/Ctrl with KeyW, KeyT, KeyL, KeyN, KeyR) — those keep browser
    behavior and are not sent.
  - Paste: `paste` event → `text` msg with clipboard text.
  - Viewer chrome: tiny fixed toolbar (auto-hide after 3s, reappears on
    mousemove near top) with ⌫ back, ⌦ forward, ✕ close tab (POST
    `/v1/close`, then show "closed"). Keyboard: Cmd+[ → `back`,
    Cmd+] → `forward` (intercept, preventDefault, send).
  - WS reconnect: on close, retry with backoff 1s,2s,…,5s; on reconnect
    re-send `hello`. Show "reconnecting…" overlay.
  - Keepalive: send `ping` every 20s.
- background.js also sets a "!" badge + console error if `POST /v1/open`
  fails; clears badge on success.

## Edge cases / robustness (agent)

- CDP WS reconnect: if the browser socket dies, re-attach to
  `/json/version`, respawn Chrome if needed, re-adopt targets; viewers get
  `{"t":"error","msg":"chrome restarted"}` and their reconnect logic
  re-hellos.
- Malformed JSON frames: ignore. Unknown `t`: ignore. Unknown tabId on WS:
  send `{"t":"error","msg":"unknown tab"}` and close.
- `hello` before anything: no frames until `hello` (metrics unknown).
  Default metrics exist from `/v1/open` (1280×800 dpr 1) so an un-hello'd
  stream still shows something.
- Log one line per event class (tab open/close, ws connect/kick, errors) to
  stdout — launchd captures it.

## Known limits (v1, honest)

- Frames are JPEG stills (CDP screencast), not 60fps video: great for
  Gmail/Docs/Drive; video playback in the streamed tab is choppy; no audio.
- Background/occluded tabs can throttle; screencast generally forces frames,
  but if the stream stalls, make sure the appliance Chrome window isn't
  minimized (park it on a rarely-used Space or a macOS virtual display).
- Keyboard is a best-effort v1 map; some exotic shortcuts may misbehave.

## Testing rule

`viewer.html` must work as a plain web page (query-param config) so the
whole system can be smoke-tested without installing the extension.

`agent/test/smoke.mjs` (owned by agent-builder): starts appliance Chrome with
a temp profile on an ephemeral CDP port + the agent on an ephemeral port,
serves a local page with an `<input>`, opens it via `/v1/open`, connects a WS
client, asserts ≥1 frame + title event, sends `text` "hi", verifies the
input's value via `Runtime.evaluate` through the agent's own CDP module,
exits 0 on success / 1 on failure. No internet access required.

## v1.1 protocol additions (post-review hardening)

These extend the WebSocket protocol above; where they conflict, v1.1 wins.

Client → server:

- `key` gains two optional fields:
  - `"commands": [<string>]` — macOS editing commands for Cmd chords, passed
    through verbatim to `Input.dispatchKeyEvent({commands})` on the down event
    (CDP does not run editing commands on mac without them). Viewer mapping
    (Cmd held, Ctrl not held): KeyA→`selectAll`, KeyC→`copy`, KeyX→`cut`,
    KeyZ→`undo`, Shift+KeyZ→`redo`. Other Cmd chords: no `commands`.
  - `"repeat": <bool>` — `KeyboardEvent.repeat`; agent passes
    `autoRepeat: repeat` to `Input.dispatchKeyEvent`.
  - macOS never fires `keyup` for a key pressed while Cmd is held, so for any
    Cmd chord the viewer sends the `up` immediately after the `down` and
    ignores the later native `keyup` for that code (if one fires).
- `nav` URLs are accepted only if `new URL(url).protocol` is `http:`/`https:`;
  anything else is silently ignored by the agent (same rule as `/v1/open`).
- Messages from a viewer socket that is no longer `tab.viewer` (kicked) are
  ignored.

Server → client:

- `{"t":"clipboard","text":<str>}` — after a `key` down whose `commands`
  include `copy` or `cut`, the agent waits ~50ms, evaluates
  `String(window.getSelection())` in the page (main frame, `Runtime.evaluate`,
  returnByValue) and, if non-empty, sends this. If empty, nothing is sent
  (best-effort: canvas-rendered editors like Google Docs keep their own
  selection). Viewer writes it with `navigator.clipboard.writeText` and shows
  a 1.5s "Copied" toast; failure is logged once, not fatal.
- `{"t":"popup","tabId":<targetId>,"url":<str>}` — on `Target.targetCreated`
  for a `page` whose `targetInfo.openerId` is a tab that currently has a
  viewer, sent to that opener's viewer after the popup is adopted/attached.
  Viewer opens a new viewer tab for it: extension context →
  `chrome.tabs.create({url: viewer.html?tab=<id>, active: true})`; plain page
  → `window.open` of the same viewer URL with the current `agent`/`token`
  query params carried over.

Close codes (viewer treats all as terminal, no reconnect):

- `4001` unauthorized → error overlay "token mismatch".
- `4002` replaced by another viewer → closed overlay "another viewer took over".
- `4004` unknown tab → closed overlay "tab no longer exists on the work Mac".

Frames / flow control (agent):

- Screencast `maxWidth`/`maxHeight` = `W_MAX*2` / `H_MAX*2` (5120×3200) so a
  dpr-2 viewer gets native-resolution frames, never a downsample.
- Frame `w`/`h` remain remote CSS px (`metadata.deviceWidth/Height` — verified
  CSS px, not physical).
- Backpressure: a screencast frame is sent only if
  `viewer.bufferedAmount < 1 MiB`; the ack is issued from the `ws.send`
  completion callback (so Chrome's next frame waits for the network). When a
  frame is dropped for backpressure, ack after 100ms and set
  `tab.needsRefresh`; the 3s title timer sends a synthetic frame if
  `needsRefresh` and the socket has drained.
- Synthetic frames: coalesced (one in flight per tab; a request during flight
  schedules exactly one follow-up), dims snapshotted *before* the capture, and
  dropped if a real screencast frame arrived during the capture or metrics
  changed.
- `tab.metrics` is updated only after `setDeviceMetricsOverride` succeeds.
- Mouse drag: agent tracks the pressed button per tab; `mouseMoved` carries
  `button:<pressed or "none">` and `buttons` bitmask (left 1, right 2,
  middle 4).

Liveness:

- Agent: records `lastRx` per viewer socket on every message; the GC sweep
  `terminate()`s a viewer silent for >60s (viewer pings every 20s).
- Viewer: records `lastRx` on every message (frames/pong); if >45s silent, it
  closes the socket itself so the normal reconnect path runs.
