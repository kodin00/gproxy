import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { log } from './log.js';

const COMMAND_TIMEOUT_MS = 10_000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET http://127.0.0.1:<cdpPort>/json/version; throws if CDP is not answering. */
export async function fetchVersionInfo(cdpPort, timeoutMs = 2000) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`/json/version HTTP ${res.status}`);
  return res.json();
}

/**
 * Spawns appliance Chrome detached with the spec's exact flags. Detached + unref
 * so Chrome outlives the agent, but the ChildProcess still delivers 'exit'
 * while we run (which we log; the CDP socket drop drives reconnection).
 */
export function launchChrome({ chromePath, profileDir, cdpPort }) {
  fs.mkdirSync(profileDir, { recursive: true });
  // '=' form only: Chrome's argv parser does NOT reliably bind space-separated
  // values (the launch then falls back to the default profile dir and aborts
  // on its SingletonLock if that profile is locked/sandboxed).
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  child.on('error', (err) => log('chrome-error', `spawn failed: ${err.message}`));
  child.on('exit', (code, signal) => log('chrome-exit', `code=${code ?? ''} signal=${signal ?? ''}`));
  log('chrome-launch', `pid=${child.pid} cdpPort=${cdpPort} profile=${profileDir}`);
  return child;
}

/** Polls /json/version until Chrome's debugger answers, then returns it. */
export async function waitForVersionInfo(cdpPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await fetchVersionInfo(cdpPort, 1500);
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw lastErr ?? new Error(`chrome did not answer on port ${cdpPort}`);
}

/**
 * Minimal flat-session CDP client over one browser WebSocket.
 *
 * - send(method, params, { sessionId }) puts `sessionId` at the message top
 *   level (flat protocol) and returns the command result; rejects on CDP
 *   error responses, timeouts, or a dead socket. Never resolves late after a
 *   timeout (the pending entry is dropped and a late reply is ignored).
 * - Session-scoped events are emitted as ('event', method, params, sessionId)
 *   with sessionId === null for browser-level events.
 */
export class CdpConnection extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this._ws = null;
    this._id = 0;
    this._pending = new Map();
  }

  get open() {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.open) return resolve();
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      this._ws = ws;
      ws.on('open', () => {
        log('cdp-open', this.wsUrl);
        resolve();
      });
      ws.on('error', (err) => {
        // Before the handshake completes, surface the failure to connect();
        // afterwards 'close' follows and the supervisor handles it.
        if (ws.readyState === WebSocket.CONNECTING) reject(err);
        else log('cdp-error', err.message);
      });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => this._onClose());
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // not valid CDP; ignore
    }
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return; // timed out already
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? msg.error.code}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit('event', msg.method, msg.params ?? {}, msg.sessionId ?? null);
    }
  }

  _onClose() {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('cdp connection closed'));
    }
    this._pending.clear();
    log('cdp-close', 'browser websocket closed');
    this.emit('closed');
  }

  /**
   * Sends a command. The ws.send happens synchronously, so a burst of
   * fire-and-forget input commands keeps its arrival order.
   */
  send(method, params = {}, { sessionId, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (!this.open) return Promise.reject(new Error('cdp not connected'));
    const id = ++this._id;
    const msg = { id, method };
    if (params) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    this._ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
    });
  }

  close() {
    try {
      this._ws?.close();
    } catch {
      // already closing/closed
    }
  }
}
