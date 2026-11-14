/* Node tests for Kin Studio 1.18.0: "Talk as" persona switching and the Learned context editor.
   Both use update-info fields Kindroid hasn't documented. All Kindroid calls are mocked. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
function loadClient() {
  const sandbox = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Promise, JSON, Date, Error, TypeError, Math, console, TextDecoder };
  sandbox.globalThis = sandbox; sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(join(here, "../public/kin-client.js"), "utf8"), sandbox, { filename: "kin-client.js" });
  return sandbox.module.exports;
}
const K = loadClient();
const html = readFileSync(join(here, "../public/phone.html"), "utf8");
const AI = "abc123def456ghi";
const GATOR = { id: "p1", name: "Gator", gender: "male", backstory: "Swamp guide.", kindroidPersonaId: "persona_gator_1" };
const HOME = { id: "p0", name: "Chris", gender: "male", backstory: "Me.", kindroidPersonaId: "persona_home_0", isHome: true };

/* A call() that goes through a RateGate the way kinRaw does, and records every body. */
function gatedCall(gate, handler) {
  const calls = [];
  const fn = async (path, body) => {
    await gate.acquire();
    calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
    if (handler) return handler(path, body, calls.length);
    return "";
  };
  fn.calls = calls;
  return fn;
}
function httpErr(status, body) {
  const e = K.classifyKindroidError(new Error(status + ": " + body), { status });
  e.body = body;
  return e;
}

test("personaSwitchBody uses active_persona_id with an ID, and only documented name/gender without one", () => {
  const b = K.personaSwitchBody(AI, GATOR);
  assert.equal(b.ai_id, AI);
  assert.equal(b.active_persona_id, "persona_gator_1");
  assert.equal(b.user_name, "Gator");
  assert.equal(b.user_gender, "Male");
  assert.equal(b.user_backstory, "Swamp guide.");
  const n = K.personaSwitchBody(AI, { name: "Nick", gender: "nonbinary", backstory: "x" });
  assert.deepEqual([...Object.keys(n)].sort(), ["ai_id", "user_gender", "user_name"]);
  assert.equal(n.user_gender, "Non-binary");
  assert.equal(K.personaMode(GATOR), "persona_id");
  assert.equal(K.personaMode({ name: "Nick" }), "name_only");
});

test("sendAsPersona: switch, send, switch back, in that order", async () => {
  const gate = new K.RateGate({ max: 9, windowMs: 30000 });
  const call = gatedCall(gate);
  const steps = [];
  const r = await K.sendAsPersona({
    call, ai_id: AI, persona: GATOR, home: HOME,
    send: async () => { await gate.acquire(); steps.push("sent"); return "hi"; },
    onStep: (s) => steps.push(s)
  });
  assert.equal(r.result, "hi");
  assert.equal(r.restored, true);
  assert.deepEqual(steps, ["switch", "send", "sent", "restore", "done"]);
  assert.equal(call.calls.length, 2);
  assert.equal(call.calls[0].body.active_persona_id, "persona_gator_1");
  assert.equal(call.calls[1].body.active_persona_id, "persona_home_0");
  assert.equal(gate.snapshot().used, 3, "switch + send + switch back all take a limiter slot");
});

test("sendAsPersona switches back even when the send fails (finally)", async () => {
  const gate = new K.RateGate({ max: 9, windowMs: 30000 });
  const call = gatedCall(gate);
  await assert.rejects(
    K.sendAsPersona({ call, ai_id: AI, persona: GATOR, home: HOME, send: async () => { throw K.KindroidError("timeout", "slow", { retry: true }); } }),
    (e) => e.kind === "timeout" && e.personaRestored === true
  );
  assert.equal(call.calls.length, 2);
  assert.equal(call.calls[1].body.active_persona_id, "persona_home_0");
});

test("sendAsPersona: a 400 or 404 on the switch sends nothing and says the endpoint may have changed", async () => {
  for (const status of [400, 404]) {
    const gate = new K.RateGate({ max: 9, windowMs: 30000 });
    const call = gatedCall(gate, () => { throw httpErr(status, "unknown field"); });
    let sent = false;
    await assert.rejects(
      K.sendAsPersona({ call, ai_id: AI, persona: GATOR, home: HOME, send: async () => { sent = true; } }),
      (e) => e.kind === "persona_switch" && e.posted === false && /isn't documented/.test(e.message) && /Nothing was sent/.test(e.message)
    );
    assert.equal(sent, false);
    assert.equal(call.calls.length, 1, "no switch-back needed when the switch never happened");
  }
});

test("sendAsPersona reports a failed switch-back without hiding the reply", async () => {
  const gate = new K.RateGate({ max: 9, windowMs: 30000 });
  const call = gatedCall(gate, (p, b, n) => { if (n === 2) throw httpErr(500, "oops"); return ""; });
  const r = await K.sendAsPersona({ call, ai_id: AI, persona: GATOR, home: HOME, send: async () => "reply" });
  assert.equal(r.result, "reply");
  assert.equal(r.restored, false);
  assert.ok(r.restoreError.length > 0);
});

test("sendAsPersona refuses without a switch-back persona or AI ID", async () => {
  const call = gatedCall(new K.RateGate());
  await assert.rejects(K.sendAsPersona({ call, ai_id: AI, persona: GATOR, home: null, send: async () => 1 }), (e) => e.kind === "persona_switch" && /Switch back/.test(e.message));
  await assert.rejects(K.sendAsPersona({ call, ai_id: "", persona: GATOR, home: HOME, send: async () => 1 }), (e) => e.kind === "persona_switch");
  assert.equal(call.calls.length, 0);
});

test("two persona sends never interleave their switch / switch-back", async () => {
  const gate = new K.RateGate({ max: 50, windowMs: 30000 });
  const log = [];
  const call = gatedCall(gate, (p, b) => { log.push("upd:" + b.active_persona_id); });
  const slow = (tag) => async () => { log.push("send:" + tag); await new Promise((r) => setTimeout(r, 30)); return tag; };
  await Promise.all([
    K.sendAsPersona({ call, ai_id: AI, persona: GATOR, home: HOME, send: slow("a") }),
    K.sendAsPersona({ call, ai_id: AI, persona: { ...GATOR, kindroidPersonaId: "persona_other" }, home: HOME, send: slow("b") })
  ]);
  assert.deepEqual(log, [
    "upd:persona_gator_1", "send:a", "upd:persona_home_0",
    "upd:persona_other", "send:b", "upd:persona_home_0"
  ]);
});

test("learnedContextBody: all three fields plus revision, length caps, whole-number revision", () => {
  const ok = K.learnedContextBody(AI, { growth: "g", importantFacts: "f", ongoingThreads: "" }, "7");
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.body)), { ai_id: AI, developed_context: { self_relationship: "g", durable_facts: "f", ongoing_context: "" }, developed_context_revision: 7 });
  const long = K.learnedContextBody(AI, { growth: "x".repeat(801), importantFacts: "", ongoingThreads: "" }, 1);
  assert.equal(long.ok, false);
  assert.match(long.problems.join(" "), /Growth & relationship is 801 characters; the limit is 800/);
  assert.equal(K.learnedContextBody(AI, {}, "abc").ok, false);
  assert.equal(K.learnedContextBody(AI, {}, "-1").ok, false);
  assert.equal(K.learnedContextBody("kn_abcdefghijkl", {}, 1).ok, false);
  assert.deepEqual([...K.LEARNED_FIELDS.map((f) => f.max)], [800, 1200, 800]);
  assert.equal(K.LEARNED_REVISION_GUESS, 0);
});

test("pushLearnedContext: success sends one update-info through the limiter", async () => {
  const gate = new K.RateGate({ max: 9, windowMs: 30000 });
  const call = gatedCall(gate);
  const r = await K.pushLearnedContext({ call, ai_id: AI, fields: { growth: "a", importantFacts: "b", ongoingThreads: "c" }, revision: 3 });
  assert.equal(r.ok, true);
  assert.equal(call.calls.length, 1);
  assert.equal(call.calls[0].path, "/update-info");
  assert.equal(call.calls[0].body.developed_context_revision, 3);
  assert.equal(gate.snapshot().used, 1);
});

test("pushLearnedContext: 409 explains plainly and picks up a revision if Kindroid sends one", async () => {
  const call = gatedCall(new K.RateGate(), () => { throw httpErr(409, "Learned context changed while you were editing it"); });
  const r = await K.pushLearnedContext({ call, ai_id: AI, fields: {}, revision: 3 });
  assert.equal(r.state, "conflict");
  assert.equal(r.serverRevision, null);
  assert.match(r.message, /changed since revision 3/);
  assert.match(r.message, /Nothing was changed/);
  assert.doesNotMatch(r.message, /rewound/);
  const call2 = gatedCall(new K.RateGate(), () => { throw httpErr(409, '{"error":"Learned context changed","developed_context_revision":12}'); });
  const r2 = await K.pushLearnedContext({ call: call2, ai_id: AI, fields: {}, revision: 3 });
  assert.equal(r2.serverRevision, 12);
  assert.equal(K.revisionFromBody("current revision: 44"), 44);
  assert.equal(K.revisionFromBody("nothing here"), null);
});

test("pushLearnedContext: 400 says the endpoint may have changed; invalid input never calls Kindroid", async () => {
  const call = gatedCall(new K.RateGate(), () => { throw httpErr(400, "bad"); });
  const r = await K.pushLearnedContext({ call, ai_id: AI, fields: {}, revision: 1 });
  assert.equal(r.state, "bad_request");
  assert.match(r.message, /isn't documented/);
  const call2 = gatedCall(new K.RateGate());
  const r2 = await K.pushLearnedContext({ call: call2, ai_id: AI, fields: { importantFacts: "x".repeat(1201) }, revision: 1 });
  assert.equal(r2.state, "invalid");
  assert.equal(call2.calls.length, 0);
});

test("error messages never include the API key", async () => {
  const key = "kn_TESTKEY_DO_NOT_SHIP_abcdefghijklmnop";
  const call = gatedCall(new K.RateGate(), () => { throw new Error("boom Bearer " + key); });
  const r = await K.pushLearnedContext({ call, ai_id: AI, fields: {}, revision: 1 });
  assert.doesNotMatch(r.message, /TESTKEY/);
  await assert.rejects(
    K.sendAsPersona({ call, ai_id: AI, persona: GATOR, home: HOME, send: async () => 1 }),
    (e) => !/TESTKEY/.test(e.message)
  );
});

test("phone.html wires Talk as and the Learned context editor", () => {
  for (const id of ["chatTalkAs", "gTalkAs", "peKindroidId", "peIsHome", "btnPersonaRestore", "cLcRev", "btnPushLearned", "lcHistory", "btnLcUseRev"]) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
  assert.match(html, /KinClient\.sendAsPersona\(/);
  assert.match(html, /KinClient\.pushLearnedContext\(/);
  assert.match(html, /function talkAsWarnOk/);
  assert.match(html, /changes your persona everywhere in your Kindroid account/);
  assert.match(html, /e\.body = kinRedact/);
  // Talk as goes through kinRaw, so every switch takes a slot from the shared limiter.
  assert.match(html, /call:function\(path, body\)\{ return kinRaw\('POST', path, body/);
  // Normal "Push to Kindroid" still never sends learned context.
  assert.doesNotMatch(html, /body\.developed_context\s*=/);
});
