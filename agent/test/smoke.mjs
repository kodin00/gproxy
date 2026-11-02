#!/usr/bin/env node
// gproxy agent smoke test (spec "Testing rule"):
//   temp-profile appliance Chrome on an ephemeral CDP port, agent on an
//   ephemeral port, a local page with an <input>, /v1/open, a WS viewer
//   client; asserts >=1 frame + title event, sends {"t":"text","text":"hi"}
//   and verifies the input value via Runtime.evaluate through the agent's own
//   CDP module. Exit 0 pass / 1 fail / 77 skip (Chrome not installed).
//
// Run from the repo root:  node agent/test/smoke.mjs

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CdpConnection, launchChrome, sleep, waitForVersionInfo } from '../src/cdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.dirname(HERE);
const AGENT_ENTRY = path.join(AGENT_DIR, 'src', 'index.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_TITLE = 'gproxy smoke page';
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body><input id="x" autofocus><p id=p>hello clip</p><script>document.getElementById("x").focus();</script></body></html>`;

const state = {
  agent: null,
  chrome: null,
  pageServer: null,
  cdp: null,
  sockets: [],
  tmp: null,
  profileDir: null,
};

const step = (msg) => console.log(`[smoke] ${msg}`);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function onceExit(child) {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([onceExit(child), sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function cleanup() {
  for (const ws of state.sockets) {
    try { ws.terminate(); } catch { /* gone */ }
  }
  try { state.cdp?.close(); } catch { /* gone */ }
  await killTree(state.agent);
  await killTree(state.chrome);
  try { state.pageServer?.close(); } catch { /* gone */ }
  if (state.profileDir) {
    try { spawnSync('pkill', ['-f', state.profileDir], { stdio: 'ignore' }); } catch { /* none */ }
  }
  if (state.tmp) {
    for (const delay of [0, 500]) {
      if (delay) await sleep(delay);
      try { fs.rmSync(state.tmp, { recursive: true, force: true }); break; } catch { /* busy */ }
    }
  }
}

/** Opens a WS client and records messages; resolves once the socket is open. */
function wsCollect(url, messages) {
  const ws = new WebSocket(url);
  state.sockets.push(ws);
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), 10_000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitMsg(messages, predicate, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      for (const m of messages) {
        if (predicate(m)) return resolve(m);
      }
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(poll, 100);
    })();
  });
}

async function fetchJson(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  return { status: res.status, body };
}

async function waitHealthy(agentPort, agent) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (agent.exitCode !== null) throw new Error(`agent exited early (code ${agent.exitCode})`);
    try {
      const { status, body } = await fetchJson(`http://127.0.0.1:${agentPort}/health`);
      if (status === 200 && body.ok === true && body.chrome === true) return body;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('agent /health never reported chrome:true');
}

/** Waits for ws 'close' and returns {code, reason}. */
function wsClose(ws, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function run() {
  // 1. Appliance Chrome (temp profile, ephemeral CDP port).
  state.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gproxy-smoke-'));
  state.profileDir = path.join(state.tmp, 'profile');
  const cdpPort = await pickPort();
  const agentPort = await pickPort();
  const pagePort = await pickPort();
  const token = crypto.randomUUID().replaceAll('-', '');
  step(`temp dir ${state.tmp}; cdpPort=${cdpPort} agentPort=${agentPort} pagePort=${pagePort}`);

  state.pageServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise((resolve) => state.pageServer.listen(pagePort, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${pagePort}/page`;
  step(`local page at ${pageUrl}`);

  step('launching appliance Chrome');
  state.chrome = launchChrome({ chromePath: CHROME, profileDir: state.profileDir, cdpPort });
  await waitForVersionInfo(cdpPort, 30_000);
  step('chrome debugger answering');

  // 2. Agent on an ephemeral port, configured purely via env vars.
  state.agent = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: AGENT_DIR,
    env: {
      ...process.env,
      GPROXY_PORT: String(agentPort),
      GPROXY_CDP_PORT: String(cdpPort),
      GPROXY_TOKEN: token,
      GPROXY_CONFIG: path.join(state.tmp, 'config.json'),
      GPROXY_PROFILE_DIR: state.profileDir,
      GPROXY_CHROME_PATH: CHROME,
      GPROXY_STALE_MIN: '60',
      GPROXY_QUALITY: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.agent.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`));
  state.agent.stderr.on('data', (d) => process.stderr.write(`[agent:err] ${d}`));
  await waitHealthy(agentPort, state.agent);
  step('agent healthy with chrome connected');

  // 3. Auth.
  const noAuth = await fetchJson(`http://127.0.0.1:${agentPort}/v1/tabs`);
  assert(noAuth.status === 401, `expected 401 without token, got ${noAuth.status}`);
  step('401 without bearer token');

  // 4. Open a tab on the local page.
  const open = await fetchJson(`http://127.0.0.1:${agentPort}/v1/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: pageUrl }),
  });
  assert(open.status === 200, `/v1/open failed: ${open.status} ${JSON.stringify(open.body)}`);
  const tabId = open.body.tabId;
  assert(typeof tabId === 'string' && tabId.length > 0, `/v1/open returned no tabId: ${JSON.stringify(open.body)}`);
  step(`opened tab ${tabId}`);

  const badOpen = await fetchJson(`http://127.0.0.1:${agentPort}/v1/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: 'file:///etc/passwd' }),
  });
  assert(badOpen.status === 400, `expected 400 for non-http(s) url, got ${badOpen.status}`);
  step('400 for non-http(s) url');

  const tabs = await fetchJson(`http://127.0.0.1:${agentPort}/v1/tabs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(tabs.status === 200 && Array.isArray(tabs.body.tabs), `/v1/tabs failed: ${JSON.stringify(tabs.body)}`);
  assert(tabs.body.tabs.some((t) => t.tabId === tabId), 'opened tab missing from /v1/tabs');
  step(`/v1/tabs lists ${tabs.body.tabs.length} tab(s)`);

  // 5. Viewer WS: hello -> ready, >=1 frame, title event.
  const msgs = [];
  const ws = await wsCollect(`ws://127.0.0.1:${agentPort}/v1/stream/${tabId}?token=${token}`, msgs);
  ws.send(JSON.stringify({ t: 'hello', w: 1024, h: 768, dpr: 1 }));

  const ready = await waitMsg(msgs, (m) => m.t === 'ready', 'ready');
  assert(ready.w === 1024 && ready.h === 768 && ready.dpr === 1, `bad ready: ${JSON.stringify(ready)}`);
  step(`ready ${ready.w}x${ready.h} dpr${ready.dpr}`);

  const frame = await waitMsg(msgs, (m) => m.t === 'frame' && typeof m.d === 'string' && m.d.length > 0
    && Number.isFinite(m.w) && Number.isFinite(m.h), 'a frame');
  step(`frame ${frame.w}x${frame.h} (${frame.d.length} b64 chars)`);

  const title = await waitMsg(msgs, (m) => m.t === 'title' && m.title === PAGE_TITLE, `title "${PAGE_TITLE}"`);
  step(`title "${title.title}" ${title.url}`);

  // 6. Type text through the stream, then read the input's value via our own CDP module.
  ws.send(JSON.stringify({ t: 'text', text: 'hi' }));
  const versionInfo = await waitForVersionInfo(cdpPort, 5000);
  state.cdp = new CdpConnection(versionInfo.webSocketDebuggerUrl);
  await state.cdp.connect();
  const { sessionId } = await state.cdp.send('Target.attachToTarget', { targetId: tabId, flatten: true });
  const value = await evalUntil(
    () => state.cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("x").value',
      returnByValue: true,
    }, { sessionId }),
    (r) => r?.result?.value === 'hi',
    8000,
  );
  assert(value.result.value === 'hi', `input value was ${JSON.stringify(value.result.value)}, expected "hi"`);
  step('text "hi" landed in the page input');

  const pageEval = (expression, extra = {}) => state.cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, ...extra,
  }, { sessionId });

  // 6a. v1.1: non-http(s) nav is ignored.
  ws.send(JSON.stringify({ t: 'nav', url: 'file:///etc/hosts' }));
  await sleep(500);
  const hrefAfterNav = (await pageEval('location.href')).result.value;
  assert(hrefAfterNav.startsWith(pageUrl), `file:// nav was not ignored: page is at ${hrefAfterNav}`);
  step('nav to file:// ignored');

  // 6b. v1.1: copy chord -> clipboard message with the page selection.
  await pageEval(`(() => { document.activeElement.blur();
    const r = document.createRange(); r.selectNodeContents(document.getElementById('p'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s); })()`);
  ws.send(JSON.stringify({
    t: 'key', a: 'down', key: 'c', code: 'KeyC', vk: 67, mods: 4, text: null, commands: ['copy'],
  }));
  const clip = await waitMsg(msgs, (m) => m.t === 'clipboard', 'clipboard message', 5000);
  assert(clip.text === 'hello clip', `bad clipboard text: ${JSON.stringify(clip.text)}`);
  step('copy chord produced clipboard "hello clip"');

  // 6c. v1.1: window.open in the viewed tab -> popup message with a listed tabId.
  await pageEval(`window.open(${JSON.stringify(pageUrl + '?popup=1')}); 1`, { userGesture: true });
  const popup = await waitMsg(msgs, (m) => m.t === 'popup', 'popup message', 10_000);
  assert(typeof popup.tabId === 'string' && popup.tabId !== tabId, `bad popup msg: ${JSON.stringify(popup)}`);
  const tabsAfterPopup = await fetchJson(`http://127.0.0.1:${agentPort}/v1/tabs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(tabsAfterPopup.body.tabs.some((t) => t.tabId === popup.tabId), 'popup tab missing from /v1/tabs');
  step(`popup ${popup.tabId} announced and listed`);

  // 6d. Regression: the popup took the front, which hides the original tab
  // (no frames, dead input). A "focus" from its viewer must bring it back.
  const visibility = async () => (await pageEval('document.visibilityState')).result.value;
  await evalUntil(visibility, (v) => v === 'hidden', 5000);
  assert(await visibility() === 'hidden', 'expected the popup to hide the original tab');
  const framesBefore = msgs.length;
  ws.send(JSON.stringify({ t: 'focus' }));
  await evalUntil(visibility, (v) => v === 'visible', 5000);
  assert(await visibility() === 'visible', 'focus did not bring the original tab back to front');
  const resumed = await evalUntil(
    async () => msgs.slice(framesBefore).some((m) => m.t === 'frame'),
    (ok) => ok,
    5000,
  );
  assert(resumed, 'no frames after bringing the original tab to front');
  step('focus brought the original tab back to front; frames resumed');

  // 7. Wrong token -> close 4001.
  const badTokenMsgs = [];
  const badWs = await wsCollect(`ws://127.0.0.1:${agentPort}/v1/stream/${tabId}?token=deadbeef`, badTokenMsgs);
  const badClose = await wsClose(badWs);
  assert(badClose.code === 4001, `expected close 4001 for bad token, got ${badClose.code}`);
  step('bad token closed with 4001');

  // 8. Second viewer kicks the first: kicked socket gets {"t":"closed"} then close.
  const kicked = wsClose(ws);
  kicked.catch(() => { /* awaited below; avoid a masking unhandled rejection */ });
  const ws2Msgs = [];
  const ws2 = await wsCollect(`ws://127.0.0.1:${agentPort}/v1/stream/${tabId}?token=${token}`, ws2Msgs);
  const kickedClose = await kicked;
  const closedMsg = await waitMsg(msgs, (m) => m.t === 'closed', '{"t":"closed"} on kicked socket');
  assert(closedMsg.t === 'closed', 'kicked socket did not get {"t":"closed"}');
  step(`first viewer kicked (close ${kickedClose.code}) and told "closed"`);
  try { ws2.close(); } catch { /* closing */ }

  // 9. Unknown tab -> error message then close.
  const unknownMsgs = [];
  const unknownWs = await wsCollect(`ws://127.0.0.1:${agentPort}/v1/stream/AAAABBBBCCCC?token=${token}`, unknownMsgs);
  await wsClose(unknownWs);
  const err = unknownMsgs.find((m) => m.t === 'error' && /unknown tab/.test(m.msg ?? ''));
  assert(!!err, `expected {"t":"error","msg":"unknown tab"}, got ${JSON.stringify(unknownMsgs)}`);
  step('unknown tab answered {"t":"error","msg":"unknown tab"} then closed');

  // 10. POST /v1/close.
  const closed = await fetchJson(`http://127.0.0.1:${agentPort}/v1/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tabId }),
  });
  assert(closed.status === 200 && closed.body.ok === true, `/v1/close failed: ${JSON.stringify(closed.body)}`);
  step('closed tab via /v1/close');
}

async function evalUntil(fn, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`Runtime.evaluate never satisfied (last: ${JSON.stringify(last)})`);
}

async function main() {
  let exitCode;
  if (!fs.existsSync(CHROME)) {
    console.error(`[smoke] skip: ${CHROME} not found — install Google Chrome to run this test`);
    exitCode = 77;
  } else {
    try {
      await run();
      console.log('[smoke] SMOKE PASS');
      exitCode = 0;
    } catch (err) {
      console.error(`[smoke] SMOKE FAIL: ${err.message}`);
      exitCode = 1;
    } finally {
      await cleanup();
    }
  }
  process.exit(exitCode);
}

// Hard watchdog: never let a hung smoke test outlive its welcome.
setTimeout(() => {
  console.error('[smoke] SMOKE FAIL: global timeout (180s)');
  try { state.agent?.kill('SIGKILL'); } catch { /* gone */ }
  try { state.chrome?.kill('SIGKILL'); } catch { /* gone */ }
  try { state.pageServer?.close(); } catch { /* gone */ }
  if (state.profileDir) {
    try { spawnSync('pkill', ['-f', state.profileDir], { stdio: 'ignore' }); } catch { /* none */ }
  }
  process.exit(1);
}, 180_000).unref();

main();
