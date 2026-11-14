const { app, BrowserWindow, shell, session, ipcMain, dialog, globalShortcut, safeStorage } = require('electron');
const { DiskStore } = require('./store');
const { createStreamServer, createSecretStore, streamHttp, AVATAR_SLOTS } = require('./stream-server');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'www');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm'
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/phone.html';
      const file = path.normalize(path.join(root, urlPath));
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      });
    });
    // Fixed origin so renderer storage (IndexedDB etc.) survives restarts. Never a random port.
    const ports = [];
    for (let p = BASE_PORT; p < BASE_PORT + PORT_RANGE; p++) ports.push(p);
    const tryNext = () => {
      const port = ports.shift();
      if (port == null) { reject(new Error('Ports ' + BASE_PORT + '-' + (BASE_PORT + PORT_RANGE - 1) + ' are all in use')); return; }
      server.listen(port, '127.0.0.1');
    };
    const onErr = (e) => { if (e.code === 'EADDRINUSE' || e.code === 'EACCES') tryNext(); else { server.removeListener('error', onErr); reject(e); } };
    server.on('error', onErr);
    server.once('listening', () => { server.removeListener('error', onErr); resolve({ server, port: server.address().port }); });
    tryNext();
  });
}

const BASE_PORT = 47820;
const PORT_RANGE = 10;

// ---- Disk storage -------------------------------------------------------
const configFile = () => path.join(app.getPath('userData'), 'kin-studio-config.json');
function readConfig() { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; } }
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const tmp = configFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, configFile());
}
function defaultDataDir() { return path.join(app.getPath('documents'), 'Kin Studio', 'data'); }
function dataDir() { return readConfig().dataDir || defaultDataDir(); }
let store = null;
function getStore() { if (!store || store.dir !== dataDir()) store = new DiskStore(dataDir()); return store; }

function registerIpc() {
  ipcMain.handle('kin-store:get', (_e, key) => getStore().get(key));
  ipcMain.handle('kin-store:set', (_e, key, raw) => getStore().set(key, raw));
  ipcMain.handle('kin-store:remove', (_e, key) => getStore().remove(key));
  ipcMain.handle('kin-store:getAll', () => getStore().getAll());
  ipcMain.handle('kin-store:path', () => dataDir());
  ipcMain.handle('kin-store:info', () => { const c = readConfig(); return { path: dataDir(), migrated: !!(c.migrated || {})[dataDir()] || !!c.migratedAny }; });
  ipcMain.handle('kin-store:markMigrated', () => { const c = readConfig(); c.migrated = Object.assign({}, c.migrated, { [dataDir()]: Date.now() }); c.migratedAny = true; writeConfig(c); return true; });
  ipcMain.handle('kin-store:openFolder', async () => { await getStore().ensure(); const err = await shell.openPath(dataDir()); return err ? { ok: false, error: err } : { ok: true, path: dataDir() }; });
  ipcMain.handle('kin-store:chooseFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Choose the Kin Studio data folder', defaultPath: dataDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, path: dataDir() };
    const dest = r.filePaths[0];
    const old = getStore();
    await old.flush();
    fs.mkdirSync(dest, { recursive: true });
    const hasData = fs.readdirSync(dest).some(n => /\.(json|txt)$/.test(n));
    let copied = 0;
    if (!hasData && path.resolve(dest) !== path.resolve(old.dir) && fs.existsSync(old.dir)) {
      for (const n of fs.readdirSync(old.dir)) {
        if (!/\.(json|txt)(\.bak)?$/.test(n)) continue;
        fs.copyFileSync(path.join(old.dir, n), path.join(dest, n)); copied++;
      }
    }
    const c = readConfig(); c.dataDir = dest; writeConfig(c);
    return { ok: true, path: dest, copied, usedExisting: hasData };
  });
}

// ---- Stream mode (1.17) ---------------------------------------------------
let mainWin = null;
let streamSrv = null;
let secrets = null;
const streamAvatarDir = () => path.join(app.getPath('userData'), 'stream-avatar');
function getSecrets() {
  if (!secrets) secrets = createSecretStore(path.join(app.getPath('userData'), 'stream-secrets.json'), safeStorage);
  return secrets;
}
function toRenderer(ch, payload) {
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); } catch (_) {}
}
async function startStreamServer() {
  if (streamSrv) return streamSrv.port;
  const srv = createStreamServer({
    overlayFile: path.join(root, 'stream-overlay.html'),
    avatarDir: streamAvatarDir(),
    onOAuthCallback: (q) => toRenderer('stream:oauth', q)
  });
  await srv.listen();
  streamSrv = srv;
  return srv.port;
}
const HOTKEY_ACTIONS = ['mute', 'skip', 'pause'];
function setHotkeys(map) {
  globalShortcut.unregisterAll();
  const out = {};
  for (const a of HOTKEY_ACTIONS) {
    const acc = map && typeof map[a] === 'string' ? map[a].trim() : '';
    if (!acc) { out[a] = 'off'; continue; }
    try { out[a] = globalShortcut.register(acc, () => toRenderer('stream:hotkey', a)) ? 'ok' : 'taken'; } catch (_) { out[a] = 'invalid'; }
  }
  return out;
}
function registerStreamIpc() {
  ipcMain.handle('stream:start', async () => { const port = await startStreamServer(); return { port, overlay: 'http://localhost:' + port + '/overlay' }; });
  ipcMain.handle('stream:stop', async () => { globalShortcut.unregisterAll(); if (streamSrv) { await streamSrv.close(); streamSrv = null; } return true; });
  ipcMain.on('stream:push', (_e, ev) => { if (streamSrv) streamSrv.push(ev); });
  ipcMain.handle('stream:config', (_e, cfg) => { if (streamSrv) streamSrv.setConfig(cfg); return true; });
  ipcMain.handle('stream:secret:get', (_e, name) => getSecrets().get(String(name)));
  ipcMain.handle('stream:secret:set', (_e, name, value) => getSecrets().set(String(name), value == null ? '' : String(value)));
  ipcMain.handle('stream:secret:clear', (_e, prefix) => getSecrets().clear(prefix ? String(prefix) : ''));
  ipcMain.handle('stream:secret:encrypted', () => getSecrets().encrypted());
  ipcMain.handle('stream:http', (_e, req) => streamHttp(req));
  ipcMain.handle('stream:hotkeys', (_e, map) => setHotkeys(map));
  ipcMain.handle('stream:open', (_e, url) => {
    let u; try { u = new URL(String(url)); } catch (_) { return false; }
    if (u.protocol !== 'https:' || !/(^|\.)(twitch\.tv|joystick\.tv)$/.test(u.hostname)) return false;
    shell.openExternal(u.toString()); return true;
  });
  ipcMain.handle('stream:avatar:set', (_e, slot, dataUrl) => {
    if (AVATAR_SLOTS.indexOf(slot) < 0) return { ok: false, error: 'slot' };
    const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return { ok: false, error: 'Use a PNG, JPG, WEBP or GIF image.' };
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) return { ok: false, error: 'Image is over 8 MB.' };
    fs.mkdirSync(streamAvatarDir(), { recursive: true });
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) { try { fs.unlinkSync(path.join(streamAvatarDir(), slot + '.' + ext)); } catch (_) {} }
    fs.writeFileSync(path.join(streamAvatarDir(), slot + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1])), buf);
    if (streamSrv) streamSrv.setConfig({});
    return { ok: true };
  });
  ipcMain.handle('stream:avatar:clear', (_e, slot) => {
    if (AVATAR_SLOTS.indexOf(slot) < 0) return false;
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) { try { fs.unlinkSync(path.join(streamAvatarDir(), slot + '.' + ext)); } catch (_) {} }
    if (streamSrv) streamSrv.setConfig({});
    return true;
  });
  ipcMain.handle('stream:avatar:list', () => AVATAR_SLOTS.filter((s) => ['png', 'jpg', 'jpeg', 'webp', 'gif'].some((x) => fs.existsSync(path.join(streamAvatarDir(), s + '.' + x)))));
}
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} });

app.whenReady().then(async () => {
  registerIpc();
  registerStreamIpc();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'microphone' || permission === 'audio' || permission === 'notifications');
  });
  const { port } = await startServer();
  console.log('Kin Studio serving on 127.0.0.1:' + port);
  const win = mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Kin Studio',
    backgroundColor: '#10140f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Let the renderer push any queued disk writes before the window goes away.
  let closing = false;
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault(); closing = true;
    const t = setTimeout(() => win.destroy(), 5000);
    win.webContents.executeJavaScript('window.__kinDiskFlush ? window.__kinDiskFlush() : true', true)
      .catch(() => {}).then(() => (store ? store.flush() : null)).finally(() => { clearTimeout(t); win.destroy(); });
  });
  await win.loadURL('http://127.0.0.1:' + port + '/phone.html');
});

let flushed = false;
app.on('before-quit', (e) => {
  if (flushed || !store) return;
  e.preventDefault();
  store.flush().finally(() => { flushed = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
module.exports = { BASE_PORT, PORT_RANGE };
