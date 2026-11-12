/* Node tests for Kin Studio 1.15.0 chat reliability. No real Kindroid calls. */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

// public/kin-client.js is a classic browser script (package.json is "type": "module").
const _clientPath = join(dirname(fileURLToPath(import.meta.url)), "../public/kin-client.js");
const _sandbox = {
  module: { exports: {} },
  exports: {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  AbortSignal,
  TextDecoder,
  TextEncoder,
  ReadableStream,
  fetch,
  Headers,
  Promise,
  JSON,
  Date,
  Error,
  TypeError,
  console,
};
_sandbox.globalThis = _sandbox;
_sandbox.global = _sandbox;
_sandbox.window = _sandbox;
vm.runInNewContext(readFileSync(_clientPath, "utf8"), _sandbox, { filename: "kin-client.js" });
const KinClient = _sandbox.module.exports || _sandbox.KinClient;
if (!KinClient || typeof KinClient.redact !== "function") {
  throw new Error("Failed to load KinClient from " + _clientPath);
}

const KEY = "kn_TESTKEY_DO_NOT_SHIP_abcdefghijklmnop";
const AI = "ai-test-id";
const MARK = "<<HTTP_ERROR>>";

function streamBody(chunks, delay = 0) {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      controller.close();
    }
  });
}

function resOf({ status = 200, text = "", chunks = null }) {
  const obj = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "text/plain" },
    text: async () => (chunks ? chunks.join("") : text),
  };
  if (chunks) obj.body = streamBody(chunks);
  else obj.body = null;
  return obj;
}

test("redact strips kn_ keys, Bearer, and Authorization", () => {
  const s = KinClient.redact("got " + KEY + " and Bearer abc Authorization: xyz");
  assert.equal(s.includes(KEY), false);
  assert.match(s, /kn_\[redacted\]/);
  assert.match(s, /Bearer \[redacted\]/);
  assert.match(s, /Authorization: \[redacted\]/);
});

test("classify: 429, 401, 403, offline, timeout, generation", () => {
  const r429 = KinClient.classifyKindroidError(new Error("429 — too many"), { status: 429 });
  assert.equal(r429.kind, "rate_limit");
  assert.match(r429.message, /10 messages every 30 seconds/);
  assert.equal(r429.retry, true);

  const r401 = KinClient.classifyKindroidError(new Error("401"), { status: 401 });
  assert.equal(r401.kind, "auth");
  assert.equal(r401.retry, false);
  assert.doesNotMatch(r401.message, /kn_[A-Za-z0-9_-]{8,}/);

  const r403 = KinClient.classifyKindroidError(new Error("403 — subscription or bad key"), { status: 403 });
  assert.equal(r403.kind, "forbidden");
  assert.match(r403.message, /trial or subscription/);

  const off = KinClient.classifyKindroidError(new Error("Failed to fetch"));
  assert.equal(off.kind, "offline");
  assert.equal(off.retry, true);

  const to = KinClient.classifyKindroidError(new Error("aborted"), { timeout: true });
  assert.equal(to.kind, "timeout");
  assert.match(to.message, /75 seconds/);

  const gen = KinClient.classifyKindroidError(new Error("< >"));
  assert.equal(gen.kind, "generation");
});

test("classify never echoes a kn_ key from a raw error body", () => {
  const e = KinClient.classifyKindroidError(new Error("500: leaked " + KEY), { status: 500 });
  assert.equal(e.message.includes(KEY), false);
  assert.match(e.message, /redacted/);
});

test("StreamAssembler drops leading keep-alive whitespace", () => {
  const a = new KinClient.StreamAssembler();
  let st = a.push("   \n\n");
  assert.equal(st.visible, false);
  st = a.push("Hello");
  assert.equal(st.visible, true);
  assert.equal(st.text, "Hello");
  st = a.push(" world");
  assert.equal(st.text, "Hello world");
  assert.equal(st.error, null);
});

test("StreamAssembler catches mid-stream HTTP_ERROR mark", () => {
  const a = new KinClient.StreamAssembler();
  a.push("Hi ");
  const st = a.push("there" + MARK + "boom");
  assert.equal(st.text, "Hi there");
  assert.equal(st.error, "boom");
});

test("sendMessage streams chunks and returns the full text", async () => {
  const seen = [];
  const fetchImpl = async () => resOf({ chunks: ["  ", "Hel", "lo from", " a Kin"] });
  const r = await KinClient.sendMessage({
    apiKey: KEY,
    ai_id: AI,
    message: "hi",
    stream: true,
    fetchImpl,
    onChunk: (_d, full) => seen.push(full),
  });
  assert.equal(r.streamed, true);
  assert.equal(r.text, "Hello from a Kin");
  assert.ok(seen.includes("Hello from a Kin") || seen[seen.length - 1] === "Hello from a Kin");
});

test("sendMessage falls back to non-stream only if the stream request never started", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (calls === 1) {
      assert.equal(body.stream, true);
      throw new TypeError("Failed to fetch");
    }
    assert.equal(body.stream, false);
    return resOf({ text: "fallback reply" });
  };
  const r = await KinClient.sendMessage({
    apiKey: KEY,
    ai_id: AI,
    message: "hi",
    stream: true,
    fetchImpl,
  });
  assert.equal(r.fallback, true);
  assert.equal(r.streamed, false);
  assert.equal(r.text, "fallback reply");
  assert.equal(calls, 2);
});

test("sendMessage does NOT double-post after a stream has started", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return resOf({ chunks: ["partial" + MARK + "server died"] });
  };
  await assert.rejects(
    () => KinClient.sendMessage({ apiKey: KEY, ai_id: AI, message: "hi", stream: true, fetchImpl }),
    (e) => e && e.name === "KindroidError"
  );
  assert.equal(calls, 1);
});

test("sendMessage times out and does not include the key in the error", async () => {
  const fetchImpl = () =>
    new Promise(() => {
      /* hang */
    });
  const err = await KinClient.sendMessage({
    apiKey: KEY,
    ai_id: AI,
    message: "hi",
    stream: true,
    fetchImpl,
    timeoutMs: 40,
  }).then(
    () => null,
    (e) => e
  );
  assert.ok(err);
  assert.equal(err.kind, "timeout");
  assert.equal(String(err.message).includes(KEY), false);
  assert.match(err.message, /75 seconds|longer than/);
});

test("sendMessage maps 429, 401, and empty-looking auth without leaking the key", async () => {
  for (const [status, kind] of [
    [429, "rate_limit"],
    [401, "auth"],
    [403, "forbidden"],
  ]) {
    const fetchImpl = async () => resOf({ status, text: "nope " + KEY });
    const err = await KinClient.sendMessage({
      apiKey: KEY,
      ai_id: AI,
      message: "hi",
      stream: false,
      fetchImpl,
    }).then(
      () => null,
      (e) => e
    );
    assert.equal(err.kind, kind, "status " + status);
    assert.equal(String(err.message).includes(KEY), false, "leaked key on " + status);
  }
});

test("sendMessage treats missing key as auth and does not throw the raw key", async () => {
  const err = await KinClient.sendMessage({ apiKey: "", ai_id: AI, message: "x", fetchImpl: async () => {} }).then(
    () => null,
    (e) => e
  );
  assert.equal(err.kind, "auth");
  assert.equal(JSON.stringify(err).includes(KEY), false);
});

test("ChatQueue serializes sends and ignores a double-tap of the same message", async () => {
  const order = [];
  let inFlight = 0;
  let max = 0;
  const q = new KinClient.ChatQueue(async (job) => {
    inFlight++;
    max = Math.max(max, inFlight);
    order.push("start:" + job.message);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    order.push("end:" + job.message);
    return { text: "ok " + job.message };
  });
  const a = q.enqueue({ message: "one" });
  const dup = q.enqueue({ message: "one" });
  const b = q.enqueue({ message: "two" });
  const dupRes = await dup;
  assert.equal(dupRes.ignored, true);
  const ra = await a;
  const rb = await b;
  assert.equal(ra.text, "ok one");
  assert.equal(rb.text, "ok two");
  assert.equal(max, 1);
  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
});

test("ChatQueue cancelQueued rejects remaining jobs without sending them", async () => {
  let sent = 0;
  const q = new KinClient.ChatQueue(async (job) => {
    sent++;
    await new Promise((r) => setTimeout(r, 40));
    return { text: job.message };
  });
  const a = q.enqueue({ message: "first" });
  const b = q.enqueue({ message: "second" });
  const n = q.cancelQueued();
  assert.equal(n, 1);
  await assert.rejects(b, (e) => e.kind === "cancelled");
  await a;
  assert.equal(sent, 1);
});

test("stripSecretsFromExport drops api_key fields and kn_ values", () => {
  const out = KinClient.stripSecretsFromExport({
    characters: [{ name: "Cara", ai_id: "abc" }],
    settings: { api_key: KEY, theme: "dark" },
    nested: { kin_api_key: KEY, note: "hello " + KEY },
  });
  const raw = JSON.stringify(out);
  assert.equal(raw.includes(KEY), false);
  assert.equal(out.settings.api_key, undefined);
  assert.equal(out.settings.theme, "dark");
  assert.equal(out.characters[0].name, "Cara");
  assert.equal(out.nested.kin_api_key, undefined);
  assert.match(out.nested.note, /redacted/);
});

test("RateGate waits when the 10-per-30s window is full", async () => {
  let now = 1_000_000;
  const g = new KinClient.RateGate({ max: 2, windowMs: 50, now: () => now });
  g.mark();
  g.mark();
  let resolved = false;
  const p = g.wait().then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false);
  now += 60;
  await p;
  assert.equal(resolved, true);
});

test("live mock HTTP server: stream path ends 200 with assembled body", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/send-message");
    // Must not write the key into logs; just assert header exists and starts with Bearer kn_
    const auth = String(req.headers.authorization || "");
    assert.match(auth, /^Bearer kn_/);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("   ");
    res.write("Streamed");
    res.end(" OK");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const r = await KinClient.sendMessage({
      apiKey: KEY,
      ai_id: AI,
      message: "ping",
      stream: true,
      apiBase: "http://127.0.0.1:" + port,
      fetchImpl: fetch,
    });
    assert.equal(r.text.trim(), "Streamed OK");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("looksLikeGenerationFail", () => {
  assert.equal(KinClient.looksLikeGenerationFail("< >"), true);
  assert.equal(KinClient.looksLikeGenerationFail("  < >  "), true);
  assert.equal(KinClient.looksLikeGenerationFail("Hello"), false);
});
