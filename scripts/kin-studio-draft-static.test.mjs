import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/phone.html"), "utf8");
const client = readFileSync(join(root, "public/kin-client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const apk = JSON.parse(readFileSync(join(root, "apk-version.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bat = readFileSync(join(root, "public/downloads/Install-Kin-Studio.bat"), "utf8");
const urlf = readFileSync(join(root, "public/downloads/Kin-Studio-Windows.url"), "utf8");

const APK = "https://github.com/tilok360/kin-studio/releases/latest/download/Kin-Studio.apk";
const SITE = "https://kin-studio1.grok.me";

test("package and apk-version are 1.15.0 / 2.4 / 15", () => {
  assert.equal(pkg.version, "1.15.0");
  assert.equal(apk.app, "1.15.0");
  assert.equal(apk.versionName, "2.4");
  assert.equal(apk.versionCode, 15);
  assert.equal(apk.applicationId, "com.kinvoicehelper.app");
});

test("phone.html is 1.15.0 and points at the new site and latest APK", () => {
  assert.match(html, /Kin Studio 1\.15\.0/);
  assert.match(html, /androidCode:15/);
  assert.match(html, /androidName:"2\.4"/);
  assert.match(html, /versionCode 15/);
  assert.match(html, new RegExp(SITE.replace(/[.]/g, "\\.")));
  assert.match(html, new RegExp(APK.replace(/[.]/g, "\\.")));
  assert.match(html, /id="btnChatCancel"/);
  assert.match(html, /id="btnChatSendAgain"/);
  assert.match(html, /id="exportRemind"/);
  assert.match(html, /id="btnExportEverything"/);
  assert.match(html, /type="password"/);
  assert.match(html, /function runChatJob/);
  assert.match(html, /KinClient\.sendMessage/);
  assert.match(html, /stripSecretsFromExport/);
  assert.match(html, /KIN_CLIENT_INLINE_START/);
  // live pointers to the retired host should not be hrefs
  assert.equal((html.match(/href="https:\/\/kin-studio\.grok\.me/g) || []).length, 0);
});

test("inline KinClient matches public/kin-client.js and never ships a real key", () => {
  const start = html.indexOf("/* === KIN_CLIENT_INLINE_START === */");
  const end = html.indexOf("/* === KIN_CLIENT_INLINE_END === */");
  assert.ok(start >= 0 && end > start);
  const inline = html.slice(start, end);
  assert.ok(inline.includes(client.trim()) || inline.includes("async function sendMessage"));
  assert.match(client, /requestPosted/);
  assert.match(client, /Promise\.race/);
  assert.doesNotMatch(client, /kn_[A-Za-z0-9_-]{16,}/);
  assert.doesNotMatch(html, /kn_[A-Za-z0-9_-]{16,}/);
  assert.match(client, /never logs or returns the kn_ API key/i);
});

test("README, bat, and Windows shortcut use the new site; APK is latest/download", () => {
  assert.match(readme, /kin-studio1\.grok\.me/);
  assert.match(readme, /Kin-Studio\.apk/);
  assert.doesNotMatch(readme, /\]\(https:\/\/kin-studio\.grok\.me\)/);
  assert.match(bat, /https:\/\/kin-studio1\.grok\.me/);
  assert.doesNotMatch(bat, /https:\/\/kin-studio\.grok\.me[^\w]/);
  assert.doesNotMatch(bat, /https:\/\/kin-studio\.grok\.me$/m);
  assert.ok(!bat.includes("https://kin-studio.grok.me"));
  assert.ok(!urlf.includes("https://kin-studio.grok.me"));
  assert.ok(urlf.includes("https://kin-studio1.grok.me"));
  assert.ok(existsSync(join(root, "public/kin-client.js")));
});
