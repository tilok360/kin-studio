# Kin Studio 1.16.0: draft notes (not pushed, tagged, released or published)

Base: tilok360/kin-studio main @ f6cb0d4 (1.15.0). Working copy: /workspace/kin-studio-1.16-draft, local branch `draft-1.16`, one local commit.
Diff: /workspace/kin-studio-1.16-draft/kin-studio-1.16.0.diff (against f6cb0d4).

## API re-check (14 Nov 2026)
kindroid.ai/v2/docs/api-documentation/ still says "Updated Oct 6, 2026". There are **no new endpoints**: send-message, chat-break, get-chat-messages, rewind-messages, update-info, the 5 group endpoints, and discord-bot. There's still no endpoint that reads a character sheet or turns a share code into an AI ID. The docs now spell out where the key and Kin ID live, and the wizard copy matches: Profile → Preferences → API & Integrations → Open → Tap here to reveal API key, and the Kin ID at the bottom of Kin settings.

## What changed
### public/kin-client.js (inline copy in phone.html re-synced; a test checks they match)
- `RateGate` can now `acquire()` atomically, so callers that arrive together can't all get through. It also has `penalize()` after a 429, `waitMs()` / `snapshot()`, and a countdown callback.
- One shared `KinClient.limiter` (9 of 10 per 30 s, leaving a spare slot).
- A status feed (`setStatus`, `onStatus`, `getStatus`, `statusFromError`) drives the header badge.
- Classification: `subscription` (403 bodies that mention a read-only account, preview, trial or subscription), `conflict` (409), and `server` (5xx, retryable).
- `backoffMs` and `isRetryable`.
- `cleanAiId` strips invisible characters, labels, quotes and URLs. `aiIdProblem` catches a pasted `kn_` key and 5-character share codes. `parseKinList` parses bulk paste.
- `testKey` does a live key check by POSTing `/update-info` with an AI ID that can't exist. Nothing changes on the account and no history pull is used. 401 means a bad key, 403 means a wrong key or a read-only account, and 200/400/404 mean the key works.
- `inspectKin` sends `get-chat-messages?limit=10` (1 pull) and fills in the name (`display_name`) and greeting (the first Kin message, oldest first).

### public/phone.html
- `kinRaw` rewritten. Every REST call takes the shared limiter, with a countdown in the badge.
  - A 429 penalizes the limiter for 30 s, then retries once.
  - Network errors and 5xx retry with backoff, but only on GET, update-info, groupchats-update and get-turn. A POST that sends a message is never retried after a network error, to avoid double posts.
  - Native (CapacitorHttp) exceptions are classified as offline.
- Chat (`runChatJob`) uses the shared limiter and its countdown, and retries once on a 429 when nothing was posted.
  - Fixed: the `< >` generation failure used to show "generation" as the message.
- Games `waitForSlot` uses the shared limiter, so Games and Chat no longer keep separate counts. Games also recognises the new `rate_limit` and `subscription` kinds.
- Groups: `groupchats-ai-response` now uses `stream:true`, so the reply text comes back directly. Mid-stream `<<HTTP_ERROR>>` is trimmed. Subscription and auth errors are no longer swallowed.
- History:
  - A 429 is only called the daily cap when the local count is at 595 or more. Otherwise it's treated as the 10/30 s limit and waited out.
  - Fixed: Listen live used to fetch the *oldest* 8 messages each time with no cursor. It now uses `start_after_timestamp`, merges into the saved thread, skips when the page is hidden or a send is in flight, keeps 60 pulls in reserve, and polls every 120 s (was 90).
- Setup wizard (`#setupWiz`): Key → Kins (bulk, live lookup, editable names, add or untick) → Voices (picker built from the existing `#piperVoice` list, so the same 28 voices, with Test) → Done → Open Chat.
  - It opens on first run when there's no key or no Kin with an ID. Once seen or finished, it doesn't open again. `?nosetup` skips it.
  - Entry points: the Guide "Set up" button, "Run setup" in Settings, "Add Kins by ID" in Characters, the Chat empty state, and Fix my connection.
- Tools → **Fix my connection**: network, key saved (never shown), limiter, pulls today, live key test, and a Kin ID hygiene check with one-tap clean-up. "Also check every Kin" uses 1 pull each and asks to confirm first.
- AI IDs are cleaned on form save and on import (`mapRawToChar`).
- Tools "Test key" now uses `testKey`, so it no longer uses a pull.
- Settings key hint updated to the current Kindroid menu path. The Guide's first-run text points to Set up and explains the badge.
- Version: 1.16.0, Android 2.5 / versionCode 16 (title, meta, `KIN_STUDIO`, footer, Android hint, export app tag). `apk-version.json` and `package.json` bumped.
- The 28 Kokoro voices, adults-only gating, export secret stripping, and the website links are unchanged.

### Chess / Games fix (/workspace/kinstudio-chess/fix.patch)
Reviewed. All 12 hunks are **already in 1.15.0**. `patch` reports it as previously applied, and kinAiId, the moveTok guards and the new kinMove protocol are all present. Nothing to fold in.

## Tests
- `node --test scripts/kin-*.test.mjs`: **31/31 pass**. That covers the existing reliability and static tests, updated for 1.16, plus a new `scripts/kin-setup-1.16.test.mjs` (limiter atomicity and penalty, ID clean-up, bulk parse, testKey for every status, inspectKin, new error kinds, status redaction, inline copy in sync).
- Headless Chrome smoke test with a mocked Kindroid API (`.draft/tests/headless-smoke-1.16.mjs`): **48/48 pass**. It covers:
  - the wizard opening on first run
  - a bad key format, a 401, and a good key, with the key input cleared afterwards
  - bulk paste: names, invisible characters, a share code, an unknown ID, an API key pasted as an ID, a duplicate
  - auto-filled name and greeting, voices assigned, Open Chat
  - a streamed chat reply
  - a 429 followed by a countdown and exactly one resend
  - a 403 subscription message and badge, and the `< >` failure
  - 11 parallel calls queued with a countdown and no failures
  - a GET network error retried, and a POST network error not retried
  - a history 429 below the cap waited out
  - a group streamed reply and a mid-stream error trim
  - Fix my connection, and cleaning up Kin IDs
  - the key never appearing in page text, non-password fields, the console, or an export
  - the footer version, Games using the Chat-tab Kin, the wizard reopening from Characters, no wizard on reload, and no page errors
- Lint: the repo's ESLint needs node_modules, which aren't installed, so I ran ESLint 9 (`no-undef`, `no-dupe-keys`, `no-unreachable`) on every inline script and kin-client.js. There are **no new findings** compared with 1.15.0. The only new names flagged are `window.kinPaintConn` and `window.kinPaintEmpty`, which are guarded with `typeof`. A `new Function` parse of all 8 inline scripts passes.

## APK
- I built it by adapting the 1.15 path: `/workspace/kin-studio-1.16-draft-build/build_apk_1.16.py`. It takes the signed 1.15.0 APK, swaps in the new index.html and kin-client.js, and patches the manifest to versionCode 16 / versionName 2.5. `aapt` confirms `com.kinvoicehelper.app`, versionCode 16, versionName 2.5.
- **It's not signed.** The 1.14.1/1.15 keystore (`/workspace/kinstudio-release/kin-studio-release.jks`) is on the box, but its password file (`/workspace/kinstudio-release-1.15/tmp/.ks-pass`) isn't, so the same-key signature can't be made. I didn't use any other key, because a different key wouldn't install over 1.15.
- Output: `/workspace/kin-studio-1.16-draft-build/apk-work/Kin-Studio-1.16.0-UNSIGNED.apk`, 225,758,336 bytes, sha256 def6ec85…8ff8c6. It won't install until it's signed. Once the pass file is back at that path (mode 600), rerun the script and it signs, verifies the cert matches 1.14.1, and copies the result to `upload/`.
- I didn't build the Windows installer, since nothing is being released.

## Needs Chris
1. The keystore password, to sign the APK with the same key (only Chris has it). Without it there's no installable 1.16 APK.
2. Approval to push, tag and release, if he wants it out. It's all ready locally: commit on `draft-1.16`, release notes in `RELEASE-NOTES-1.16.0.md`.
3. A real-account check of `testKey`. Kindroid's docs don't say what `/update-info` returns for an AI ID that doesn't exist (I assume 400/404). If a real key gets 403 there, the wizard says "key wrong or account read-only" and still lets him continue.
4. Optional: hide the Android/Windows/iPhone download buttons inside the APK, from the brainstorm. Not done.
