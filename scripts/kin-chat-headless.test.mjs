import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let path = u.pathname;
    if (path === "/__smoke.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(readFileSync(join(root, "scripts/headless-smoke.html")));
      return;
    }
    if (path === "/") path = "/phone.html";
    const file = join(root, "public", path);
    if (!file.startsWith(join(root, "public")) || !existsSync(file)) {
      res.writeHead(404); res.end("no"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function chromeDump(url) {
  const chrome = process.env.CHROME || "google-chrome";
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--allow-insecure-localhost",
    "--virtual-time-budget=20000",
    "--timeout=25000",
    "--dump-dom",
    url
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("chrome timeout; stderr=" + err.slice(0, 500)));
    }, 40000);
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

test("headless chrome loads 1.15.0 phone.html and KinClient mock API works", async (t) => {
  const server = await startServer();
  const { port } = server.address();
  const url = "http://127.0.0.1:" + port + "/__smoke.html";
  try {
    const { code, out, err } = await chromeDump(url);
    const pass = /<title>SMOKE_PASS<\/title>/.test(out) || /data-smoke="PASS"/.test(out);
    const fail = /<title>SMOKE_FAIL<\/title>/.test(out) || /data-smoke="FAIL"/.test(out);
    const report = (out.match(/PASS [^\n<]+|FAIL [^\n<]+/g) || []).join("\n");
    if (!pass) {
      assert.fail(
        "headless smoke did not PASS (chrome exit " + code + ")\n" +
        report + "\n--- stderr ---\n" + err.slice(-800) + "\n--- title area ---\n" +
        (out.match(/<title>[^<]+<\/title>/) || ["no title"])[0] +
        "\n" + out.slice(0, 400)
      );
    }
    assert.ok(pass && !fail, report);
    assert.match(out, /PASS stream assembled/);
    assert.match(out, /PASS timeout kind/);
    assert.match(out, /PASS 429 kind/);
    assert.match(out, /PASS iframe 1\.15\.0/);
    assert.match(out, /PASS iframe KinClient/);
    assert.match(out, /PASS cancel button/);
    assert.match(out, /PASS api key is password/);
  } finally {
    server.close();
  }
});
