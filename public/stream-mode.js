/* Kin Studio 1.17 Stream mode — Windows app only.
   Loaded by phone.html only when window.KinDesktop.stream exists, so the phone app never sees it.
   Uses: KinStream (stream-core.js), KinClient (shared Kindroid limiter + sendMessage),
   and the app's own readApiKey / chars / voiceForChar / speakText / stopSpeaking / adultsOn.
   Tokens are kept in memory and in the Windows app's encrypted token file, never in localStorage or exports. */
(function () {
  "use strict";
  var D = window.KinDesktop && window.KinDesktop.stream;
  var K = window.KinStream;
  if (!D || !K) return;

  var SKEY = "stream_settings";
  var TWITCH_SCOPES = "chat:read chat:edit moderator:read:followers";
  var JOY_SCOPES = "identity:read chat:read chat:write stream:read";
  function $s(id) { return document.getElementById(id); }
  function escH(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function getStore() { try { return store; } catch (_) { return null; } } // phone.html's const store
  function loadSettings() { var st = getStore(); return K.sanitizeSettings(st ? st.get(SKEY, {}) : {}); }
  function saveSettings(s) { var st = getStore(); if (st) st.set(SKEY, s); }
  var S = loadSettings();

  /* ---------- small helpers ---------- */
  function log(kind, text) {
    var box = $s("smLog"); if (!box) return;
    var row = document.createElement("div");
    row.className = "sm-log-" + kind;
    var t = new Date();
    row.textContent = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2) + ":" + ("0" + t.getSeconds()).slice(-2) + "  " + K.redactStream(text);
    box.insertBefore(row, box.firstChild);
    while (box.childNodes.length > 200) box.removeChild(box.lastChild);
  }
  function setPill(id, state, text) {
    var el = $s(id); if (!el) return;
    el.textContent = text; el.className = "badge" + (state === "ok" ? " on" : "");
  }
  function form(obj) { return Object.keys(obj).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]); }).join("&"); }
  async function http(req) { var r = await D.http(req); var j = null; try { j = JSON.parse(r.text || ""); } catch (_) {} r.json = j; return r; }
  function b64url(buf) { var s = ""; var b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function randStr(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- the Kin ---------- */
  function pickedKin() {
    var list = []; try { list = chars(); } catch (_) {}
    return list.find(function (c) { return c.id === S.kin_id; }) || null;
  }
  async function kinSend(prompt) {
    var c = pickedKin();
    if (!c || !c.ai_id) { var e0 = new Error("Pick a Kin with a Kindroid AI ID in Stream → Kin."); e0.kind = "setup"; throw e0; }
    if (!window.KinClient || !KinClient.sendMessage) throw new Error("Kindroid client not loaded.");
    var L = KinClient.limiter || (typeof getChatRate === "function" ? getChatRate() : null);
    // One shared limiter for the whole app (10 requests / 30 s). Skip only if sendMessage takes the slot itself.
    if (L && !KinClient.SEND_ACQUIRES_LIMITER) {
      if (L.acquire) await L.acquire(); else if (L.wait) { await L.wait(); L.mark(); }
    }
    try {
      var r = await KinClient.sendMessage({
        apiKey: readApiKey(), ai_id: c.ai_id, message: prompt, stream: false,
        timeoutMs: KinClient.TIMEOUT_MS || 75000,
        fetchImpl: typeof kindroidFetch === "function" ? kindroidFetch : undefined
      });
      try { if (KinClient.setStatus) KinClient.setStatus("ok", ""); } catch (_) {}
      return (r && r.text) || "";
    } catch (e) {
      try { if (e && e.kind === "rate_limit" && L && L.penalize) L.penalize(); } catch (_) {}
      try { if (KinClient.statusFromError) KinClient.statusFromError(e); } catch (_) {}
      throw e;
    }
  }

  /* ---------- lip-sync: listen to the app's own audio output (voices untouched) ---------- */
  var tap = { on: false, analysers: new Map() };
  (function patchConnect() {
    if (!window.AudioNode || AudioNode.prototype.__kinStreamTap) return;
    var orig = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      var r = orig.apply(this, arguments);
      try {
        if (tap.on && window.AudioDestinationNode && dest instanceof AudioDestinationNode && window.AudioBufferSourceNode && this instanceof AudioBufferSourceNode) {
          var ctx = this.context, an = tap.analysers.get(ctx);
          if (!an) {
            an = ctx.createAnalyser(); an.fftSize = 512;
            var mute = ctx.createGain(); mute.gain.value = 0;
            orig.call(an, mute); orig.call(mute, ctx.destination);
            tap.analysers.set(ctx, an);
          }
          orig.call(this, an);
        }
      } catch (_) {}
      return r;
    };
    AudioNode.prototype.__kinStreamTap = true;
  })();
  var mouthLoop = null;
  function mouthStart() {
    var prev = 0, lastPush = 0, buf = new Uint8Array(512), t0 = Date.now();
    D.push({ type: "talk", on: true });
    clearInterval(mouthLoop);
    mouthLoop = setInterval(function () {
      var level = 0;
      tap.analysers.forEach(function (an) { try { an.getByteTimeDomainData(buf); level = Math.max(level, K.rmsLevel(buf)); } catch (_) {} });
      // Device-voice fallback has no audio graph: flap gently instead.
      if (!tap.analysers.size) level = 0.05 + 0.05 * Math.abs(Math.sin((Date.now() - t0) / 90));
      prev = K.mouthFrom(level, prev, 6);
      var now = Date.now();
      if (now - lastPush >= 45) { lastPush = now; D.push({ type: "mouth", v: Math.round(prev * 100) / 100 }); }
    }, 30);
  }
  function mouthStop() { clearInterval(mouthLoop); mouthLoop = null; D.push({ type: "talk", on: false }); }
  async function kinSpeak(text) {
    var c = pickedKin();
    tap.on = true; mouthStart();
    try { await speakText(text, typeof voiceForChar === "function" ? voiceForChar(c) : null); }
    finally { mouthStop(); }
  }

  /* ---------- streamer mic (auto-duck) ---------- */
  var mic = { stream: null, ctx: null, an: null, until: 0, level: 0, timer: null };
  async function micStart() {
    micStop();
    if (!S.duck_on_mic) return;
    try {
      var cons = { audio: S.mic_device ? { deviceId: { exact: S.mic_device }, echoCancellation: false, noiseSuppression: false } : { echoCancellation: false } };
      mic.stream = await navigator.mediaDevices.getUserMedia(cons);
      mic.ctx = new (window.AudioContext || window.webkitAudioContext)();
      var src = mic.ctx.createMediaStreamSource(mic.stream);
      mic.an = mic.ctx.createAnalyser(); mic.an.fftSize = 512; src.connect(mic.an);
      var buf = new Uint8Array(512);
      mic.timer = setInterval(function () {
        mic.an.getByteTimeDomainData(buf);
        mic.level = K.rmsLevel(buf);
        if (mic.level > S.mic_threshold) mic.until = Date.now() + 900;
        var m = $s("smMicMeter"); if (m) m.style.width = Math.min(100, Math.round(mic.level * 400)) + "%";
      }, 100);
    } catch (e) { log("error", "Mic not available: " + (e && e.message || e)); }
  }
  function micStop() {
    clearInterval(mic.timer); mic.timer = null;
    try { if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    try { if (mic.ctx) mic.ctx.close(); } catch (_) {}
    mic.stream = mic.ctx = mic.an = null;
  }
  function micActive() { return Date.now() < mic.until; }

  /* ---------- Twitch ---------- */
  var tw = { token: "", refresh: "", login: "", userId: "", irc: null, es: null, stop: false, tries: 0, posted: [] };
  async function twitchLoadTokens() {
    tw.token = (await D.secretGet("twitch_access")) || "";
    tw.refresh = (await D.secretGet("twitch_refresh")) || "";
  }
  async function twitchValidate() {
    if (!tw.token) return false;
    var r = await http({ url: "https://id.twitch.tv/oauth2/validate", headers: { Authorization: "OAuth " + tw.token } });
    if (r.status === 200 && r.json) { tw.login = r.json.login; tw.userId = r.json.user_id; return true; }
    if (r.status === 401 && tw.refresh && S.twitch_client_id) return twitchRefresh();
    return false;
  }
  async function twitchRefresh() {
    var r = await http({ url: "https://id.twitch.tv/oauth2/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: S.twitch_client_id, grant_type: "refresh_token", refresh_token: tw.refresh }) });
    if (r.status === 200 && r.json && r.json.access_token) {
      tw.token = r.json.access_token; tw.refresh = r.json.refresh_token || tw.refresh;
      await D.secretSet("twitch_access", tw.token); await D.secretSet("twitch_refresh", tw.refresh);
      return twitchValidate();
    }
    return false;
  }
  /* Device Code Flow: no redirect URL, nothing to host. Chris types the code at twitch.tv/activate. */
  async function twitchConnect() {
    if (!S.twitch_client_id) { setPill("smTwState", "", "Paste your Twitch Client ID first"); return; }
    var r = await http({ url: "https://id.twitch.tv/oauth2/device", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: S.twitch_client_id, scopes: TWITCH_SCOPES }) });
    if (r.status !== 200 || !r.json) { setPill("smTwState", "", "Twitch said no (" + r.status + "). Check the Client ID and that the app is a Public client."); return; }
    var d = r.json;
    var box = $s("smTwCode"); if (box) { box.hidden = false; box.innerHTML = "Code: <strong style=\"font-size:1.3em;letter-spacing:.1em\">" + escH(d.user_code) + "</strong> — enter it on the Twitch page that just opened."; }
    D.open(d.verification_uri || "https://www.twitch.tv/activate");
    var until = Date.now() + (d.expires_in || 1800) * 1000, wait = (d.interval || 5) * 1000;
    while (Date.now() < until) {
      await sleep(wait);
      var t = await http({ url: "https://id.twitch.tv/oauth2/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: S.twitch_client_id, scopes: TWITCH_SCOPES, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
      if (t.status === 200 && t.json && t.json.access_token) {
        tw.token = t.json.access_token; tw.refresh = t.json.refresh_token || "";
        await D.secretSet("twitch_access", tw.token); await D.secretSet("twitch_refresh", tw.refresh);
        if (box) box.hidden = true;
        var ok = await twitchValidate();
        if (ok && !S.twitch_channel) { S.twitch_channel = tw.login; saveSettings(S); paintForm(); }
        setPill("smTwState", ok ? "ok" : "", ok ? "Signed in as " + tw.login : "Signed in, but the token didn't validate");
        return;
      }
      var msg = t.json && (t.json.message || t.json.error) || "";
      if (/slow_down/.test(msg)) wait += 5000;
      else if (!/authorization_pending/.test(msg)) { if (box) box.hidden = true; setPill("smTwState", "", "Twitch sign-in stopped: " + msg); return; }
    }
    if (box) box.hidden = true;
    setPill("smTwState", "", "The Twitch code expired. Press Connect again.");
  }
  function twitchIrcStart() {
    if (!tw.token || !S.twitch_channel) return;
    var ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    tw.irc = ws;
    ws.onopen = function () {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS oauth:" + tw.token);
      ws.send("NICK " + (tw.login || "justinfan" + Math.floor(Math.random() * 99999)));
      ws.send("JOIN #" + S.twitch_channel);
    };
    ws.onmessage = function (m) {
      String(m.data).split("\r\n").forEach(function (line) {
        if (!line) return;
        var msg = K.parseIrcLine(line); if (!msg) return;
        if (msg.command === "PING") { ws.send("PONG :" + (msg.trailing || "tmi.twitch.tv")); return; }
        if (msg.command === "001") { tw.tries = 0; return; }
        if (msg.command === "JOIN" && msg.nick === tw.login) { setPill("smTwState", "ok", "Twitch chat: #" + S.twitch_channel); log("info", "Joined Twitch chat #" + S.twitch_channel); return; }
        if (msg.command === "NOTICE" && /authentication failed|improperly formatted auth|invalid nick/i.test(msg.trailing)) {
          tw.stop = true; setPill("smTwState", "", "Twitch rejected the sign-in. Press Connect Twitch again."); try { ws.close(); } catch (_) {} return;
        }
        if (msg.command === "RECONNECT") { try { ws.close(); } catch (_) {} return; }
        if (msg.command === "PRIVMSG" || msg.command === "USERNOTICE") {
          var ev = K.twitchEventFromIrc(msg);
          if (!ev) return;
          if (ev.kind === "chat" && ev.user === tw.login && tw.posted.indexOf(ev.text) >= 0) return; // our own post-back

          feed(ev);
        }
      });
    };
    ws.onclose = function () {
      if (tw.irc !== ws) return;
      tw.irc = null;
      if (tw.stop || !running) return;
      setPill("smTwState", "", "Twitch chat reconnecting…");
      var wait = Math.min(30000, 1000 * Math.pow(2, tw.tries++));
      setTimeout(function () { if (running && !tw.stop) twitchIrcStart(); }, wait);
    };
  }
  function twitchFollowsStart(url) {
    if (!tw.token || !tw.userId || !S.thank_follows || S.mode !== "cohost") return;
    var ws = new WebSocket(url || "wss://eventsub.wss.twitch.tv/ws");
    var old = tw.es; tw.es = ws;
    ws.onmessage = async function (m) {
      var f; try { f = JSON.parse(m.data); } catch (_) { return; }
      var type = f.metadata && f.metadata.message_type;
      if (type === "session_welcome") {
        if (old) { try { old.__replaced = true; old.close(); } catch (_) {} old = null; if (url) return; }
        var r = await http({
          url: "https://api.twitch.tv/helix/eventsub/subscriptions", method: "POST",
          headers: { Authorization: "Bearer " + tw.token, "Client-Id": S.twitch_client_id, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "channel.follow", version: "2", condition: { broadcaster_user_id: tw.userId, moderator_user_id: tw.userId }, transport: { method: "websocket", session_id: f.payload.session.id } })
        });
        if (r.status === 202) log("info", "Twitch follow alerts on.");
        else log("error", "Twitch follow alerts unavailable (" + r.status + "). Follows only work on your own channel.");
      } else if (type === "session_reconnect") {
        twitchFollowsStart(f.payload.session.reconnect_url);
      } else if (type === "notification") {
        var ev = K.twitchEventFromEventSub(f); if (ev) feed(ev);
      }
    };
    ws.onclose = function () { if (tw.es === ws && !ws.__replaced) { tw.es = null; if (running && !tw.stop) setTimeout(function () { twitchFollowsStart(); }, 10000); } };
  }
  function twitchPost(text) {
    if (tw.irc && tw.irc.readyState === 1) {
      tw.posted.push(text); if (tw.posted.length > 20) tw.posted.shift();
      tw.irc.send("PRIVMSG #" + S.twitch_channel + " :" + text);
    }
  }
  function twitchStop() { tw.stop = true; try { if (tw.irc) tw.irc.close(); } catch (_) {} try { if (tw.es) tw.es.close(); } catch (_) {} tw.irc = tw.es = null; }

  /* ---------- Joystick.tv ---------- */
  var jy = { token: "", refresh: "", exp: 0, ws: null, stop: false, tries: 0, pkce: null, channelId: "", refreshTimer: null };
  function joyRedirect() { return "http://127.0.0.1:" + overlayPort + "/callback"; }
  async function joyConnect() {
    if (!S.joystick_client_id) { setPill("smJyState", "", "Paste your Joystick bot Client ID first"); return; }
    await ensureServer();
    var verifier = randStr(48);
    var challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    jy.pkce = { verifier: verifier, state: randStr(16), redirect: joyRedirect() };
    var url = "https://joystick.tv/api/oauth/authorize?" + form({ response_type: "code", client_id: S.joystick_client_id, scope: JOY_SCOPES, redirect_uri: jy.pkce.redirect, code_challenge: challenge, code_challenge_method: "S256", state: jy.pkce.state });
    D.open(url);
    setPill("smJyState", "", "Approve Kin Studio on the Joystick page that opened…");
  }
  D.onOAuth(async function (q) {
    var p = jy.pkce; jy.pkce = null;
    if (!p || !q || q.state !== p.state) { setPill("smJyState", "", "Joystick sign-in didn't match. Press Connect again."); return; }
    if (q.error || !q.code) { setPill("smJyState", "", "Joystick sign-in was cancelled."); return; }
    var r = await http({ url: "https://api.joystick.tv/api/oauth/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form({ grant_type: "authorization_code", code: q.code, redirect_uri: p.redirect, client_id: S.joystick_client_id, code_verifier: p.verifier }) });
    if (!(await joySaveTokens(r))) { setPill("smJyState", "", "Joystick didn't give a token (" + r.status + ")."); return; }
    setPill("smJyState", "ok", "Joystick connected");
    if (running && S.joystick_enabled) joyStart();
  });
  async function joySaveTokens(r) {
    if (r.status !== 200 || !r.json || !r.json.access_token) return false;
    jy.token = r.json.access_token; jy.refresh = r.json.refresh_token || jy.refresh;
    jy.exp = Date.now() + (r.json.expires_in || 14400) * 1000;
    await D.secretSet("joystick_access", jy.token); await D.secretSet("joystick_refresh", jy.refresh); await D.secretSet("joystick_expires", String(jy.exp));
    joyScheduleRefresh();
    return true;
  }
  function joyScheduleRefresh() {
    clearTimeout(jy.refreshTimer);
    var ms = Math.max(30000, jy.exp - Date.now() - 5 * 60000);
    jy.refreshTimer = setTimeout(function () { joyRefresh().then(function (ok) { if (ok && running && jy.ws) { try { jy.ws.close(); } catch (_) {} } }); }, ms);
  }
  async function joyRefresh() {
    if (!jy.refresh || !S.joystick_client_id) return false;
    var r = await http({ url: "https://api.joystick.tv/api/oauth/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form({ grant_type: "refresh_token", refresh_token: jy.refresh, client_id: S.joystick_client_id }) });
    return joySaveTokens(r);
  }
  async function joyLoadTokens() {
    jy.token = (await D.secretGet("joystick_access")) || "";
    jy.refresh = (await D.secretGet("joystick_refresh")) || "";
    jy.exp = Number((await D.secretGet("joystick_expires")) || 0);
    if (jy.refresh && (!jy.token || Date.now() > jy.exp - 60000)) await joyRefresh();
    else if (jy.token) joyScheduleRefresh();
  }
  function joyStart() {
    if (!jy.token) return;
    jy.stop = false;
    var ws = new WebSocket("wss://api.joystick.tv/cable?token=" + encodeURIComponent(jy.token), "actioncable-v1-json");
    jy.ws = ws;
    ws.onopen = function () { ws.send(K.joystickSubscribeFrame()); };
    ws.onmessage = function (m) {
      var f; try { f = JSON.parse(m.data); } catch (_) { return; }
      if (f.type === "confirm_subscription") { jy.tries = 0; setPill("smJyState", "ok", "Joystick chat connected"); log("info", "Joystick gateway subscribed."); return; }
      if (f.type === "reject_subscription") { setPill("smJyState", "", "Joystick refused the bot subscription."); return; }
      if (f.error) { log("error", "Joystick: " + f.error); return; }
      var ev = K.joystickEventFromFrame(f);
      if (ev) { if (ev.channel_id) jy.channelId = ev.channel_id; feed(ev); }
    };
    ws.onclose = async function (e) {
      if (jy.ws !== ws) return;
      jy.ws = null;
      if (jy.stop || !running) return;
      if (e && e.code === 4401) { var ok = await joyRefresh(); if (!ok) { setPill("smJyState", "", "Joystick sign-in expired. Press Connect Joystick again."); return; } }
      setPill("smJyState", "", "Joystick reconnecting…");
      setTimeout(function () { if (running && !jy.stop) joyStart(); }, Math.min(30000, 1000 * Math.pow(2, jy.tries++)));
    };
  }
  async function joyPost(text) {
    await http({ url: "https://api.joystick.tv/api/v1/chat/messages", method: "POST", headers: { Authorization: "Bearer " + jy.token, "Content-Type": "application/json" }, body: JSON.stringify({ text: text }) });
  }
  function joyStop() { jy.stop = true; try { if (jy.ws) jy.ws.close(); } catch (_) {} jy.ws = null; }

  /* ---------- 1.18 stream awareness: Twitch title / game / live, OBS scene ---------- */
  var info = { timer: null, channelId: "", channelLogin: "", lastErr: "" };
  function helixHeaders() { return { Authorization: "Bearer " + tw.token, "Client-Id": S.twitch_client_id }; }
  async function helixGet(path) {
    var r = await http({ url: "https://api.twitch.tv/helix/" + path, headers: helixHeaders() });
    if (r.status === 401 && tw.refresh && (await twitchRefresh())) r = await http({ url: "https://api.twitch.tv/helix/" + path, headers: helixHeaders() });
    return r;
  }
  /* Works with whichever account is signed in (e.g. the Kin's own bot account) because it reads the Channel by name. */
  async function infoPoll() {
    if (!S.twitch_info || !S.twitch_enabled || !S.twitch_channel) return;
    if (!tw.token) { await twitchLoadTokens(); if (!tw.token) { paintInfo("Sign in to Twitch (step 2) so the Kin can see your title and game."); return; } }
    try {
      if (info.channelLogin !== S.twitch_channel || !info.channelId) {
        var u = await helixGet("users?login=" + encodeURIComponent(S.twitch_channel));
        var d = u.json && u.json.data && u.json.data[0];
        if (u.status !== 200 || !d) { paintInfo("Twitch couldn't find the channel \"" + S.twitch_channel + "\" (" + u.status + ")."); return; }
        info.channelId = d.id; info.channelLogin = S.twitch_channel;
      }
      var ch = await helixGet("channels?broadcaster_id=" + encodeURIComponent(info.channelId));
      var st = await helixGet("streams?user_id=" + encodeURIComponent(info.channelId));
      var patch = Object.assign({}, K.parseHelixChannel(ch.json) || {}, K.parseHelixStream(st.json) || {});
      if (ch.status !== 200) { paintInfo("Couldn't read the stream title from Twitch (" + ch.status + ")."); return; }
      var changed = engine.setStreamInfo(patch);
      if (changed.indexOf("title") >= 0 || changed.indexOf("game") >= 0) log("info", "Stream info: " + (engine.info.game || "no category") + " · " + (engine.info.title || "no title"));
      if (changed.indexOf("live") >= 0) log("info", engine.info.live ? "Twitch says you're live." : "Twitch says you're offline.");
      paintInfo();
    } catch (e) { paintInfo("Couldn't reach Twitch for stream info: " + K.redactStream(e && e.message || e)); }
  }
  function infoStart() {
    clearInterval(info.timer); info.timer = null;
    if (!S.twitch_info || !S.twitch_enabled) return;
    infoPoll();
    info.timer = setInterval(infoPoll, S.info_poll_min * 60000);
  }
  function infoStop() { clearInterval(info.timer); info.timer = null; }

  var obs = { ws: null, stop: true, tries: 0, timer: null, state: "" };
  async function sha256b64(text) {
    var h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    var b = new Uint8Array(h), s2 = "";
    for (var i = 0; i < b.length; i++) s2 += String.fromCharCode(b[i]);
    return btoa(s2);
  }
  function obsPill(state, text) { obs.state = text; setPill("smObsState", state, text); }
  /* testOnly: connect once, report the scene, don't reconnect. */
  function obsConnect(testOnly) {
    obsDisconnect();
    obs.stop = false;
    var ws;
    try { ws = new WebSocket(S.obs_url); } catch (e) { obsPill("", "Bad OBS address: " + S.obs_url); return; }
    obs.ws = ws;
    obsPill("", "Connecting to OBS…");
    ws.onmessage = async function (m) {
      var f; try { f = JSON.parse(m.data); } catch (_) { return; }
      if (f.op === 0) {
        try {
          var pw = (await D.secretGet("obs_password")) || "";
          ws.send(await K.obsIdentify(f, pw, sha256b64));
        } catch (e) { obs.stop = true; obsPill("", e.message); try { ws.close(); } catch (_) {} }
        return;
      }
      if (f.op === 2) { obs.tries = 0; obsPill("ok", "OBS connected"); ws.send(K.obsRequestFrame("GetCurrentProgramScene", "scene1")); return; }
      var scene = K.obsSceneFromFrame(f);
      if (scene != null) {
        var initial = f.op === 7;
        var react = engine.setScene(scene, initial);
        obsPill("ok", "OBS scene: " + scene);
        if (!initial) log("info", "OBS scene: " + scene + (react ? " (Kin will say a line)" : ""));
        paintInfo();
        if (testOnly && initial) { log("info", "OBS test worked. Current scene: " + scene); obs.stop = true; try { ws.close(); } catch (_) {} }
      }
    };
    ws.onclose = function (e) {
      if (obs.ws !== ws) return;
      obs.ws = null;
      if (e && e.code === 4009) { obs.stop = true; obsPill("", "OBS said the password is wrong. Re-copy it from OBS (Tools → WebSocket Server Settings → Show Connect Info)."); return; }
      if (obs.stop || testOnly || !running || !S.obs_enabled) { if (!/password|OBS scene|Bad OBS/.test(obs.state)) obsPill("", obs.tries || testOnly ? "OBS not reachable. In OBS: Tools → WebSocket Server Settings → Enable WebSocket server." : "OBS disconnected"); return; }
      obsPill("", "OBS not reachable, retrying… (Tools → WebSocket Server Settings → Enable)");
      obs.timer = setTimeout(function () { if (running && S.obs_enabled && !obs.stop) obsConnect(false); }, Math.min(60000, 2000 * Math.pow(2, obs.tries++)));
    };
  }
  function obsDisconnect() { obs.stop = true; clearTimeout(obs.timer); obs.timer = null; var w = obs.ws; obs.ws = null; try { if (w) w.close(); } catch (_) {} }

  /* ---------- engine ---------- */
  var running = false, tickTimer = null, overlayPort = 0;
  function isAdults() { try { return typeof adultsOn === "function" ? !!adultsOn() : false; } catch (_) { return false; } }
  var engine = new K.CohostEngine({
    send: kinSend,
    speak: kinSpeak,
    stopSpeaking: function () { try { stopSpeaking(); } catch (_) {} mouthStop(); },
    postChat: function (platform, text) { return platform === "twitch" ? twitchPost(text) : joyPost(text); },
    overlay: function (ev) { D.push(ev); },
    adultsOn: isAdults,
    micActive: micActive,
    limiter: window.KinClient && KinClient.limiter
  }, S);
  engine.on(function (e) {
    if (e.type === "reply") log("kin", "Kin (" + e.emotion + "): " + e.text);
    else if (e.type === "send") log("info", "Asking Kin (" + e.job + ")…");
    else if (e.type === "filtered") log("warn", "Filtered a " + e.where + " message (blocked word).");
    else if (e.type === "error") log("error", e.text);
    else if (e.type === "stopped") { log("error", e.text); setPill("smRunState", "", "Stopped: " + e.text); }
    paintStats();
  });
  function feed(ev) {
    var why = engine.ingest(ev);
    if (!why && ev.kind === "chat") log("chat", ev.name + ": " + ev.text);
    else if (!why) log("event", K.eventLine(ev) || ev.kind);
    paintStats();
  }
  function defaultPlatform() {
    if (S.twitch_enabled) return "twitch";
    if (S.joystick_enabled) return "joystick";
    return "stream";
  }
  async function ensureServer() {
    if (overlayPort) return overlayPort;
    var r = await D.start();
    overlayPort = r.port;
    paintUrls();
    D.config(overlayConfig());
    return overlayPort;
  }
  function overlayConfig() {
    return { overlay_font: S.overlay_font, overlay_size: S.overlay_size, overlay_position: S.overlay_position, overlay_color: S.overlay_color, overlay_bg: S.overlay_bg, caption_hold_sec: S.caption_hold_sec, avatar_side: S.avatar_side };
  }
  async function start() {
    if (running) return;
    var c = pickedKin();
    if (!c || !c.ai_id) { setPill("smRunState", "", "Pick a Kin first (step 1)."); return; }
    if (!S.twitch_enabled && !S.joystick_enabled) { setPill("smRunState", "", "Tick Use Twitch in step 2 first."); return; }
    await ensureServer();
    running = true;
    engine.configure(S); engine.resume(); engine.defaultPlatform = defaultPlatform();
    tw.stop = false; jy.stop = false;
    if (S.twitch_enabled) { await twitchLoadTokens(); if (await twitchValidate()) { twitchIrcStart(); twitchFollowsStart(); } else setPill("smTwState", "", "Twitch not signed in — press Connect Twitch."); }
    if (S.joystick_enabled) { await joyLoadTokens(); if (jy.token) joyStart(); else setPill("smJyState", "", "Joystick not connected — press Connect Joystick."); }
    var hk = await D.hotkeys({ mute: S.hotkey_mute, skip: S.hotkey_skip, pause: S.hotkey_pause });
    Object.keys(hk || {}).forEach(function (k) { if (hk[k] === "taken" || hk[k] === "invalid") log("warn", "Hotkey for " + k + " is " + hk[k] + "."); });
    await micStart();
    infoStart();
    if (S.obs_enabled) { obs.tries = 0; obsConnect(false); }
    clearInterval(tickTimer);
    tickTimer = setInterval(function () { engine.tick(); }, 500);
    setPill("smRunState", "ok", "Live: " + c.name + (S.mode === "cohost" ? " is co-hosting" : " answers " + S.command));
    log("info", "Stream mode started.");
  }
  async function stop() {
    running = false;
    clearInterval(tickTimer); tickTimer = null;
    twitchStop(); joyStop(); micStop(); infoStop(); obsDisconnect(); engine.sceneJob = null;
    engine.skip();
    try { await D.hotkeys({}); } catch (_) {}
    setPill("smRunState", "", "Stopped");
    log("info", "Stream mode stopped.");
  }
  D.onHotkey(function (a) {
    if (a === "mute") { var m = engine.mute(); log("info", m ? "Kin muted." : "Kin unmuted."); paintButtons(); }
    else if (a === "skip") { engine.skip(); log("info", "Skipped."); }
    else if (a === "pause") { var p = engine.pause(); log("info", p ? "Auto-chat paused." : "Auto-chat resumed."); paintButtons(); }
  });
  async function testPipeline() {
    await ensureServer();
    var c = pickedKin();
    if (!c || !c.ai_id) { log("error", "Pick a Kin first."); return; }
    engine.configure(S); engine.resume(); engine.defaultPlatform = defaultPlatform();
    var plat = defaultPlatform() === "stream" ? "twitch" : defaultPlatform();
    var text = S.mode === "command" ? S.command + " say hi to the test viewer and tell them the stream is working" : "Hey! This is a test message, can you hear me?";
    engine.lastChatReplyAt = 0;
    feed({ platform: plat, kind: "chat", user: "kinstudio_test", name: "TestViewer", text: text, first: true, mod: false, test: true });
    engine.lastEventsAt = Date.now(); engine.events = []; // the test greets only through the chat reply
    log("info", "Test sent through filter → queue → Kindroid → voice → overlay (nothing is posted to real chat).");
    var r = await engine.tick();
    if (!r) log("warn", "The test is waiting (rate limit, paused, or the mic is active). It will go when ready.");
    if (!running) { var t = setInterval(function () { if (!engine.queued() || running) { clearInterval(t); return; } engine.tick(); }, 500); }
  }

  /* ---------- UI ---------- */
  var SLOTS = [["idle", "Idle (mouth closed)"], ["talk", "Talking (mouth open)"], ["blink", "Blink"], ["happy", "Happy"], ["happy_talk", "Happy, talking"], ["laugh", "Laughing"], ["surprised", "Surprised"], ["sad", "Sad"], ["angry", "Angry"], ["thinking", "Thinking"]];
  function chk(id, label) { return '<label class="sm-chk"><input type="checkbox" id="' + id + '"> ' + label + "</label>"; }
  function num(id, label, min, max) { return '<label>' + label + '</label><input id="' + id + '" type="number" min="' + min + '" max="' + max + '">'; }
  function txt(id, label, ph) { return '<label>' + label + '</label><input id="' + id + '" placeholder="' + escH(ph || "") + '" autocomplete="off" spellcheck="false">'; }
  function area(id, label, ph) { return '<label>' + label + '</label><textarea id="' + id + '" rows="2" placeholder="' + escH(ph || "") + '"></textarea>'; }
  function buildUi() {
    var tabs = document.querySelector(".tab[data-p=\"settings\"]");
    if (!tabs || $s("p-stream")) return;
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "tab"; btn.dataset.p = "stream"; btn.textContent = "Stream";
    tabs.parentNode.insertBefore(btn, tabs);
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
      document.querySelectorAll(".panel").forEach(function (x) { x.classList.remove("active"); });
      btn.classList.add("active"); btn.setAttribute("aria-selected", "true");
      $s("p-stream").classList.add("active");
      paintKins(); paintForm();
    });
    var sec = document.createElement("section");
    sec.id = "p-stream"; sec.className = "panel";
    sec.innerHTML =
      '<style>#p-stream .sm-chk{display:flex;align-items:center;gap:8px;margin:8px 0}#p-stream .sm-chk input{width:auto;margin:0;flex:0 0 auto}#p-stream .sm-urls code{user-select:all;word-break:break-all}#smLog{max-height:260px;overflow:auto;font:12px/1.4 Consolas,monospace;background:rgba(0,0,0,.25);padding:8px;border-radius:8px}#smLog .sm-log-error{color:#ff9a9a}#smLog .sm-log-warn{color:#ffd27a}#smLog .sm-log-kin{color:#9fe3a8}#smMic{height:8px;background:rgba(255,255,255,.1);border-radius:4px;overflow:hidden;margin-top:6px}#smMicMeter{height:100%;width:0;background:#7bd389}#p-stream .sm-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}#p-stream .sm-slot{border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px;font-size:.85em}</style>' +
      '<div class="card"><h2 style="margin:0 0 6px;font-size:1.15rem">Stream mode</h2><p class="hint">Your Kin co-hosts your Twitch stream: reads chat, answers people by name, thanks follows, subs, bits and raids, and talks with its own voice on an OBS overlay. Windows app only.</p>' +
      '<div class="row"><button type="button" class="btn" id="smStart">Start</button><button type="button" class="btn" id="smStop">Stop</button><button type="button" class="btn" id="smTest">Test</button><span id="smRunState" class="badge">Stopped</span></div>' +
      '<div class="row"><button type="button" class="btn" id="smMute">Mute Kin</button><button type="button" class="btn" id="smSkip">Skip reply</button><button type="button" class="btn" id="smPause">Pause auto-chat</button></div>' +
      '<label>Say this (a line or topic for your Kin)</label><div class="row"><input id="smSay" placeholder="Tell chat we\'re going into the boss fight"><button type="button" class="btn" id="smSayBtn">Send</button></div>' +
      '<p class="hint" id="smStats"></p></div>' +
      '<div class="card"><h3>1. Kin</h3><label>Which Kin is on stream</label><select id="smKin"></select><p class="hint">Uses that Kin\'s Kokoro voice from the Voices tab. Messages go through the same Kindroid queue as Chat (10 per 30 seconds).</p></div>' +
      '<div class="card"><h3>2. Twitch</h3>' + chk("smTwOn", "Use Twitch") + txt("smTwChan", "Channel", "your_twitch_name") +
      '<div class="row"><button type="button" class="btn" id="smTwConnect">Connect Twitch</button><button type="button" class="btn" id="smTwForget">Sign out</button><span id="smTwState" class="badge">Not connected</span></div><p class="hint" id="smTwCode" hidden></p><p class="hint">Press Connect Twitch, then type the code Twitch shows you. Twitch is always kept safe-for-work, even with Adults-only on.</p>' +
      '<details><summary class="hint">Advanced</summary>' + txt("smTwClient", "Twitch Client ID (leave as is unless you registered your own app)", "") + txt("smJyClient", "Joystick.tv bot Client ID (Joystick support is coming later; leave empty)", "") + '</details></div>' +
      '<div class="card" id="smJyCard" hidden style="display:none"><h3>Joystick.tv (preview)</h3>' + chk("smJyOn", "Use Joystick.tv") +
      '<div class="row"><button type="button" class="btn" id="smJyConnect">Connect Joystick</button><button type="button" class="btn" id="smJyForget">Sign out</button><span id="smJyState" class="badge">Not connected</span></div><p class="hint" id="smAdultHint"></p></div>' +
      '<div class="card"><h3>3. Co-host</h3><label>Mode</label><select id="smMode"><option value="cohost">Co-host: reads chat on its own</option><option value="command">Command only: answers !kin</option></select>' +
      txt("smCmd", "Command", "!kin") + chk("smRead", "Read chat and answer on its own") + num("smBatch", "Chat lines per reply", 1, 20) + num("smGap", "Seconds between chat replies", 4, 600) + num("smMax", "Max Kindroid messages per 30 s for streaming (1–8)", 1, 8) +
      chk("smFirst", "Greet first-time chatters") + chk("smFol", "Thank follows") + chk("smSubs", "Thank subs / gift subs") + chk("smBits", "Thank bits (Twitch)") + (S.joystick_client_id ? chk("smTips", "Thank tips (Joystick)") : "") + chk("smRaids", "Thank raids (Twitch)") + num("smEvGap", "Seconds between thank-you lines", 5, 600) +
      chk("smIdle", "Talk when chat is quiet") + num("smIdleSec", "Quiet for this many seconds", 30, 3600) +
      area("smGame", "What's happening (game, goal, inside jokes)", "Playing Elden Ring, stuck on Malenia, chat keeps telling me to git gud") + num("smWords", "Reply length (words)", 10, 150) + '</div>' +
      '<div class="card"><h3>4. Safety</h3>' + chk("smModOnly", "Only mods (and the allow list) can talk to the Kin") + chk("smAllowOnly", "Only people on the allow list") + area("smAllow", "Allow list (usernames, one per line or commas)", "") + area("smBlock", "Block list (usernames)", "") + area("smWords2", "Extra blocked words", "") +
      num("smCool", "Per-viewer cooldown for !kin (seconds)", 0, 3600) + num("smQueue", "Max waiting !kin requests", 1, 50) + '<p class="hint">Chat is checked before it goes to Kindroid, and the reply is checked again before it is spoken or shown. Blocked names and messages are never read out.</p></div>' +
      '<div class="card"><h3>5. Voice and chat</h3>' + chk("smSpeak", "Speak replies out loud") + chk("smPost", "Also post the reply in chat (cut to 500 characters)") + chk("smDuck", "Wait while I\'m talking (watch my mic)") +
      '<label>Mic</label><select id="smMicDev"><option value="">Default mic</option></select>' + num("smMicTh", "Mic sensitivity (0.01 = very sensitive, 0.2 = loud only)", 0.005, 0.5) + '<div id="smMic"><div id="smMicMeter"></div></div></div>' +
      '<div class="card sm-urls"><h3>6. OBS overlay</h3><p class="hint">In OBS: Sources → + → Browser. Paste a link, width 1920, height 1080. The background is see-through.</p><div id="smUrls"><p class="hint">Press Start or Test once to turn the overlay on.</p></div>' +
      txt("smFont", "Caption font", "Segoe UI") + num("smSize", "Caption size (px)", 12, 120) + '<label>Caption position</label><select id="smPos"><option value="bottom">Bottom</option><option value="top">Top</option><option value="middle">Middle</option></select>' +
      txt("smColor", "Caption color", "#ffffff") + txt("smBg", "Caption background", "rgba(0,0,0,0.55)") + num("smHold", "Keep captions up for (seconds)", 1, 60) + '<label>Avatar side</label><select id="smSide"><option value="left">Left</option><option value="right">Right</option></select>' +
      '<h3>Avatar pictures</h3><p class="hint">Upload your Kin\'s selfies. Only Idle is needed. Add Talking (mouth open) and Blink for a PNGTuber look; mood pictures swap in when the Kin sounds happy, surprised and so on. PNG with a see-through background looks best.</p><div class="sm-slots" id="smSlots"></div></div>' +
      '<div class="card"><h3>7. Hotkeys</h3><p class="hint">Work even while the game has focus. Examples: Ctrl+Alt+M, F9.</p>' + txt("smHkMute", "Mute / unmute Kin", "Ctrl+Alt+M") + txt("smHkSkip", "Skip the current reply", "Ctrl+Alt+S") + txt("smHkPause", "Pause / resume auto-chat", "Ctrl+Alt+P") + '<div class="row"><button type="button" class="btn" id="smSave">Save stream settings</button></div></div>' +
      '<div class="card"><h3>8. Stream awareness</h3><p class="hint">Lets your Kin know what\'s on stream besides chat. It\'s added as one short line to the messages the Kin already gets, so it costs no extra Kindroid messages. Titles and scene names go through the same blocked-word check as chat.</p>' +
      chk("smInfoOn", "Tell the Kin my stream title, game and whether I\'m live (from Twitch)") + num("smInfoMin", "Check Twitch every (minutes, 2–10)", 2, 10) +
      '<p class="hint">Uses your Twitch sign-in from step 2. It reads the Channel above, so it works when the Kin has its own Twitch account.</p>' +
      chk("smObsOn", "Tell the Kin which OBS scene is showing") +
      '<p class="hint">One-time setup in OBS 28 or newer: Tools → WebSocket Server Settings → tick Enable WebSocket server. If Enable Authentication is ticked, press Show Connect Info and copy the Server Password here.</p>' +
      txt("smObsUrl", "OBS address", "ws://localhost:4455") + '<label>OBS WebSocket password (saved encrypted on this PC)</label><input id="smObsPw" type="password" autocomplete="off" placeholder="leave empty if authentication is off">' +
      '<div class="row"><button type="button" class="btn" id="smObsTest">Test OBS connection</button><button type="button" class="btn" id="smObsForget">Forget password</button><span id="smObsState" class="badge">OBS off</span></div>' +
      chk("smSceneOn", "Say a short line when I switch to a BRB, Starting soon or Ending scene (and when I come back)") + num("smSceneGap", "At most one scene line every (seconds)", 30, 3600) +
      '<p class="hint">Scene names count if they contain words like BRB, Break, Away, Starting, Soon, Intro, Ending or Outro. Needs the OBS box above ticked and Co-host mode.</p>' +
      '<p class="hint" id="smInfoNow">The Kin sees: nothing yet.</p></div>' +
      '<div class="card"><h3>Activity</h3><div id="smLog"></div></div>';
    var settingsPanel = $s("p-settings");
    (settingsPanel && settingsPanel.parentNode ? settingsPanel.parentNode : document.body).insertBefore(sec, settingsPanel || null);
    bindUi();
    paintSlots();
  }
  var MAP = [
    ["smTwOn", "twitch_enabled"], ["smTwClient", "twitch_client_id"], ["smTwChan", "twitch_channel"], ["smJyOn", "joystick_enabled"], ["smJyClient", "joystick_client_id"],
    ["smMode", "mode"], ["smCmd", "command"], ["smRead", "read_chat"], ["smBatch", "batch_max_lines"], ["smGap", "chat_gap_sec"], ["smMax", "max_per_30s"],
    ["smFirst", "greet_first_timers"], ["smFol", "thank_follows"], ["smSubs", "thank_subs"], ["smBits", "thank_bits"], ["smTips", "thank_tips"], ["smRaids", "thank_raids"], ["smEvGap", "events_gap_sec"],
    ["smIdle", "idle_banter"], ["smIdleSec", "idle_sec"], ["smGame", "game_context"], ["smWords", "reply_words"],
    ["smModOnly", "mod_only"], ["smAllowOnly", "allowlist_only"], ["smAllow", "allow_users"], ["smBlock", "block_users"], ["smWords2", "block_words"], ["smCool", "user_cooldown_sec"], ["smQueue", "max_queue"],
    ["smSpeak", "speak"], ["smPost", "post_to_chat"], ["smDuck", "duck_on_mic"], ["smMicDev", "mic_device"], ["smMicTh", "mic_threshold"],
    ["smFont", "overlay_font"], ["smSize", "overlay_size"], ["smPos", "overlay_position"], ["smColor", "overlay_color"], ["smBg", "overlay_bg"], ["smHold", "caption_hold_sec"], ["smSide", "avatar_side"],
    ["smHkMute", "hotkey_mute"], ["smHkSkip", "hotkey_skip"], ["smHkPause", "hotkey_pause"], ["smKin", "kin_id"],
    ["smInfoOn", "twitch_info"], ["smInfoMin", "info_poll_min"], ["smObsOn", "obs_enabled"], ["smObsUrl", "obs_url"], ["smSceneOn", "scene_react"], ["smSceneGap", "scene_gap_sec"]
  ];
  function paintForm() {
    MAP.forEach(function (m) { var el = $s(m[0]); if (!el) return; if (el.type === "checkbox") el.checked = !!S[m[1]]; else el.value = S[m[1]] == null ? "" : S[m[1]]; });
    var jc = $s("smJyCard"); if (jc) { jc.hidden = !S.joystick_client_id; jc.style.display = S.joystick_client_id ? "" : "none"; }
    var ah = $s("smAdultHint");
    if (ah) ah.textContent = isAdults() ? "Adults-only (18+) is on in Settings, so Joystick replies can be adult. Twitch stays safe-for-work." : "Adults-only (18+) is off in Settings, so Joystick replies stay safe-for-work too.";
    paintButtons();
  }
  function readForm() {
    var o = Object.assign({}, S);
    MAP.forEach(function (m) { var el = $s(m[0]); if (!el) return; o[m[1]] = el.type === "checkbox" ? el.checked : el.value; });
    S = K.sanitizeSettings(o);
    saveSettings(S);
    engine.configure(S); engine.defaultPlatform = defaultPlatform();
    if (overlayPort) D.config(overlayConfig());
    if (running) {
      D.hotkeys({ mute: S.hotkey_mute, skip: S.hotkey_skip, pause: S.hotkey_pause }); micStart();
      var infoKey = [S.twitch_info, S.twitch_enabled, S.twitch_channel, S.info_poll_min].join("|");
      if (infoKey !== lastInfoKey) infoStart();
      var obsKey = [S.obs_enabled, S.obs_url].join("|");
      if (obsKey !== lastObsKey) { if (S.obs_enabled) { obs.tries = 0; obsConnect(false); } else { obsDisconnect(); obsPill("", "OBS off"); } }
    }
    lastInfoKey = [S.twitch_info, S.twitch_enabled, S.twitch_channel, S.info_poll_min].join("|");
    lastObsKey = [S.obs_enabled, S.obs_url].join("|");
    paintInfo();
  }
  var lastInfoKey = "", lastObsKey = "";
  function paintInfo(note) {
    var el = $s("smInfoNow"); if (!el) return;
    var line = engine.streamLine(defaultPlatform() === "stream" ? "twitch" : defaultPlatform());
    el.textContent = (note ? note + " " : "") + "The Kin sees: " + (line || "nothing yet (it updates once Stream mode starts).");
  }
  function paintKins() {
    var sel = $s("smKin"); if (!sel) return;
    var list = []; try { list = chars(); } catch (_) {}
    sel.innerHTML = '<option value="">Pick a Kin…</option>' + list.map(function (c) { return '<option value="' + escH(c.id) + '"' + (c.ai_id ? "" : " disabled") + ">" + escH(c.name || "Kin") + (c.ai_id ? "" : " (needs AI ID)") + "</option>"; }).join("");
    sel.value = S.kin_id || "";
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(function (devs) {
        var ms = $s("smMicDev"); if (!ms) return;
        ms.innerHTML = '<option value="">Default mic</option>' + devs.filter(function (d) { return d.kind === "audioinput" && d.deviceId !== "default"; }).map(function (d, i) { return '<option value="' + escH(d.deviceId) + '">' + escH(d.label || "Mic " + (i + 1)) + "</option>"; }).join("");
        ms.value = S.mic_device || "";
      }).catch(function () {});
    }
  }
  function paintUrls() {
    var box = $s("smUrls"); if (!box || !overlayPort) return;
    var base = "http://localhost:" + overlayPort;
    box.innerHTML = [["Avatar + captions (one source)", base + "/overlay"], ["Avatar only", base + "/overlay/avatar"], ["Captions only", base + "/overlay/captions"]].map(function (r) {
      return '<p><strong>' + r[0] + '</strong><br><code>' + escH(r[1]) + '</code> <button type="button" class="btn sm-copy" data-u="' + escH(r[1]) + '">Copy</button></p>';
    }).join("");
    box.querySelectorAll(".sm-copy").forEach(function (b) { b.onclick = function () { navigator.clipboard.writeText(b.dataset.u).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); }); }; });
  }
  async function paintSlots() {
    var box = $s("smSlots"); if (!box) return;
    var have = []; try { have = await D.avatarList(); } catch (_) {}
    box.innerHTML = SLOTS.map(function (s) {
      return '<div class="sm-slot"><div>' + s[1] + (have.indexOf(s[0]) >= 0 ? " ✓" : "") + '</div><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-slot="' + s[0] + '">' + (have.indexOf(s[0]) >= 0 ? '<button type="button" class="btn" data-clear="' + s[0] + '">Remove</button>' : "") + "</div>";
    }).join("");
    box.querySelectorAll("input[type=file]").forEach(function (inp) {
      inp.onchange = function () {
        var f = inp.files && inp.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = async function () { var r = await D.avatarSet(inp.dataset.slot, rd.result); if (!r || !r.ok) log("error", "Picture not saved: " + (r && r.error || "")); paintSlots(); };
        rd.readAsDataURL(f);
      };
    });
    box.querySelectorAll("[data-clear]").forEach(function (b) { b.onclick = async function () { await D.avatarClear(b.dataset.clear); paintSlots(); }; });
  }
  function paintButtons() {
    if ($s("smMute")) $s("smMute").textContent = engine.state.muted ? "Unmute Kin" : "Mute Kin";
    if ($s("smPause")) $s("smPause").textContent = engine.state.paused ? "Resume auto-chat" : "Pause auto-chat";
  }
  function paintStats() {
    var el = $s("smStats"); if (!el) return;
    var st = engine.stats;
    el.textContent = "Chat seen " + st.received + " · sent to Kin " + st.sent + " · filtered " + st.filtered + " · skipped " + st.dropped + " · waiting " + engine.queued() + " · errors " + st.errors;
  }
  function bindUi() {
    MAP.forEach(function (m) { var el = $s(m[0]); if (el) el.addEventListener("change", readForm); });
    $s("smStart").onclick = function () { readForm(); start(); };
    $s("smStop").onclick = stop;
    $s("smTest").onclick = function () { readForm(); testPipeline(); };
    $s("smMute").onclick = function () { engine.mute(); paintButtons(); };
    $s("smSkip").onclick = function () { engine.skip(); };
    $s("smPause").onclick = function () { engine.pause(); paintButtons(); };
    $s("smSayBtn").onclick = function () { if (engine.say($s("smSay").value)) { $s("smSay").value = ""; log("info", "Line queued for the Kin."); if (!running) engine.tick(); } };
    $s("smSay").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $s("smSayBtn").click(); } });
    $s("smSave").onclick = function () { readForm(); log("info", "Stream settings saved."); };
    $s("smObsPw").addEventListener("change", async function () {
      var v = $s("smObsPw").value; $s("smObsPw").value = "";
      if (!v) return;
      await D.secretSet("obs_password", v);
      $s("smObsPw").placeholder = "saved (type a new one to replace it)";
      log("info", "OBS password saved (encrypted on this PC).");
    });
    $s("smObsForget").onclick = async function () { await D.secretClear("obs_"); $s("smObsPw").value = ""; $s("smObsPw").placeholder = "leave empty if authentication is off"; log("info", "OBS password forgotten."); };
    $s("smObsTest").onclick = function () { readForm(); obs.tries = 0; obsConnect(!running || !S.obs_enabled); };
    D.secretGet("obs_password").then(function (t) { if (t && $s("smObsPw")) $s("smObsPw").placeholder = "saved (type a new one to replace it)"; });
    $s("smTwConnect").onclick = function () { readForm(); twitchConnect().catch(function (e) { setPill("smTwState", "", "Twitch sign-in failed: " + K.redactStream(e && e.message)); }); };
    $s("smTwForget").onclick = async function () { twitchStop(); await D.secretClear("twitch_"); tw.token = tw.refresh = ""; setPill("smTwState", "", "Signed out"); };
    $s("smJyConnect").onclick = function () { readForm(); joyConnect().catch(function (e) { setPill("smJyState", "", "Joystick sign-in failed: " + K.redactStream(e && e.message)); }); };
    $s("smJyForget").onclick = async function () {
      joyStop();
      if (jy.refresh && S.joystick_client_id) { try { await http({ url: "https://api.joystick.tv/api/oauth/revoke", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: jy.refresh, client_id: S.joystick_client_id }) }); } catch (_) {} }
      await D.secretClear("joystick_"); jy.token = jy.refresh = ""; setPill("smJyState", "", "Signed out");
    };
    paintForm();
    D.secretGet("twitch_access").then(function (t) { if (t) setPill("smTwState", "", "Signed in (checks on Start)"); });
    D.secretGet("joystick_refresh").then(function (t) { if (t) setPill("smJyState", "", "Connected (checks on Start)"); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUi); else buildUi();
  window.KinStreamMode = { engine: engine, start: start, stop: stop, test: testPipeline };
})();
