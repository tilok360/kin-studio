# Kin Studio 1.16.0 (DRAFT, not released)

Easier setup and a steadier connection to Kindroid.

## Easier setup
- **Setup wizard on first run.** Four short steps: paste your `kn_` key (with where to find it in Kindroid), test it live, add your Kins by Kin ID, pick a voice, done. You can run it again any time from the Guide, from Settings, or with **Characters → Add Kins by ID**.
- **Add several Kins at once.** Paste one Kin ID per line, with a name first if you like (`Abby: your-kin-id`). The app looks each one up on Kindroid, fills in its name and greeting, and flags IDs Kindroid doesn't know, duplicates, a pasted API key, or a 5-letter share code (the API can't use share codes).
- **Hidden characters are removed.** Copying a Kin ID can bring along invisible spaces, which caused "AI not found". They are now stripped when you save, import, or add a Kin.
- **Fix my connection** (Tools). Checks your network, saved key (never shown), Kindroid's rate limit, today's history pulls, and your Kin IDs, then tells you what to fix. It can clean up bad Kin IDs in one tap.
- Clear empty state in Chat when nothing is set up yet.

## Better communication with Kindroid
- **One shared limit for everything.** Chat, Games, Groups, Sync, Tools and setup now share one queue for Kindroid's 10 requests per 30 seconds. When it's full, the app waits and counts down instead of failing.
- **429 handled for you.** If Kindroid still says "too many requests", the app waits out the window and sends once more. That's safe because a 429 means Kindroid didn't take the message.
- **Network hiccups retried.** Reads (history, key test) retry with backoff. Messages are never re-sent automatically after a network error, so nothing gets posted twice.
- **Clearer errors.** 401 = key not accepted, 403 = free preview ended or a subscription is needed, 409 = can't rewind that, 5xx = Kindroid server problem, `< >` = Kindroid couldn't generate a reply.
- **Connection badge** in the header: connected, working, waiting (with seconds), offline, key problem, or needs subscription. Tap it for Fix my connection.
- **Group chats stream replies** straight back, so the app no longer spends history pulls to find out what a Kin said.
- **History pulls go further.** A 429 on Sync is only called the daily cap when you're actually near 600. Listen live now asks only for new messages (before, it re-read the oldest ones), pauses when the app is in the background, and keeps 60 pulls in reserve.
- The key test no longer uses a history pull.

## Not changed
The 28 Kokoro voices, the adults-only setting, exports (still without your API key).

## Downloads
| File | For |
|---|---|
| `Kin-Studio.apk` / `Kin-Studio-1.16.0.apk` | Android (versionName 2.5, versionCode 16) |

### Android
If you have 1.14.1 or 1.15.0, this APK installs over it. Don't uninstall. It's signed with the same key.
