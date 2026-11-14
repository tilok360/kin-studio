// Kin Studio 1.17 Stream mode: local overlay server for OBS + OAuth loopback callback.
// Binds 127.0.0.1 only. No Electron imports so it can be tested with plain Node.
const http = require('http');
const fs = require('fs');
const path = require('path');

const STREAM_BASE_PORT = 47830;
const STREAM_PORT_RANGE = 10;
const AVATAR_SLOTS = ['idle', 'talk', 'blink', 'happy', 'happy_talk', 'laugh', 'surprised', 'sad', 'angry', 'thinking'];
const IMG_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function okHost(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost';
}

function createStreamServer(opts) {
  const o = opts || {};
  const overlayFile = o.overlayFile;
  const avatarDir = o.avatarDir;
  const clients = new Set();
  let config = Object.assign({}, o.config || {});
  let last = { caption: null, state: { type: 'state', state: 'idle' } };
  let port = 0;

  function send(res, ev) {
    try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (_) {}
  }
  function push(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'caption') last.caption = ev;
    if (ev.type === 'clear') last.caption = null;
    if (ev.type === 'state') last.state = ev;
    for (const res of clients) send(res, ev);
  }
  function setConfig(c) {
    config = Object.assign({}, config, c || {});
    push({ type: 'config', config });
  }
  function avatarFile(slot) {
    if (!avatarDir || AVATAR_SLOTS.indexOf(slot) < 0) return null;
    for (const ext of Object.keys(IMG_EXT)) {
      const f = path.join(avatarDir, slot + ext);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }
  function avatarList() { return AVATAR_SLOTS.filter((s) => !!avatarFile(s)); }

  const server = http.createServer((req, res) => {
    if (!okHost(req)) { res.writeHead(403); res.end(); return; }
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    const noCache = { 'Cache-Control': 'no-store' };
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (p === '/overlay' || p === '/overlay/avatar' || p === '/overlay/captions') {
      fs.readFile(overlayFile, (err, data) => {
        if (err) { res.writeHead(500); res.end('Overlay file missing'); return; }
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noCache));
        res.end(data);
      });
      return;
    }
    if (p === '/overlay/events') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }, noCache));
      res.write('retry: 2000\n\n');
      clients.add(res);
      send(res, { type: 'config', config, avatars: avatarList() });
      send(res, last.state);
      if (last.caption) send(res, last.caption);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (p === '/overlay/config.json') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, noCache));
      res.end(JSON.stringify({ config, avatars: avatarList() }));
      return;
    }
    const m = /^\/overlay\/img\/([a-z_]+)$/.exec(p);
    if (m) {
      const f = avatarFile(m[1]);
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, Object.assign({ 'Content-Type': IMG_EXT[path.extname(f).toLowerCase()] }, noCache));
      fs.createReadStream(f).pipe(res);
      return;
    }
    if (p === '/callback') {
      const code = u.searchParams.get('code') || '';
      const state = u.searchParams.get('state') || '';
      const error = u.searchParams.get('error') || '';
      try { if (o.onOAuthCallback) o.onOAuthCallback({ code, state, error }); } catch (_) {}
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noCache));
      res.end('<!doctype html><meta charset="utf-8"><title>Kin Studio</title><body style="font-family:sans-serif;padding:40px">' +
        (error ? '<h2>Joystick said no.</h2><p>You can close this tab and try again in Kin Studio.</p>' : '<h2>Connected.</h2><p>Go back to Kin Studio. You can close this tab.</p>') + '</body>');
      return;
    }
    res.writeHead(404); res.end('Not found');
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const base = o.basePort || STREAM_BASE_PORT;
      const ports = [];
      for (let q = base; q < base + (o.portRange || STREAM_PORT_RANGE); q++) ports.push(q);
      const tryNext = () => {
        const q = ports.shift();
        if (q == null) { reject(new Error('Stream overlay ports are all in use')); return; }
        server.listen(q, '127.0.0.1');
      };
      const onErr = (e) => { if (e.code === 'EADDRINUSE' || e.code === 'EACCES') tryNext(); else { server.removeListener('error', onErr); reject(e); } };
      server.on('error', onErr);
      server.once('listening', () => { server.removeListener('error', onErr); port = server.address().port; resolve(port); });
      tryNext();
    });
  }
  function close() {
    for (const res of clients) { try { res.end(); } catch (_) {} }
    clients.clear();
    return new Promise((r) => server.close(() => r()));
  }
  return { listen, close, push, setConfig, avatarList, get port() { return port; }, get clientCount() { return clients.size; } };
}

// Encrypted local token store. `crypt` is Electron's safeStorage (or a test double).
// Tokens never go into the Kin Studio data folder, exports, or the repo.
function createSecretStore(file, crypt) {
  const canCrypt = () => { try { return !!(crypt && crypt.isEncryptionAvailable && crypt.isEncryptionAvailable()); } catch (_) { return false; } };
  function readAll() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; }
  }
  function writeAll(obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const NAME = /^(twitch|joystick)_[a-z_]{2,32}$/;
  return {
    get(name) {
      if (!NAME.test(String(name))) return null;
      const v = readAll()[name];
      if (!v) return null;
      try {
        if (v.e) return canCrypt() ? crypt.decryptString(Buffer.from(v.e, 'base64')) : null;
        return v.p != null ? String(v.p) : null;
      } catch (_) { return null; }
    },
    set(name, value) {
      if (!NAME.test(String(name))) return false;
      const all = readAll();
      if (value == null || value === '') delete all[name];
      else if (canCrypt()) all[name] = { e: crypt.encryptString(String(value)).toString('base64') };
      else all[name] = { p: String(value) };
      writeAll(all);
      return true;
    },
    clear(prefix) {
      const all = readAll();
      for (const k of Object.keys(all)) if (!prefix || k.indexOf(prefix) === 0) delete all[k];
      writeAll(all);
      return true;
    },
    has(name) { return !!readAll()[name]; },
    encrypted: canCrypt
  };
}

// Only these hosts can be reached through the main-process HTTP helper (no CORS in main).
const HTTP_ALLOW = ['id.twitch.tv', 'api.twitch.tv', 'api.joystick.tv'];
async function streamHttp(req, fetchImpl) {
  const r = req || {};
  let u;
  try { u = new URL(String(r.url)); } catch (_) { return { status: 0, text: '', error: 'bad url' }; }
  if (u.protocol !== 'https:' || HTTP_ALLOW.indexOf(u.hostname) < 0) return { status: 0, text: '', error: 'host not allowed' };
  const method = /^(GET|POST|DELETE)$/.test(r.method || 'GET') ? (r.method || 'GET') : 'GET';
  const headers = Object.assign({}, r.headers || {});
  try {
    const res = await (fetchImpl || fetch)(u.toString(), { method, headers, body: method === 'GET' ? undefined : r.body });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 200000) };
  } catch (e) {
    return { status: 0, text: '', error: 'offline' };
  }
}

module.exports = { createStreamServer, createSecretStore, streamHttp, STREAM_BASE_PORT, STREAM_PORT_RANGE, AVATAR_SLOTS, HTTP_ALLOW };
