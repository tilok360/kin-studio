/* Kin Studio — local archive of a Kindroid data export.
   The file is read here. It is not uploaded. Photos are fetched only from
   storage.kindroid.ai links that are already inside that export. */
(function (root) {
  'use strict';

  var HOST = 'storage.kindroid.ai';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' })[c];
    });
  }
  function msOf(n) {
    if (typeof n === 'string') {
      var t = n.trim();
      if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);
      else if (/^\d{4}-\d\d-\d\d/.test(t)) n = Date.parse(t);
      else return null;
    }
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    return n < 1e11 ? n * 1000 : n;
  }
  function whenOf(o) {
    return msOf(o && o.timestamp) || msOf(o && o.data && o.data.timestamp) || null;
  }
  function slug(s) {
    var out = String(s || 'kin').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return out || 'kin';
  }
  function safeId(id) {
    return String(id || 'x').replace(/[^A-Za-z0-9_-]/g, '') || 'x';
  }
  function mediaUrl(path) {
    if (!path || typeof path !== 'string') return null;
    var u;
    try {
      u = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\/+/, ''), 'https://' + HOST + '/');
    } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.hostname !== HOST) return null;
    return u.href;
  }
  function fileName(path, used) {
    var parts = String(path).split('?')[0].split('/').filter(Boolean);
    var base = (parts[parts.length - 1] || 'media').replace(/[^A-Za-z0-9._-]/g, '_');
    if (base.charAt(0) === '.' || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = 'media-' + base.replace(/^\.+/, '');
    var name = base;
    var n = 2;
    while (used[name]) { name = n + '-' + base; n++; }
    used[name] = true;
    return name;
  }
  function msgKey(m) {
    if (m.record_id) return 'r:' + m.record_id;
    if (m.id) return 'i:' + m.id;
    return 'h:' + (m.timestamp || '') + '|' + (m.sender_type || '') + '|' + String(m.message || '').slice(0, 180);
  }
  function entityName(e) {
    var c = e.config || {};
    var n = e.kind === 'group' ? (c.group_name || c.name) : (c.ai_name || c.name);
    if (n) return String(n);
    var hit = e.messages.filter(function (m) { return m.sender_type !== 'user' && m.sender_name; })[0];
    return hit ? String(hit.sender_name) : (e.kind === 'group' ? 'Unnamed group' : 'Unnamed kin');
  }
  function asObject(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    if (typeof v === 'string') { try { var o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }
    return null;
  }

  function rowsFromText(text) {
    var raw = String(text || '').replace(/^\uFEFF/, '');
    var trimmed = raw.trim();
    if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
      try {
        var whole = JSON.parse(trimmed);
        if (Array.isArray(whole)) return { rows: whole.filter(function (o) { return o && typeof o === 'object'; }), bad: 0 };
        if (whole && Array.isArray(whole.records)) return { rows: whole.records, bad: 0 };
      } catch (e) { /* line file */ }
    }
    var rows = [], bad = 0;
    var lines = raw.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        var o = JSON.parse(lines[i]);
        if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o);
        else bad++;
      } catch (e) { bad++; }
    }
    return { rows: rows, bad: bad };
  }

  function parseExportText(text) {
    var parsed = rowsFromText(text);
    var model = {
      meta: null, user: null, personas: [], journal: [],
      entities: [], bad: parsed.bad, other: 0
    };
    var byId = new Map();
    function ent(id, kind) {
      if (!byId.has(id)) {
        byId.set(id, { id: id, kind: kind || null, config: null, messages: [], selfies: [], videos: [], avatars: [] });
      }
      var e = byId.get(id);
      if (!e.kind && kind) e.kind = kind;
      return e;
    }
    parsed.rows.forEach(function (o) {
      var type = o.type;
      if (type === 'meta') { model.meta = o; return; }
      if (type === 'user') { model.user = o; return; }
      if (type === 'persona') { model.personas.push(o); return; }
      if (type === 'journal_entry') { model.journal.push(o); return; }
      if (type === 'generated_avatar') { model.other++; return; }
      var kind = o.entity_type === 'group' ? 'group' : (o.entity_type === 'ai' ? 'ai' : null);
      var id = o.entity_id || (type === 'entity' ? (o.record_id || (o.data && (o.data.ai_id || o.data.group_id))) : null);
      if (!id || !kind) { model.other++; return; }
      var e = ent(id, kind);
      if (type === 'entity') e.config = (o.data && typeof o.data === 'object') ? o.data : {};
      else if (type === 'text_message') e.messages.push(o);
      else if (type === 'selfie') e.selfies.push(o);
      else if (type === 'video_selfie') e.videos.push(o);
      else if (type === 'saved_avatar') e.avatars.push(o);
      else if (type === 'call' || type === 'call_message' || type === 'favorite_thought') e.messages.push(o);
    });
    var taken = {};
    model.entities = Array.from(byId.values()).filter(function (e) {
      return e.config || e.messages.length || e.selfies.length || e.videos.length;
    });
    model.entities.forEach(function (e) {
      e.messages.sort(function (a, b) { return (whenOf(a) || 0) - (whenOf(b) || 0); });
      e.name = entityName(e);
      var id = safeId(e.id);
      var folder = slug(e.name) + '-' + id.slice(0, 6);
      var n = 6;
      while (taken[folder]) { n++; folder = slug(e.name) + '-' + id.slice(0, Math.min(n, id.length)); if (n > id.length + 4) folder += '-' + n; }
      taken[folder] = true;
      e.folder = folder;
      e.media = planMedia(e);
      e.exportDate = msOf(model.meta && model.meta.generated_at);
    });
    model.entities.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return model;
  }

  function planMedia(e) {
    var plan = [];
    var seen = {};
    var names = {};
    function add(path, kind) {
      if (!path || seen[path]) return;
      var url = mediaUrl(path);
      if (!url) return;
      seen[path] = true;
      plan.push({ path: path, url: url, name: fileName(path, names), kind: kind });
    }
    var c = e.config || {};
    add(c.custom_avatar_url || (c.customAvatar && c.customAvatar.custom_avatar_url), 'avatar');
    e.avatars.forEach(function (a) { add(a.data && a.data.custom_avatar_url, 'avatar'); });
    var bg = asObject(c.background_settings);
    if (bg) add(bg.background_url, 'image');
    e.selfies.forEach(function (s) { add(s.data && s.data.url, 'image'); });
    e.videos.forEach(function (v) {
      add(v.data && v.data.video_url, 'video');
      add(v.data && v.data.image_url, 'image');
    });
    e.messages.forEach(function (m) {
      var imgs = [].concat(Array.isArray(m.image_urls) ? m.image_urls : [], Array.isArray(m.attachment_urls) ? m.attachment_urls : []);
      imgs.forEach(function (u) { add(u, 'image'); });
      add(m.video_url, 'video');
    });
    return plan;
  }

  function counts(e) {
    var photos = 0, videos = 0;
    e.media.forEach(function (m) { if (m.kind === 'video') videos++; else photos++; });
    var last = null;
    e.messages.forEach(function (m) { var t = whenOf(m); if (t && (!last || t > last)) last = t; });
    return { messages: e.messages.length, photos: photos, videos: videos, last: last };
  }

  async function unzipText(buf) {
    var u8 = new Uint8Array(buf);
    var view = new DataView(buf);
    var o = 0;
    var texts = [];
    while (o + 30 < u8.length && view.getUint32(o, true) === 0x04034b50) {
      var flags = view.getUint16(o + 6, true);
      var method = view.getUint16(o + 8, true);
      var compSize = view.getUint32(o + 18, true);
      var nameLen = view.getUint16(o + 26, true);
      var extraLen = view.getUint16(o + 28, true);
      var start = o + 30 + nameLen + extraLen;
      if (flags & 8) break;
      if (start + compSize > u8.length) break;
      var name = new TextDecoder().decode(u8.subarray(o + 30, o + 30 + nameLen));
      var data = u8.subarray(start, start + compSize);
      o = start + compSize;
      if (name.endsWith('/')) continue;
      var raw = data;
      if (method === 8) {
        if (typeof DecompressionStream !== 'function') continue;
        var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        raw = new Uint8Array(await new Response(stream).arrayBuffer());
      } else if (method !== 0) continue;
      if (/\.(jsonl?|ndjson|txt)$/i.test(name) || name.indexOf('.') < 0) texts.push(new TextDecoder().decode(raw));
    }
    if (!texts.length) throw new Error('Unzip the export first, then choose the file inside.');
    return texts.join('\n');
  }

  async function textFromFile(file) {
    var buf = await file.arrayBuffer();
    var u8 = new Uint8Array(buf);
    if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream === 'function') {
      var gz = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(gz).text();
    }
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b) return unzipText(buf);
    return new TextDecoder().decode(u8);
  }

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('kin-studio-archive', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbOp(db, mode, run) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', mode);
      var out = run(tx.objectStore('kv'));
      tx.oncomplete = function () { resolve(out && out.result); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function readJsonStore(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function sameText(a, b) { return norm(a).toLowerCase() === norm(b).toLowerCase(); }
  function charFromEntity(e, prev) {
    prev = prev || {};
    var c = e.config || {};
    var ai = c.ai_id || e.id;
    return {
      id: prev.id || ('arc_' + safeId(e.id).slice(0, 36)),
      name: e.name,
      ai_id: ai,
      voice_id: prev.voice_id || '',
      tag: c.ai_tagline || c.tagline || prev.tag || '',
      bio: c.bio || prev.bio || '',
      shareCode: prev.shareCode || '',
      characterLink: prev.characterLink || '',
      shareLink: prev.shareLink || '',
      selfieTemplate: prev.selfieTemplate || '',
      avatarGenerator: prev.avatarGenerator || '',
      appearance: prev.appearance || '',
      descAtelier: prev.descAtelier || '',
      descTableau: prev.descTableau || '',
      face: prev.face || '',
      voiceDescription: prev.voiceDescription || '',
      personality: c.ai_backstory || c.backstory || prev.personality || '',
      greeting: c.greeting || prev.greeting || '',
      keyMemories: c.ai_memory || prev.keyMemories || '',
      memories: c.ai_memory || prev.memories || '',
      growth: prev.growth || '',
      importantFacts: prev.importantFacts || '',
      ongoingThreads: prev.ongoingThreads || '',
      directive: c.ai_directive || prev.directive || '',
      example: c.ai_example_message || prev.example || '',
      additional: c.ai_additional_context || prev.additional || '',
      avatar: prev.avatar || ''
    };
  }
  var COMPARE = [
    ['name', 'Name'],
    ['ai_id', 'AI ID'],
    ['personality', 'Personality'],
    ['keyMemories', 'Key memories'],
    ['directive', 'Response directives'],
    ['example', 'Example message'],
    ['additional', 'Additional context'],
    ['greeting', 'Greeting'],
    ['tag', 'Tag line'],
    ['bio', 'Bio']
  ];
  function changedFields(prev, next) {
    var out = [];
    COMPARE.forEach(function (pair) {
      if (!sameText(prev[pair[0]], next[pair[0]])) out.push(pair[1]);
    });
    return out;
  }
  function findChar(list, row) {
    var byId = -1;
    if (row.ai_id) {
      byId = list.findIndex(function (c) { return c.ai_id && c.ai_id === row.ai_id; });
    }
    if (byId >= 0) return byId;
    var name = norm(row.name).toLowerCase();
    if (!name) return -1;
    return list.findIndex(function (c) { return norm(c.name).toLowerCase() === name; });
  }
  function loadChars() {
    if (typeof root.chars === 'function') return root.chars() || [];
    return readJsonStore('chars', []);
  }
  function writeChars(list) {
    if (typeof root.saveChars === 'function') root.saveChars(list);
    else {
      try { localStorage.setItem('chars', JSON.stringify(list)); } catch (e) {}
    }
    if (typeof root.renderChars === 'function') root.renderChars();
    if (typeof root.refreshSelects === 'function') root.refreshSelects();
  }
  function askCharChoice(name, fields, index, total) {
    var sheet = document.getElementById('charChoice');
    var title = document.getElementById('charChoiceTitle');
    var count = document.getElementById('charChoiceCount');
    var text = document.getElementById('charChoiceText');
    if (!sheet || !title || !text) return Promise.resolve('skip');
    title.textContent = name + ' is already in the app';
    if (count) count.textContent = total > 1 ? (index + ' of ' + total) : '';
    text.textContent = fields.length
      ? 'This export has changes: ' + fields.join(', ') + '. Replace the one in Characters, add a second copy, or skip?'
      : 'Replace the one in Characters, add a second copy, or skip?';
    sheet.hidden = false;
    return new Promise(function (resolve) {
      function done(value) {
        sheet.hidden = true;
        ['charChoiceReplace', 'charChoiceAdd', 'charChoiceSkip'].forEach(function (id) {
          var b = document.getElementById(id);
          if (b) b.onclick = null;
        });
        resolve(value);
      }
      document.getElementById('charChoiceReplace').onclick = function () { done('replace'); };
      document.getElementById('charChoiceAdd').onclick = function () { done('add'); };
      document.getElementById('charChoiceSkip').onclick = function () { done('skip'); };
    });
  }
  function openCharacters(note) {
    var tab = document.querySelector('.tab[data-p="character"]');
    if (tab) tab.click();
    var st = document.getElementById('cStatus');
    if (st && note) st.textContent = note;
  }
  async function bringIntoCharacters(model) {
    var list = loadChars().slice();
    var kins = model.entities.filter(function (e) { return e.kind !== 'group'; });
    var pending = [];
    kins.forEach(function (e) {
      var draft = charFromEntity(e, {});
      var idx = findChar(list, draft);
      if (idx < 0) pending.push({ e: e, idx: -1, fields: [] });
      else {
        var merged = charFromEntity(e, list[idx]);
        var fields = changedFields(list[idx], merged);
        if (fields.length) pending.push({ e: e, idx: idx, fields: fields });
      }
    });
    var added = 0, replaced = 0, skipped = 0;
    var same = kins.length - pending.filter(function (p) { return p.idx < 0; }).length - pending.filter(function (p) { return p.idx >= 0; }).length;
    same = kins.length - pending.length;
    var asks = pending.filter(function (p) { return p.idx >= 0; });
    var askN = 0;
    for (var i = 0; i < pending.length; i++) {
      var item = pending[i];
      var row = charFromEntity(item.e, item.idx >= 0 ? list[item.idx] : {});
      if (item.idx < 0) {
        list.push(row);
        added++;
        continue;
      }
      askN++;
      var choice = await askCharChoice(item.e.name, item.fields, askN, asks.length);
      if (choice === 'replace') {
        row.id = list[item.idx].id;
        list[item.idx] = row;
        replaced++;
      } else if (choice === 'add') {
        row.id = 'arc_' + safeId(item.e.id).slice(0, 18) + '_' + Math.random().toString(36).slice(2, 7);
        list.push(row);
        added++;
      } else skipped++;
    }
    writeChars(list);
    return { added: added, replaced: replaced, skipped: skipped, same: same, total: kins.length };
  }
  function saveGroup(e) {
    var c = e.config || {};
    var gid = c.group_id || e.id;
    var groups = readJsonStore('groups', []);
    var gi = groups.findIndex(function (g) { return g.group_id === gid; });
    var grow = { id: gi >= 0 ? groups[gi].id : ('arc_' + safeId(e.id).slice(0, 24)), name: e.name, group_id: gid, mode: 'auto', max: 8 };
    if (gi >= 0) groups[gi] = Object.assign({}, groups[gi], grow, { id: groups[gi].id });
    else groups.push(grow);
    try {
      if (typeof root.saveGroupsList === 'function') root.saveGroupsList(groups);
      else localStorage.setItem('groups', JSON.stringify(groups));
    } catch (err) {}
    if (typeof root.renderSavedGroups === 'function') root.renderSavedGroups();
    return 'Saved group ' + e.name;
  }
  function characterNote(r) {
    if (!r.total) return 'No kins in that export.';
    var bits = [];
    if (r.added) bits.push('Added ' + r.added);
    if (r.replaced) bits.push('Replaced ' + r.replaced);
    if (r.skipped) bits.push('Skipped ' + r.skipped);
    if (r.same) bits.push(r.same + ' already up to date');
    return (bits.join('. ') || 'Nothing new') + '. They are on the Characters tab.';
  }

  function summaryText(model) {
    var n = model.entities.length;
    var msgs = 0, photos = 0, videos = 0;
    model.entities.forEach(function (e) {
      var c = counts(e);
      msgs += c.messages; photos += c.photos; videos += c.videos;
    });
    var when = msOf(model.meta && model.meta.generated_at);
    var bits = [n + (n === 1 ? ' kin' : ' kins'), msgs + ' messages', photos + ' photos', videos + ' videos'];
    if (model.personas.length) bits.push(model.personas.length + ' personas');
    if (model.journal.length) bits.push(model.journal.length + ' journal entries');
    var line = bits.join(' · ');
    if (when) line = 'Export from ' + new Date(when).toLocaleDateString() + '. ' + line;
    if (model.bad) line += '. ' + model.bad + ' lines could not be read.';
    return line;
  }

  async function readTextFile(dir, name) {
    try {
      var fh = await dir.getFileHandle(name);
      return await (await fh.getFile()).text();
    } catch (e) { return null; }
  }
  async function writeTextFile(dir, name, text) {
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function hasFile(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
  }
  async function subdir(dir, name) {
    return dir.getDirectoryHandle(name, { create: true });
  }

  async function saveModel(model, rootDir, onStatus, signal) {
    var indexText = await readTextFile(rootDir, 'index.json');
    var index = { version: 1, app: 'Kin Studio', updated: null, exports: [], kins: [] };
    if (indexText) { try { index = Object.assign(index, JSON.parse(indexText)); } catch (e) { /* start fresh beside it */ } }
    var known = {};
    (index.kins || []).forEach(function (k) { if (k.id && k.folder) known[k.id] = k; });
    var exportMs = msOf(model.meta && model.meta.generated_at);
    var exportIso = exportMs ? new Date(exportMs).toISOString() : null;
    var newest = (index.exports || []).reduce(function (max, iso) {
      var t = Date.parse(iso);
      return t > max ? t : max;
    }, 0);
    var older = !!(exportMs && newest && exportMs < newest);

    if (model.personas.length) {
      var personas = [];
      var prevP = await readTextFile(rootDir, 'personas.json');
      if (prevP) { try { personas = JSON.parse(prevP); } catch (e) { personas = []; } }
      var pSeen = {};
      personas.forEach(function (p) { pSeen[p.record_id || p.data && p.data.id || ''] = true; });
      model.personas.forEach(function (p) {
        var id = p.record_id || (p.data && p.data.id) || '';
        if (!pSeen[id]) personas.push(p);
      });
      await writeTextFile(rootDir, 'personas.json', JSON.stringify(personas));
    }
    if (model.journal.length) {
      var journal = [];
      var prevJ = await readTextFile(rootDir, 'journal.json');
      if (prevJ) { try { journal = JSON.parse(prevJ); } catch (e) { journal = []; } }
      var jSeen = {};
      journal.forEach(function (p) { jSeen[p.record_id || ''] = true; });
      model.journal.forEach(function (p) { if (!jSeen[p.record_id || '']) journal.push(p); });
      await writeTextFile(rootDir, 'journal.json', JSON.stringify(journal));
    }

    var kinsDir = await subdir(rootDir, 'kins');
    var saved = 0, addedMsgs = 0, gotMedia = 0, missed = 0, skipped = 0;
    for (var i = 0; i < model.entities.length; i++) {
      if (signal.aborted) break;
      var e = model.entities[i];
      var folder = (known[e.id] && known[e.id].folder) || e.folder;
      onStatus('Saving ' + e.name + ' (' + (i + 1) + ' of ' + model.entities.length + ')');
      var kinDir = await subdir(kinsDir, folder);
      var profileThere = await hasFile(kinDir, 'profile.json');
      if (!older || !profileThere) {
        await writeTextFile(kinDir, 'profile.json', JSON.stringify({
          id: e.id, kind: e.kind, name: e.name, exportDate: exportIso, config: e.config || {}
        }, null, 2));
      }
      var prevLines = await readTextFile(kinDir, 'messages.jsonl');
      var seen = {};
      var kept = [];
      if (prevLines) {
        prevLines.split('\n').forEach(function (line) {
          if (!line.trim()) return;
          kept.push(line);
          try { seen[msgKey(JSON.parse(line))] = true; } catch (err) {}
        });
      }
      e.messages.forEach(function (m) {
        var k = msgKey(m);
        if (seen[k]) return;
        seen[k] = true;
        kept.push(JSON.stringify(m));
        addedMsgs++;
      });
      if (kept.length) await writeTextFile(kinDir, 'messages.jsonl', kept.join('\n') + '\n');

      var mapText = await readTextFile(kinDir, 'media-map.json');
      var map = {};
      if (mapText) { try { map = JSON.parse(mapText); } catch (err) { map = {}; } }
      var mediaDir = await subdir(kinDir, 'media');
      for (var mi = 0; mi < e.media.length; mi++) {
        if (signal.aborted) break;
        var item = e.media[mi];
        var localName = map[item.path] || item.name;
        map[item.path] = localName;
        if (await hasFile(mediaDir, localName)) { skipped++; continue; }
        onStatus(e.name + ' — ' + (item.kind === 'video' ? 'video' : 'photo') + ' ' + (mi + 1) + ' of ' + e.media.length);
        var ok = false, gone = false;
        for (var attempt = 0; attempt < 3 && !ok && !gone && !signal.aborted; attempt++) {
          try {
            var res = await fetch(item.url, { mode: 'cors', credentials: 'omit', signal: signal });
            if (res.status === 404 || res.status === 403 || res.status === 410) { gone = true; break; }
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
            var fh = await mediaDir.getFileHandle(localName, { create: true });
            var w = await fh.createWritable();
            await res.body.pipeTo(w);
            ok = true;
            gotMedia++;
          } catch (err) {
            if (signal.aborted) break;
            await new Promise(function (r) { setTimeout(r, attempt === 0 ? 800 : 2000); });
          }
        }
        if (!ok) {
          missed++;
          try { await mediaDir.removeEntry(localName); } catch (ignore) {}
        }
      }
      await writeTextFile(kinDir, 'media-map.json', JSON.stringify(map));
      var c = counts(e);
      var row = { id: e.id, name: e.name, kind: e.kind, folder: folder, messages: Math.max(c.messages, Object.keys(seen).length), photos: c.photos, videos: c.videos, last: c.last, exportDate: exportIso };
      var ix = (index.kins || []).findIndex(function (k) { return k.id === e.id; });
      if (ix >= 0) index.kins[ix] = row; else index.kins.push(row);
      saved++;
    }
    if (exportIso && index.exports.indexOf(exportIso) < 0) index.exports.push(exportIso);
    index.exports.sort();
    index.updated = new Date().toISOString();
    await writeTextFile(rootDir, 'index.json', JSON.stringify(index, null, 2));
    return { saved: saved, addedMsgs: addedMsgs, gotMedia: gotMedia, missed: missed, skipped: skipped, older: !!older, stopped: !!signal.aborted };
  }

  function archivePayload(model) {
    return {
      app: 'Kin Studio',
      exported: new Date().toISOString(),
      sourceDate: msOf(model.meta && model.meta.generated_at),
      user: model.user || null,
      personas: model.personas,
      journal: model.journal,
      kins: model.entities.map(function (e) {
        return { id: e.id, name: e.name, kind: e.kind, folder: e.folder, config: e.config || {}, messages: e.messages, media: e.media.map(function (m) { return { path: m.path, url: m.url, kind: m.kind, name: m.name }; }) };
      })
    };
  }

  function downloadText(model) {
    var blob = new Blob([JSON.stringify(archivePayload(model))], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kin-studio-archive.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function mount() {
    var drop = document.getElementById('archiveDrop');
    if (!drop || drop.dataset.ready) return;
    drop.dataset.ready = '1';
    var fileInput = document.getElementById('archiveFile');
    var status = document.getElementById('archiveStatus');
    var list = document.getElementById('archiveList');
    var folderLabel = document.getElementById('archiveFolder');
    var saveBtn = document.getElementById('btnArchiveSave');
    var textBtn = document.getElementById('btnArchiveText');
    var iosLink = document.getElementById('btnArchiveIos');
    var iosUrl = null;
    var stopBtn = document.getElementById('btnArchiveStop');
    var model = null;
    var dirHandle = null;
    var job = null;

    function setStatus(msg, bad) {
      status.className = 'status' + (bad ? ' error' : '');
      status.textContent = msg || '';
    }
    function paint() {
      if (!model) { list.innerHTML = ''; return; }
      list.innerHTML = model.entities.map(function (e) {
        var c = counts(e);
        var last = c.last ? new Date(c.last).toLocaleDateString() : 'no messages';
        return '<div class="list-item"><strong>' + esc(e.name) + '</strong>'
          + '<div class="hint">' + (e.kind === 'group' ? 'Group' : 'Kin') + ' · ' + c.messages + ' messages · ' + c.photos + ' photos · ' + c.videos + ' videos · ' + esc(last) + '</div>'
          + (e.kind === 'group'
            ? '<div class="row" style="margin-top:6px"><button type="button" class="btn secondary" data-arc-group="' + esc(e.id) + '">Save group</button></div>'
            : '')
          + '</div>';
      }).join('');
      list.querySelectorAll('[data-arc-group]').forEach(function (b) {
        b.onclick = function () {
          var e = model.entities.filter(function (x) { return x.id === b.getAttribute('data-arc-group'); })[0];
          if (!e) return;
          try { setStatus(saveGroup(e)); } catch (err) { setStatus(err.message || String(err), true); }
        };
      });
    }
    function armIosDownload() {
      if (iosUrl) URL.revokeObjectURL(iosUrl);
      iosUrl = null;
      if (!iosLink) return;
      if (!model) {
        iosLink.hidden = true;
        iosLink.removeAttribute('href');
        return;
      }
      iosUrl = URL.createObjectURL(new Blob([JSON.stringify(archivePayload(model))], { type: 'application/json' }));
      iosLink.href = iosUrl;
      iosLink.hidden = false;
    }
    function refreshButtons() {
      saveBtn.disabled = !model || !dirHandle || !!job;
      textBtn.disabled = !model || !!job;
      armIosDownload();
    }
    async function takeFile(file) {
      if (!file) return;
      setStatus('Reading ' + file.name + '…');
      try {
        var text = await textFromFile(file);
        model = parseExportText(text);
        if (!model.entities.length) throw new Error('No kin found. Is this the export Kindroid emailed you?');
        setStatus('Checking Characters…');
        var report = await bringIntoCharacters(model);
        var note = characterNote(report);
        setStatus(summaryText(model) + ' ' + note);
        paint();
        refreshButtons();
        openCharacters(note);
      } catch (err) {
        model = null;
        paint();
        refreshButtons();
        setStatus(err.message || String(err), true);
      }
    }

    document.getElementById('btnArchivePick').onclick = function () { fileInput.click(); };
    fileInput.onchange = function () { var f = fileInput.files && fileInput.files[0]; fileInput.value = ''; takeFile(f); };
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      takeFile(f);
    });

    document.getElementById('btnArchiveFolder').onclick = async function () {
      if (typeof showDirectoryPicker !== 'function') {
        setStatus('This browser cannot write a folder. Use Chrome or Edge, or download the text.', true);
        return;
      }
      try {
        dirHandle = await showDirectoryPicker({ id: 'kin-studio-archive', mode: 'readwrite' });
        var db = await idb();
        await new Promise(function (resolve, reject) {
          var tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(dirHandle, 'dir');
          tx.oncomplete = resolve;
          tx.onerror = function () { reject(tx.error); };
        });
        folderLabel.textContent = 'Folder: ' + (dirHandle.name || 'chosen');
        refreshButtons();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        setStatus(err.message || String(err), true);
      }
    };

    saveBtn.onclick = async function () {
      if (!model || !dirHandle || job) return;
      try {
        var perm = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') { setStatus('Folder permission was not granted.', true); return; }
      } catch (err) { setStatus(err.message || String(err), true); return; }
      job = new AbortController();
      stopBtn.hidden = false;
      refreshButtons();
      try {
        var result = await saveModel(model, dirHandle, setStatus, job.signal);
        var bits = ['Saved ' + result.saved + (result.saved === 1 ? ' kin' : ' kins')];
        if (result.addedMsgs) bits.push(result.addedMsgs + ' new messages');
        if (result.gotMedia) bits.push(result.gotMedia + ' new files');
        if (result.skipped) bits.push(result.skipped + ' already there');
        if (result.missed) bits.push(result.missed + ' could not be downloaded');
        if (result.older) bits.push('older export — existing profiles were left as they are');
        if (result.stopped) bits.push('stopped early');
        setStatus(bits.join('. ') + '.');
      } catch (err) {
        setStatus(err.message || String(err), true);
      } finally {
        job = null;
        stopBtn.hidden = true;
        refreshButtons();
      }
    };
    stopBtn.onclick = function () { if (job) job.abort(); };
    textBtn.onclick = function () { if (model) { downloadText(model); setStatus('Text archive downloaded. Photos stay in the folder save.'); } };

    idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readonly');
        var req = tx.objectStore('kv').get('dir');
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    }).then(function (handle) {
      if (!handle) {
        if (typeof showDirectoryPicker !== 'function') folderLabel.textContent = 'This browser cannot write a folder. Download the text, or open Kin Studio in Chrome or Edge.';
        return;
      }
      dirHandle = handle;
      folderLabel.textContent = 'Folder: ' + (handle.name || 'chosen') + ' (confirm when you save)';
      refreshButtons();
    }).catch(function () {});
  }

  var api = { parseExportText: parseExportText, planMedia: planMedia, counts: counts, charFromEntity: charFromEntity, findChar: findChar, changedFields: changedFields, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
