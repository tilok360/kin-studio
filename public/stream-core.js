/* Kin Studio 1.17/1.18 Stream mode — core logic (no DOM, no network).
   Twitch IRC + Joystick.tv gateway parsing, filters, cooldowns, SFW gating,
   co-host batching/pacing, and the CohostEngine that ties them together.
   Network, TTS and the overlay are injected so this file is fully testable.
   Never logs or returns tokens or the kn_ key. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KinStream = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.18.0";
  var TWITCH_CHAT_MAX = 500;
  var JOYSTICK_CHAT_MAX = 500;
  var KIN_MESSAGE_MAX = 1800;
  // Kin Studio's registered Twitch app (Public client). A Client ID is public, not a secret.
  var DEFAULT_TWITCH_CLIENT_ID = "zqz75ysyudsfui05fioi6nxtocfxtb";

  var DEFAULTS = {
    enabled: false,
    mode: "cohost", // "cohost" (reads chat on its own) | "command" (only !kin)
    kin_id: "", // Kin Studio character id
    command: "!kin",
    // co-host
    read_chat: true,
    batch_max_lines: 8,
    chat_gap_sec: 12, // min seconds between chat replies
    max_per_30s: 5, // stream mode never takes more than this many of Kindroid's 10/30s
    greet_first_timers: true,
    thank_follows: true,
    thank_subs: true,
    thank_bits: true,
    thank_tips: true,
    thank_raids: true,
    events_gap_sec: 20,
    idle_banter: true,
    idle_sec: 120,
    game_context: "",
    reply_words: 45,
    // access
    mod_only: false,
    allowlist_only: false,
    allow_users: "",
    block_users: "",
    user_cooldown_sec: 20,
    max_queue: 10,
    block_words: "",
    // output
    speak: true,
    post_to_chat: false,
    duck_on_mic: false,
    mic_device: "",
    mic_threshold: 0.06,
    // overlay
    overlay_font: "Segoe UI",
    overlay_size: 34,
    overlay_position: "bottom", // bottom | top | middle
    overlay_color: "#ffffff",
    overlay_bg: "rgba(0,0,0,0.55)",
    caption_hold_sec: 6,
    avatar_side: "left", // left | right
    // hotkeys (Electron accelerators)
    hotkey_mute: "Ctrl+Alt+M",
    hotkey_skip: "Ctrl+Alt+S",
    hotkey_pause: "Ctrl+Alt+P",
    // platforms
    twitch_enabled: true,
    twitch_channel: "",
    twitch_client_id: "", // public Client ID from dev.twitch.tv (not a secret)
    joystick_enabled: false,
    joystick_client_id: "", // public Client ID of Chris's Joystick bot (not a secret)
    // 1.18 stream awareness (no extra Kindroid calls: it rides along with replies)
    twitch_info: true, // read the stream title, game and live/offline from Twitch
    info_poll_min: 3, // how often to re-read them (minutes)
    obs_enabled: false, // read the current OBS scene (obs-websocket, OBS 28+)
    obs_url: "ws://localhost:4455",
    scene_react: false, // one short line on BRB / Starting soon / Ending / back
    scene_gap_sec: 120
  };

  function clampNum(v, lo, hi, d) {
    var n = Number(v);
    if (!isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, n));
  }
  function sanitizeSettings(s) {
    s = s || {};
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var d = DEFAULTS[k], v = s[k];
      if (v === undefined || v === null) { o[k] = d; return; }
      if (typeof d === "boolean") o[k] = v === true || v === "true" || v === 1;
      else if (typeof d === "number") o[k] = Number(v);
      else o[k] = String(v);
    });
    o.mode = o.mode === "command" ? "command" : "cohost";
    o.batch_max_lines = clampNum(o.batch_max_lines, 1, 20, 8);
    o.chat_gap_sec = clampNum(o.chat_gap_sec, 4, 600, 12);
    o.max_per_30s = clampNum(o.max_per_30s, 1, 8, 5); // always leave Kindroid slots for the rest of the app
    o.events_gap_sec = clampNum(o.events_gap_sec, 5, 600, 20);
    o.idle_sec = clampNum(o.idle_sec, 30, 3600, 120);
    o.reply_words = clampNum(o.reply_words, 10, 150, 45);
    o.user_cooldown_sec = clampNum(o.user_cooldown_sec, 0, 3600, 20);
    o.max_queue = clampNum(o.max_queue, 1, 50, 10);
    o.mic_threshold = clampNum(o.mic_threshold, 0.005, 0.5, 0.06);
    o.overlay_size = clampNum(o.overlay_size, 12, 120, 34);
    o.caption_hold_sec = clampNum(o.caption_hold_sec, 1, 60, 6);
    if (["bottom", "top", "middle"].indexOf(o.overlay_position) < 0) o.overlay_position = "bottom";
    if (["left", "right"].indexOf(o.avatar_side) < 0) o.avatar_side = "left";
    o.command = (o.command || "!kin").trim().split(/\s+/)[0] || "!kin";
    o.twitch_channel = String(o.twitch_channel || "").trim().replace(/^#/, "").replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/.*$/, "").toLowerCase();
    o.twitch_client_id = String(o.twitch_client_id || "").trim().replace(/[^A-Za-z0-9]/g, "") || DEFAULT_TWITCH_CLIENT_ID;
    o.joystick_client_id = String(o.joystick_client_id || "").trim().replace(/[^A-Za-z0-9-]/g, "");
    // Joystick.tv is not in 1.17 (coming later). It stays off unless a Joystick Client ID was entered.
    if (!o.joystick_client_id) o.joystick_enabled = false;
    o.game_context = String(o.game_context || "").slice(0, 400);
    o.info_poll_min = clampNum(o.info_poll_min, 2, 10, 3);
    o.scene_gap_sec = clampNum(o.scene_gap_sec, 30, 3600, 120);
    o.obs_url = cleanObsUrl(o.obs_url);
    return o;
  }

  /* OBS websocket address: ws:// or wss:// plus a host and optional port, nothing else. */
  function cleanObsUrl(u) {
    u = String(u || "").trim();
    if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(u)) u = "ws://" + u;
    var m = /^(wss?):\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(:\d{1,5})?\/?$/.exec(u);
    if (!m) return "ws://localhost:4455";
    return m[1] + "://" + m[2] + (m[3] || (m[1] === "ws" ? ":4455" : ""));
  }

  /* ---------- stream awareness (1.18) ---------- */
  function cleanInfo(v, max) {
    v = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\[\]{}<>]/g, "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
    if (v.length > max) v = v.slice(0, max - 1).trim() + "…";
    return v;
  }
  /* What a scene name means. "" = a normal scene (gameplay, chatting, …). */
  function sceneKind(name) {
    var n = " " + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    if (/ (brb|be right back|right back|break|away|afk|intermission|pause) /.test(n)) return "brb";
    if (/ (starting|start soon|starting soon|pre ?show|countdown|intro) /.test(n)) return "starting";
    if (/ (ending|end|outro|goodbye|bye|thanks for watching|offline|stream over) /.test(n)) return "ending";
    return "";
  }
  /* Helix GET /channels and GET /streams -> plain info. */
  function parseHelixChannel(j) {
    var d = j && j.data && j.data[0];
    if (!d) return null;
    return { title: String(d.title || ""), game: String(d.game_name || "") };
  }
  function parseHelixStream(j) {
    if (!j || !Array.isArray(j.data)) return null;
    var d = j.data[0];
    return d && d.type === "live" ? { live: true, viewers: Number(d.viewer_count) || 0 } : { live: false, viewers: 0 };
  }
  /* obs-websocket v5 auth: secret = b64(sha256(password + salt)); auth = b64(sha256(secret + challenge)).
     sha256b64(text) -> Promise<base64 string> is injected (WebCrypto in the app, node:crypto in tests). */
  function obsAuth(password, salt, challenge, sha256b64) {
    return Promise.resolve(sha256b64(String(password) + String(salt))).then(function (secret) { return sha256b64(secret + String(challenge)); });
  }
  var OBS_EVENTS_SCENES = 1 << 2;
  /* Hello (op 0) -> Identify (op 1) frame text. Rejects if OBS wants a password and none is saved. */
  function obsIdentify(hello, password, sha256b64) {
    var d = (hello && hello.d) || {};
    var out = { op: 1, d: { rpcVersion: 1, eventSubscriptions: OBS_EVENTS_SCENES } };
    if (!d.authentication) return Promise.resolve(JSON.stringify(out));
    if (!password) { var e = new Error("OBS asks for a password. Copy it from OBS (Tools → WebSocket Server Settings → Show Connect Info) into Kin Studio."); e.kind = "obs_password"; return Promise.reject(e); }
    return obsAuth(password, d.authentication.salt, d.authentication.challenge, sha256b64).then(function (a) { out.d.authentication = a; return JSON.stringify(out); });
  }
  function obsRequestFrame(type, id) { return JSON.stringify({ op: 6, d: { requestType: type, requestId: String(id || type) } }); }
  /* Scene name from an OBS frame, or null. op 5 = event, op 7 = request response. */
  function obsSceneFromFrame(f) {
    if (!f || typeof f !== "object" || !f.d) return null;
    if (f.op === 5 && f.d.eventType === "CurrentProgramSceneChanged") return String((f.d.eventData && (f.d.eventData.sceneName || f.d.eventData.sceneUuid)) || "");
    if (f.op === 7 && f.d.requestType === "GetCurrentProgramScene" && f.d.requestStatus && f.d.requestStatus.result) {
      var r = f.d.responseData || {};
      return String(r.currentProgramSceneName || r.sceneName || "");
    }
    return null;
  }
  /* One short line with what's on stream. Each piece is checked with the reply filter; blocked pieces are left out. */
  function streamContextLine(info, opts) {
    info = info || {}; opts = opts || {};
    var ok = function (t) { return !opts.filter || opts.filter.check(t).ok; };
    var parts = [];
    if (opts.twitch !== false) {
      var game = cleanInfo(info.game, 80), title = cleanInfo(info.title, 140);
      if (game && ok(game)) parts.push("playing " + game);
      if (title && ok(title)) parts.push('title "' + title + '"');
      if (info.live === true) parts.push("live now");
      else if (info.live === false) parts.push("offline");
    }
    if (opts.obs !== false) {
      var scene = cleanInfo(info.scene, 60);
      if (scene && ok(scene)) parts.push("scene: " + scene);
    }
    return parts.length ? "[Stream: " + parts.join(", ") + "]" : "";
  }

  /* ---------- secrets ---------- */
  function redactStream(s) {
    s = String(s == null ? "" : s);
    s = s.replace(/kn_[A-Za-z0-9_-]{4,}/g, "kn_[redacted]");
    s = s.replace(/oauth:[A-Za-z0-9]+/gi, "oauth:[redacted]");
    s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    s = s.replace(/((?:^|[?&\s])(?:token|access_token|refresh_token|code|code_verifier|device_code)=)[^&\s#]+/gi, "$1[redacted]");
    s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt redacted]");
    s = s.replace(/("?(?:access_token|refresh_token|client_secret)"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[redacted]");
    return s;
  }

  /* ---------- Twitch IRC ---------- */
  function unescapeTag(v) {
    return String(v || "").replace(/\\(.)/g, function (_, c) {
      return c === "s" ? " " : c === ":" ? ";" : c === "\\" ? "\\" : c === "r" ? "\r" : c === "n" ? "\n" : c;
    });
  }
  function parseIrcLine(line) {
    line = String(line || "").replace(/\r?\n$/, "");
    if (!line) return null;
    var msg = { raw: line, tags: {}, prefix: "", nick: "", command: "", params: [], trailing: "" };
    var i = 0;
    if (line[0] === "@") {
      var sp = line.indexOf(" ");
      line.slice(1, sp).split(";").forEach(function (kv) {
        var eq = kv.indexOf("=");
        if (eq < 0) msg.tags[kv] = "";
        else msg.tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
      });
      i = sp + 1;
    }
    if (line[i] === ":") {
      var sp2 = line.indexOf(" ", i);
      msg.prefix = line.slice(i + 1, sp2);
      msg.nick = msg.prefix.split("!")[0];
      i = sp2 + 1;
    }
    var rest = line.slice(i);
    var t = rest.indexOf(" :");
    var head = t >= 0 ? rest.slice(0, t) : rest;
    if (t >= 0) msg.trailing = rest.slice(t + 2);
    var parts = head.split(" ").filter(Boolean);
    msg.command = parts.shift() || "";
    msg.params = parts;
    return msg;
  }
  function badgeSet(s) {
    var o = {};
    String(s || "").split(",").forEach(function (b) { if (b) o[b.split("/")[0]] = true; });
    return o;
  }
  /* Normalised event: { platform, kind, user, name, text, mod, broadcaster, subscriber, first, amount, id } */
  function twitchEventFromIrc(m) {
    if (!m) return null;
    var tags = m.tags || {};
    var badges = badgeSet(tags.badges);
    var user = (tags.login || m.nick || "").toLowerCase();
    var name = tags["display-name"] || user;
    var base = {
      platform: "twitch",
      user: user,
      name: name,
      mod: tags.mod === "1" || !!badges.moderator || !!badges.broadcaster,
      broadcaster: !!badges.broadcaster,
      subscriber: tags.subscriber === "1" || !!badges.subscriber,
      first: tags["first-msg"] === "1",
      id: tags.id || ""
    };
    if (m.command === "PRIVMSG") {
      var text = m.trailing;
      var me = /^\u0001ACTION (.*)\u0001$/.exec(text);
      if (me) text = me[1];
      var bits = parseInt(tags.bits || "0", 10) || 0;
      if (bits > 0) {
        return Object.assign(base, { kind: "bits", amount: bits, text: text.replace(/\b[A-Za-z]+\d+\b/g, "").trim() });
      }
      return Object.assign(base, { kind: "chat", text: text });
    }
    if (m.command === "USERNOTICE") {
      var id = tags["msg-id"] || "";
      if (id === "sub" || id === "resub") return Object.assign(base, { kind: "sub", amount: parseInt(tags["msg-param-cumulative-months"] || "1", 10) || 1, text: m.trailing || "" });
      if (id === "subgift" || id === "submysterygift" || id === "anonsubgift") {
        return Object.assign(base, { kind: "gift", amount: parseInt(tags["msg-param-mass-gift-count"] || "1", 10) || 1, text: "", name: tags["msg-param-origin-id"] && id === "anonsubgift" ? "An anonymous viewer" : name });
      }
      if (id === "raid") return Object.assign(base, { kind: "raid", amount: parseInt(tags["msg-param-viewerCount"] || "0", 10) || 0, name: tags["msg-param-displayName"] || name, text: "" });
      return null;
    }
    return null;
  }
  /* EventSub websocket notification -> event (only channel.follow is used). */
  function twitchEventFromEventSub(frame) {
    try {
      if (!frame || !frame.metadata || frame.metadata.message_type !== "notification") return null;
      var sub = frame.payload && frame.payload.subscription;
      var ev = frame.payload && frame.payload.event;
      if (!sub || !ev) return null;
      if (sub.type === "channel.follow") {
        return { platform: "twitch", kind: "follow", user: String(ev.user_login || "").toLowerCase(), name: ev.user_name || ev.user_login || "someone", text: "", mod: false, broadcaster: false, subscriber: false, first: false, id: frame.metadata.message_id || "" };
      }
    } catch (_) {}
    return null;
  }

  /* ---------- Joystick.tv gateway (ActionCable, v2 envelope; v1 tolerated) ---------- */
  function joystickEventFromFrame(frame) {
    if (!frame || typeof frame !== "object") return null;
    if (frame.type === "ping" || frame.type === "welcome" || frame.type === "confirm_subscription") return null;
    var m = frame.message;
    if (!m || typeof m !== "object") return null;
    var type = String(m.type || "");
    var data = m.data;
    if (m.v !== 2 && m.metadata) { try { data = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata; } catch (_) { data = {}; } }
    data = data || {};
    var channel = m.channel_id || m.channelId || "";
    if (type === "new_message" || m.event === "ChatMessage") {
      var a = (data.author || m.author || {});
      var b = a.badges || {};
      var u = String(a.username || "").toLowerCase();
      return { platform: "joystick", kind: "chat", user: u, name: a.nickname || a.username || "someone", text: String(data.text != null ? data.text : m.text || ""), mod: !!(b.mod || b.streamer), broadcaster: !!b.streamer, subscriber: !!b.subscriber, bot: !!b.bot, first: !!b.new, id: m.id || "", channel_id: channel, visibility: data.visibility || "public" };
    }
    var t = type.toLowerCase();
    var who = String(data.who || data.username || "");
    var base = { platform: "joystick", user: who.toLowerCase(), name: who || "someone", text: "", mod: false, broadcaster: false, subscriber: false, first: false, id: m.id || "", channel_id: channel };
    if (t === "tipped") return Object.assign(base, { kind: "tip", amount: parseInt(data.how_much, 10) || 0, text: String(data.tip_menu_item || "") });
    if (t === "followed") return Object.assign(base, { kind: "follow" });
    if (t === "subscribed" || t === "resubscribed") return Object.assign(base, { kind: "sub", amount: 1 });
    if (t === "gifted_subscriptions") return Object.assign(base, { kind: "gift", amount: parseInt(data.number_of_subscriptions || data.amount || "1", 10) || 1 });
    return null;
  }
  function joystickSubscribeFrame() {
    return JSON.stringify({ command: "subscribe", identifier: JSON.stringify({ channel: "GatewayChannel", event_version: "v2" }) });
  }
  function joystickSendFrame(channelId, text) {
    return JSON.stringify({ command: "message", identifier: JSON.stringify({ channel: "GatewayChannel" }), data: JSON.stringify({ action: "send_message", text: String(text), channel_id: String(channelId) }) });
  }

  /* ---------- commands ---------- */
  function parseCommand(text, cmd) {
    cmd = String(cmd || "!kin").toLowerCase();
    var t = String(text || "").trim();
    if (t.toLowerCase() === cmd) return "";
    if (t.toLowerCase().indexOf(cmd + " ") === 0) return t.slice(cmd.length + 1).trim();
    return null;
  }

  /* ---------- word filter ---------- */
  // Short built-in list: slurs and the strongest sexual terms. Streamers add their own in settings.
  var BASE_BLOCK = [
    "nigger", "nigga", "faggot", "fag", "retard", "tranny", "chink", "spic", "kike", "wetback", "coon",
    "rape", "rapist", "pedo", "pedophile", "cp", "loli", "shota", "kys", "kill yourself"
  ];
  var SFW_BLOCK = [
    "fuck", "fucking", "shit", "cunt", "cock", "dick", "pussy", "porn", "nude", "nudes", "naked", "sex", "sexy",
    "horny", "boobs", "tits", "cum", "blowjob", "anal", "orgasm", "masturbate", "onlyfans", "strip", "nsfw", "bitch", "whore", "slut"
  ];
  function normalizeForFilter(s) {
    return String(s || "").toLowerCase()
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[@4]/g, "a").replace(/3/g, "e").replace(/[1!|]/g, "i").replace(/0/g, "o").replace(/[5$]/g, "s").replace(/7/g, "t")
      .replace(/(.)\1{2,}/g, "$1$1");
  }
  function splitList(s) {
    return String(s || "").split(/[\n,]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  }
  function makeFilter(opts) {
    opts = opts || {};
    var words = BASE_BLOCK.concat(opts.sfw ? SFW_BLOCK : [], splitList(opts.extra));
    var res = words.map(function (w) {
      var n = normalizeForFilter(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return new RegExp("(^|[^a-z])" + n + "(?=$|[^a-z])", "i");
    });
    // Hidden-inside-a-word check only for the built-in slur list (avoids "striped", "cocktail").
    var squashed = BASE_BLOCK.filter(function (w) { return w.length >= 5 && !/\s/.test(w); }).map(normalizeForFilter);
    return {
      check: function (text) {
        var n = normalizeForFilter(text);
        // "f u c k" / "f.u.c.k" -> "fuck"
        var joined = n.replace(/\b([a-z])(?:[\s.\-_*]+([a-z])\b)+/g, function (m) { return m.replace(/[^a-z]/g, ""); });
        for (var i = 0; i < res.length; i++) if (res[i].test(n) || res[i].test(joined)) return { ok: false, hit: words[i] };
        var sq = n.replace(/[^a-z]/g, "");
        for (var j = 0; j < squashed.length; j++) if (sq.indexOf(squashed[j]) >= 0) return { ok: false, hit: squashed[j] };
        return { ok: true, hit: "" };
      },
      // Usernames get a stricter check: any listed word hidden inside the name ("fuckboy99").
      checkName: function (name) {
        var r = this.check(name);
        if (!r.ok) return r;
        var sq = normalizeForFilter(name).replace(/[^a-z]/g, "");
        for (var i = 0; i < words.length; i++) {
          var w = normalizeForFilter(words[i]).replace(/[^a-z]/g, "");
          if (w.length >= 4 && sq.indexOf(w) >= 0) return { ok: false, hit: words[i] };
        }
        return { ok: true, hit: "" };
      }
    };
  }

  /* ---------- content gating ---------- */
  /* Twitch: always SFW. Joystick: adult content only when the app's existing Adults-only (18+) switch is on. */
  function isSfw(platform, adultsOn) {
    if (platform === "joystick") return !adultsOn;
    return true;
  }
  function gatingInstruction(platform, adultsOn) {
    if (isSfw(platform, adultsOn)) {
      return "Stream rules: this is a public live stream. Keep it safe for work: no sexual content, no nudity, no slurs, no graphic violence or gore, no self-harm talk. If chat asks for that, joke it off and change the subject.";
    }
    return "Stream rules: this is an 18+ Joystick.tv stream and every viewer is a verified adult. Adult humor and flirting are fine. Never sexual content involving minors, never non-consent, no slurs, no real-world threats.";
  }
  function isBadReply(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return "empty";
    if (t.charAt(0) === "<") return "generation"; // "< >" or an HTML error page sent with HTTP 200
    return "";
  }

  /* ---------- emotion tags ---------- */
  var EMOTIONS = ["neutral", "happy", "laugh", "surprised", "sad", "angry", "thinking"];
  var EMOTION_WORDS = {
    laugh: /\b(haha+|lol|lmao|hehe+|laugh(s|ing)?|giggl\w*)\b/i,
    surprised: /\b(whoa|wow|what\?!|no way|omg|holy|gasp\w*)\b/i,
    happy: /\b(yay|love|awesome|great|thank(s| you)|welcome|glad|smil\w*|grin\w*)\b|[!]{2,}/i,
    sad: /\b(sad|sorry|miss(ed)?|sigh|aww+|unfortunately)\b/i,
    angry: /\b(ugh|annoy\w*|angry|furious|grr+|how dare)\b/i,
    thinking: /\b(hmm+|let me think|i wonder|maybe)\b/i
  };
  function extractEmotion(text) {
    var t = String(text || "");
    var m = /^\s*\[(neutral|happy|laugh|laughing|surprised|sad|angry|thinking)\]\s*/i.exec(t);
    var emo = "";
    if (m) { emo = m[1].toLowerCase(); if (emo === "laughing") emo = "laugh"; t = t.slice(m[0].length); }
    t = t.replace(/\s*\[(neutral|happy|laugh|laughing|surprised|sad|angry|thinking)\]\s*/gi, " ").trim();
    if (!emo) {
      for (var k in EMOTION_WORDS) if (EMOTION_WORDS[k].test(t)) { emo = k; break; }
    }
    return { emotion: emo || "neutral", text: t };
  }

  /* ---------- chat output ---------- */
  function forChat(text, platform) {
    var max = platform === "joystick" ? JOYSTICK_CHAT_MAX : TWITCH_CHAT_MAX;
    var t = String(text || "").replace(/\*[^*]{0,200}\*/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^[\/.]+/, ""); // never let a reply run a chat command
    if (t.length > max) {
      var cut = t.slice(0, max - 1);
      var sp = cut.lastIndexOf(" ");
      t = (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
    }
    return t;
  }

  /* ---------- per-user cooldown + access ---------- */
  function Cooldowns(now) { this.now = now || Date.now; this.last = {}; }
  Cooldowns.prototype.ready = function (key, sec) {
    if (!sec) return true;
    var t = this.last[key];
    return !t || this.now() - t >= sec * 1000;
  };
  Cooldowns.prototype.hit = function (key) { this.last[key] = this.now(); };

  function accessCheck(ev, s) {
    var allow = splitList(s.allow_users), block = splitList(s.block_users);
    var u = String(ev.user || "").toLowerCase();
    if (block.indexOf(u) >= 0) return "blocked_user";
    if (ev.bot) return "bot";
    if (ev.broadcaster) return "";
    if (ev.mod || allow.indexOf(u) >= 0) return "";
    if (s.mod_only) return "mod_only";
    if (s.allowlist_only && allow.length) return "not_allowed";
    return "";
  }

  /* ---------- co-host prompt ---------- */
  function safeName(ev, filter) {
    var n = String(ev.name || ev.user || "someone").replace(/[\r\n\t]/g, " ").slice(0, 40);
    if (filter && !(filter.checkName ? filter.checkName(n) : filter.check(n)).ok) return "a viewer";
    return n;
  }
  function eventLine(e) {
    if (e.kind === "follow") return e.name + " just followed";
    if (e.kind === "sub") return e.name + " subscribed" + (e.amount > 1 ? " (" + e.amount + " months)" : "");
    if (e.kind === "gift") return e.name + " gifted " + (e.amount || 1) + " sub" + ((e.amount || 1) > 1 ? "s" : "");
    if (e.kind === "bits") return e.name + " cheered " + e.amount + " bits";
    if (e.kind === "tip") return e.name + " tipped " + e.amount + " tokens" + (e.text ? " (" + e.text + ")" : "");
    if (e.kind === "raid") return e.name + " raided with " + e.amount + " viewers";
    if (e.kind === "first") return e.name + " is chatting for the first time";
    return "";
  }
  function buildPrompt(job, ctx) {
    ctx = ctx || {};
    var words = ctx.reply_words || 45;
    var lines = [];
    var where = job.platform === "joystick" ? "Joystick.tv" : job.platform === "twitch" ? "Twitch" : "the stream";
    lines.push("(Live stream co-host mode on " + where + ". You are on camera next to me while I play. Talk to chat out loud.)");
    if (ctx.game_context) lines.push("What's happening: " + ctx.game_context);
    if (ctx.stream_line) lines.push(ctx.stream_line);
    if (job.type === "chat") {
      lines.push("New chat messages:");
      job.lines.forEach(function (l) { lines.push("- " + l.name + ": " + l.text); });
      if (job.skipped) lines.push("(" + job.skipped + " older messages scrolled past.)");
      lines.push("Pick the one or two most fun to answer and talk to them by name. You don't have to answer everyone.");
    } else if (job.type === "events") {
      lines.push("Stream alerts: " + job.events.map(eventLine).filter(Boolean).join("; ") + ".");
      lines.push("Thank or welcome them by name in one quick, warm line. Don't list amounts back robotically.");
    } else if (job.type === "idle") {
      lines.push("Chat has been quiet for a bit. Say something about what's happening, or ask chat a fun question.");
    } else if (job.type === "say") {
      lines.push("Say this to chat in your own words: " + job.text);
    } else if (job.type === "command") {
      lines.push(job.name + " asked you directly: " + job.text);
      lines.push("Answer " + job.name + " by name.");
    } else if (job.type === "scene") {
      lines.push({
        brb: "I just switched to my BRB screen. Tell chat in one short line that I'll be right back.",
        starting: "I'm on my Starting soon screen. Welcome chat in one short line and say we're starting soon.",
        ending: "I'm wrapping up the stream. Say a short, warm goodbye to chat.",
        back: "I'm back from my break. Welcome me back in one short line."
      }[job.kind] || "Say one short line to chat.");
    } else if (job.type === "test") {
      lines.push("Test message from " + job.name + ": " + job.text);
    }
    lines.push(gatingInstruction(job.platform, ctx.adultsOn));
    lines.push("Keep it under " + words + " words, spoken style, no emoji, no stage directions. Start with one mood tag: [happy], [laugh], [surprised], [sad], [angry], [thinking] or [neutral].");
    var out = lines.join("\n");
    if (out.length > KIN_MESSAGE_MAX) out = out.slice(0, KIN_MESSAGE_MAX - 1) + "…";
    return out;
  }

  /* ---------- pacing ---------- */
  /* Stream mode keeps its own count so it never uses more than max_per_30s of the shared 10/30s,
     and it also checks the shared limiter so it never blocks Chat or Games. */
  function Pacer(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.windowMs = 30000;
    this.sent = [];
    this.pausedUntil = 0;
  }
  Pacer.prototype.used = function () {
    var now = this.now(), w = this.windowMs;
    this.sent = this.sent.filter(function (t) { return now - t < w; });
    return this.sent.length;
  };
  Pacer.prototype.canSend = function (maxPer30, limiter) {
    if (this.now() < this.pausedUntil) return false;
    if (this.used() >= maxPer30) return false;
    if (limiter && typeof limiter.waitMs === "function" && limiter.waitMs() > 0) return false;
    if (limiter && !limiter.waitMs && limiter.sent && limiter.max != null && limiter.sent.length >= limiter.max) return false;
    return true;
  };
  Pacer.prototype.mark = function () { this.sent.push(this.now()); };
  Pacer.prototype.hold = function (ms) { this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms); };

  /* ---------- engine ---------- */
  /* deps: {
       send(prompt, job) -> Promise<string>   (goes through the shared Kindroid limiter)
       speak(text, emotion, job) -> Promise   (Kin's existing Kokoro voice)
       stopSpeaking()
       postChat(platform, text, job) -> Promise
       overlay(event)                          ({type:"caption"|"state"|"clear", ...})
       adultsOn() -> boolean                   (the app's existing 18+ switch, read only)
       micActive() -> boolean
       limiter                                 (KinClient.limiter)
       log(entry)
       now()
     } */
  function CohostEngine(deps, settings) {
    this.deps = deps || {};
    this.now = this.deps.now || Date.now;
    this.pacer = new Pacer({ now: this.now });
    this.cool = new Cooldowns(this.now);
    this.state = { paused: false, muted: false, inflight: false, speaking: false, stopped: false, stopReason: "" };
    this.chat = []; // pending chat lines (co-host)
    this.events = []; // pending alerts
    this.commands = []; // !kin and test jobs
    this.says = []; // streamer "say this"
    this.seen = {};
    this.lastChatAt = this.now();
    this.lastKinAt = this.now();
    this.lastChatReplyAt = 0;
    this.lastEventsAt = 0;
    this.info = { title: "", game: "", live: null, viewers: 0, scene: "" };
    this.sceneJob = null;
    this.lastSceneAt = 0;
    this.lastSceneKind = "";
    this.stats = { received: 0, filtered: 0, sent: 0, dropped: 0, errors: 0 };
    this.listeners = [];
    this.configure(settings);
  }
  CohostEngine.prototype.configure = function (settings) {
    this.s = sanitizeSettings(settings);
    this.filterCache = {};
  };
  CohostEngine.prototype.filterFor = function (platform) {
    var sfw = isSfw(platform, this.adultsOn());
    var key = sfw ? "sfw" : "adult";
    if (!this.filterCache[key]) this.filterCache[key] = makeFilter({ sfw: sfw, extra: this.s.block_words });
    return this.filterCache[key];
  };
  CohostEngine.prototype.adultsOn = function () {
    try { return !!(this.deps.adultsOn && this.deps.adultsOn()); } catch (_) { return false; }
  };
  CohostEngine.prototype.emit = function (type, data) {
    var e = Object.assign({ type: type, at: this.now() }, data || {});
    if (e.text) e.text = redactStream(e.text);
    try { if (this.deps.log) this.deps.log(e); } catch (_) {}
    this.listeners.forEach(function (fn) { try { fn(e); } catch (_) {} });
  };
  CohostEngine.prototype.on = function (fn) { this.listeners.push(fn); };
  CohostEngine.prototype.queued = function () { return this.commands.length + this.says.length + this.chat.length + (this.events.length ? 1 : 0) + (this.sceneJob ? 1 : 0); };

  /* 1.18 stream awareness. patch: { title, game, live, viewers }. Returns the names of the fields that changed. */
  CohostEngine.prototype.setStreamInfo = function (patch) {
    var self = this, changed = [];
    ["title", "game", "live", "viewers"].forEach(function (k) {
      if (patch && patch[k] !== undefined && patch[k] !== self.info[k]) { self.info[k] = patch[k]; changed.push(k); }
    });
    if (changed.length) this.emit("info", { changed: changed });
    return changed;
  };
  /* OBS scene changed. initial = the scene we found on connect (never reacted to).
     Returns the reaction queued ("brb" | "starting" | "ending" | "back") or "". */
  CohostEngine.prototype.setScene = function (name, initial) {
    name = String(name || "");
    if (name === this.info.scene && !initial) return "";
    this.info.scene = name;
    var kind = sceneKind(name), prev = this.lastSceneKind;
    this.lastSceneKind = kind;
    this.emit("info", { changed: ["scene"] });
    if (initial || !this.s.scene_react || !this.s.obs_enabled || this.s.mode !== "cohost") return "";
    var react = kind || ((prev === "brb" || prev === "starting") ? "back" : "");
    if (!react) return "";
    // Went to BRB and came straight back before the Kin said anything: say nothing.
    if (react === "back" && this.sceneJob) { this.sceneJob = null; return ""; }
    if (this.lastSceneAt && this.now() - this.lastSceneAt < this.s.scene_gap_sec * 1000) return "";
    this.sceneJob = { type: "scene", kind: react, platform: this.defaultPlatform || "stream" };
    return react;
  };
  CohostEngine.prototype.streamLine = function (platform) {
    return streamContextLine(this.info, { filter: this.filterFor(platform), twitch: !!this.s.twitch_info, obs: !!this.s.obs_enabled });
  };

  /* Returns a short reason string when the event is dropped, "" when accepted. */
  CohostEngine.prototype.ingest = function (ev) {
    if (!ev || !ev.kind) return "invalid";
    this.stats.received++;
    var s = this.s;
    var f = this.filterFor(ev.platform);
    var deny = accessCheck(ev, s);
    if (deny === "blocked_user" || deny === "bot") { this.stats.filtered++; return deny; }
    var name = safeName(ev, f);
    if (ev.kind === "chat") {
      this.lastChatAt = this.now();
      var text = String(ev.text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
      if (!text) return "empty";
      if (!f.check(text).ok) { this.stats.filtered++; this.emit("filtered", { where: "chat", platform: ev.platform }); return "filtered"; }
      var cmd = parseCommand(text, s.command);
      var key = ev.platform + ":" + ev.user;
      var isFirst = (ev.first || (ev.platform === "joystick" && ev.first)) && !this.seen[key];
      this.seen[key] = 1;
      if (isFirst && s.greet_first_timers && s.mode === "cohost") this.events.push({ kind: "first", name: name, platform: ev.platform });
      if (cmd !== null) {
        if (deny) return deny;
        if (!cmd) return "empty_command";
        if (!ev.mod && !this.cool.ready(key, s.user_cooldown_sec)) return "cooldown";
        if (this.commands.length >= s.max_queue) { this.stats.dropped++; return "queue_full"; }
        this.cool.hit(key);
        this.commands.push({ type: "command", platform: ev.platform, name: name, text: cmd.slice(0, 300), channel_id: ev.channel_id, test: !!ev.test });
        return "";
      }
      if (s.mode !== "cohost" || !s.read_chat) return "not_command";
      if (deny) return deny;
      if (/^[!\/]/.test(text)) return "other_command";
      this.chat.push({ name: name, text: text, platform: ev.platform, channel_id: ev.channel_id, user: ev.user, test: !!ev.test });
      // keep the newest lines; old ones scroll past like real chat
      var cap = Math.max(s.batch_max_lines * 3, s.max_queue);
      if (this.chat.length > cap) { var over = this.chat.length - cap; this.chat.splice(0, over); this.stats.dropped += over; this.droppedSince = (this.droppedSince || 0) + over; }
      return "";
    }
    if (s.mode !== "cohost") return "events_off";
    var want = { follow: s.thank_follows, sub: s.thank_subs, gift: s.thank_subs, bits: s.thank_bits, tip: s.thank_tips, raid: s.thank_raids }[ev.kind];
    if (!want) return "event_off";
    if (ev.text && !f.check(ev.text).ok) ev = Object.assign({}, ev, { text: "" });
    if (this.events.length >= 20) { this.stats.dropped++; return "queue_full"; }
    this.events.push({ kind: ev.kind, name: name, amount: ev.amount || 0, text: ev.text || "", platform: ev.platform, channel_id: ev.channel_id });
    return "";
  };

  /* Streamer feeds a line or topic. */
  CohostEngine.prototype.say = function (text, platform) {
    text = String(text || "").trim().slice(0, 400);
    if (!text) return false;
    this.says.push({ type: "say", platform: platform || this.defaultPlatform || "stream", text: text });
    return true;
  };
  CohostEngine.prototype.pause = function (on) { this.state.paused = on == null ? !this.state.paused : !!on; this.emit("state", { paused: this.state.paused }); return this.state.paused; };
  CohostEngine.prototype.mute = function (on) {
    this.state.muted = on == null ? !this.state.muted : !!on;
    if (this.state.muted) this.skip();
    this.emit("state", { muted: this.state.muted });
    return this.state.muted;
  };
  CohostEngine.prototype.skip = function () {
    try { if (this.deps.stopSpeaking) this.deps.stopSpeaking(); } catch (_) {}
    try { if (this.deps.overlay) this.deps.overlay({ type: "clear" }); } catch (_) {}
    this.emit("skip", {});
  };
  CohostEngine.prototype.stop = function (reason) { this.state.stopped = true; this.state.stopReason = reason || ""; this.emit("stopped", { text: reason || "" }); };
  CohostEngine.prototype.resume = function () { this.state.stopped = false; this.state.stopReason = ""; };

  /* Pick the next job, or null. Order: streamer lines, !kin / test, alerts, chat, idle banter. */
  CohostEngine.prototype.nextJob = function () {
    var s = this.s, now = this.now();
    if (this.says.length) return this.says.shift();
    if (this.commands.length) return this.commands.shift();
    if (s.mode !== "cohost") { this.sceneJob = null; return null; }
    if (this.sceneJob) { var sj = this.sceneJob; this.sceneJob = null; this.lastSceneAt = now; this.lastKinAt = now; return sj; }
    if (this.events.length && now - this.lastEventsAt >= s.events_gap_sec * 1000) {
      var evs = this.events.splice(0, 8);
      var extra = this.events.length;
      if (extra) { evs.push({ kind: "follow", name: "and " + extra + " more", platform: evs[0].platform }); this.events = []; }
      this.lastEventsAt = now;
      return { type: "events", platform: evs[0].platform, events: evs, channel_id: evs[0].channel_id };
    }
    if (this.chat.length && now - this.lastChatReplyAt >= s.chat_gap_sec * 1000) {
      var n = s.batch_max_lines;
      var take = this.chat.splice(Math.max(0, this.chat.length - n));
      var skipped = this.chat.length + (this.droppedSince || 0);
      this.chat = [];
      this.droppedSince = 0;
      this.lastChatReplyAt = now;
      return { type: "chat", platform: take[take.length - 1].platform, lines: take, skipped: skipped, channel_id: take[take.length - 1].channel_id, test: take.some(function (l) { return l.test; }) };
    }
    if (s.idle_banter && now - Math.max(this.lastChatAt, this.lastKinAt) >= s.idle_sec * 1000) {
      this.lastKinAt = now;
      return { type: "idle", platform: this.defaultPlatform || "stream" };
    }
    return null;
  };

  /* Call about twice a second. Resolves when any started job finishes (tests await it). */
  CohostEngine.prototype.tick = function () {
    var st = this.state;
    if (st.stopped || st.inflight || st.speaking) return Promise.resolve(null);
    if (st.paused && !this.says.length) return Promise.resolve(null);
    var duck = false;
    try { duck = !!(this.s.duck_on_mic && this.deps.micActive && this.deps.micActive()); } catch (_) {}
    if (duck) return Promise.resolve(null);
    if (!this.queued() && !(this.s.mode === "cohost" && this.s.idle_banter)) return Promise.resolve(null);
    if (!this.pacer.canSend(this.s.max_per_30s, this.deps.limiter)) return Promise.resolve(null);
    var job = this.nextJob();
    if (!job) return Promise.resolve(null);
    return this.run(job);
  };

  CohostEngine.prototype.run = function (job) {
    var self = this, st = this.state, deps = this.deps;
    var ctx = { game_context: this.s.game_context, stream_line: this.streamLine(job.platform), reply_words: job.type === "scene" ? Math.min(25, this.s.reply_words) : this.s.reply_words, adultsOn: this.adultsOn() };
    var prompt = buildPrompt(job, ctx);
    st.inflight = true;
    this.pacer.mark();
    this.stats.sent++;
    try { if (deps.overlay) deps.overlay({ type: "state", state: "thinking" }); } catch (_) {}
    this.emit("send", { job: job.type, platform: job.platform });
    return Promise.resolve()
      .then(function () { return deps.send(prompt, job); })
      .then(function (reply) {
        var bad = isBadReply(reply);
        if (bad) { var e = new Error(bad === "generation" ? "Kindroid couldn't write a reply this time." : "Kindroid sent an empty reply."); e.kind = bad; throw e; }
        var em = extractEmotion(reply);
        var f = self.filterFor(job.platform);
        var chk = f.check(em.text);
        if (!chk.ok) { self.stats.filtered++; self.emit("filtered", { where: "reply", platform: job.platform }); return { filtered: true }; }
        self.lastKinAt = self.now();
        st.inflight = false;
        self.emit("reply", { job: job.type, emotion: em.emotion, text: em.text });
        var done = [];
        if (self.s.post_to_chat && !job.test && deps.postChat && (job.platform === "twitch" || job.platform === "joystick")) {
          done.push(Promise.resolve().then(function () { return deps.postChat(job.platform, forChat(em.text, job.platform), job); }).catch(function (e2) { self.emit("error", { text: "Couldn't post to chat: " + (e2 && e2.message || e2) }); }));
        }
        try { if (deps.overlay) deps.overlay({ type: "caption", text: em.text, emotion: em.emotion, hold: self.s.caption_hold_sec }); } catch (_) {}
        if (self.s.speak && !st.muted && deps.speak) {
          st.speaking = true;
          done.push(Promise.resolve().then(function () { return deps.speak(em.text, em.emotion, job); }).catch(function () {}).then(function () { st.speaking = false; }));
        }
        return Promise.all(done).then(function () { return { text: em.text, emotion: em.emotion }; });
      })
      .catch(function (e) {
        self.stats.errors++;
        var k = e && e.kind, status = e && e.status;
        if (k === "rate_limit" || status === 429) { self.pacer.hold(30000); self.emit("error", { text: "Kindroid rate limit (10 per 30 seconds). Stream mode is waiting 30 seconds." }); }
        else if (k === "auth" || status === 401) { self.stop("Kindroid didn't accept the API key (401). Fix it in Settings, then press Start again."); }
        else if (k === "forbidden" || k === "subscription" || status === 403) { self.stop("Kindroid refused the request (403). The key may be wrong or the account needs an active subscription."); }
        else { self.pacer.hold(5000); self.emit("error", { text: (e && e.message) || "Something went wrong." }); }
        return { error: true, kind: k || "", status: status || 0 };
      })
      .then(function (r) {
        st.inflight = false;
        st.speaking = false;
        try { if (deps.overlay) deps.overlay({ type: "state", state: "idle" }); } catch (_) {}
        return r;
      });
  };

  /* ---------- lip-sync helper ---------- */
  function rmsLevel(samples) {
    var sum = 0, n = samples.length || 0;
    if (!n) return 0;
    for (var i = 0; i < n; i++) { var v = (samples[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / n);
  }
  /* Smooth a level into 0..1 mouth openness with attack/release. */
  function mouthFrom(level, prev, gain) {
    var target = Math.min(1, Math.max(0, level * (gain || 6)));
    var p = prev || 0;
    return target > p ? p + (target - p) * 0.6 : p + (target - p) * 0.25;
  }

  return {
    VERSION: VERSION,
    DEFAULT_TWITCH_CLIENT_ID: DEFAULT_TWITCH_CLIENT_ID,
    DEFAULTS: DEFAULTS,
    TWITCH_CHAT_MAX: TWITCH_CHAT_MAX,
    sanitizeSettings: sanitizeSettings,
    redactStream: redactStream,
    parseIrcLine: parseIrcLine,
    twitchEventFromIrc: twitchEventFromIrc,
    twitchEventFromEventSub: twitchEventFromEventSub,
    joystickEventFromFrame: joystickEventFromFrame,
    joystickSubscribeFrame: joystickSubscribeFrame,
    joystickSendFrame: joystickSendFrame,
    parseCommand: parseCommand,
    makeFilter: makeFilter,
    normalizeForFilter: normalizeForFilter,
    isSfw: isSfw,
    gatingInstruction: gatingInstruction,
    isBadReply: isBadReply,
    extractEmotion: extractEmotion,
    EMOTIONS: EMOTIONS,
    forChat: forChat,
    Cooldowns: Cooldowns,
    accessCheck: accessCheck,
    buildPrompt: buildPrompt,
    eventLine: eventLine,
    Pacer: Pacer,
    CohostEngine: CohostEngine,
    rmsLevel: rmsLevel,
    mouthFrom: mouthFrom,
    cleanObsUrl: cleanObsUrl,
    cleanInfo: cleanInfo,
    sceneKind: sceneKind,
    parseHelixChannel: parseHelixChannel,
    parseHelixStream: parseHelixStream,
    obsAuth: obsAuth,
    obsIdentify: obsIdentify,
    obsRequestFrame: obsRequestFrame,
    obsSceneFromFrame: obsSceneFromFrame,
    streamContextLine: streamContextLine
  };
});
