#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { BrowserSupervisor } from './browser.js';
import { TabRegistry } from './tabs.js';
import { log } from './log.js';

const VERSION = '1.0.0';
const BODY_LIMIT_BYTES = 1024 * 1024;

// This runs under launchd unattended: log and keep going, never crash.
process.on('unhandledRejection', (err) => log('unhandled-rejection', err?.stack || String(err)));
process.on('uncaughtException', (err) => log('uncaught-exception', err?.stack || String(err)));

const config = loadConfig();
log('agent-start', `version=${VERSION} port=${config.port} cdpPort=${config.cdpPort} chrome=${config.chromePath} profile=${config.profileDir} staleMin=${config.staleMin} quality=${config.quality}`);

const supervisor = new BrowserSupervisor(config);
const tabs = new TabRegistry(config);
supervisor.on('connected', (conn) => {
  tabs.setConnection(conn).catch((err) => log('cdp-error', `sweep: ${err.message}`));
});
supervisor.on('disconnected', () => tabs.clearConnection());
supervisor.start();

// ---- helpers -----------------------------------------------------------------

function tokenEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && tokenEq(m[1], config.token);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJson(req) {
  return readBody(req).then((body) => {
    if (!body) return {};
    const parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  });
}

function httpUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

// ---- HTTP routes ---------------------------------------------------------------

async function route(req, res) {
  let path;
  try {
    path = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
    });
    res.end();
    return;
  }

  if (path === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, chrome: supervisor.connected, version: VERSION });
  }

  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (path === '/v1/open' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: `bad request: ${err.message}` });
    }
    const urlToOpen = httpUrl(body.url);
    if (!urlToOpen) return sendJson(res, 400, { error: 'url must be http(s)' });
    try {
      await supervisor.ensureConnected();
      const tab = await tabs.createTab(urlToOpen);
      return sendJson(res, 200, { tabId: tab.targetId, url: urlToOpen });
    } catch (err) {
      log('http-error', `/v1/open: ${err.message}`);
      return sendJson(res, 502, { error: `chrome unavailable: ${err.message}` });
    }
  }

  if (path === '/v1/close' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: `bad request: ${err.message}` });
    }
    if (typeof body.tabId !== 'string' || body.tabId === '') {
      return sendJson(res, 400, { error: 'tabId required' });
    }
    const ok = await tabs.closeTab(body.tabId);
    return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'unknown tab' });
  }

  if (path === '/v1/tabs' && req.method === 'GET') {
    return sendJson(res, 200, { tabs: tabs.listTabs() });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    log('http-error', `${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  });
});

// ---- WebSocket: /v1/stream/<tabId>?token=... ------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT_BYTES });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  const m = /^\/v1\/stream\/([^/]+)$/.exec(url.pathname);
  if (!m) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  let tabId;
  try {
    tabId = decodeURIComponent(m[1]);
  } catch {
    tabId = m[1];
  }
  const token = url.searchParams.get('token') ?? '';
  if (!tokenEq(token, config.token)) {
    // Complete the handshake so the client observes close code 4001.
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, 'unauthorized'));
    log('ws-auth', 'rejected (bad token)');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => tabs.handleViewer(tabId, ws));
});

// A bind failure is unrecoverable for this process: let launchd restart it.
server.on('error', (err) => {
  log('http-error', `server: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, '0.0.0.0', () => {
  log('http-listen', `0.0.0.0:${config.port}`);
});

// ---- shutdown --------------------------------------------------------------------

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('agent-stop', signal);
  try {
    tabs.shutdown();
  } catch (err) {
    log('agent-stop', err.message);
  }
  supervisor.stop();
  server.close();
  for (const client of wss.clients) {
    try {
      client.close(1001, 'agent shutting down');
    } catch { /* closing */ }
  }
  // Let close frames flush, then exit regardless of lingering timers.
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
