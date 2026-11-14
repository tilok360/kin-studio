const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('KinDesktop', {
  platform: 'windows',
  store: {
    // Values are the raw strings the app would have put in localStorage.
    get: (key) => inv('kin-store:get', String(key)),
    set: (key, value) => inv('kin-store:set', String(key), String(value)),
    remove: (key) => inv('kin-store:remove', String(key)),
    getAll: () => inv('kin-store:getAll'),
    info: () => inv('kin-store:info'),
    markMigrated: () => inv('kin-store:markMigrated'),
    openFolder: () => inv('kin-store:openFolder'),
    chooseFolder: () => inv('kin-store:chooseFolder'),
    path: () => inv('kin-store:path')
  },
  // 1.17 Stream mode (Windows only). Tokens live in an encrypted file in %APPDATA%, never in the data folder.
  stream: {
    start: () => inv('stream:start'),
    stop: () => inv('stream:stop'),
    push: (ev) => ipcRenderer.send('stream:push', ev),
    config: (cfg) => inv('stream:config', cfg),
    secretGet: (name) => inv('stream:secret:get', String(name)),
    secretSet: (name, value) => inv('stream:secret:set', String(name), value == null ? '' : String(value)),
    secretClear: (prefix) => inv('stream:secret:clear', prefix ? String(prefix) : ''),
    encrypted: () => inv('stream:secret:encrypted'),
    http: (req) => inv('stream:http', req),
    hotkeys: (map) => inv('stream:hotkeys', map),
    open: (url) => inv('stream:open', String(url)),
    avatarSet: (slot, dataUrl) => inv('stream:avatar:set', String(slot), String(dataUrl)),
    avatarClear: (slot) => inv('stream:avatar:clear', String(slot)),
    avatarList: () => inv('stream:avatar:list'),
    onHotkey: (fn) => { const h = (_e, a) => fn(a); ipcRenderer.on('stream:hotkey', h); return () => ipcRenderer.removeListener('stream:hotkey', h); },
    onOAuth: (fn) => { const h = (_e, q) => fn(q); ipcRenderer.on('stream:oauth', h); return () => ipcRenderer.removeListener('stream:oauth', h); }
  }
});
