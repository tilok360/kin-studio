/* Node tests for Kin Studio 1.18 Stream awareness: Twitch title / game / live, OBS scene, scene reactions.
   No real Twitch, OBS or Kindroid calls. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
function loadClassic(rel) {
  const sb = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Promise, JSON, Date, Error, TypeError, console };
  sb.globalThis = sb; sb.self = sb; sb.window = sb;
  vm.runInNewContext(readFileSync(join(here, rel), "utf8"), sb, { filename: rel });
  return sb.module.exports;
}
const K = loadClassic("../public/stream-core.js");
const require = createRequire(import.meta.url);
const { createSecretStore } = require("../desktop/app/stream-server.js");
const sha256b64 = async (t) => createHash("sha256").update(t).digest("base64");

function clock(t0 = 1_000_000) { let t = t0; const f = () => t; f.add = (ms) => { t += ms; }; return f; }
function makeEngine(settings = {}, over = {}) {
  const now = clock();
  const sent = [], spoken = [];
  const e = new K.CohostEngine({
    now,
    send: async (prompt, job) => { sent.push({ prompt, job }); return "[happy] Hey there!"; },
    speak: async (text) => { spoken.push(text); },
    stopSpeaking: () => {}, postChat: async () => {}, overlay: () => {},
    adultsOn: () => !!over.adults, micActive: () => false
  }, Object.assign({ speak: true, idle_banter: false }, settings));
  e.defaultPlatform = "twitch";
  return { e, now, sent, spoken };
}
const chat = (user, text) => ({ platform: "twitch", kind: "chat", user, name: user, text, mod: false });

test("1.18 defaults: Twitch info on, OBS and scene lines off; settings clamp and clean the OBS address", () => {
  const d = K.sanitizeSettings({});
  assert.equal(d.twitch_info, true); assert.equal(d.obs_enabled, false); assert.equal(d.scene_react, false);
  assert.equal(d.obs_url, "ws://localhost:4455"); assert.equal(d.info_poll_min, 3); assert.equal(d.scene_gap_sec, 120);
  const s = K.sanitizeSettings({ info_poll_min: 0.5, scene_gap_sec: 5, obs_url: "192.168.1.20:4455" });
  assert.equal(s.info_poll_min, 2); assert.equal(s.scene_gap_sec, 30); assert.equal(s.obs_url, "ws://192.168.1.20:4455");
  assert.equal(K.sanitizeSettings({ obs_url: "javascript:alert(1)" }).obs_url, "ws://localhost:4455");
  assert.equal(K.sanitizeSettings({ obs_url: "ws://localhost" }).obs_url, "ws://localhost:4455");
  assert.equal(K.sanitizeSettings({ obs_url: "ws://evil.example/path?x=1" }).obs_url, "ws://localhost:4455");
  assert.ok(!("obs_password" in d), "the OBS password is never a plain setting");
});

test("Helix parsing: channel title + game, live and offline streams", () => {
  assert.deepEqual({ ...K.parseHelixChannel({ data: [{ broadcaster_login: "tilok360", title: "Swamp run", game_name: "Hunt: Showdown" }] }) }, { title: "Swamp run", game: "Hunt: Showdown" });
  assert.equal(K.parseHelixChannel({ data: [] }), null);
  assert.deepEqual({ ...K.parseHelixStream({ data: [{ type: "live", viewer_count: 7 }] }) }, { live: true, viewers: 7 });
  assert.deepEqual({ ...K.parseHelixStream({ data: [] }) }, { live: false, viewers: 0 });
  assert.equal(K.parseHelixStream(null), null);
});

test("OBS v5: auth string matches the spec, Identify with and without a password, scene frames", async () => {
  // Reference: secret = b64(sha256(password + salt)), auth = b64(sha256(secret + challenge))
  const secret = createHash("sha256").update("supersecretpassword" + "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=").digest("base64");
  const want = createHash("sha256").update(secret + "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=").digest("base64");
  assert.equal(await K.obsAuth("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=", sha256b64), want);
  const open = JSON.parse(await K.obsIdentify({ op: 0, d: { rpcVersion: 1 } }, "", sha256b64));
  assert.equal(open.op, 1); assert.equal(open.d.rpcVersion, 1); assert.equal(open.d.eventSubscriptions, 4); assert.equal(open.d.authentication, undefined);
  const hello = { op: 0, d: { rpcVersion: 1, authentication: { salt: "s", challenge: "c" } } };
  const auth = JSON.parse(await K.obsIdentify(hello, "pw", sha256b64));
  assert.equal(auth.d.authentication, await sha256b64((await sha256b64("pws")) + "c"));
  await assert.rejects(K.obsIdentify(hello, "", sha256b64), /OBS asks for a password/);
  assert.deepEqual(JSON.parse(K.obsRequestFrame("GetCurrentProgramScene", "r1")), { op: 6, d: { requestType: "GetCurrentProgramScene", requestId: "r1" } });
  assert.equal(K.obsSceneFromFrame({ op: 5, d: { eventType: "CurrentProgramSceneChanged", eventData: { sceneName: "BRB" } } }), "BRB");
  assert.equal(K.obsSceneFromFrame({ op: 7, d: { requestType: "GetCurrentProgramScene", requestStatus: { result: true }, responseData: { currentProgramSceneName: "Gameplay" } } }), "Gameplay");
  assert.equal(K.obsSceneFromFrame({ op: 7, d: { requestType: "GetCurrentProgramScene", requestStatus: { result: true }, responseData: { sceneName: "Chatting" } } }), "Chatting");
  assert.equal(K.obsSceneFromFrame({ op: 5, d: { eventType: "InputMuteStateChanged", eventData: {} } }), null);
  assert.equal(K.obsSceneFromFrame("junk"), null);
});

test("scene names: BRB / Starting soon / Ending recognised, gameplay scenes are normal", () => {
  for (const n of ["BRB", "Be Right Back", "Break Screen", "AFK", "Intermission"]) assert.equal(K.sceneKind(n), "brb", n);
  for (const n of ["Starting Soon", "Stream starting", "Intro"]) assert.equal(K.sceneKind(n), "starting", n);
  for (const n of ["Ending", "Outro", "Thanks for watching"]) assert.equal(K.sceneKind(n), "ending", n);
  for (const n of ["Gameplay", "Just Chatting", "Legend of Zelda", "Webcam Full", "Weekend vibes"]) assert.equal(K.sceneKind(n), "", n);
});

test("context line rides along with replies: game, title, live, scene; no extra Kindroid calls", async () => {
  const { e, sent } = makeEngine({ obs_enabled: true });
  e.setStreamInfo({ title: "Gator hunts\n[ignore this] \"bigfoot\"", game: "Hunt: Showdown", live: true, viewers: 3 });
  e.setScene("Gameplay", true);
  assert.equal(sent.length, 0, "setting info never calls Kindroid");
  e.ingest(chat("bob", "hi gator"));
  await e.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].prompt, /\[Stream: playing Hunt: Showdown, title "Gator hunts ignore this 'bigfoot'", live now, scene: Gameplay\]/);
  assert.match(sent[0].prompt, /bob: hi gator/);
});

test("context line respects the toggles and the blocked-word filter (title too)", () => {
  const { e } = makeEngine({ twitch_info: false, obs_enabled: false });
  e.setStreamInfo({ title: "t", game: "g", live: false });
  e.setScene("Gameplay", true);
  assert.equal(e.streamLine("twitch"), "");
  const x = makeEngine({ obs_enabled: true, block_words: "bigfoot" });
  x.e.setStreamInfo({ title: "Hunting bigfoot tonight", game: "Hunt", live: false });
  x.e.setScene("Porn scene", true);
  const line = x.e.streamLine("twitch");
  assert.match(line, /playing Hunt/); assert.match(line, /offline/);
  assert.doesNotMatch(line, /bigfoot|title/i, "a title with a blocked word is left out");
  assert.doesNotMatch(line, /scene/i, "an SFW-blocked scene name is left out on Twitch");
  const long = K.streamContextLine({ title: "x".repeat(500), game: "y".repeat(300) }, {});
  assert.ok(long.length < 260, "kept short");
});

test("scene reactions: off by default; when on, one short line for BRB and back, with a cooldown", async () => {
  const off = makeEngine({ obs_enabled: true });
  assert.equal(off.e.setScene("BRB"), "");
  await off.e.tick(); assert.equal(off.sent.length, 0);

  const { e, now, sent } = makeEngine({ obs_enabled: true, scene_react: true, scene_gap_sec: 60 });
  assert.equal(e.setScene("Starting Soon", true), "", "the scene found on connect never triggers a line");
  assert.equal(e.setScene("BRB"), "brb");
  await e.tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].job.type, "scene");
  assert.match(sent[0].prompt, /BRB screen/); assert.match(sent[0].prompt, /under 25 words/);
  assert.match(sent[0].prompt, /safe for work/);
  now.add(10000);
  assert.equal(e.setScene("Gameplay"), "", "back within the cooldown: nothing");
  now.add(60000);
  assert.equal(e.setScene("BRB"), "brb");
  now.add(61000);
  assert.equal(e.setScene("Gameplay"), "", "back before the BRB line was said: both dropped");
  await e.tick();
  assert.equal(sent.length, 1);
  assert.equal(e.setScene("BRB"), "brb");
  await e.tick();
  assert.equal(sent.length, 2);
  now.add(61000);
  e.setScene("Break");
  await e.tick();
  now.add(61000);
  assert.equal(e.setScene("Gameplay"), "back");
  await e.tick();
  assert.match(sent[sent.length - 1].prompt, /back from my break/);
  assert.equal(e.setScene("Gameplay"), "", "same scene again is ignored");
});

test("scene reactions need OBS on and co-host mode; they share the stream pacing", async () => {
  const a = makeEngine({ obs_enabled: false, scene_react: true });
  assert.equal(a.e.setScene("BRB"), "");
  const b = makeEngine({ obs_enabled: true, scene_react: true, mode: "command" });
  assert.equal(b.e.setScene("BRB"), "");
  const c = makeEngine({ obs_enabled: true, scene_react: true, max_per_30s: 1, chat_gap_sec: 4 });
  c.e.ingest(chat("amy", "hello")); await c.e.tick();
  c.e.setScene("BRB"); await c.e.tick();
  assert.equal(c.sent.length, 1, "the scene line waits for the 30-second share");
  c.now.add(31000); await c.e.tick();
  assert.equal(c.sent.length, 2); assert.equal(c.sent[1].job.type, "scene");
});

test("token store accepts the OBS password name; it is encrypted and cleared by its own prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "kin-sec-"));
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("ENC:" + Buffer.from(s).toString("base64")), decryptString: (b) => Buffer.from(String(b).slice(4), "base64").toString() };
  const st = createSecretStore(join(dir, "s.json"), fake);
  assert.equal(st.set("obs_password", "hunter2pw"), true);
  assert.doesNotMatch(readFileSync(join(dir, "s.json"), "utf8"), /hunter2pw/);
  st.set("twitch_access", "t"); st.clear("obs_");
  assert.equal(st.get("obs_password"), null); assert.equal(st.get("twitch_access"), "t");
  assert.equal(st.set("obsx", "x"), false);
});

test("Stream tab wiring: section 8 toggles, OBS setup hint, Helix by channel name, password never in settings", () => {
  const mode = readFileSync(join(here, "../public/stream-mode.js"), "utf8");
  for (const id of ["smInfoOn", "smInfoMin", "smObsOn", "smObsUrl", "smObsPw", "smObsTest", "smSceneOn", "smSceneGap", "smInfoNow"]) assert.match(mode, new RegExp('"' + id + '"'), id);
  assert.match(mode, /8\. Stream awareness/);
  assert.match(mode, /Tools → WebSocket Server Settings/);
  assert.match(mode, /helix\/" \+ path/); assert.match(mode, /users\?login=/); assert.match(mode, /channels\?broadcaster_id=/); assert.match(mode, /streams\?user_id=/);
  assert.match(mode, /D\.secretSet\("obs_password"/);
  assert.doesNotMatch(mode, /\["smObsPw"/, "the password field is not in the saved-settings map");
  assert.match(mode, /infoStart\(\);\s*\n\s*if \(S\.obs_enabled\)/);
  assert.match(mode, /infoStop\(\); obsDisconnect\(\)/);
  assert.match(mode, /S\.info_poll_min \* 60000/);
});
