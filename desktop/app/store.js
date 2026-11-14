// Kin Studio disk store: one file per key, atomic writes with a .bak of the previous version.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ALIAS = { chars: 'characters' };
const UNALIAS = Object.fromEntries(Object.entries(ALIAS).map(([k, v]) => [v, k]));

function hash8(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }
// Filename base for a key. Unsafe chars are %-encoded; keys with capitals get a hash suffix so
// keys differing only in case can't collide on case-insensitive NTFS.
function baseFor(key) {
  if (ALIAS[key]) return ALIAS[key];
  let b = encodeURIComponent(key).replace(/[*!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (/^\./.test(b)) b = '%2E' + b.slice(1);
  if (/[A-Z]/.test(key.replace(/%[0-9A-F]{2}/g, ''))) b += '~' + hash8(key);
  return b;
}
function keyFor(base) {
  if (UNALIAS[base]) return UNALIAS[base];
  base = base.replace(/~[0-9a-f]{8}$/, '');
  try { return decodeURIComponent(base); } catch { return null; }
}

class DiskStore {
  constructor(dir) { this.dir = dir; this.queues = new Map(); }
  async ensure() { await fsp.mkdir(this.dir, { recursive: true }); }
  files(key) { const b = path.join(this.dir, baseFor(key)); return { json: b + '.json', txt: b + '.txt' }; }
  async readFile(f) {
    try { return await fsp.readFile(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  // Returns the raw string, or null.
  async get(key) {
    const { json, txt } = this.files(key);
    for (const f of [json, json + '.bak']) {
      const s = await this.readFile(f);
      if (s == null) continue;
      try { return JSON.stringify(JSON.parse(s)); } catch { /* corrupt, try .bak */ }
    }
    const t = await this.readFile(txt);
    if (t != null) return t;
    return await this.readFile(txt + '.bak');
  }
  async getAll() {
    await this.ensure();
    const out = {}; const errors = [];
    for (const name of await fsp.readdir(this.dir)) {
      const m = name.match(/^(.*)\.(json|txt)$/);
      if (!m || name.startsWith('.')) continue;
      const key = keyFor(m[1]);
      if (key == null || key in out) continue;
      try { const v = await this.get(key); if (v != null) out[key] = v; } catch (e) { errors.push(name + ': ' + e.message); }
    }
    return { data: out, errors };
  }
  async atomicWrite(file, text) {
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    try { await fsp.copyFile(file, file + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.rename(tmp, file);
  }
  // Serialise operations per key so writes land in order.
  enqueue(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
  set(key, raw) {
    return this.enqueue(key, async () => {
      await this.ensure();
      const { json, txt } = this.files(key);
      let parsed, isJson = true;
      try { parsed = JSON.parse(raw); } catch { isJson = false; }
      if (isJson) { await this.atomicWrite(json, JSON.stringify(parsed, null, 1)); await rmq(txt); }
      else { await this.atomicWrite(txt, raw); await rmq(json); }
      return true;
    });
  }
  remove(key) {
    return this.enqueue(key, async () => {
      const { json, txt } = this.files(key);
      for (const f of [json, txt]) { try { await fsp.copyFile(f, f + '.bak'); } catch {} await rmq(f); }
      return true;
    });
  }
  async flush() { await Promise.allSettled([...this.queues.values()]); }
}
async function rmq(f) { try { await fsp.unlink(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } }

module.exports = { DiskStore, baseFor, keyFor };
