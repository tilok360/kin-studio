/* Kin Studio chat client — 1.18.0.
   Official Kindroid send-message helper: streaming with fallback, 75s timeout,
   rate-limit / auth / offline errors, a send queue, and secret redaction.
   1.16: one shared rate limiter for every Kindroid call (10 per 30 s, auto-wait
   with a countdown), retry/backoff helpers, a connection-status feed, AI ID
   clean-up and bulk-list parsing, live key test and Kin lookup for setup.
   1.18: "Talk as" persona switching and the Learned context editor. Both use
   update-info fields Kindroid has NOT documented (found by other API users);
   they may change or stop working, so every failure is reported plainly.
   Never logs or returns the kn_ API key. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KinClient = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var API = "https://api.kindroid.ai/v1";
  var TIMEOUT_MS = 75000;
  var RATE_MAX = 10;
  var RATE_WINDOW_MS = 30000;
  var HTTP_ERROR_MARK = "<<HTTP_ERROR>>";
  var KEY_RE = /kn_[A-Za-z0-9_-]{8,}/gi;

  function redact(s) {
    s = String(s == null ? "" : s);
    s = s.replace(KEY_RE, "kn_[redacted]");
    s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    s = s.replace(/Authorization\s*[:=]\s*[^\s&,;]+/gi, "Authorization: [redacted]");
    return s;
  }

  function KindroidError(kind, message, extra) {
    var e = new Error(redact(message));
    e.name = "KindroidError";
    e.kind = kind;
    e.retry = !!(extra && extra.retry);
    e.timeout = !!(extra && extra.timeout);
    e.status = extra && extra.status;
    e.cancelled = kind === "cancelled";
    return e;
  }

  function classifyKindroidError(err, extras) {
    extras = extras || {};
    var status = extras.status != null ? extras.status : err && err.status;
    var msg = redact((err && err.message) || err || "");
    var name = err && err.name;
    var offlineNav =
      typeof navigator !== "undefined" && navigator && navigator.onLine === false;

    if (extras.cancelled || (err && err.cancelled) || (err && err.kind === "cancelled")) {
      return KindroidError("cancelled", "Cancelled.", { retry: true });
    }
    if (
      extras.timeout ||
      (err && err.timeout) ||
      (err && err.kind === "timeout") ||
      (name === "AbortError" && extras.reason === "timeout") ||
      /did not answer within|took longer than 75/i.test(msg)
    ) {
      return KindroidError(
        "timeout",
        "Kindroid took longer than 75 seconds. Tap Send again, or Cancel.",
        { retry: true, timeout: true }
      );
    }
    if (status === 429 || /^429|\b429\b/.test(msg) || (err && err.kind === "rate_limit")) {
      return KindroidError(
        "rate_limit",
        "Kindroid is rate limiting (10 messages every 30 seconds). Wait a moment, then try again.",
        { retry: true, status: 429 }
      );
    }
    if (status === 401 || (err && err.kind === "auth") || /\b401\b/.test(msg)) {
      return KindroidError(
        "auth",
        "Kindroid rejected the API key (401). Paste a valid kn_ key in Settings. The key is never shown in errors.",
        { retry: false, status: 401 }
      );
    }
    if (status === 403 || (err && err.kind === "forbidden") || /\b403\b/.test(msg)) {
      if (/subscri|read[- ]?only|preview|trial|plan|upgrade|restrict/i.test(msg) && !/bad key|invalid key|wrong key/i.test(msg)) {
        return KindroidError(
          "subscription",
          "Kindroid says this account needs an active trial or subscription (403). The free preview may have ended, or group chats need a subscription. Your key is fine to keep.",
          { retry: false, status: 403 }
        );
      }
      return KindroidError(
        "forbidden",
        "Kindroid rejected the request (403). The API key may be wrong, or the account needs an active trial or subscription. Check the key in Settings. The key is never shown in errors.",
        { retry: false, status: 403 }
      );
    }
    if (status === 409 || /^409\b/.test(msg)) {
      return KindroidError(
        "conflict",
        "Kindroid can't do that right now (409). Messages from a chat break, a voice call, or media still generating can't be rewound.",
        { retry: false, status: 409 }
      );
    }
    if (status >= 500 || /^5\d\d\b/.test(msg)) {
      return KindroidError(
        "server",
        "Kindroid had a server problem (" + (status || "5xx") + "). Wait a few seconds, then try again.",
        { retry: true, status: status || 500 }
      );
    }
    if (status === 404 || /\b404\b/.test(msg) || /not found/i.test(msg) && /\b400\b|\b404\b/.test(msg)) {
      return KindroidError(
        "not_found",
        redact(msg) || "Kindroid does not recognize that Kin ID. Check the AI ID on the Characters tab.",
        { retry: false, status: status || 404 }
      );
    }
    if (
      extras.offline ||
      offlineNav ||
      (err && err.kind === "offline") ||
      /Failed to fetch|NetworkError|ERR_INTERNET|ENOTFOUND|ECONN|offline|CORS|Kindroid blocked|Load failed|network/i.test(msg) ||
      (name === "TypeError" && /fetch|network/i.test(msg))
    ) {
      return KindroidError(
        "offline",
        "No connection to Kindroid. Check your network, then try again. If this is the website in a browser, use the Android app — some browsers block the Kindroid API.",
        { retry: true }
      );
    }
    if ((err && err.kind === "generation") || /^<\s*>/.test(msg) || /could not generate/i.test(msg)) {
      return KindroidError(
        "generation",
        "Kindroid could not generate a reply this time. Wait a moment, then try again.",
        { retry: true }
      );
    }
    if (err && err.kind === "empty") {
      return KindroidError("empty", "Kindroid sent back an empty reply. Try again.", { retry: true });
    }
    return KindroidError("error", msg || "Something went wrong. Try again.", { retry: true, status: status });
  }

  function looksLikeGenerationFail(text) {
    return /^<\s*>/.test(String(text || "").trim());
  }

  function StreamAssembler() {
    this.buf = "";
    this.started = false;
  }
  StreamAssembler.prototype.push = function (chunk) {
    this.buf += String(chunk == null ? "" : chunk);
    var vis = this.buf;
    if (!this.started) {
      vis = vis.replace(/^[\s\u0000]+/, "");
      if (!vis) return { text: "", error: null, visible: false };
      this.started = true;
      this.buf = vis;
    }
    var idx = this.buf.indexOf(HTTP_ERROR_MARK);
    if (idx >= 0) {
      return {
        text: this.buf.slice(0, idx),
        error: this.buf.slice(idx + HTTP_ERROR_MARK.length).trim() || "Kindroid stream error",
        visible: true
      };
    }
    return { text: this.buf, error: null, visible: true };
  };

  function isResponseLike(res) {
    return res && (typeof res.text === "function" || typeof res.status === "number" || res.body);
  }

  async function readFullText(res) {
    if (!res) return "";
    if (typeof res.text === "function") return await res.text();
    if (res.data == null) return "";
    if (typeof res.data === "string") return res.data;
    try {
      return JSON.stringify(res.data);
    } catch (_) {
      return String(res.data);
    }
  }

  async function readStream(res, onChunk, signal) {
    var asm = new StreamAssembler();
    if (!res || !res.body || typeof res.body.getReader !== "function") {
      var full = await readFullText(res);
      var r = asm.push(full);
      if (r.error) throw classifyKindroidError(new Error(r.error), { status: 200 });
      if (onChunk && r.visible) onChunk("", r.text);
      return r.text;
    }
    var reader = res.body.getReader();
    var dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    try {
      for (;;) {
        if (signal && signal.aborted) {
          var reason = signal.reason || (signal._kinReason);
          var err = new Error("aborted");
          err.name = "AbortError";
          throw classifyKindroidError(err, {
            timeout: reason === "timeout",
            cancelled: reason === "cancel" || !reason || reason === "cancel"
          });
        }
        var step = await reader.read();
        if (step.done) break;
        var chunk = step.value;
        if (chunk && typeof chunk !== "string") {
          chunk = dec ? dec.decode(chunk, { stream: true }) : String.fromCharCode.apply(null, chunk);
        }
        var st = asm.push(chunk);
        if (st.visible && onChunk) onChunk(chunk, st.text);
        if (st.error) {
          throw classifyKindroidError(new Error(st.error), { status: 200 });
        }
      }
      if (dec && dec.decode) asm.push(dec.decode());
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {}
    }
    return asm.started ? asm.buf : asm.push("\n").text || asm.buf;
  }

  function httpFail(status, body) {
    var text = redact(String(body || "")).slice(0, 180);
    var e = new Error(status + (text ? ": " + text : ""));
    e.status = status;
    e.http = true;
    throw classifyKindroidError(e, { status: status });
  }


  async function sendMessage(opts) {
    opts = opts || {};
    var apiKey = opts.apiKey;
    if (!apiKey || !/^kn_[A-Za-z0-9_-]{8,}$/.test(String(apiKey))) {
      throw classifyKindroidError(new Error("Paste the kn_ key in Settings first."), { status: 401 });
    }
    if (!opts.ai_id) {
      throw KindroidError("error", "Pick a character with a Kindroid AI ID.", { retry: false });
    }
    var timeoutMs = opts.timeoutMs == null ? TIMEOUT_MS : Number(opts.timeoutMs);
    var fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw KindroidError("error", "No fetch available.", { retry: false });

    var wantStream = opts.stream !== false;
    var external = opts.signal;
    var ctrl = opts.controller || (typeof AbortController !== "undefined" ? new AbortController() : null);
    if (external && ctrl && typeof external.addEventListener === "function") {
      if (external.aborted) ctrl.abort();
      else external.addEventListener("abort", function () { try { ctrl.abort(); } catch (_) {} });
    }
    var signal = (ctrl && ctrl.signal) || external;
    var timedOut = false;
    var cancelled = false;
    var timer = null;
    var requestPosted = false;
    var url = (opts.apiBase || API) + "/send-message";
    var headers = {
      Authorization: "Bearer " + apiKey,
      Accept: "text/plain, application/json",
      "Content-Type": "application/json"
    };

    function classifyCaught(e) {
      if (e && e.name === "KindroidError") return e;
      if (cancelled || (e && e.cancelled) || (e && e.name === "AbortError" && !timedOut)) {
        return classifyKindroidError(e, { cancelled: true });
      }
      if (timedOut || (e && e.timeout) || (e && e.name === "AbortError")) {
        return classifyKindroidError(e, { timeout: true, reason: "timeout" });
      }
      return classifyKindroidError(e, { status: e && e.status });
    }

    if (opts.onCancelHook && ctrl) {
      opts.onCancelHook(function () {
        cancelled = true;
        if (signal) signal._kinReason = "cancel";
        try { ctrl.abort(); } catch (_) {}
      });
    }

    async function post(streamFlag) {
      var res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            ai_id: opts.ai_id,
            message: opts.message == null ? "" : String(opts.message),
            stream: !!streamFlag
          }),
          signal: signal
        });
      } catch (e) {
        throw classifyCaught(e);
      }
      if (!isResponseLike(res)) {
        throw KindroidError("error", "Unexpected Kindroid response.", { retry: true });
      }
      var status = res.status || 0;
      if (status && (status < 200 || status >= 300)) {
        var body = "";
        try { body = await readFullText(res); } catch (_) {}
        httpFail(status, body);
      }
      return res;
    }

    async function work() {
      if (wantStream) {
        var started = false;
        try {
          var res = await post(true);
          started = true;
          requestPosted = true;
          var hasReader = res.body && typeof res.body.getReader === "function";
          var text;
          if (hasReader) {
            text = await readStream(res, opts.onChunk, signal);
            return { text: text, streamed: true, fallback: false, posted: true };
          }
          text = await readFullText(res);
          var asm = new StreamAssembler();
          var st = asm.push(text);
          if (st.error) throw classifyKindroidError(new Error(st.error), { status: 200 });
          if (opts.onChunk && st.visible) opts.onChunk("", st.text);
          return { text: st.text, streamed: false, fallback: true, posted: true };
        } catch (e) {
          // Only fall back to a second request if the stream never started.
          // A second send-message after a 200 would post the user line twice.
          var classified = classifyCaught(e);
          var canFallback =
            !started &&
            classified.kind !== "cancelled" &&
            classified.kind !== "timeout" &&
            classified.kind !== "auth" &&
            classified.kind !== "forbidden" &&
            classified.kind !== "rate_limit" &&
            classified.kind !== "not_found" &&
            !classified.status;
          if (!canFallback) {
            classified.posted = requestPosted;
            throw classified;
          }
        }
      }
      var res2 = await post(false);
      requestPosted = true;
      var text2 = await readFullText(res2);
      var asm2 = new StreamAssembler();
      var st2 = asm2.push(text2);
      if (st2.error) throw classifyKindroidError(new Error(st2.error), { status: 200 });
      if (opts.onChunk && st2.visible) opts.onChunk("", st2.text);
      return { text: st2.text, streamed: false, fallback: wantStream, posted: true };
    }

    var timeoutPromise = null;
    if (timeoutMs > 0) {
      timeoutPromise = new Promise(function (_, rej) {
        timer = setTimeout(function () {
          timedOut = true;
          if (signal) signal._kinReason = "timeout";
          try { if (ctrl) ctrl.abort(); } catch (_) {}
          if (typeof opts.onTimeout === "function") {
            try { opts.onTimeout(); } catch (_) {}
          }
          rej(KindroidError(
            "timeout",
            "Kindroid took longer than 75 seconds. Tap Send again, or Cancel.",
            { retry: true, timeout: true }
          ));
        }, timeoutMs);
      });
    }

    try {
      if (timeoutPromise) return await Promise.race([work(), timeoutPromise]);
      return await work();
    } catch (e) {
      var c = classifyCaught(e);
      c.posted = !!(requestPosted || (e && e.posted));
      throw c;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function RateGate(opts) {
    opts = opts || {};
    this.max = opts.max == null ? RATE_MAX - 1 : opts.max; // leave a slot; Kindroid is 10/30s
    this.windowMs = opts.windowMs || RATE_WINDOW_MS;
    this.sent = [];
    this.blockedUntil = 0;
    this.now = opts.now || function () { return Date.now(); };
    this.scale = opts.scale || 1;
  }
  RateGate.prototype._prune = function () {
    var now = this.now(), w = this.windowMs;
    this.sent = this.sent.filter(function (t) { return now - t < w; });
    return now;
  };
  /* How long (ms) until a request may go out. 0 = now. */
  RateGate.prototype.waitMs = function () {
    var now = this._prune();
    var block = Math.max(0, this.blockedUntil - now);
    var slot = this.sent.length < this.max ? 0 : this.windowMs - (now - this.sent[0]) + 50;
    return Math.max(block, slot, 0);
  };
  RateGate.prototype.snapshot = function () {
    var ms = this.waitMs();
    return { used: this.sent.length, max: this.max, waitMs: ms, blocked: this.blockedUntil > this.now() };
  };
  /* Resolve when a slot is free. onWait(secondsLeft) is called about twice a second while waiting. */
  RateGate.prototype.wait = function (onWait, signal) {
    var self = this;
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (signal && signal.aborted) return reject(KindroidError("cancelled", "Cancelled.", { retry: true }));
        var ms = self.waitMs();
        if (ms <= 0) {
          if (onWait) { try { onWait(0); } catch (_) {} }
          return resolve(0);
        }
        if (onWait) { try { onWait(Math.ceil(ms / 1000)); } catch (_) {} }
        setTimeout(tick, Math.max(20, Math.min(ms * self.scale, 500)));
      })();
    });
  };
  RateGate.prototype.mark = function () {
    this._prune();
    this.sent.push(this.now());
  };
  /* Wait for a slot and take it in one step (what every Kindroid call should do). */
  RateGate.prototype.acquire = function (onWait, signal) {
    // Check and take the slot in the same tick, so callers that arrive together can't all slip through.
    var self = this;
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (signal && signal.aborted) return reject(KindroidError("cancelled", "Cancelled.", { retry: true }));
        var ms = self.waitMs();
        if (ms <= 0) {
          self.mark();
          if (onWait) { try { onWait(0); } catch (_) {} }
          return resolve(0);
        }
        if (onWait) { try { onWait(Math.ceil(ms / 1000)); } catch (_) {} }
        setTimeout(tick, Math.max(20, Math.min(ms * self.scale, 500)));
      })();
    });
  };
  /* Kindroid said 429: hold everything for a full window. */
  RateGate.prototype.penalize = function (ms) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + (ms == null ? this.windowMs : ms));
  };

  /* One limiter for the whole app: Chat, Games, Groups, Sync, Tools, setup. */
  var limiter = new RateGate();

  /* Connection status feed for the header pill. state: ok | waiting | busy | offline | auth | subscription | error | unknown */
  var statusState = { state: "unknown", detail: "", at: 0 };
  var statusListeners = [];
  function setStatus(state, detail) {
    statusState = { state: String(state || "unknown"), detail: redact(detail || ""), at: Date.now() };
    statusListeners.slice().forEach(function (fn) { try { fn(statusState); } catch (_) {} });
    return statusState;
  }
  function onStatus(fn) {
    if (typeof fn === "function") statusListeners.push(fn);
    return function () { statusListeners = statusListeners.filter(function (x) { return x !== fn; }); };
  }
  function getStatus() { return statusState; }
  function statusFromError(e) {
    var k = e && e.kind;
    if (k === "offline") return setStatus("offline", e.message);
    if (k === "auth" || k === "forbidden") return setStatus("auth", e.message);
    if (k === "subscription") return setStatus("subscription", e.message);
    if (k === "rate_limit") return setStatus("waiting", e.message);
    if (k === "cancelled") return statusState;
    // A reply-level problem (not found, "< >", timeout) still means the line to Kindroid works.
    if (k === "not_found" || k === "generation" || k === "empty" || k === "conflict" || k === "timeout") return setStatus("ok", "");
    return setStatus("error", (e && e.message) || "");
  }

  /* Backoff for network errors / 5xx: 1.5 s, 4 s, 9 s (+ jitter). */
  function backoffMs(attempt) {
    var base = [1500, 4000, 9000][Math.min(Math.max(attempt, 0), 2)];
    return base + Math.floor(Math.random() * 400);
  }
  function isRetryable(e) {
    var k = e && e.kind;
    return k === "offline" || k === "server";
  }

  /* ---------- AI IDs ---------- */
  var INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u00A0\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
  var AI_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  /* Clean a pasted AI ID / Kin ID / group link: strips invisible characters, quotes, labels and URLs. */
  function cleanAiId(raw) {
    var s = String(raw == null ? "" : raw).replace(INVISIBLE_RE, "").trim();
    s = s.replace(/^["'`\u2018\u2019\u201C\u201D]+|["'`\u2018\u2019\u201C\u201D.,;]+$/g, "").trim();
    var url = s.match(/\/(?:chat\/group|group|chat|kin|ai)\/([A-Za-z0-9_-]{6,64})/i);
    if (url) return url[1];
    s = s.replace(/^(?:kin\s*id|ai\s*id|ai_id|id|group\s*id|group_id)\s*[:=#-]?\s*/i, "");
    s = s.replace(/\s+/g, "");
    return s;
  }
  function aiIdProblem(id) {
    id = String(id || "");
    if (!id) return "empty";
    if (/^kn_/i.test(id)) return "That is your API key, not a Kin ID. The Kin ID is at the bottom of the Kin's settings.";
    if (/^[A-Za-z0-9]{5}$/.test(id)) return "That looks like a 5-character share code. Kindroid's API can't open a Kin from a share code — use the Kin ID from the bottom of the Kin's settings.";
    if (!AI_ID_RE.test(id)) return "A Kin ID is 6–64 letters, numbers, - or _. Copy it again from the bottom of the Kin's settings in Kindroid.";
    return "";
  }
  /* Parse a pasted list: one Kin per line. "Name: id", "Name = id", "Name, id", "Name | id", "Name<TAB>id", "id Name" or just "id". */
  function parseKinList(text) {
    var out = [], seen = {};
    String(text || "").replace(INVISIBLE_RE, function (c) { return c === "\n" || c === "\r" ? c : ""; })
      .split(/\r?\n|;/).forEach(function (line, i) {
        var raw = line.trim();
        if (!raw || /^#/.test(raw)) return;
        var name = "", id = "";
        var urlTok = raw.match(/https?:\/\/\S+/i);
        if (urlTok) {
          id = cleanAiId(urlTok[0].replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop());
          name = raw.replace(urlTok[0], "").replace(/[\s:=|,\t-]+$/, "").replace(/^[\s:=|,\t-]+/, "").trim();
          var p0 = aiIdProblem(id);
          out.push({ line: i + 1, name: name, ai_id: id, problem: p0, duplicate: !!seen[id] });
          seen[id] = 1;
          return;
        }
        var m = raw.match(/^(.*?)\s*(?::|=|\||\t|,|\s-\s|\s\u2013\s)\s*([^\s:=|,]+)\s*$/);
        if (m && m[1] && !/^(kin\s*id|ai\s*id|ai_id|id)$/i.test(m[1].trim())) { name = m[1].trim(); id = cleanAiId(m[2]); }
        else {
          var parts = raw.split(/\s+/);
          var idIdx = -1;
          for (var j = 0; j < parts.length; j++) {
            var cand = cleanAiId(parts[j]);
            if (AI_ID_RE.test(cand) && /\d/.test(cand) && cand.length >= 12) { idIdx = j; id = cand; break; }
          }
          if (idIdx < 0) { id = cleanAiId(raw); }
          else { name = parts.filter(function (_, k) { return k !== idIdx; }).join(" ").replace(/^(kin\s*id|ai\s*id)\s*:?/i, "").trim(); }
        }
        if (!id) return;
        var problem = aiIdProblem(id);
        var dup = !!seen[id];
        seen[id] = 1;
        out.push({ line: i + 1, name: name.replace(/^["']|["']$/g, ""), ai_id: id, problem: problem, duplicate: dup });
      });
    return out;
  }

  /* ---------- Setup helpers (used by the first-run wizard and Fix my connection) ---------- */
  async function callRaw(opts, method, path, body) {
    var fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw KindroidError("error", "No fetch available.", { retry: false });
    var gate = opts.limiter || limiter;
    await gate.acquire(opts.onWait);
    var headers = { Authorization: "Bearer " + opts.apiKey, Accept: "text/plain, application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    var res;
    try {
      res = await fetchImpl((opts.apiBase || API) + path, { method: method, headers: headers, body: method === "POST" ? JSON.stringify(body || {}) : undefined });
    } catch (e) {
      throw classifyKindroidError(e, {});
    }
    var text = "";
    try { text = await readFullText(res); } catch (_) {}
    return { status: res.status || 0, text: text };
  }

  /* Live key test. Sends update-info for an AI ID that cannot exist, so nothing on the account changes.
     Result: { ok, state: "ok" | "bad_key" | "subscription" | "offline" | "rate_limit" | "error", message } */
  async function testKey(opts) {
    opts = opts || {};
    var key = String(opts.apiKey || "");
    if (!/^kn_[A-Za-z0-9_-]{8,}$/.test(key)) {
      return { ok: false, state: "bad_key", message: "That doesn't look like a Kindroid API key. It starts with kn_ — copy it again." };
    }
    var r;
    try {
      r = await callRaw(opts, "POST", "/update-info", { ai_id: "kinstudio-key-check-" + Date.now().toString(36) });
    } catch (e) {
      statusFromError(e);
      return { ok: false, state: e.kind === "offline" ? "offline" : "error", message: e.message };
    }
    var st = r.status;
    if (st === 401) { setStatus("auth", ""); return { ok: false, state: "bad_key", message: "Kindroid didn't accept this key (401). Copy it again, or tap Regenerate in Kindroid and paste the new one." }; }
    if (st === 429) { limiter.penalize(); setStatus("waiting", ""); return { ok: false, state: "rate_limit", message: "Kindroid is rate limiting (10 requests every 30 seconds). Wait 30 seconds and test again." }; }
    if (st === 403) {
      setStatus("subscription", "");
      return { ok: false, state: "subscription", message: "Kindroid refused this key (403). Either the key is wrong, or the account is read-only because the free preview ended (chat needs an active trial or subscription). Check Kindroid → Subscriptions, then test again." };
    }
    if (st >= 500) { setStatus("error", ""); return { ok: false, state: "error", message: "Kindroid had a server problem (" + st + "). Try again in a minute." }; }
    // 200, 400, 404: the key got through authentication.
    setStatus("ok", "");
    return { ok: true, state: "ok", message: "Key works." };
  }

  /* Look up one Kin by AI ID through get-chat-messages (counts 1 of the 600 daily history pulls).
     Oldest message first, so the first Kin line is usually the greeting and display_name is the Kin's name.
     Result: { ok, state: "ok" | "not_found" | "bad_key" | "subscription" | "rate_limit" | "offline" | "error", name, greeting, count, message } */
  async function inspectKin(opts) {
    opts = opts || {};
    var id = cleanAiId(opts.ai_id);
    var problem = aiIdProblem(id);
    if (problem) return { ok: false, state: "not_found", ai_id: id, message: problem === "empty" ? "No Kin ID." : problem };
    var r;
    try {
      r = await callRaw(opts, "GET", "/get-chat-messages?ai_id=" + encodeURIComponent(id) + "&limit=10");
    } catch (e) {
      statusFromError(e);
      return { ok: false, state: e.kind === "offline" ? "offline" : "error", ai_id: id, message: e.message };
    }
    if (typeof opts.onPull === "function") { try { opts.onPull(); } catch (_) {} }
    var st = r.status;
    if (st === 401) { setStatus("auth", ""); return { ok: false, state: "bad_key", ai_id: id, message: "Kindroid didn't accept the API key (401)." }; }
    if (st === 403) { setStatus("subscription", ""); return { ok: false, state: "subscription", ai_id: id, message: "Kindroid refused (403). The key may be wrong, this Kin may belong to another account, or the free preview ended." }; }
    if (st === 429) { limiter.penalize(); setStatus("waiting", ""); return { ok: false, state: "rate_limit", ai_id: id, message: "Rate limited. Wait 30 seconds, then check again." }; }
    if (st === 400 || st === 404) { setStatus("ok", ""); return { ok: false, state: "not_found", ai_id: id, message: "Kindroid doesn't know this Kin ID. Copy it again from the bottom of the Kin's settings." }; }
    if (st < 200 || st >= 300) { setStatus("error", ""); return { ok: false, state: "error", ai_id: id, message: "Kindroid error " + st + "." }; }
    setStatus("ok", "");
    var data = null;
    try { data = JSON.parse(r.text); } catch (_) {}
    var msgs = (data && (Array.isArray(data) ? data : data.messages)) || [];
    var name = "", greeting = "";
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i] || {};
      var t = String(m.sender_type || m.sender || m.role || "").toLowerCase();
      var isUser = t.indexOf("user") >= 0 || t === "human";
      if (!isUser) {
        if (!name && m.display_name) name = String(m.display_name).trim();
        if (!greeting && m.message && !looksLikeGenerationFail(m.message)) greeting = String(m.message).trim();
      }
      if (name && greeting) break;
    }
    return { ok: true, state: "ok", ai_id: id, name: name, greeting: greeting, count: msgs.length, message: msgs.length ? "Found." : "Found (no messages yet)." };
  }

  /* ---------- 1.18: undocumented update-info helpers ----------
     Kindroid has no GET for Kin fields, so nothing here can read the current
     persona, learned context or revision back. The app keeps its own copy. */

  /* Gender words as the Kindroid app shows them. A guess: not documented for personas. */
  var PERSONA_GENDER = { male: "Male", female: "Female", nonbinary: "Non-binary" };

  /* Kindroid's own reason from an update-info error. Verified live Nov 14 2026: update-info
     answers errors in plain text (schema messages like "\"x\" is not allowed"), not JSON. */
  function kindroidReason(e) {
    var raw = String((e && (e.body || e.message)) || "").replace(/^\d{3}:\s*/, "").trim();
    raw = redact(raw).replace(/\s+/g, " ").slice(0, 160);
    return raw && !/^(OK|bad|error)$/i.test(raw) ? raw : "";
  }

  /* Body for a persona switch. With a Kindroid persona ID it uses active_persona_id (undocumented).
     Without one it falls back to the documented account-wide user_name / user_gender only.
     Verified live Nov 14 2026: active_persona_id (and user_persona_id) are accepted string fields,
     and Kindroid answers 200 for ANY persona ID string without checking it exists. So a typo in the
     ID is not caught by Kindroid; the app can't tell a wrong ID from a right one. */
  function personaSwitchBody(ai_id, persona) {
    persona = persona || {};
    var body = { ai_id: String(ai_id || "") };
    var pid = String(persona.kindroidPersonaId || "").replace(INVISIBLE_RE, "").trim();
    if (persona.name) body.user_name = String(persona.name).slice(0, 100);
    if (persona.gender && PERSONA_GENDER[persona.gender]) body.user_gender = PERSONA_GENDER[persona.gender];
    if (pid) {
      body.active_persona_id = pid;
      if (persona.backstory) body.user_backstory = String(persona.backstory).slice(0, 1000);
    }
    return body;
  }
  function personaMode(persona) {
    return persona && String(persona.kindroidPersonaId || "").trim() ? "persona_id" : "name_only";
  }

  /* One persona-switched send at a time, so two sends can't interleave their switch / switch-back. */
  var personaLock = Promise.resolve();

  /* Switch to `persona`, run send(), then switch back to `home` in a finally block.
     opts: { call(path, body) -> Promise (must go through the shared limiter), ai_id, persona, home,
             send() -> Promise, onStep(step) }
     Throws a KindroidError with kind "persona_switch" (nothing was sent) when the switch itself fails.
     The result has restored:false and restoreError when switching back failed. */
  function sendAsPersona(opts) {
    opts = opts || {};
    var run = personaLock.then(function () { return sendAsPersonaNow(opts); });
    personaLock = run.then(function () {}, function () {});
    return run;
  }
  async function sendAsPersonaNow(opts) {
    var call = opts.call;
    var step = typeof opts.onStep === "function" ? opts.onStep : function () {};
    if (typeof call !== "function" || typeof opts.send !== "function") {
      throw KindroidError("error", "sendAsPersona needs call() and send().", { retry: false });
    }
    if (!opts.ai_id) throw KindroidError("persona_switch", "Talk as needs a Kin with an AI ID to switch through. Nothing was sent.", { retry: false });
    if (!opts.home) throw KindroidError("persona_switch", "Pick the persona to switch back to (Personas tab, \"Switch back to this one\") before using Talk as. Nothing was sent.", { retry: false });
    step("switch");
    try {
      await call("/update-info", personaSwitchBody(opts.ai_id, opts.persona));
    } catch (e) {
      var st = e && e.status;
      var reason = kindroidReason(e);
      var why = st === 400 || st === 404 || (e && e.kind === "not_found")
        ? "Kindroid didn't accept the persona switch (" + (st || "400/404") + (reason ? ": " + reason : "") + "). Persona switching uses a part of Kindroid's API that isn't documented, and it may have changed. Check the Kindroid persona ID on the Personas tab."
        : redact((e && e.message) || "The persona switch failed.");
      var pe = KindroidError("persona_switch", why + " Nothing was sent.", { retry: false, status: st });
      pe.cause = e && e.kind;
      pe.posted = false;
      throw pe;
    }
    var result, sendErr = null, restored = false, restoreError = "";
    try {
      step("send");
      result = await opts.send();
    } catch (e) {
      sendErr = e;
    } finally {
      step("restore");
      try {
        await call("/update-info", personaSwitchBody(opts.ai_id, opts.home));
        restored = true;
      } catch (re) {
        restoreError = redact((re && re.message) || "switch back failed");
      }
      step("done");
    }
    if (sendErr) {
      sendErr.personaRestored = restored;
      if (!restored) sendErr.personaRestoreError = restoreError;
      throw sendErr;
    }
    return { result: result, restored: restored, restoreError: restoreError };
  }

  /* Learned context (developed_context). Caps match the Characters tab, which follows the Kindroid app. */
  var LEARNED_FIELDS = [
    { key: "self_relationship", local: "growth", label: "Growth & relationship", max: 800 },
    { key: "durable_facts", local: "importantFacts", label: "Important facts", max: 1200 },
    { key: "ongoing_context", local: "ongoingThreads", label: "Ongoing threads", max: 800 }
  ];
  /* Used only when the user has no revision number. A documented GUESS, not something Kindroid published.
     Verified live Nov 14 2026: Kindroid requires a whole number >= 0 and never sends the current one back. */
  var LEARNED_REVISION_GUESS = 0;

  function parseRevision(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!/^\d{1,12}$/.test(s)) return null;
    return Number(s);
  }
  /* Validate and build the update-info body. All three fields and the revision are required by Kindroid. */
  function learnedContextBody(ai_id, fields, revision) {
    fields = fields || {};
    var problems = [];
    var id = cleanAiId(ai_id);
    var idp = aiIdProblem(id);
    if (idp) problems.push(idp === "empty" ? "This Kin needs an AI ID." : idp);
    var dc = {};
    LEARNED_FIELDS.forEach(function (f) {
      var v = fields[f.key] != null ? fields[f.key] : fields[f.local];
      v = String(v == null ? "" : v).replace(/\r\n/g, "\n");
      if (v.length > f.max) problems.push(f.label + " is " + v.length + " characters; the limit is " + f.max + ".");
      dc[f.key] = v;
    });
    var rev = parseRevision(revision);
    if (rev == null) problems.push("Revision must be a whole number.");
    return { ok: !problems.length, problems: problems, body: { ai_id: id, developed_context: dc, developed_context_revision: rev } };
  }
  /* Look for a revision number in a 409 body, in case Kindroid ever sends the current one back.
     Verified live Nov 14 2026: today's 409 is plain text with NO number
     ("Learned context changed while you were editing it. Try again."), so this returns null. Kept for later API changes. */
  function revisionFromBody(text) {
    var s = String(text || "");
    try {
      var j = JSON.parse(s);
      var found = null;
      (function walk(o, depth) {
        if (found != null || !o || typeof o !== "object" || depth > 4) return;
        Object.keys(o).forEach(function (k) {
          if (found != null) return;
          if (/revision/i.test(k) && parseRevision(o[k]) != null) found = parseRevision(o[k]);
          else walk(o[k], depth + 1);
        });
      })(j, 0);
      if (found != null) return found;
    } catch (_) { /* not JSON; try plain text below */ }
    var m = s.match(/revision[^0-9]{0,24}(\d{1,12})/i);
    return m ? Number(m[1]) : null;
  }
  /* Push learned context. opts: { call(path, body) (shared limiter), ai_id, fields, revision }
     Result: { ok, state: "ok" | "invalid" | "conflict" | "bad_request" | "error", message, sentRevision, serverRevision, body } */
  async function pushLearnedContext(opts) {
    opts = opts || {};
    var built = learnedContextBody(opts.ai_id, opts.fields, opts.revision);
    if (!built.ok) return { ok: false, state: "invalid", message: built.problems.join(" "), body: built.body };
    try {
      await opts.call("/update-info", built.body);
    } catch (e) {
      var st = e && e.status;
      var raw = (e && (e.body || e.message)) || "";
      if (st === 409 || (e && e.kind === "conflict") || /learned context changed/i.test(raw)) {
        var srv = revisionFromBody(raw);
        return {
          ok: false, state: "conflict", sentRevision: built.body.developed_context_revision, serverRevision: srv, body: built.body,
          message: "Kindroid said the learned context changed since revision " + built.body.developed_context_revision +
            " (409). Your Kin probably learned something new on its own. Nothing was changed. Open the Kin in the Kindroid app, copy the three Learned context fields again, paste them here, add your edits, and push again" +
            (srv != null ? " (Kindroid mentioned revision " + srv + ")." : ".")
        };
      }
      if (st === 400) {
        var why400 = kindroidReason(e);
        return { ok: false, state: "bad_request", sentRevision: built.body.developed_context_revision, body: built.body,
          message: "Kindroid rejected the learned context (400" + (why400 ? ": " + why400 : "") + "). This part of the API isn't documented and may have changed, or a field is too long. Nothing was changed." };
      }
      if (st >= 500) {
        /* Verified live Nov 14 2026: an AI ID that doesn't exist gets a 500 here, not a 404. */
        return { ok: false, state: "error", sentRevision: built.body.developed_context_revision, body: built.body,
          message: "Kindroid had a server error (" + st + "). Nothing was changed. Kindroid also answers this way when the AI ID doesn't belong to a Kin on your account, so check the AI ID on this character, then try again in a minute." };
      }
      return { ok: false, state: "error", sentRevision: built.body.developed_context_revision, body: built.body, message: redact((e && e.message) || "Push failed.") };
    }
    return { ok: true, state: "ok", sentRevision: built.body.developed_context_revision, body: built.body, message: "Learned context pushed to Kindroid." };
  }

  function ChatQueue(sendFn) {
    this._send = sendFn;
    this._q = [];
    this._inflight = false;
    this._current = null;
    this.length = 0;
  }
  ChatQueue.prototype.busy = function () {
    return this._inflight;
  };
  ChatQueue.prototype.has = function (text) {
    text = String(text || "");
    if (this._current && String(this._current.message || "") === text) return true;
    return this._q.some(function (n) { return n.job && String(n.job.message || "") === text; });
  };
  ChatQueue.prototype.enqueue = function (job) {
    job = job || {};
    // Ignore a duplicate of the in-flight or last-queued message (double tap / double Enter).
    var text = String(job.message || "");
    if (this._inflight && this._current && this._current.message === text && !job.skip) {
      return Promise.resolve({ ignored: true, reason: "duplicate" });
    }
    var last = this._q[this._q.length - 1];
    if (last && last.message === text && !job.skip && !text) {
      return Promise.resolve({ ignored: true, reason: "duplicate" });
    }
    if (last && last.message === text && !job.skip) {
      return Promise.resolve({ ignored: true, reason: "duplicate" });
    }
    var self = this;
    return new Promise(function (resolve, reject) {
      self._q.push({ job: job, resolve: resolve, reject: reject });
      self.length = self._q.length;
      self._drain();
    });
  };
  ChatQueue.prototype._drain = function () {
    if (this._inflight) return;
    var next = this._q.shift();
    this.length = this._q.length;
    if (!next) return;
    this._inflight = true;
    this._current = next.job;
    var self = this;
    Promise.resolve()
      .then(function () { return self._send(next.job); })
      .then(function (r) { next.resolve(r); })
      .catch(function (e) { next.reject(e); })
      .then(function () {
        self._inflight = false;
        self._current = null;
        self._drain();
      });
  };
  ChatQueue.prototype.cancelQueued = function () {
    var dropped = this._q.splice(0);
    this.length = 0;
    dropped.forEach(function (n) {
      var e = KindroidError("cancelled", "Cancelled.", { retry: true });
      n.reject(e);
    });
    return dropped.length;
  };

  var SECRET_KEYS = {
    api_key: 1,
    apiKey: 1,
    kin_api_key: 1,
    authorization: 1,
    Authorization: 1,
    password: 1,
    keystore: 1,
    token: 1,
    discord_token: 1
  };
  function stripSecretsFromExport(value, seen) {
    seen = seen || [];
    if (value == null) return value;
    if (typeof value === "string") return value.replace(KEY_RE, "kn_[redacted]");
    if (typeof value !== "object") return value;
    if (seen.indexOf(value) >= 0) return null;
    seen.push(value);
    if (Array.isArray(value)) {
      return value.map(function (v) { return stripSecretsFromExport(v, seen); });
    }
    var out = {};
    Object.keys(value).forEach(function (k) {
      if (SECRET_KEYS[k] || /^api[_-]?key$/i.test(k) || /^kin_api/.test(k)) return;
      out[k] = stripSecretsFromExport(value[k], seen);
    });
    return out;
  }


  return {
    API: API,
    TIMEOUT_MS: TIMEOUT_MS,
    RATE_MAX: RATE_MAX,
    RATE_WINDOW_MS: RATE_WINDOW_MS,
    HTTP_ERROR_MARK: HTTP_ERROR_MARK,
    redact: redact,
    classifyKindroidError: classifyKindroidError,
    KindroidError: KindroidError,
    StreamAssembler: StreamAssembler,
    sendMessage: sendMessage,
    RateGate: RateGate,
    limiter: limiter,
    setStatus: setStatus,
    onStatus: onStatus,
    getStatus: getStatus,
    statusFromError: statusFromError,
    backoffMs: backoffMs,
    isRetryable: isRetryable,
    cleanAiId: cleanAiId,
    aiIdProblem: aiIdProblem,
    parseKinList: parseKinList,
    testKey: testKey,
    inspectKin: inspectKin,
    ChatQueue: ChatQueue,
    stripSecretsFromExport: stripSecretsFromExport,
    looksLikeGenerationFail: looksLikeGenerationFail,
    PERSONA_GENDER: PERSONA_GENDER,
    personaSwitchBody: personaSwitchBody,
    personaMode: personaMode,
    sendAsPersona: sendAsPersona,
    LEARNED_FIELDS: LEARNED_FIELDS,
    LEARNED_REVISION_GUESS: LEARNED_REVISION_GUESS,
    parseRevision: parseRevision,
    learnedContextBody: learnedContextBody,
    revisionFromBody: revisionFromBody,
    pushLearnedContext: pushLearnedContext
  };
});
