/* Kin Studio chat client — 1.15.0 draft.
   Official Kindroid send-message helper: streaming with fallback, 75s timeout,
   rate-limit / auth / offline errors, a send queue, and secret redaction.
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
      return KindroidError(
        "forbidden",
        "Kindroid rejected the request (403). The API key may be wrong, or the account needs an active trial or subscription. Check the key in Settings. The key is never shown in errors.",
        { retry: false, status: 403 }
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
    this.now = opts.now || function () { return Date.now(); };
  }
  RateGate.prototype.wait = function () {
    var self = this;
    return new Promise(function (resolve) {
      (function tick() {
        var now = self.now();
        self.sent = self.sent.filter(function (t) { return now - t < self.windowMs; });
        if (self.sent.length < self.max) return resolve(0);
        var wait = self.windowMs - (now - self.sent[0]) + 50;
        setTimeout(tick, Math.min(Math.max(wait, 50), 1000));
      })();
    });
  };
  RateGate.prototype.mark = function () {
    this.sent.push(this.now());
  };

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

  function looksLikeGenerationFail(text) {
    return /^<\s*>/.test(String(text || "").trim());
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
    ChatQueue: ChatQueue,
    stripSecretsFromExport: stripSecretsFromExport,
    looksLikeGenerationFail: looksLikeGenerationFail
  };
});
