import { EventEmitter } from 'node:events';
import { CdpConnection, fetchVersionInfo, launchChrome, sleep, waitForVersionInfo } from './cdp.js';
import { log } from './log.js';

const ENSURE_TIMEOUT_MS = 30_000;
const BACKOFF_MAX_MS = 10_000;

/**
 * Owns the appliance Chrome lifecycle and the browser CDP connection:
 *
 *   start() -> probe /json/version -> (spawn Chrome detached if down) ->
 *   connect browser WS -> Target.setDiscoverTargets -> emit 'connected'.
 *
 * If the CDP socket ever dies, the loop probes again, respawns Chrome when
 * needed, and re-attaches; 'disconnected' then 'connected' are emitted each
 * cycle. ensureConnected() lets HTTP handlers wait for (and trigger) a
 * connection with a timeout instead of hanging forever.
 *
 * Events: 'connected' (CdpConnection), 'disconnected' ().
 */
export class BrowserSupervisor extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.conn = null;
    this._stopped = false;
    this._running = false;
    this._backoffMs = 1000;
  }

  get connected() {
    return !!this.conn && this.conn.open;
  }

  /** Kicks off the supervision loop (idempotent, fire and forget). */
  start() {
    this._stopped = false;
    if (this._running) return;
    this._running = true;
    this._run().catch((err) => log('browser', `supervisor loop crashed: ${err.message}`));
  }

  stop() {
    this._stopped = true;
    this.conn?.close(); // Chrome itself is left running: it outlives the agent
  }

  async _run() {
    try {
      while (!this._stopped) {
        try {
          const conn = await this._connectOnce();
          if (this._stopped) {
            conn.close();
            return;
          }
          this.conn = conn;
          this._backoffMs = 1000;
          this.emit('connected', conn);
          await new Promise((resolve) => conn.once('closed', resolve));
          this.emit('disconnected');
        } catch (err) {
          log('cdp-error', err.message);
        }
        this.conn = null;
        if (this._stopped) return;
        log('browser', `reconnecting in ${this._backoffMs}ms`);
        await sleep(this._backoffMs);
        this._backoffMs = Math.min(this._backoffMs * 2, BACKOFF_MAX_MS);
      }
    } finally {
      this._running = false;
    }
  }

  async _connectOnce() {
    let info = null;
    try {
      info = await fetchVersionInfo(this.config.cdpPort);
    } catch {
      info = null; // Chrome down (or starting): spawn it
    }
    if (!info) {
      launchChrome(this.config);
      info = await waitForVersionInfo(this.config.cdpPort, ENSURE_TIMEOUT_MS);
    }
    const conn = new CdpConnection(info.webSocketDebuggerUrl);
    await conn.connect();
    try {
      // Browser-level targetCreated/targetDestroyed events need discovery on.
      await conn.send('Target.setDiscoverTargets', { discover: true });
    } catch (err) {
      conn.close(); // don't leak a socket per retry
      throw err;
    }
    return conn;
  }

  /**
   * Resolves with a live CdpConnection (waiting for any in-flight reconnect,
   * which also respawns Chrome if it died). Rejects after timeoutMs so HTTP
   * handlers can answer 502 instead of hanging.
   */
  ensureConnected(timeoutMs = ENSURE_TIMEOUT_MS) {
    if (this.connected) return Promise.resolve(this.conn);
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new Error('chrome not connected'));
      }, timeoutMs);
      const onConnected = (conn) => {
        clearTimeout(timer);
        resolve(conn);
      };
      this.once('connected', onConnected);
    });
  }
}
