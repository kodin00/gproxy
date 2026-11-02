import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { log } from './log.js';

const DEFAULTS = {
  port: 7654,
  cdpPort: 7655,
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  profileDir: '~/.local/share/gproxy/chrome-profile',
  quality: 70,
  staleMin: 10,
};

// Env vars override config-file values (used by the smoke test and launchd tweaks).
const ENV = {
  port: 'GPROXY_PORT',
  cdpPort: 'GPROXY_CDP_PORT',
  token: 'GPROXY_TOKEN',
  chromePath: 'GPROXY_CHROME_PATH',
  profileDir: 'GPROXY_PROFILE_DIR',
  quality: 'GPROXY_QUALITY',
  staleMin: 'GPROXY_STALE_MIN',
};

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function clampInt(value, fallback, min, max) {
  return Math.min(max, Math.max(min, toInt(value, fallback)));
}

function expandTilde(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function configPathFromEnv() {
  return process.env.GPROXY_CONFIG || path.join(os.homedir(), '.config', 'gproxy', 'config.json');
}

function persistToken(configPath, fileCfg, token) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const merged = { ...fileCfg, token };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(configPath, 0o600); // mode only applies on create; tighten an existing file too
  } catch (err) {
    log('config', `could not save token to ${configPath}: ${err.message} (token still active in memory)`);
  }
}

/**
 * Loads ~/.config/gproxy/config.json (or $GPROXY_CONFIG), applies defaults and
 * env overrides, and guarantees a token: env > file > freshly generated
 * 32-hex (persisted back into the config file and printed to stdout).
 */
export function loadConfig() {
  const configPath = configPathFromEnv();
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (fileCfg === null || typeof fileCfg !== 'object' || Array.isArray(fileCfg)) fileCfg = {};
  } catch (err) {
    if (err.code !== 'ENOENT') log('config', `unreadable ${configPath}: ${err.message} (using defaults)`);
  }

  const cfg = { ...DEFAULTS, ...fileCfg };
  for (const [key, envName] of Object.entries(ENV)) {
    const v = process.env[envName];
    if (v !== undefined && v !== '') cfg[key] = v;
  }

  cfg.port = clampInt(cfg.port, DEFAULTS.port, 1, 65535);
  cfg.cdpPort = clampInt(cfg.cdpPort, DEFAULTS.cdpPort, 1, 65535);
  cfg.quality = clampInt(cfg.quality, DEFAULTS.quality, 1, 100);
  cfg.staleMin = Math.max(1, toInt(cfg.staleMin, DEFAULTS.staleMin));
  cfg.chromePath = String(cfg.chromePath);
  cfg.profileDir = expandTilde(String(cfg.profileDir));
  cfg.configPath = configPath;

  if (typeof cfg.token !== 'string' || cfg.token.trim() === '') {
    cfg.token = crypto.randomBytes(16).toString('hex');
    persistToken(configPath, fileCfg, cfg.token);
    // Never log the token value: launchd log files are world-readable in /tmp.
    log('token', `generated a new token, saved to ${configPath} (read it there, or rerun deploy/install.sh)`);
  } else {
    cfg.token = cfg.token.trim();
  }

  return cfg;
}
