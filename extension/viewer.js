"use strict";

/* gproxy viewer — streams one tab from the work-Mac agent into a canvas.
 *
 * Config resolution (per spec): query params `tab`, `agent`, `token` first,
 * then chrome.storage.local (guarded so this also runs as a plain web page).
 * The token never appears in a URL we build except the WS query param, which
 * the protocol requires (browsers cannot set WS headers).
 */

var DEFAULT_AGENT = "http://work-mac:7654";
var PING_MS = 20000;
var RESIZE_DEBOUNCE_MS = 300;
var MOVE_THROTTLE_MS = 16;   // ~60/s
var TOOLBAR_HIDE_MS = 3000;
var CLICK_DOUBLE_MS = 500;   // matches Chrome's dblclick window
var CLICK_SLOP_PX = 6;
var BACKOFF_MIN_MS = 1000;
var BACKOFF_MAX_MS = 5000;
var LIVENESS_MS = 45000;     // no message for this long -> close and reconnect
var TOAST_MS = 1500;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

var canvas = document.getElementById("screen");
var ctx = canvas.getContext("2d");
var overlay = document.getElementById("overlay");
var ovTitle = document.getElementById("ov-title");
var ovSub = document.getElementById("ov-sub");
var toolbar = document.getElementById("toolbar");
var btnBack = document.getElementById("btn-back");
var btnForward = document.getElementById("btn-forward");
var btnClose = document.getElementById("btn-close");
var toast = document.getElementById("toast");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var cfg = null;            // {agent, token, tab} once resolved
var state = "loading";     // loading | live | reconnecting | closed | error

var ws = null;
var wsUrl = "";
var everConnected = false; // first open succeeded at least once
var sawFrameOnConn = false;  // any frame received on the current connection
var lastErrorMsg = "";     // last agent {"t":"error"} text (survives the close)
var terminal = false;      // "closed" or fatal auth error — stop reconnecting
var retryDelay = BACKOFF_MIN_MS;
var retryTimer = 0;
var pingTimer = 0;

var geo = null;            // letterbox geometry of the drawn frame, CSS px:
                           // {dx, dy, dw, dh, fw, fh} — fw/fh are frame pixels
var latest = null;         // newest received frame {seq, d, w, h}
var drawn = null;          // {img, w, h} currently displayed (kept for repaint)
var frameSeq = 0;          // sequence number of the newest received frame
var drawnSeq = 0;          // sequence number of the frame on screen
var decoding = false;      // one image decode in flight at a time
var rafId = 0;
var decodeErrLogged = false;
var lastRx = 0;            // Date.now() of the last message from the agent
var wheelAcc = null;       // coalesced wheel {x, y, dx, dy, mods}
var wheelRaf = 0;
var sentUp = {};           // codes whose keyup was already sent (Cmd chords)
var toastTimer = 0;
var clipWarned = false;

var lastMoveAt = 0;        // mousemove throttle
var moveTimer = 0;
var lastMoveEvt = null;
var activeBtns = {};       // mouse buttons currently down on the canvas
var clickSeq = 0;          // consecutive-click counter (clickCount semantics)
var lastDownAt = 0;
var lastDownX = 0;
var lastDownY = 0;
var lastDownBtn = -1;
var lastClicksSent = 1;
var composing = false;     // IME composition in progress

var resizeTimer = 0;
var toolbarTimer = 0;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function normalizeAgent(raw) {
  var a = (raw || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(a) ? a : null;
}

function storageGet(keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(keys, resolve);
    } catch (e) {
      resolve({});
    }
  });
}

async function resolveConfig() {
  var q = new URLSearchParams(location.search);
  var agent = q.get("agent") || "";
  var token = q.get("token") || "";
  var tab = q.get("tab") || "";

  if (!agent || !token) {
    // Extension context: fall back to the options page's stored config.
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      var got = await storageGet(["agentUrl", "token"]);
      if (!agent) agent = got.agentUrl || DEFAULT_AGENT;
      if (!token) token = got.token || "";
    } else if (!agent) {
      agent = DEFAULT_AGENT;
    }
  }

  return {
    agent: normalizeAgent(agent),
    token: (token || "").trim(),
    tab: tab.trim()
  };
}

// ---------------------------------------------------------------------------
// Overlays / states
// ---------------------------------------------------------------------------

var STATE_TITLES = {
  loading: "Loading…",
  reconnecting: "Reconnecting…",
  closed: "Closed",
  error: "Error"
};

function setState(name, sub) {
  state = name;
  if (name === "live") {
    overlay.classList.remove("show");
    return;
  }
  ovTitle.textContent = STATE_TITLES[name] || name;
  if (sub === undefined) {
    if (name === "loading") sub = "waiting for the first frame from " + (cfg ? cfg.agent : "");
    else if (name === "reconnecting") sub = "connection lost — retrying (" + (cfg ? cfg.agent : "") + ")";
    else if (name === "closed") sub = "the tab was closed on the work Mac";
    else sub = "";
  }
  ovSub.textContent = sub;
  overlay.classList.add("show");
}

function fatal(msg) {
  lastErrorMsg = msg;
  setState("error", msg);
  console.error("gproxy viewer: " + msg);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function wsUrlFor(agent, tab, token) {
  var u = agent.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return u + "/v1/stream/" + encodeURIComponent(tab) +
    "?token=" + encodeURIComponent(token);
}

function connect() {
  if (terminal) return; // a close arrived while a retry was already pending
  ws = new WebSocket(wsUrl);

  ws.onopen = function () {
    everConnected = true;
    sawFrameOnConn = false;
    lastErrorMsg = "";
    retryDelay = BACKOFF_MIN_MS;
    lastRx = Date.now();
    sendHello();
  };

  ws.onmessage = function (ev) {
    lastRx = Date.now(); // any traffic (frames, pong) proves the link is alive
    if (typeof ev.data !== "string") return;
    handleMsg(ev.data);
  };

  ws.onerror = function () {
    // onclose always follows; state is decided there.
  };

  ws.onclose = function (ev) {
    ws = null;

    // Terminal close codes (SPEC v1.1): never reconnect. 4002/4004 are handled
    // even if a {"t":"closed"} message already put us in the closed state, so
    // the more specific sub-message wins.
    if (ev.code === 4002) { enterClosed("another viewer took over this tab"); return; }
    if (ev.code === 4004) { enterClosed("tab no longer exists on the work Mac"); return; }
    if (terminal) return;
    if (ev.code === 4001) {
      terminal = true;
      clearTimeout(retryTimer);
      fatal("token mismatch — fix it in gproxy options, then reload");
      return;
    }

    if (!everConnected) {
      // WS failure before the first open: agent unreachable / bad URL.
      setState("error", "cannot connect to " + cfg.agent + " — retrying");
    } else if (sawFrameOnConn || !lastErrorMsg) {
      setState("reconnecting");
    }
    // else: the agent's error message was the last thing we saw and no frames
    // followed — keep the error overlay; the reconnect below still runs.
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  var delay = retryDelay;
  retryDelay = Math.min(BACKOFF_MAX_MS, retryDelay + BACKOFF_MIN_MS); // 1s, 2s, ..., 5s cap
  retryTimer = setTimeout(connect, delay);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket died mid-send */ }
  }
}

function sendHello() {
  send({ t: "hello", w: Math.floor(window.innerWidth), h: Math.floor(window.innerHeight), dpr: dprClamped() });
}

function handleMsg(data) {
  var msg;
  try { msg = JSON.parse(data); } catch (e) { return; } // malformed: ignore
  if (!msg || typeof msg.t !== "string") return;

  switch (msg.t) {
    case "frame":
      onFrame(msg);
      break;
    case "title":
      onTitle(msg);
      break;
    case "closed":
      enterClosed();
      break;
    case "clipboard":
      onClipboard(msg);
      break;
    case "popup":
      onPopup(msg);
      break;
    case "error":
      fatal(String(msg.msg || "agent error"));
      break;
    case "ready":
    case "pong":
    default:
      break; // ready dims are not trusted; frame messages carry their own
  }
}

function enterClosed(sub) {
  terminal = true;
  clearTimeout(retryTimer);
  setState("closed", sub);
  if (ws) { try { ws.close(1000); } catch (e) {} }
  ws = null;
}

// ---------------------------------------------------------------------------
// Frames + drawing
// ---------------------------------------------------------------------------

function onFrame(msg) {
  if (typeof msg.d !== "string" || !msg.d) return;
  sawFrameOnConn = true;
  latest = { seq: ++frameSeq, d: msg.d, w: msg.w | 0, h: msg.h | 0 };
  scheduleDraw();
}

function scheduleDraw() {
  if (!rafId && !decoding) rafId = requestAnimationFrame(drawFrame);
}

// Newest-wins scheduling, one decode in flight. A decoded frame is shown if it
// is newer than what is on screen, even when an even newer frame has arrived
// meanwhile (otherwise a fast stream could starve the display forever).
function drawFrame() {
  rafId = 0;
  var f = latest;
  if (decoding || !f || f.seq <= drawnSeq) return;
  decoding = true;

  var img = new Image();
  img.onload = function () {
    decoding = false;
    if (f.seq > drawnSeq) {
      drawnSeq = f.seq;
      drawn = { img: img, w: f.w || img.naturalWidth, h: f.h || img.naturalHeight };
      repaint();
      if (!terminal) setState("live"); // frames flowing again = live
    }
    if (latest && latest.seq > drawnSeq) scheduleDraw(); // decode the newer one next
  };
  img.onerror = function () {
    decoding = false;
    if (f.seq > drawnSeq) drawnSeq = f.seq; // skip the undecodable frame (no retry loop)
    if (!decodeErrLogged) {
      decodeErrLogged = true;
      console.error("gproxy viewer: frame decode failed (logged once)");
    }
    if (latest && latest.seq > drawnSeq) scheduleDraw();
  };
  img.src = "data:image/jpeg;base64," + f.d;
}

function fitCanvas() {
  var dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  repaint();
}

function repaint() {
  var cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (!drawn) { geo = null; return; }

  var cssW = window.innerWidth, cssH = window.innerHeight;
  var s = Math.min(cssW / drawn.w, cssH / drawn.h); // contain-fit
  var dw = drawn.w * s, dh = drawn.h * s;
  var dx = (cssW - dw) / 2, dy = (cssH - dh) / 2;

  geo = { dx: dx, dy: dy, dw: dw, dh: dh, fw: drawn.w, fh: drawn.h };

  var k = cw / cssW; // backing pixels per CSS pixel
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(drawn.img, dx * k, dy * k, dw * k, dh * k);
}

// ---------------------------------------------------------------------------
// Title / favicon
// ---------------------------------------------------------------------------

function onTitle(msg) {
  if (typeof msg.title === "string" && msg.title) document.title = msg.title;
  if (typeof msg.url === "string") setFavicon(msg.url);
}

var PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".ts.net", ".home.arpa"];

// Only public-looking hostnames may be sent to the google s2 favicon service.
function isPublicHost(host) {
  host = (host || "").toLowerCase().replace(/\.$/, "");
  if (!host || host.indexOf(".") < 0) return false;          // also covers localhost
  if (host === "localhost") return false;
  if (host.charAt(0) === "[" || host.indexOf(":") >= 0) return false; // IPv6 literal
  if (/^\d+(\.\d+){3}$/.test(host)) return false;           // IPv4 literal
  for (var i = 0; i < PRIVATE_SUFFIXES.length; i++) {
    var sfx = PRIVATE_SUFFIXES[i];
    if (host.length >= sfx.length && host.slice(-sfx.length) === sfx) return false;
  }
  return true;
}

function setFavicon(url) {
  var host;
  try { host = new URL(url).hostname; } catch (e) { return; }
  var link = document.querySelector("link[rel='icon']");
  if (!isPublicHost(host)) {
    if (link) link.remove(); // never leak internal hostnames to a third party
    return;
  }
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(host) + "&sz=64";
}

// ---------------------------------------------------------------------------
// Mouse input
// ---------------------------------------------------------------------------

var BTN_NAMES = { 0: "left", 1: "middle", 2: "right" };

function modsOf(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/* Map a mouse event to frame pixels, accounting for letterboxing:
 * x = (clientX - offsetX) * frame.w / displayedWidth. When the frame exactly
 * matches the viewport this reduces to the spec's (clientX - rect.left) * dpr.
 */
function frameXY(e) {
  if (!geo) return null;
  var r = canvas.getBoundingClientRect();
  var x = (e.clientX - r.left - geo.dx) * geo.fw / geo.dw;
  var y = (e.clientY - r.top - geo.dy) * geo.fh / geo.dh;
  x = Math.max(0, Math.min(geo.fw - 1, x));
  y = Math.max(0, Math.min(geo.fh - 1, y));
  return { x: x, y: y };
}

canvas.addEventListener("mousemove", function (e) {
  lastMoveEvt = e;
  var now = performance.now();
  if (now - lastMoveAt >= MOVE_THROTTLE_MS) {
    flushMove();
  } else if (!moveTimer) {
    moveTimer = setTimeout(flushMove, MOVE_THROTTLE_MS); // trailing send
  }
});

canvas.addEventListener("mouseleave", flushMove);

function flushMove() {
  clearTimeout(moveTimer);
  moveTimer = 0;
  var e = lastMoveEvt;
  if (!e) return;
  lastMoveEvt = null;
  lastMoveAt = performance.now();
  var p = frameXY(e);
  if (!p) return;
  send({ t: "mouse", a: "move", x: p.x, y: p.y, mods: modsOf(e) });
}

canvas.addEventListener("mousedown", function (e) {
  e.preventDefault(); // no local selection / drag / autoscroll
  canvas.focus();     // preventDefault suppresses the default focus move
  var name = BTN_NAMES[e.button];
  if (!name) return; // back/forward mouse buttons: not in the protocol
  var p = frameXY(e);
  if (!p) return;

  var now = performance.now();
  if (e.button === lastDownBtn &&
      now - lastDownAt < CLICK_DOUBLE_MS &&
      Math.hypot(e.clientX - lastDownX, e.clientY - lastDownY) < CLICK_SLOP_PX) {
    clickSeq = Math.min(clickSeq + 1, 3);
  } else {
    clickSeq = 1;
  }
  lastDownBtn = e.button;
  lastDownAt = now;
  lastDownX = e.clientX;
  lastDownY = e.clientY;
  lastClicksSent = clickSeq;
  activeBtns[e.button] = true;

  send({ t: "mouse", a: "down", x: p.x, y: p.y, btn: name, clicks: clickSeq, mods: modsOf(e) });
});

// mouseup on window so a drag that ends over the toolbar (or outside the
// canvas) still releases the remote button.
window.addEventListener("mouseup", function (e) {
  if (!activeBtns[e.button]) return;
  delete activeBtns[e.button];
  var name = BTN_NAMES[e.button];
  if (!name) return;
  var p = frameXY(e); // null only before the first frame
  if (!p) return;
  send({ t: "mouse", a: "up", x: p.x, y: p.y, btn: name, clicks: lastClicksSent, mods: modsOf(e) });
});

// Spec: "clicks 2 on dblclick". The counter above normally already sent the
// second press with clicks:2; this is the fallback for a timing edge where it
// did not — then we deliver an explicit clicks:2 down/up pair.
canvas.addEventListener("dblclick", function (e) {
  if (clickSeq >= 2) return;
  var name = BTN_NAMES[e.button];
  if (!name) return;
  var p = frameXY(e);
  if (!p) return;
  lastClicksSent = 2;
  send({ t: "mouse", a: "down", x: p.x, y: p.y, btn: name, clicks: 2, mods: modsOf(e) });
  send({ t: "mouse", a: "up", x: p.x, y: p.y, btn: name, clicks: 2, mods: modsOf(e) });
});

canvas.addEventListener("wheel", function (e) {
  e.preventDefault();
  var p = frameXY(e);
  if (!p) return;
  var pagePx = geo ? geo.fh : window.innerHeight; // frame CSS px, not display px
  var dx = normDelta(e.deltaX, e.deltaMode, pagePx);
  var dy = normDelta(e.deltaY, e.deltaMode, pagePx);
  if (dx === 0 && dy === 0) return;
  if (!wheelAcc) wheelAcc = { x: 0, y: 0, dx: 0, dy: 0, mods: 0 };
  wheelAcc.dx += dx;
  wheelAcc.dy += dy;
  wheelAcc.x = p.x;
  wheelAcc.y = p.y;
  wheelAcc.mods = modsOf(e);
  if (!wheelRaf) wheelRaf = requestAnimationFrame(flushWheel);
}, { passive: false });

function flushWheel() {
  wheelRaf = 0;
  var w = wheelAcc;
  wheelAcc = null;
  if (!w || (w.dx === 0 && w.dy === 0)) return;
  send({ t: "mouse", a: "wheel", x: w.x, y: w.y, dx: w.dx, dy: w.dy, mods: w.mods });
}

function normDelta(v, mode, pagePx) {
  if (mode === 1) return v * 16;       // DOM_DELTA_LINE -> ~16px per line
  if (mode === 2) return v * pagePx;   // DOM_DELTA_PAGE -> one viewport
  return v;                            // DOM_DELTA_PIXEL (mac default)
}

canvas.addEventListener("contextmenu", function (e) {
  e.preventDefault(); // right-click flows through mousedown/mouseup
});

// ---------------------------------------------------------------------------
// Keyboard input
// ---------------------------------------------------------------------------

var VK = {
  Backspace: 8, Tab: 9, Enter: 13,
  ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18,
  Escape: 27, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191,
  Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222
};
for (var d = 0; d < 10; d++) VK["Digit" + d] = 48 + d;
for (var k = 0; k < 26; k++) VK["Key" + String.fromCharCode(65 + k)] = 65 + k;

var RESERVED_CODES = { KeyW: 1, KeyT: 1, KeyL: 1, KeyN: 1, KeyR: 1 }; // browser combos, never sent

function vkOf(e) {
  if (Object.prototype.hasOwnProperty.call(VK, e.code)) return VK[e.code];
  return e.keyCode; // spec fallback
}

var CMD_COMMANDS = {
  KeyA: ["selectAll"], KeyC: ["copy"], KeyX: ["cut"]
};

function isMetaKey(e) {
  return e.code === "MetaLeft" || e.code === "MetaRight";
}

// A Cmd chord: Cmd held together with a non-Meta key.
function isCmdChord(e) {
  return e.metaKey && !isMetaKey(e);
}

function commandsOf(e) {
  if (!e.metaKey || e.ctrlKey) return null;
  if (e.code === "KeyZ") return e.shiftKey ? ["redo"] : ["undo"];
  if (e.shiftKey) return null; // Cmd+Shift+A/C/X are not editing commands
  return CMD_COMMANDS[e.code] || null;
}

function isReserved(e) {
  return (e.metaKey || e.ctrlKey) &&
    (RESERVED_CODES[e.code] ||
     e.code === "KeyV"); // Cmd/Ctrl+V: kept local so the paste event fires
}

document.addEventListener("keydown", function (e) {
  if (!document.hasFocus()) return;

  // Cmd+[ / Cmd+] -> remote history navigation.
  if (e.metaKey && (e.code === "BracketLeft" || e.key === "[")) {
    e.preventDefault();
    send({ t: "back" });
    return;
  }
  if (e.metaKey && (e.code === "BracketRight" || e.key === "]")) {
    e.preventDefault();
    send({ t: "forward" });
    return;
  }

  if (isReserved(e)) return; // browser keeps these; not forwarded

  if (composing) return; // IME is composing locally; text goes via "text" msg

  e.preventDefault();

  var text = e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : null;
  var msg = {
    t: "key", a: "down",
    key: e.key, code: e.code, vk: vkOf(e), mods: modsOf(e), text: text,
    repeat: e.repeat
  };
  var cmds = commandsOf(e);
  if (cmds) msg.commands = cmds;
  send(msg);

  if (isCmdChord(e)) {
    // macOS never fires keyup for a key pressed while Cmd is held: send it now
    // and swallow the native one if it does show up.
    send({ t: "key", a: "up", key: e.key, code: e.code, vk: vkOf(e), mods: modsOf(e), text: null });
    sentUp[e.code] = true;
  } else {
    delete sentUp[e.code]; // a plain press of this key: its keyup is real
  }
});

document.addEventListener("keyup", function (e) {
  if (!document.hasFocus()) return;
  if (sentUp[e.code]) { delete sentUp[e.code]; return; }
  if (e.metaKey && (e.code === "BracketLeft" || e.key === "[")) return;
  if (e.metaKey && (e.code === "BracketRight" || e.key === "]")) return;
  if (isReserved(e)) return;
  if (composing) return;

  send({
    t: "key", a: "up",
    key: e.key, code: e.code, vk: vkOf(e), mods: modsOf(e), text: null
  });
});

document.addEventListener("paste", function (e) {
  var text = "";
  try {
    text = e.clipboardData.getData("text/plain");
    if (!text) text = e.clipboardData.getData("text");
  } catch (err) { /* no clipboard access */ }
  e.preventDefault();
  if (text) send({ t: "text", text: text });
});

// IME: swallow raw keys while composing, forward the committed string.
document.addEventListener("compositionstart", function () { composing = true; });
document.addEventListener("compositionend", function (e) {
  composing = false;
  if (e.data) send({ t: "text", text: e.data });
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function returnFocus(e) {
  e.currentTarget.blur();
  canvas.focus();
}

function showToolbar() {
  toolbar.classList.remove("hidden");
  clearTimeout(toolbarTimer);
  toolbarTimer = setTimeout(function () { toolbar.classList.add("hidden"); }, TOOLBAR_HIDE_MS);
}

window.addEventListener("mousemove", function (e) {
  if (e.clientY < 60) showToolbar(); // near the top edge
}, { passive: true });

btnBack.addEventListener("click", function (e) {
  returnFocus(e);
  send({ t: "back" });
});

btnForward.addEventListener("click", function (e) {
  returnFocus(e);
  send({ t: "forward" });
});

btnClose.addEventListener("click", function (e) {
  returnFocus(e);
  closeRemoteTab();
});

async function closeRemoteTab() {
  if (terminal) return;
  try {
    var res = await postJson(cfg.agent + "/v1/close", { tabId: cfg.tab }, cfg.token);
    if (res.status === 404) { enterClosed(); return; } // already gone
    if (!res.ok) throw new Error("HTTP " + res.status);
    enterClosed();
  } catch (err) {
    fatal("close failed: " + (err && err.message ? err.message : err));
  }
}

function postJson(url, body, token) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(body)
  });
}

// ---------------------------------------------------------------------------
// Resize / ping / boot
// ---------------------------------------------------------------------------

window.addEventListener("resize", function () {
  fitCanvas(); // keep the canvas crisp immediately...
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    if (terminal) return;
    send({ t: "resize", w: Math.floor(window.innerWidth), h: Math.floor(window.innerHeight), dpr: dprClamped() });
  }, RESIZE_DEBOUNCE_MS); // ...but tell the agent only once it settles
});

function dprClamped() {
  return (window.devicePixelRatio || 1) > 1 ? 2 : 1;
}

function startPing() {
  pingTimer = setInterval(function () {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastRx > LIVENESS_MS) {
      try { ws.close(); } catch (e) {} // onclose runs the normal reconnect path
      return;
    }
    send({ t: "ping" });
  }, PING_MS);
}

// ---------------------------------------------------------------------------
// Clipboard / popups (agent -> viewer)
// ---------------------------------------------------------------------------

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove("show"); }, TOAST_MS);
}

function onClipboard(msg) {
  if (typeof msg.text !== "string" || !msg.text) return;
  try {
    navigator.clipboard.writeText(msg.text).then(function () {
      showToast("Copied");
    }, warnClipboard);
  } catch (e) {
    warnClipboard(e);
  }
}

function warnClipboard(err) {
  if (clipWarned) return;
  clipWarned = true;
  console.warn("gproxy viewer: clipboard write failed (logged once): " + (err && err.message ? err.message : err));
}

function onPopup(msg) {
  if (typeof msg.tabId !== "string" || !msg.tabId) return;
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({
      url: chrome.runtime.getURL("viewer.html") + "?tab=" + encodeURIComponent(msg.tabId),
      active: true
    });
    return;
  }
  var u = new URL(location.href); // keeps agent/token and any other params
  u.searchParams.set("tab", msg.tabId);
  if (!window.open(u.href, "_blank")) {
    console.warn("gproxy viewer: popup blocked by the browser");
  }
}

async function init() {
  window.focus();
  fitCanvas();
  showToolbar();

  var c = await resolveConfig();
  if (!c.agent) { fatal("no valid agent URL — open gproxy options (or pass ?agent= for plain-page testing)"); return; }
  if (!c.tab) { fatal("no tab id — this page needs ?tab=<id> from the agent"); return; }
  if (!c.token) { fatal("no token configured — set it in gproxy options, or pass ?token= when testing as a plain page"); return; }

  cfg = c;
  wsUrl = wsUrlFor(cfg.agent, cfg.tab, cfg.token);
  setState("loading");
  startPing();
  connect();
}

init();
