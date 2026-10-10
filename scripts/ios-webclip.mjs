import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIP_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PROF_UUID = "3b12c6a0-8d44-4f2a-9c71-2e5a8b1d4f33";

/**
 * @param {any} req
 * @param {string} name
 */
function header(req, name) {
  if (!req) return "";
  const headers = req.headers;
  if (headers && typeof headers.get === "function") return headers.get(name) || "";
  const h = headers || {};
  return String(h[name] || h[name.toLowerCase()] || "");
}

/** @param {any} req */
export function iosAppUrl(req) {
  const forwarded = header(req, "x-forwarded-host");
  const host = (forwarded || header(req, "host") || "localhost:8080").split(",")[0].trim();
  const proto =
    header(req, "x-forwarded-proto") ||
    (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return proto + "://" + host + "/";
}

function iconBase64() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "../public/apple-touch-icon.png");
    return readFileSync(p).toString("base64");
  } catch {
    return "";
  }
}

/** @param {any} s */
function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    if (ch === '"') return "&" + "quot;";
    return ch;
  });
}

/** @param {string} url */
export function renderIosWebclip(url) {
  const icon = iconBase64();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>PayloadContent</key>",
    "  <array>",
    "    <dict>",
    "      <key>FullScreen</key>",
    "      <true/>",
  ];
  if (icon) {
    lines.push("      <key>Icon</key>", "      <data>" + icon + "</data>");
  }
  lines.push(
    "      <key>IsRemovable</key>",
    "      <true/>",
    "      <key>Label</key>",
    "      <string>Kin Studio</string>",
    "      <key>PayloadDescription</key>",
    "      <string>Adds Kin Studio to the Home Screen</string>",
    "      <key>PayloadDisplayName</key>",
    "      <string>Kin Studio</string>",
    "      <key>PayloadIdentifier</key>",
    "      <string>app.kinstudio.webclip</string>",
    "      <key>PayloadType</key>",
    "      <string>com.apple.webClip.managed</string>",
    "      <key>PayloadUUID</key>",
    "      <string>" + CLIP_UUID + "</string>",
    "      <key>PayloadVersion</key>",
    "      <integer>1</integer>",
    "      <key>Precomposed</key>",
    "      <true/>",
    "      <key>URL</key>",
    "      <string>" + xmlEscape(url) + "</string>",
    "    </dict>",
    "  </array>",
    "  <key>PayloadDisplayName</key>",
    "  <string>Kin Studio</string>",
    "  <key>PayloadIdentifier</key>",
    "  <string>app.kinstudio.profile</string>",
    "  <key>PayloadOrganization</key>",
    "  <string>Kin Studio</string>",
    "  <key>PayloadRemovalDisallowed</key>",
    "  <false/>",
    "  <key>PayloadType</key>",
    "  <string>Configuration</string>",
    "  <key>PayloadUUID</key>",
    "  <string>" + PROF_UUID + "</string>",
    "  <key>PayloadVersion</key>",
    "  <integer>1</integer>",
    "</dict>",
    "</plist>",
    "",
  );
  return lines.join("\n");
}

/** @param {any} req */
export function iosWebclipResponse(req) {
  const body = renderIosWebclip(iosAppUrl(req));
  return {
    body,
    headers: {
      "Content-Type": "application/x-apple-aspen-config",
      "Content-Disposition": 'attachment; filename="Kin-Studio.mobileconfig"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  };
}
