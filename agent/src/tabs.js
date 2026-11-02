import { log } from './log.js';

const DEFAULT_METRICS = { w: 1280, h: 800, dpr: 1 }; // applied by /v1/open and adoption
const W_MIN = 500, W_MAX = 2560;
const H_MIN = 400, H_MAX = 1600;
const TITLE_POLL_MS = 3000;
const GC_INTERVAL_MS = 30_000;
const SCREENCAST_MAX_W = W_MAX * 2;
const SCREENCAST_MAX_H = H_MAX * 2;
const BACKPRESSURE_BYTES = 1024 * 1024; // viewer.bufferedAmount ceiling for sending frames
const DROP_ACK_MS = 100; // ack delay for a frame dropped under backpressure
const VIEWER_SILENT_MS = 60_000; // terminate viewers silent for longer
const CLIPBOARD_MAX = 1024 * 1024;
const COPY_SETTLE_MS = 50;
const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v, fallback = 0) {
  return Math.round(num(v, fallback));
}

function clampMetrics(msg) {
  const w = Math.min(W_MAX, Math.max(W_MIN, int(msg.w, DEFAULT_METRICS.w)));
  const h = Math.min(H_MAX, Math.max(H_MIN, int(msg.h, DEFAULT_METRICS.h)));
  const dpr = num(msg.dpr, 1) >= 1.5 ? 2 : 1;
  return { w, h, dpr };
}

function isHttpUrl(str) {
  try {
    const { protocol } = new URL(str);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function buttonOf(v) {
  return v === 'middle' || v === 'right' ? v : 'left';
}

class Tab {
  constructor(registry, targetId) {
    this.registry = registry;
    this.targetId = targetId;
    this.sessionId = null; // flat CDP session; null while Chrome is unreachable
    this.title = '';
    this.url = '';
    this.viewer = null; // the single connected viewer WebSocket
    this.metrics = { ...DEFAULT_METRICS };
    this.screencast = false;
    this.titleTimer = null;
    this.lastTitleKey = null;
    this.lastViewerAt = Date.now();
    this.attaching = null; // in-flight _doAttach() promise, if any
    this.frameSeq = 0; // incremented by every real screencast frame
    this.needsRefresh = false; // a frame was dropped for backpressure
    this.capturing = false; // a synthetic capture is in flight
    this.capturePending = false; // one follow-up capture requested during flight
    this.pressed = null; // currently pressed mouse button name, or null
  }

  /** Session-scoped CDP command (flat protocol: sessionId at message top).
   *  Always rejects (never throws synchronously) when Chrome is unreachable. */
  send(method, params) {
    if (!this.sessionId || !this.registry.conn?.open) {
      return Promise.reject(new Error('cdp not connected'));
    }
    return this.registry.conn.send(method, params, { sessionId: this.sessionId });
  }
}

/**
 * Tab registry: owns every page target of the appliance Chrome, its flat CDP
 * session, its single viewer WebSocket, screencast lifecycle, input
 * forwarding, title pushes and stale GC.
 *
 * The registry learns about Chrome through setConnection()/clearConnection()
 * (wired to the BrowserSupervisor's 'connected'/'disconnected' events).
 */
export class TabRegistry {
  constructor(config) {
    this.config = config;
    this.conn = null;
    this.tabs = new Map(); // targetId -> Tab (tabId === targetId)
    this._bySession = new Map(); // CDP sessionId -> Tab
    this._sweepSeq = 0;
    this._connHandler = null;
    this.frontTabId = null; // tab we last brought to front; null = unknown
    this.gcTimer = setInterval(() => this._gc(), GC_INTERVAL_MS);
  }

  // ---- Chrome connection -------------------------------------------------

  /** Called on every (re)connect: re-attaches known tabs, adopts new page
   *  targets, drops registry entries whose targets no longer exist. */
  async setConnection(conn) {
    this.clearConnection();
    this.conn = conn;
    this._connHandler = (method, params, sessionId) => this._onCdpEvent(method, params, sessionId);
    conn.on('event', this._connHandler);

    const seq = ++this._sweepSeq;
    let targetInfos = [];
    try {
      ({ targetInfos } = await conn.send('Target.getTargets'));
    } catch (err) {
      log('cdp-error', `getTargets: ${err.message}`);
      return;
    }
    if (seq !== this._sweepSeq) return; // a newer sweep superseded this one

    const seen = new Set();
    for (const info of targetInfos) {
      if (info.type !== 'page') continue;
      seen.add(info.targetId);
      const tab = this.tabs.get(info.targetId);
      if (tab) {
        tab.title = info.title ?? tab.title;
        tab.url = info.url ?? tab.url;
        this._attach(tab).catch((err) => this._attachFailed(tab, err));
      } else {
        this._adopt(info.targetId, info.url ?? 'about:blank');
      }
    }
    for (const tab of this.tabs.values()) {
      if (!seen.has(tab.targetId)) this._drop(tab, 'target gone');
    }
  }

  /** Chrome is unreachable: freeze sessions, tell viewers to re-hello later. */
  clearConnection() {
    if (!this.conn) return; // already cleared (or never connected)
    if (this._connHandler) this.conn.removeListener('event', this._connHandler);
    this.conn = null;
    this.frontTabId = null;
    this._sweepSeq++;
    this._bySession.clear();
    for (const tab of this.tabs.values()) {
      tab.sessionId = null;
      tab.attaching = null;
      tab.screencast = false;
      this._stopTitleTimer(tab);
      this._viewerSend(tab, { t: 'error', msg: 'chrome restarted' });
    }
  }

  shutdown() {
    clearInterval(this.gcTimer);
    for (const tab of this.tabs.values()) {
      this._stopTitleTimer(tab);
      try {
        tab.viewer?.close(1001, 'agent shutting down');
      } catch { /* closing */ }
      tab.viewer = null;
    }
  }

  // ---- Tab lifecycle -----------------------------------------------------

  /** Creates a target, attaches, enables Page, applies default metrics.
   *  Resolves only once the tab has a session, so /v1/open never returns a
   *  tab a viewer could not immediately use. */
  async createTab(url) {
    if (!this.conn?.open) throw new Error('chrome not connected');
    const { targetId } = await this.conn.send('Target.createTarget', { url });
    // targetCreated may have raced the response and adopted it already.
    let tab = this.tabs.get(targetId);
    if (!tab) {
      tab = new Tab(this, targetId);
      this.tabs.set(targetId, tab);
    }
    tab.url = url;
    try {
      await this._attach(tab);
    } catch (err) {
      this._attachFailed(tab, err);
      throw err;
    }
    log('tab-open', `${targetId} ${url}`);
    return tab;
  }

  /** Closes the target (cleanup happens via targetDestroyed / _drop). */
  async closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    log('tab-close', `${tabId} (requested)`);
    if (this.conn?.open) {
      try {
        await this.conn.send('Target.closeTarget', { targetId: tabId });
      } catch (err) {
        log('cdp-error', `closeTarget: ${err.message}`);
      }
    }
    this._drop(tab, 'closed'); // targetDestroyed may also drop it; idempotent
    return true;
  }

  listTabs() {
    const tabs = [];
    for (const tab of this.tabs.values()) {
      tabs.push({ tabId: tab.targetId, title: tab.title, url: tab.url });
    }
    return tabs;
  }

  /** Registers a page target and attaches. Resolves true once attached, false
   *  if the attach failed (already handled via _attachFailed); never rejects. */
  _adopt(targetId, url) {
    const tab = new Tab(this, targetId);
    tab.url = url;
    this.tabs.set(targetId, tab);
    log('tab-adopt', `${targetId} ${url}`);
    return this._attach(tab).then(
      () => true,
      (err) => {
        this._attachFailed(tab, err);
        return false;
      },
    );
  }

  _attachFailed(tab, err) {
    log('cdp-error', `attach ${tab.targetId}: ${err.message}`);
    // Chrome unreachable: the reconnect sweep re-attaches known tabs.
    if (!this.conn?.open) return;
    // Do not leave an unmanaged tab behind in the appliance Chrome.
    this.conn.send('Target.closeTarget', { targetId: tab.targetId })
      .catch((e) => log('cdp-error', `closeTarget after attach failure: ${e.message}`));
    this._drop(tab, 'attach failed');
  }

  /** Attaches (or re-attaches) a flat session; idempotent while one is in
   *  flight, so createTab and a racing targetCreated adoption share a single
   *  attach instead of stacking two sessions on one target. */
  _attach(tab) {
    if (tab.attaching) return tab.attaching;
    const promise = this._doAttach(tab);
    tab.attaching = promise;
    return promise;
  }

  async _doAttach(tab) {
    const { sessionId } = await this.conn.send('Target.attachToTarget', {
      targetId: tab.targetId,
      flatten: true,
    });
    if (!this.tabs.has(tab.targetId)) {
      // Dropped while attaching: don't register the session, release it.
      this.conn?.send('Target.detachFromTarget', { sessionId })
        .catch((err) => log('cdp-error', `detachFromTarget: ${err.message}`));
      return;
    }
    tab.sessionId = sessionId;
    this._bySession.set(sessionId, tab);
    await tab.send('Page.enable');
    // A fresh session can lose prior emulation overrides, so re-apply them.
    await this._applyMetrics(tab, tab.metrics, { silent: true });
    if (tab.viewer && this.conn?.open) {
      await this._startScreencast(tab);
      this._pushTitle(tab);
      this._sendSyntheticFrame(tab); // reconnected viewer needs pixels too
    }
  }

  _drop(tab, reason) {
    if (!this.tabs.has(tab.targetId)) return;
    this.tabs.delete(tab.targetId);
    if (tab.sessionId && this._bySession.get(tab.sessionId) === tab) this._bySession.delete(tab.sessionId);
    tab.sessionId = null;
    tab.screencast = false;
    tab.pressed = null;
    this._stopTitleTimer(tab);
    this._viewerSend(tab, { t: 'closed' });
    // The viewer socket is left open in "closed" state (per spec the viewer
    // shows it); later messages answer "unknown tab" and close.
    tab.viewer = null;
    log('tab-close', `${tab.targetId} (${reason})`);
  }

  _gc() {
    const now = Date.now();
    const cutoff = now - this.config.staleMin * 60_000;
    for (const tab of this.tabs.values()) {
      const v = tab.viewer;
      if (v && now - (v.lastRx ?? now) > VIEWER_SILENT_MS) {
        // terminate() emits 'close' -> _onViewerClose cleans up.
        log('ws-timeout', `${tab.targetId} viewer silent >${VIEWER_SILENT_MS / 1000}s`);
        try {
          v.terminate();
        } catch (err) {
          log('ws-error', `terminate: ${err.message}`);
        }
        // Don't depend on the close event alone for state cleanup.
        this._onViewerClose(tab, v);
      }
      if (!tab.viewer && tab.lastViewerAt <= cutoff) {
        log('tab-gc', `${tab.targetId} stale after ${this.config.staleMin}min with no viewer`);
        this.closeTab(tab.targetId).catch((err) => log('cdp-error', `gc closeTarget: ${err.message}`));
      }
    }
  }

  // ---- Viewer sockets -----------------------------------------------------

  /** Called by index.js after a successful WS upgrade for /v1/stream/<tabId>. */
  handleViewer(tabId, ws) {
    ws.on('error', (err) => log('ws-error', `${tabId} ${err.message}`));
    ws.lastRx = Date.now();
    const tab = this.tabs.get(tabId);
    if (!tab) {
      this._wsSend(ws, { t: 'error', msg: 'unknown tab' });
      ws.close(4004, 'unknown tab');
      log('ws-error', `unknown tab ${tabId}`);
      return;
    }
    if (tab.viewer && tab.viewer !== ws) {
      this._wsSend(tab.viewer, { t: 'closed' });
      try {
        tab.viewer.close(4002, 'replaced');
      } catch { /* closing */ }
      log('ws-kick', `${tabId} (second viewer)`);
    }
    tab.viewer = ws;
    tab.pressed = null;
    tab.needsRefresh = false;
    tab.lastViewerAt = Date.now();
    log('ws-open', `${tabId}`);
    ws.on('message', (data) => this._onViewerMessage(tab, ws, data));
    ws.on('close', () => this._onViewerClose(tab, ws));
    this._activate(tab, ws).catch(() => { /* attach failure drops the tab */ });
  }

  /** Frames flow from connect (before any hello) using the tab's current
   *  metrics — the /v1/open defaults if never hello'd. */
  async _activate(tab, ws) {
    if (tab.attaching) await tab.attaching;
    if (tab.viewer !== ws || !this.conn?.open) return;
    this._bringToFront(tab);
    if (tab.sessionId && !tab.screencast) {
      this._startScreencast(tab).catch((err) => log('cdp-error', `startScreencast: ${err.message}`));
    }
    // An idle page can go minutes without a compositor frame, which would
    // leave the viewer stuck on "waiting for first frame". Guarantee one.
    this._sendSyntheticFrame(tab);
    // A fresh viewer has no title yet, even if the page loaded long before
    // it connected: force one initial push.
    tab.lastTitleKey = null;
    this._pushTitle(tab);
  }

  _onViewerClose(tab, ws) {
    if (tab.viewer !== ws) return; // it was kicked; the new viewer owns the tab
    tab.viewer = null;
    tab.pressed = null;
    tab.needsRefresh = false;
    tab.lastViewerAt = Date.now();
    log('ws-close', `${tab.targetId}`);
    if (tab.screencast) this._stopScreencast(tab);
  }

  _onViewerMessage(tab, ws, data) {
    ws.lastRx = Date.now();
    // Kicked viewers are ignored; a dropped tab (viewer nulled) still falls
    // through to the unknown-tab handling below.
    if (tab.viewer !== ws && this.tabs.has(tab.targetId)) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log('ws-error', `${tab.targetId} malformed JSON frame ignored`);
      return;
    }
    if (!this.tabs.has(tab.targetId)) {
      this._wsSend(ws, { t: 'error', msg: 'unknown tab' });
      ws.close(4004, 'unknown tab');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
      case 'resize':
        this._handleMetrics(tab, msg);
        return;
      case 'focus':
        this._bringToFront(tab);
        return;
      case 'mouse':
        if (msg.a === 'down' || msg.a === 'wheel') this._bringToFront(tab);
        this._handleMouse(tab, msg);
        return;
      case 'key':
        if (msg.a === 'down') this._bringToFront(tab);
        this._handleKey(tab, msg);
        return;
      case 'text':
        this._bringToFront(tab);
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          tab.send('Input.insertText', { text: msg.text })
            .catch((err) => log('cdp-error', `insertText: ${err.message}`));
        }
        return;
      case 'nav':
        if (typeof msg.url === 'string' && isHttpUrl(msg.url)) {
          tab.send('Page.navigate', { url: msg.url })
            .catch((err) => log('cdp-error', `navigate: ${err.message}`));
        }
        return;
      case 'back':
        this._navigateHistory(tab, -1);
        return;
      case 'forward':
        this._navigateHistory(tab, 1);
        return;
      case 'ping':
        this._wsSend(ws, { t: 'pong' });
        return;
      default:
        return; // unknown t: ignore
    }
  }

  // ---- hello / resize ------------------------------------------------------

  async _handleMetrics(tab, msg) {
    const metrics = clampMetrics(msg);
    try {
      if (tab.attaching) await tab.attaching;
      await this._applyMetrics(tab, metrics);
      tab.metrics = metrics; // only once Chrome actually applied it
      this._wsSend(tab.viewer, { t: 'ready', w: metrics.w, h: metrics.h, dpr: metrics.dpr });
      // setDeviceMetricsOverride does not reliably emit a screencast frame on
      // an idle page — push one at the new aspect ratio immediately.
      this._sendSyntheticFrame(tab);
    } catch (err) {
      log('cdp-error', `setDeviceMetricsOverride: ${err.message}`);
      this._wsSend(tab.viewer, { t: 'error', msg: 'chrome unreachable' });
    }
  }

  async _applyMetrics(tab, metrics, { silent = false } = {}) {
    try {
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: metrics.w,
        height: metrics.h,
        deviceScaleFactor: metrics.dpr,
        mobile: false,
      });
    } catch (err) {
      if (!silent) throw err;
      log('cdp-error', `setDeviceMetricsOverride ${tab.targetId}: ${err.message}`);
    }
  }

  // ---- Input forwarding -----------------------------------------------------

  /**
   * Viewer x/y arrive in remote CSS px: the viewer's letterbox math maps
   * against the frame message's w/h, which are the remote viewport's DIP
   * (CSS) dims. Input.dispatchMouseEvent takes exactly those — no rescaling.
   */
  _handleMouse(tab, msg) {
    const x = num(msg.x);
    const y = num(msg.y);
    const modifiers = int(msg.mods, 0);
    let params;
    switch (msg.a) {
      case 'move':
        params = {
          type: 'mouseMoved', x, y, button: tab.pressed ?? 'none',
          buttons: tab.pressed ? BUTTON_MASK[tab.pressed] : 0, modifiers,
        };
        break;
      case 'down':
        tab.pressed = buttonOf(msg.btn);
        params = {
          type: 'mousePressed', x, y, button: tab.pressed, buttons: BUTTON_MASK[tab.pressed],
          clickCount: Math.max(1, int(msg.clicks, 1)), modifiers,
        };
        break;
      case 'up':
        tab.pressed = null;
        params = {
          type: 'mouseReleased', x, y, button: buttonOf(msg.btn), buttons: 0,
          clickCount: Math.max(1, int(msg.clicks, 1)), modifiers,
        };
        break;
      case 'wheel':
        params = { type: 'mouseWheel', x, y, deltaX: num(msg.dx), deltaY: num(msg.dy) };
        break;
      default:
        return;
    }
    tab.send('Input.dispatchMouseEvent', params)
      .catch((err) => log('cdp-error', `dispatchMouseEvent: ${err.message}`));
  }

  _handleKey(tab, msg) {
    const key = typeof msg.key === 'string' ? msg.key : '';
    const code = typeof msg.code === 'string' ? msg.code : '';
    const vk = int(msg.vk, 0);
    const modifiers = int(msg.mods, 0);
    // Enter arrives with text:null (multi-char key) but still must insert:
    // CDP only produces the default action (newline/submit) via keyDown+text.
    const text = typeof msg.text === 'string' && msg.text.length > 0
      ? msg.text
      : (key === 'Enter' ? '\r' : null);
    let params;
    if (msg.a === 'down') {
      // Printable chars ride along with keyDown; everything else is rawKeyDown.
      params = {
        type: text !== null ? 'keyDown' : 'rawKeyDown',
        key, code, modifiers,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        autoRepeat: !!msg.repeat,
      };
      if (text !== null) params.text = text;
      if (Array.isArray(msg.commands)) {
        const commands = msg.commands.filter((c) => typeof c === 'string').slice(0, 4);
        if (commands.length > 0) params.commands = commands;
      }
    } else if (msg.a === 'up') {
      params = {
        type: 'keyUp', key, code, modifiers,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        autoRepeat: !!msg.repeat,
      };
    } else {
      return;
    }
    tab.send('Input.dispatchKeyEvent', params)
      .catch((err) => log('cdp-error', `dispatchKeyEvent: ${err.message}`));
    if (params.commands?.some((c) => c === 'copy' || c === 'cut')) {
      this._pushClipboard(tab, tab.viewer);
    }
  }

  /** After a copy/cut chord, read the page selection and hand it to the viewer
   *  (best-effort: empty selections and canvas editors send nothing). */
  async _pushClipboard(tab, ws) {
    try {
      await sleep(COPY_SETTLE_MS);
      const res = await tab.send('Runtime.evaluate', {
        expression: 'String(window.getSelection())',
        returnByValue: true,
      });
      const value = res?.result?.value;
      if (typeof value !== 'string' || value.length === 0) return;
      if (tab.viewer !== ws) return;
      this._wsSend(ws, { t: 'clipboard', text: value.slice(0, CLIPBOARD_MAX) });
    } catch (err) {
      log('cdp-error', `clipboard: ${err.message}`);
    }
  }

  async _navigateHistory(tab, delta) {
    try {
      const { currentIndex, entries } = await tab.send('Page.getNavigationHistory');
      const next = (currentIndex ?? -1) + delta;
      if (next >= 0 && next < entries.length) {
        await tab.send('Page.navigate', { entryId: entries[next].id });
      }
    } catch (err) {
      log('cdp-error', `getNavigationHistory: ${err.message}`);
    }
  }

  // ---- Screencast + titles ---------------------------------------------------

  async _startScreencast(tab) {
    if (tab.screencast) return;
    tab.screencast = true;
    try {
      await tab.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.config.quality,
        maxWidth: SCREENCAST_MAX_W,
        maxHeight: SCREENCAST_MAX_H,
        everyFrame: true,
      });
    } catch (err) {
      tab.screencast = false;
      throw err;
    }
    if (!tab.screencast) return; // viewer left mid-start; don't leak the timer
    this._startTitleTimer(tab);
  }

  _stopScreencast(tab) {
    if (!tab.screencast) return;
    tab.screencast = false;
    this._stopTitleTimer(tab);
    if (tab.sessionId) {
      tab.send('Page.stopScreencast').catch((err) => log('cdp-error', `stopScreencast: ${err.message}`));
    }
  }

  _onFrame(tab, params) {
    tab.frameSeq++;
    const meta = params.metadata ?? {};
    // params.sessionId is the *screencast* session, distinct from the flat CDP
    // session the ack command itself rides on (tab.sessionId). Chrome stalls
    // the stream if frames are never acked, so every path acks.
    const ack = () => {
      try {
        tab.send('Page.screencastFrameAck', { sessionId: params.sessionId })
          .catch((err) => log('cdp-error', `screencastFrameAck: ${err.message}`));
      } catch (err) {
        log('cdp-error', `screencastFrameAck: ${err.message}`);
      }
    };
    const viewer = tab.viewer;
    if (!viewer) {
      ack();
      return;
    }
    if (viewer.readyState === 1 && viewer.bufferedAmount < BACKPRESSURE_BYTES) {
      try {
        viewer.send(JSON.stringify({
          t: 'frame', d: params.data, w: meta.deviceWidth, h: meta.deviceHeight,
        }), (err) => {
          if (err) log('ws-error', `frame send: ${err.message}`);
          ack();
        });
      } catch (err) {
        log('ws-error', `frame send: ${err.message}`);
        ack();
      }
    } else {
      tab.needsRefresh = true;
      setTimeout(ack, DROP_ACK_MS);
    }
  }

  /** Page.captureScreenshot forces a composite; relay it as a frame so a
   *  viewer connecting to (or resizing against) an idle page gets pixels
   *  immediately. Coalesced: one capture in flight per tab, and any requests
   *  made meanwhile collapse into exactly one follow-up. */
  _sendSyntheticFrame(tab) {
    if (tab.capturing) {
      tab.capturePending = true;
      return;
    }
    tab.capturing = true;
    this._captureOnce(tab)
      .catch((err) => log('cdp-error', `captureScreenshot: ${err.message}`))
      .finally(() => {
        tab.capturing = false;
        if (tab.capturePending) {
          tab.capturePending = false;
          this._sendSyntheticFrame(tab);
        }
      });
  }

  /** Dims are the tab's CSS metrics, snapshotted before the await. The frame
   *  is dropped if a real frame arrived or the metrics changed meanwhile. */
  async _captureOnce(tab) {
    if (!tab.sessionId || !this.conn?.open) return;
    const { w, h } = tab.metrics;
    const seq = tab.frameSeq;
    const { data } = await tab.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: this.config.quality,
    });
    const viewer = tab.viewer;
    if (!viewer || !this.tabs.has(tab.targetId)) return;
    if (tab.frameSeq !== seq || tab.metrics.w !== w || tab.metrics.h !== h) return;
    if (viewer.bufferedAmount >= BACKPRESSURE_BYTES) return;
    this._wsSend(viewer, { t: 'frame', d: data, w, h });
  }

  _startTitleTimer(tab) {
    if (tab.titleTimer) return;
    tab.titleTimer = setInterval(() => {
      this._pushTitle(tab);
      const v = tab.viewer;
      if (tab.needsRefresh && v && v.readyState === 1 && v.bufferedAmount < BACKPRESSURE_BYTES) {
        tab.needsRefresh = false;
        this._sendSyntheticFrame(tab);
      }
    }, TITLE_POLL_MS);
  }

  _stopTitleTimer(tab) {
    if (tab.titleTimer) {
      clearInterval(tab.titleTimer);
      tab.titleTimer = null;
    }
  }

  /** Target.getTargetInfo -> push {"t":"title"} when title or url changed. */
  async _pushTitle(tab) {
    if (!this.conn?.open) return;
    try {
      const { targetInfo } = await this.conn.send('Target.getTargetInfo', { targetId: tab.targetId });
      const key = `${targetInfo.title}\u0000${targetInfo.url}`;
      if (key === tab.lastTitleKey) return;
      tab.lastTitleKey = key;
      tab.title = targetInfo.title ?? '';
      tab.url = targetInfo.url ?? '';
      this._viewerSend(tab, { t: 'title', title: tab.title, url: tab.url });
    } catch (err) {
      log('cdp-error', `getTargetInfo: ${err.message}`);
    }
  }

  // ---- CDP event routing ------------------------------------------------------

  _onCdpEvent(method, params, sessionId) {
    if (sessionId === null) {
      this._onBrowserEvent(method, params);
      return;
    }
    const tab = this._bySession.get(sessionId);
    if (!tab || !this.tabs.has(tab.targetId)) return;
    switch (method) {
      case 'Page.screencastFrame':
        this._onFrame(tab, params);
        break;
      case 'Page.loadEventFired':
        this._pushTitle(tab);
        break;
      default:
        break;
    }
  }

  /**
   * Chrome only renders the active tab of each window: a background tab is
   * document.hidden, emits no screencast frames and drops input. A popup or a
   * new /v1/open tab steals the front, freezing every other viewer — so the
   * tab a viewer is using (connect, focus, click, key) is brought to front.
   */
  _bringToFront(tab) {
    if (!tab.sessionId || this.frontTabId === tab.targetId) return;
    this.frontTabId = tab.targetId;
    tab.send('Page.bringToFront')
      .then(() => this._sendSyntheticFrame(tab))
      .catch((err) => {
        if (this.frontTabId === tab.targetId) this.frontTabId = null;
        log('cdp-error', `bringToFront ${tab.targetId}: ${err.message}`);
      });
  }

  _onBrowserEvent(method, params) {
    switch (method) {
      case 'Target.targetDestroyed':
        {
          // Chrome picks a new front tab on its own; we no longer know which.
          if (this.frontTabId === params.targetId) this.frontTabId = null;
          const tab = this.tabs.get(params.targetId);
          if (tab) this._drop(tab, 'target destroyed');
        }
        break;
      case 'Target.targetCreated':
        // A new page (popup or /v1/open) opens in front of whatever we raised.
        if (params.targetInfo?.type === 'page') this.frontTabId = null;
        if (params.targetInfo?.type === 'page' && !this.tabs.has(params.targetInfo.targetId)) {
          const info = params.targetInfo;
          const opener = info.openerId ? this.tabs.get(info.openerId) : null;
          const attached = this._adopt(info.targetId, info.url ?? 'about:blank');
          if (opener?.viewer) {
            attached.then((ok) => {
              if (ok && this.tabs.has(info.targetId)) {
                this._viewerSend(opener, { t: 'popup', tabId: info.targetId, url: info.url ?? '' });
              }
            });
          }
        }
        break;
      case 'Target.targetInfoChanged':
        {
          const tab = this.tabs.get(params.targetInfo?.targetId);
          if (tab) {
            tab.title = params.targetInfo.title ?? tab.title;
            tab.url = params.targetInfo.url ?? tab.url;
          }
        }
        break;
      default:
        break;
    }
  }

  // ---- outbound viewer helpers -------------------------------------------------

  _wsSend(ws, obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (err) {
      log('ws-error', err.message);
    }
  }

  _viewerSend(tab, obj) {
    if (tab?.viewer) this._wsSend(tab.viewer, obj);
  }
}
