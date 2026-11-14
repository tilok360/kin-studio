/* Node tests for Kin Studio 1.16.0: shared rate limiter, AI ID clean-up, bulk list parsing,
   live key test and Kin lookup. All Kindroid calls are mocked. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Promise, JSON, Date, Error, TypeError, Math, console, TextDecoder };
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.runInNewContext(readFileSync(join(here, "../public/kin-client.js"), "utf8"), sandbox, { filename: "kin-client.js" });
const K = sandbox.module.exports;
const KEY = "kn_TESTKEY_DO_NOT_SHIP_abcdefghijklmnop";

function mockFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    return { status: r.status, text: async () => r.body || "" };
  };
  f.calls = calls;
  return f;
}

test("inline copy in phone.html matches public/kin-client.js", () => {
  const html = readFileSync(join(here, "../public/phone.html"), "utf8");
  const client = readFileSync(join(here, "../public/kin-client.js"), "utf8").trim();
  assert.ok(html.includes(client), "re-sync the KIN_CLIENT_INLINE block");
});

test("RateGate.acquire is atomic: 12 callers at once, only max go out per window", async () => {
  const g = new K.RateGate({ max: 9, windowMs: 300 });
  const t0 = Date.now(); const times = [];
  await Promise.all(Array.from({ length: 12 }, () => g.acquire().then(() => times.push(Date.now() - t0))));
  times.sort((a, b) => a - b);
  assert.equal(times.filter((t) => t < 150).length, 9);
  assert.ok(times[11] >= 280, "the 10th–12th wait for the window");
});

test("RateGate.penalize blocks everyone and reports seconds left", async () => {
  const g = new K.RateGate({ windowMs: 200 });
  g.penalize(250);
  const seen = [];
  const t0 = Date.now();
  await g.acquire((s) => seen.push(s));
  assert.ok(Date.now() - t0 >= 230);
  assert.ok(seen.some((s) => s > 0) && seen[seen.length - 1] === 0);
});

test("cleanAiId strips invisible characters, labels, quotes and URLs", () => {
  assert.equal(K.cleanAiId("\u200BabcDEF123456\u00A0 "), "abcDEF123456");
  assert.equal(K.cleanAiId("Kin ID: abc123def456"), "abc123def456");
  assert.equal(K.cleanAiId("“abc123def456”"), "abc123def456");
  assert.equal(K.cleanAiId("https://kindroid.ai/v2/chat/group/Grp123456789"), "Grp123456789");
  assert.match(K.aiIdProblem("kn_abcdefghijkl"), /API key/);
  assert.match(K.aiIdProblem("AbCd1"), /share code/);
  assert.equal(K.aiIdProblem("abc123def456"), "");
});

test("parseKinList handles names, separators, duplicates and junk", () => {
  const rows = K.parseKinList("Abby: abc123def456ghi\nCara = xyz987654321abc\n\u200Bq1w2e3r4t5y6u7\u200B\nRikka  r1k2k3a4id5678\nabc123def456ghi\n# comment\n\nAbCd1");
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((r) => [r.name, r.ai_id, !!r.problem, r.duplicate]))), [
    ["Abby", "abc123def456ghi", false, false],
    ["Cara", "xyz987654321abc", false, false],
    ["", "q1w2e3r4t5y6u7", false, false],
    ["Rikka", "r1k2k3a4id5678", false, false],
    ["", "abc123def456ghi", false, true],
    ["", "AbCd1", true, false],
  ]);
});

test("testKey: 401 bad key, 403 subscription, 404 = key works, never echoes the key", async () => {
  const lim = new K.RateGate({ windowMs: 50 });
  for (const [status, state, ok] of [[401, "bad_key", false], [403, "subscription", false], [404, "ok", true], [400, "ok", true], [200, "ok", true], [429, "rate_limit", false], [500, "error", false]]) {
    const f = mockFetch(() => ({ status, body: "x " + KEY }));
    const r = await K.testKey({ apiKey: KEY, fetchImpl: f, limiter: lim });
    assert.equal(r.state, state, "status " + status);
    assert.equal(r.ok, ok);
    assert.equal(JSON.stringify(r).includes(KEY), false);
    assert.match(f.calls[0].url, /\/update-info$/);
    assert.match(JSON.parse(f.calls[0].init.body).ai_id, /^kinstudio-key-check-/);
  }
  const bad = await K.testKey({ apiKey: "nope" });
  assert.equal(bad.state, "bad_key");
});

test("inspectKin pulls name + greeting (oldest first) and counts one pull", async () => {
  let pulls = 0;
  const f = mockFetch((url) => {
    assert.match(url, /get-chat-messages\?ai_id=abc123def456&limit=10$/);
    return { status: 200, body: JSON.stringify({ messages: [
      { sender_type: "user", display_name: "Chris", message: "hi" },
      { sender_type: "ai", display_name: "Abby", message: "Hello there." },
    ] }) };
  });
  const r = await K.inspectKin({ apiKey: KEY, ai_id: "\u200Babc123def456 ", fetchImpl: f, limiter: new K.RateGate(), onPull: () => pulls++ });
  assert.equal(r.ok, true); assert.equal(r.name, "Abby"); assert.equal(r.greeting, "Hello there."); assert.equal(pulls, 1);
  const nf = await K.inspectKin({ apiKey: KEY, ai_id: "abc123def456", fetchImpl: mockFetch(() => ({ status: 404, body: "AI not found" })), limiter: new K.RateGate() });
  assert.equal(nf.state, "not_found");
  const share = await K.inspectKin({ apiKey: KEY, ai_id: "AbCd1", fetchImpl: mockFetch(() => { throw new Error("should not call"); }) });
  assert.equal(share.state, "not_found");
});

test("classify: 403 with subscription wording, 409, 5xx", () => {
  assert.equal(K.classifyKindroidError(new Error('403: {"error":"Account is read-only"}'), { status: 403 }).kind, "subscription");
  assert.equal(K.classifyKindroidError(new Error("409: conflict"), { status: 409 }).kind, "conflict");
  const s = K.classifyKindroidError(new Error("503: down"), { status: 503 });
  assert.equal(s.kind, "server"); assert.equal(s.retry, true);
  assert.equal(K.isRetryable(s), true);
  assert.equal(K.isRetryable(K.classifyKindroidError(new Error("401"), { status: 401 })), false);
});

test("status feed notifies listeners and redacts", () => {
  const seen = [];
  const off = K.onStatus((s) => seen.push(s.state + ":" + s.detail));
  K.setStatus("auth", "bad " + KEY);
  off();
  K.setStatus("ok", "");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes(KEY), false);
});
