/* Node tests for Kin Studio 1.17 Stream mode. No real Twitch, Joystick or Kindroid calls. */
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
function loadClassic(rel) {
  const sb = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal,
    TextDecoder, TextEncoder, ReadableStream, fetch, Headers, Promise, JSON, Date, Error, TypeError, console };
  sb.globalThis = sb; sb.self = sb; sb.window = sb;
  vm.runInNewContext(readFileSync(join(here, rel), "utf8"), sb, { filename: rel });
  return sb.module.exports;
}
const K = loadClassic("../public/stream-core.js");
const KinClient = loadClassic("../public/kin-client.js");
const require = createRequire(import.meta.url);
const { createStreamServer, createSecretStore, streamHttp } = require("../desktop/app/stream-server.js");

/* ---------- parsing ---------- */
test("Twitch IRC: chat with tags, escaped values, mod + first message", () => {
  const m = K.parseIrcLine("@badges=moderator/1,subscriber/12;display-name=Some\\sOne;first-msg=1;id=abc;mod=1;subscriber=1 :someone!someone@someone.tmi.twitch.tv PRIVMSG #chris :!kin how are you?");
  assert.equal(m.command, "PRIVMSG");
  assert.equal(m.tags["display-name"], "Some One");
  const ev = K.twitchEventFromIrc(m);
  assert.equal(ev.kind, "chat"); assert.equal(ev.user, "someone"); assert.equal(ev.mod, true); assert.equal(ev.first, true); assert.equal(ev.subscriber, true);
  assert.equal(ev.text, "!kin how are you?");
});
test("Twitch IRC: bits, subs, gift subs, raids, /me", () => {
  const bits = K.twitchEventFromIrc(K.parseIrcLine("@bits=100;display-name=Bitty :bitty!b@b PRIVMSG #c :Cheer100 great run"));
  assert.equal(bits.kind, "bits"); assert.equal(bits.amount, 100); assert.equal(bits.text, "great run");
  const sub = K.twitchEventFromIrc(K.parseIrcLine("@msg-id=resub;display-name=Sam;login=sam;msg-param-cumulative-months=7 :tmi.twitch.tv USERNOTICE #c :love it"));
  assert.equal(sub.kind, "sub"); assert.equal(sub.amount, 7); assert.equal(sub.name, "Sam");
  const gift = K.twitchEventFromIrc(K.parseIrcLine("@msg-id=submysterygift;display-name=Gifter;login=gifter;msg-param-mass-gift-count=5 :tmi.twitch.tv USERNOTICE #c"));
  assert.equal(gift.kind, "gift"); assert.equal(gift.amount, 5);
  const raid = K.twitchEventFromIrc(K.parseIrcLine("@msg-id=raid;display-name=Raider;login=raider;msg-param-displayName=Raider;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #c"));
  assert.equal(raid.kind, "raid"); assert.equal(raid.amount, 42);
  const me = K.twitchEventFromIrc(K.parseIrcLine(":a!a@a PRIVMSG #c :\u0001ACTION waves\u0001"));
  assert.equal(me.text, "waves");
  assert.equal(K.twitchEventFromIrc(K.parseIrcLine("PING :tmi.twitch.tv")), null);
});
test("Twitch EventSub: channel.follow notification", () => {
  const ev = K.twitchEventFromEventSub({ metadata: { message_type: "notification", message_id: "x" }, payload: { subscription: { type: "channel.follow" }, event: { user_login: "newbie", user_name: "Newbie" } } });
  assert.equal(ev.kind, "follow"); assert.equal(ev.name, "Newbie");
  assert.equal(K.twitchEventFromEventSub({ metadata: { message_type: "session_keepalive" } }), null);
});
test("Joystick: v2 chat, tip, follow, sub; v1 chat; pings ignored; frames", () => {
  const chat = K.joystickEventFromFrame({ message: { v: 2, type: "new_message", id: "m1", channel_id: "ch", text: "hello chat", data: { author: { username: "someviewer", nickname: null, badges: { mod: false, subscriber: true, bot: false } }, text: "hello chat" } } });
  assert.equal(chat.kind, "chat"); assert.equal(chat.user, "someviewer"); assert.equal(chat.text, "hello chat"); assert.equal(chat.channel_id, "ch");
  const tip = K.joystickEventFromFrame({ message: { v: 2, type: "tipped", data: { who: "BusTester", how_much: 50, tip_menu_item: "Hydrate" } } });
  assert.equal(tip.kind, "tip"); assert.equal(tip.amount, 50); assert.equal(tip.text, "Hydrate");
  assert.equal(K.joystickEventFromFrame({ message: { v: 2, type: "followed", data: { who: "F" } } }).kind, "follow");
  assert.equal(K.joystickEventFromFrame({ message: { v: 2, type: "subscribed", data: { who: "S" } } }).kind, "sub");
  const v1 = K.joystickEventFromFrame({ message: { event: "ChatMessage", type: "new_message", text: "old style", author: { username: "Old" } } });
  assert.equal(v1.kind, "chat"); assert.equal(v1.text, "old style");
  assert.equal(K.joystickEventFromFrame({ type: "ping", message: 1782000000 }), null);
  assert.equal(K.joystickEventFromFrame({ message: { v: 2, type: "wheel_spin_claimed", data: {} } }), null);
  const sub = JSON.parse(K.joystickSubscribeFrame());
  assert.equal(sub.command, "subscribe"); assert.deepEqual(JSON.parse(sub.identifier), { channel: "GatewayChannel", event_version: "v2" });
  const send = JSON.parse(K.joystickSendFrame("ch", "hi"));
  assert.deepEqual(JSON.parse(send.data), { action: "send_message", text: "hi", channel_id: "ch" });
});
test("!kin command parsing", () => {
  assert.equal(K.parseCommand("!kin hello there", "!kin"), "hello there");
  assert.equal(K.parseCommand("!KIN Hi", "!kin"), "Hi");
  assert.equal(K.parseCommand("!kin", "!kin"), "");
  assert.equal(K.parseCommand("!kinda cool", "!kin"), null);
  assert.equal(K.parseCommand("hi !kin", "!kin"), null);
});

/* ---------- filter + gating ---------- */
test("word filter: slurs always, SFW list on Twitch, leetspeak and spaced letters, no false hits", () => {
  const sfw = K.makeFilter({ sfw: true }), adult = K.makeFilter({ sfw: false, extra: "spoilers, malenia dies" });
  for (const bad of ["you're s3xy", "f u c k this", "F.U.C.K", "send nudes", "n1gg3r"]) assert.equal(sfw.check(bad).ok, false, bad);
  for (const ok of ["striped shirt", "a cocktail", "grape juice", "Dickens is great", "assassin's creed", "hello chat"]) assert.equal(sfw.check(ok).ok, true, ok);
  assert.equal(adult.check("you're sexy").ok, true);
  assert.equal(adult.check("f4ggot").ok, false);
  assert.equal(adult.check("no SPOILERS please").ok, false);
  assert.equal(adult.check("malenia dies soon").ok, false);
});
test("gating: Twitch always SFW; Joystick adult only with the existing 18+ switch", () => {
  assert.equal(K.isSfw("twitch", true), true);
  assert.equal(K.isSfw("twitch", false), true);
  assert.equal(K.isSfw("joystick", false), true);
  assert.equal(K.isSfw("joystick", true), false);
  assert.match(K.gatingInstruction("twitch", true), /safe for work/);
  assert.match(K.gatingInstruction("joystick", true), /18\+/);
  assert.match(K.gatingInstruction("stream", true), /safe for work/);
});
test("bad replies: '<' bodies (HTTP 200 generation fail / HTML) and empty", () => {
  assert.equal(K.isBadReply("< >"), "generation");
  assert.equal(K.isBadReply("<html>error</html>"), "generation");
  assert.equal(K.isBadReply("   "), "empty");
  assert.equal(K.isBadReply("Hi chat"), "");
});
test("emotion tags and keyword fallback", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(K.extractEmotion("[happy] Welcome in, Sam!"))), { emotion: "happy", text: "Welcome in, Sam!" });
  assert.equal(K.extractEmotion("[Laughing] lol").emotion, "laugh");
  assert.equal(K.extractEmotion("Whoa, no way you did that").emotion, "surprised");
  assert.equal(K.extractEmotion("Just a normal line.").emotion, "neutral");
});
test("chat output: Twitch 500 limit, no leading command, no actions", () => {
  const long = ("word ".repeat(200)).trim();
  const out = K.forChat(long, "twitch");
  assert.ok(out.length <= 500); assert.ok(out.endsWith("…"));
  assert.equal(K.forChat("/ban someone", "twitch"), "ban someone");
  assert.equal(K.forChat("*waves* hi chat", "joystick"), "hi chat");
});
test("settings sanitize: clamps rate share, cleans channel and ids", () => {
  const s = K.sanitizeSettings({ max_per_30s: 50, twitch_channel: "https://twitch.tv/Tilok360/videos", twitch_client_id: " abc 123 ", mode: "weird", command: "  !ask me " });
  assert.equal(s.max_per_30s, 8); assert.equal(s.twitch_channel, "tilok360"); assert.equal(s.twitch_client_id, "abc123"); assert.equal(s.mode, "cohost"); assert.equal(s.command, "!ask");
});
test("1.17 defaults: Kin Studio's Twitch Client ID, Twitch on, Joystick off unless a Joystick Client ID is set", () => {
  const d = K.sanitizeSettings({});
  assert.equal(d.twitch_client_id, "zqz75ysyudsfui05fioi6nxtocfxtb");
  assert.equal(d.twitch_enabled, true);
  assert.equal(K.sanitizeSettings({ joystick_enabled: true }).joystick_enabled, false);
  assert.equal(K.sanitizeSettings({ joystick_enabled: true, joystick_client_id: "0000-abcd" }).joystick_enabled, true);
});
test("redaction hides tokens", () => {
  const r = K.redactStream("PASS oauth:abcdef123 token=xyz Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdEFGH kn_supersecretkey");
  assert.doesNotMatch(r, /abcdef123|xyz|supersecret|eyJhbGci/);
});

/* ---------- engine ---------- */
function clock(t0 = 1_000_000) { let t = t0; const f = () => t; f.add = (ms) => { t += ms; }; return f; }
function makeEngine(settings = {}, over = {}) {
  const now = clock();
  const sent = [], spoken = [], posted = [], overlay = [];
  const deps = Object.assign({
    now,
    send: async (prompt, job) => { sent.push({ prompt, job }); return over.reply ? over.reply(prompt, job) : "[happy] Hey there!"; },
    speak: async (text, emo) => { spoken.push({ text, emo }); },
    stopSpeaking: () => {},
    postChat: async (p, t) => { posted.push({ p, t }); },
    overlay: (e) => overlay.push(e),
    adultsOn: () => !!over.adults,
    micActive: () => !!over.mic,
    limiter: over.limiter
  }, over.deps || {});
  const e = new K.CohostEngine(deps, Object.assign({ speak: true }, settings));
  return { e, now, sent, spoken, posted, overlay };
}
const chat = (user, text, extra = {}) => Object.assign({ platform: "twitch", kind: "chat", user, name: user[0].toUpperCase() + user.slice(1), text, mod: false }, extra);

test("command mode: only !kin, viewer name in prompt, SFW on Twitch, cooldown, queue cap", async () => {
  const { e, now, sent, spoken } = makeEngine({ mode: "command", user_cooldown_sec: 20, max_queue: 2 }, { adults: true });
  assert.equal(e.ingest(chat("bob", "just chatting")), "not_command");
  assert.equal(e.ingest(chat("bob", "!kin tell me a joke")), "");
  assert.equal(e.ingest(chat("bob", "!kin again")), "cooldown");
  assert.equal(e.ingest(chat("amy", "!kin hi")), "");
  assert.equal(e.ingest(chat("cat", "!kin hi")), "queue_full");
  await e.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].prompt, /Bob asked you directly: tell me a joke/);
  assert.match(sent[0].prompt, /safe for work/);
  assert.equal(spoken[0].text, "Hey there!"); assert.equal(spoken[0].emo, "happy");
  now.add(21000);
  assert.equal(e.ingest(chat("bob", "!kin again")), "");
});
test("co-host: batches chat lines by name, keeps newest, notes skipped ones", async () => {
  const { e, sent } = makeEngine({ batch_max_lines: 3 });
  ["a1", "b2", "c3", "d4", "e5"].forEach((t, i) => e.ingest(chat("user" + i, "message " + t)));
  await e.tick();
  assert.equal(sent.length, 1);
  const p = sent[0].prompt;
  assert.match(p, /User4: message e5/); assert.match(p, /User2: message c3/);
  assert.doesNotMatch(p, /message a1/);
  assert.match(p, /2 older messages scrolled past/);
  assert.match(p, /talk to them by name/);
});
test("co-host: first-timer greeting and alerts are batched into one thank-you", async () => {
  const { e, sent } = makeEngine({ chat_gap_sec: 600 });
  e.ingest(chat("newbie", "hi everyone", { first: true }));
  e.ingest({ platform: "twitch", kind: "follow", user: "f1", name: "F1" });
  e.ingest({ platform: "twitch", kind: "bits", user: "b1", name: "B1", amount: 500 });
  e.ingest({ platform: "twitch", kind: "raid", user: "r1", name: "R1", amount: 12 });
  await e.tick();
  assert.equal(sent[0].job.type, "events");
  const p = sent[0].prompt;
  assert.match(p, /Newbie is chatting for the first time/); assert.match(p, /F1 just followed/); assert.match(p, /B1 cheered 500 bits/); assert.match(p, /R1 raided with 12 viewers/);
});
test("events respect their on/off switches", () => {
  const { e } = makeEngine({ thank_bits: false, thank_follows: false });
  assert.equal(e.ingest({ platform: "twitch", kind: "bits", user: "b", name: "B", amount: 5 }), "event_off");
  assert.equal(e.ingest({ platform: "twitch", kind: "follow", user: "f", name: "F" }), "event_off");
  assert.equal(e.ingest({ platform: "twitch", kind: "sub", user: "s", name: "S", amount: 1 }), "");
});
test("idle banter after quiet period, with game context", async () => {
  const { e, now, sent } = makeEngine({ idle_sec: 60, game_context: "Playing Elden Ring" });
  await e.tick(); assert.equal(sent.length, 0);
  now.add(61000);
  await e.tick();
  assert.equal(sent[0].job.type, "idle");
  assert.match(sent[0].prompt, /quiet/); assert.match(sent[0].prompt, /Elden Ring/);
});
test("pacing: never more than max_per_30s, and waits when the shared limiter is full", async () => {
  const { e, now, sent } = makeEngine({ max_per_30s: 2, chat_gap_sec: 4, idle_banter: false });
  for (let i = 0; i < 5; i++) { e.ingest(chat("u" + i, "line " + i)); await e.tick(); now.add(5000); }
  assert.equal(sent.length, 2);
  now.add(30000); e.ingest(chat("z", "later")); await e.tick();
  assert.equal(sent.length, 3);
  // Shared limiter (KinClient.limiter) full -> stream mode does not send.
  const L = new KinClient.RateGate({ now });
  for (let i = 0; i < 9; i++) L.mark();
  const x = makeEngine({ idle_banter: false }, { limiter: L });
  x.e.ingest(chat("a", "hello")); await x.e.tick();
  assert.equal(x.sent.length, 0);
});
test("reply filter: blocked reply is not spoken, shown or posted", async () => {
  const { e, spoken, posted, overlay } = makeEngine({ mode: "command", post_to_chat: true }, { reply: () => "[happy] send nudes lol" });
  e.ingest(chat("bob", "!kin hi")); await e.tick();
  assert.equal(spoken.length, 0); assert.equal(posted.length, 0);
  assert.equal(overlay.filter((o) => o.type === "caption").length, 0);
  assert.equal(e.stats.filtered, 1);
});
test("chat filter: blocked messages and blocked users never reach Kindroid; bad names become 'a viewer'", async () => {
  const { e, sent } = makeEngine({ block_users: "trolly", block_words: "spoiler" });
  assert.equal(e.ingest(chat("bob", "you're a f4ggot")), "filtered");
  assert.equal(e.ingest(chat("trolly", "hello")), "blocked_user");
  assert.equal(e.ingest(chat("amy", "huge SPOILER ahead")), "filtered");
  assert.equal(e.ingest(chat("fuckboy99", "hi kin", { name: "fuckboy99" })), "");
  await e.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].prompt, /a viewer: hi kin/);
  assert.doesNotMatch(sent[0].prompt, /fuckboy|trolly|f4ggot|SPOILER/i);
});
test("mod-only and allow list", () => {
  const { e } = makeEngine({ mode: "command", mod_only: true, allow_users: "vip1", user_cooldown_sec: 0 });
  assert.equal(e.ingest(chat("pleb", "!kin hi")), "mod_only");
  assert.equal(e.ingest(chat("vip1", "!kin hi")), "");
  assert.equal(e.ingest(chat("modguy", "!kin hi", { mod: true })), "");
  const b = makeEngine({ mode: "command", allowlist_only: true, allow_users: "vip1" }).e;
  assert.equal(b.ingest(chat("pleb", "!kin hi")), "not_allowed");
});
test("Joystick replies: adult allowed only when the 18+ switch is on", async () => {
  const on = makeEngine({ mode: "command" }, { adults: true, reply: () => "[laugh] you're sexy" });
  on.e.ingest(Object.assign(chat("bob", "!kin flirt"), { platform: "joystick" })); await on.e.tick();
  assert.match(on.sent[0].prompt, /18\+ Joystick/); assert.equal(on.spoken.length, 1);
  const off = makeEngine({ mode: "command" }, { adults: false, reply: () => "[laugh] you're sexy" });
  off.e.ingest(Object.assign(chat("bob", "!kin flirt"), { platform: "joystick" })); await off.e.tick();
  assert.match(off.sent[0].prompt, /safe for work/); assert.equal(off.spoken.length, 0);
  const tw = makeEngine({ mode: "command" }, { adults: true, reply: () => "[laugh] you're sexy" });
  tw.e.ingest(chat("bob", "!kin flirt")); await tw.e.tick();
  assert.equal(tw.spoken.length, 0);
});
test("'<' reply = failure, 429 holds 30 s, 401/403 stop with a clear message", async () => {
  const a = makeEngine({ mode: "command", user_cooldown_sec: 0 }, { reply: () => "< >" });
  a.e.ingest(chat("bob", "!kin hi")); const r = await a.e.tick();
  assert.equal(r.error, true); assert.equal(a.spoken.length, 0);
  const rl = makeEngine({ mode: "command", user_cooldown_sec: 0 }, { reply: () => { const e = new Error("429"); e.kind = "rate_limit"; e.status = 429; throw e; } });
  rl.e.ingest(chat("bob", "!kin hi")); await rl.e.tick();
  rl.e.ingest(chat("amy", "!kin hi")); rl.now.add(10000); await rl.e.tick();
  assert.equal(rl.sent.length, 1);
  rl.now.add(21000); await rl.e.tick();
  assert.equal(rl.sent.length, 2);
  const au = makeEngine({ mode: "command" }, { reply: () => { const e = new Error("401"); e.kind = "auth"; e.status = 401; throw e; } });
  const msgs = []; au.e.on((x) => msgs.push(x));
  au.e.ingest(chat("bob", "!kin hi")); await au.e.tick();
  assert.equal(au.e.state.stopped, true);
  assert.ok(msgs.some((m) => m.type === "stopped" && /401/.test(m.text)));
});
test("streamer controls: say-this jumps the line, pause, mute, mic ducking, test never posts", async () => {
  const { e, sent, spoken } = makeEngine({ chat_gap_sec: 4 });
  e.ingest(chat("bob", "hello")); e.say("Tell chat we're fighting the boss");
  await e.tick();
  assert.equal(sent[0].job.type, "say"); assert.match(sent[0].prompt, /fighting the boss/);
  e.pause(true); e.ingest(chat("amy", "hi")); await e.tick(); assert.equal(sent.length, 1);
  e.pause(false); e.mute(true); await e.tick(); assert.equal(sent.length, 2); assert.equal(spoken.length, 1);
  const d = makeEngine({ duck_on_mic: true }, { mic: true });
  d.e.ingest(chat("bob", "hello")); await d.e.tick(); assert.equal(d.sent.length, 0);
  const t = makeEngine({ post_to_chat: true });
  t.e.ingest(chat("tester", "test", { test: true })); await t.e.tick();
  assert.equal(t.sent.length, 1); assert.equal(t.posted.length, 0);
  const p = makeEngine({ post_to_chat: true });
  p.e.ingest(chat("viewer", "hey")); await p.e.tick();
  assert.equal(p.posted.length, 1); assert.equal(p.posted[0].p, "twitch");
});

/* ---------- whole pipeline with the real KinClient + shared limiter against a fake Kindroid ---------- */
async function fakeKindroid(handler) {
  const srv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(req, res, b)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
test("pipeline: chat -> filter -> shared limiter -> Kindroid send-message (Bearer, viewer name) -> voice + overlay", async () => {
  const seen = [];
  const k = await fakeKindroid((req, res, body) => { seen.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(body) }); res.writeHead(200, { "Content-Type": "text/plain" }); res.end("[happy] Hi TestViewer, I can hear you!"); });
  const L = new KinClient.RateGate();
  const before = L.snapshot().used;
  const spoken = [], overlay = [];
  const e = new K.CohostEngine({
    limiter: L,
    send: async (prompt) => { await L.acquire(); const r = await KinClient.sendMessage({ apiKey: "kn_testkey_0123456789", ai_id: "kinAI123456", message: prompt, stream: false, apiBase: k.base }); return r.text; },
    speak: async (t, emo) => spoken.push({ t, emo }), overlay: (o) => overlay.push(o), adultsOn: () => false
  }, { speak: true });
  e.ingest({ platform: "twitch", kind: "chat", user: "kinstudio_test", name: "TestViewer", text: "Hey! can you hear me?", first: true, test: true });
  e.lastEventsAt = Date.now(); e.events = [];
  await e.tick();
  await k.close();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/send-message");
  assert.equal(seen[0].auth, "Bearer kn_testkey_0123456789");
  assert.equal(seen[0].body.ai_id, "kinAI123456");
  assert.match(seen[0].body.message, /TestViewer: Hey! can you hear me\?/);
  assert.equal(spoken[0].t, "Hi TestViewer, I can hear you!"); assert.equal(spoken[0].emo, "happy");
  assert.ok(overlay.some((o) => o.type === "caption" && /TestViewer/.test(o.text)));
  assert.equal(L.snapshot().used, before + 1, "one shared-limiter slot used");
});
test("pipeline: HTTP 200 '< >' and 403 from Kindroid", async () => {
  let mode = "lt";
  const k = await fakeKindroid((req, res) => { if (mode === "lt") { res.writeHead(200); res.end("< >"); } else { res.writeHead(403); res.end("forbidden"); } });
  const spoken = [];
  const e = new K.CohostEngine({ send: async (p) => (await KinClient.sendMessage({ apiKey: "kn_testkey_0123456789", ai_id: "kinAI123456", message: p, stream: false, apiBase: k.base })).text, speak: async (t) => spoken.push(t) }, { mode: "command", user_cooldown_sec: 0 });
  e.ingest(chat("bob", "!kin hi")); const r1 = await e.tick();
  assert.equal(r1.error, true); assert.equal(spoken.length, 0);
  mode = "403"; e.pacer.pausedUntil = 0;
  e.ingest(chat("amy", "!kin hi")); await e.tick();
  await k.close();
  assert.equal(e.state.stopped, true); assert.match(e.state.stopReason, /403/);
});

/* ---------- desktop overlay server + token store ---------- */
function get(port, path, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: host + ":" + port } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: b })); });
    req.on("error", reject); req.end();
  });
}
test("overlay server: pages, SSE pushes, avatar images, OAuth callback, host check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kin-stream-"));
  writeFileSync(join(dir, "idle.png"), Buffer.from([137, 80, 78, 71]));
  const calls = [];
  const srv = createStreamServer({ overlayFile: join(here, "../public/stream-overlay.html"), avatarDir: dir, basePort: 47930, onOAuthCallback: (q) => calls.push(q) });
  const port = await srv.listen();
  try {
    for (const p of ["/overlay", "/overlay/avatar", "/overlay/captions"]) {
      const r = await get(port, p); assert.equal(r.status, 200); assert.match(r.body, /EventSource/);
    }
    assert.equal((await get(port, "/overlay", "evil.example")).status, 403);
    const img = await get(port, "/overlay/img/idle"); assert.equal(img.status, 200); assert.equal(img.type, "image/png");
    assert.equal((await get(port, "/overlay/img/talk")).status, 404);
    assert.equal((await get(port, "/overlay/img/..%2Fsecret")).status, 404);
    const cfg = JSON.parse((await get(port, "/overlay/config.json")).body); assert.deepEqual(cfg.avatars, ["idle"]);
    const cb = await get(port, "/callback?code=abc&state=xyz"); assert.equal(cb.status, 200);
    assert.deepEqual(calls[0], { code: "abc", state: "xyz", error: "" });
    // SSE
    const got = await new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/overlay/events" }, (res) => {
        let b = ""; res.on("data", (c) => { b += c; if (/Hello chat/.test(b)) { req.destroy(); resolve(b); } });
        setTimeout(() => srv.push({ type: "caption", text: "Hello chat", emotion: "happy" }), 50);
      });
      req.end();
    });
    assert.match(got, /"type":"config"/); assert.match(got, /Hello chat/);
  } finally { await srv.close(); }
});
test("token store: encrypted with safeStorage, names restricted, clear by prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "kin-sec-"));
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("ENC:" + Buffer.from(s).toString("base64")), decryptString: (b) => Buffer.from(String(b).slice(4), "base64").toString() };
  const st = createSecretStore(join(dir, "stream-secrets.json"), fake);
  assert.equal(st.set("twitch_access", "tok_abc123"), true);
  assert.equal(st.set("../evil", "x"), false);
  assert.equal(st.get("twitch_access"), "tok_abc123");
  assert.doesNotMatch(rf(join(dir, "stream-secrets.json"), "utf8"), /tok_abc123/);
  st.set("joystick_refresh", "r1"); st.clear("twitch_");
  assert.equal(st.get("twitch_access"), null); assert.equal(st.get("joystick_refresh"), "r1");
});
test("main-process HTTP helper only reaches Twitch and Joystick over https", async () => {
  let called = 0; const f = async () => { called++; return { status: 200, text: async () => "{}" }; };
  assert.equal((await streamHttp({ url: "https://evil.example/x" }, f)).error, "host not allowed");
  assert.equal((await streamHttp({ url: "http://id.twitch.tv/x" }, f)).error, "host not allowed");
  assert.equal((await streamHttp({ url: "https://api.kindroid.ai/v1/x" }, f)).error, "host not allowed");
  assert.equal((await streamHttp({ url: "https://api.joystick.tv/api/v1/me", headers: { Authorization: "Bearer x" } }, f)).status, 200);
  assert.equal(called, 1);
});

/* ---------- wiring ---------- */
test("phone app gets no stream code; Windows preload exposes it; versions are 1.18.0 / 2.7 / 18", () => {
  const html = readFileSync(join(here, "../public/phone.html"), "utf8");
  assert.doesNotMatch(html, /<script src="\/stream-(core|mode)\.js">/);
  assert.match(html, /if\(!\(window\.KinDesktop&&window\.KinDesktop\.stream\)\)return;/);
  assert.match(html, /app:"1\.18\.0",androidName:"2\.7",androidCode:18/);
  const pre = readFileSync(join(here, "../desktop/app/preload.js"), "utf8");
  assert.match(pre, /stream: \{/);
  const apk = JSON.parse(readFileSync(join(here, "../apk-version.json"), "utf8"));
  assert.equal(apk.versionName, "2.7"); assert.equal(apk.versionCode, 18);
  const mode = readFileSync(join(here, "../public/stream-mode.js"), "utf8");
  assert.doesNotMatch(mode, /localStorage\.setItem\([^)]*token/i);
  assert.doesNotMatch(mode, /kokoroId\s*=|voices\(\)\.push|saveVoices\(/, "stream mode must not change Kokoro voices");
});
