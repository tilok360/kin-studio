# Kin Studio 1.18.0

Your Kin can now keep up with your stream, and you can try Talk as (Experimental).

## Stream awareness (Windows Stream mode)
Your Kin can know your Twitch title, the game you're playing, and whether you're live. Find it under **Stream → 8. Stream awareness**.
- **Title, game, and live/offline from Twitch.** On by default. Kin Studio reads them from your Twitch channel every 3 minutes (you can pick 2–10), plus once when you press Start. It uses your Twitch sign-in from step 2, and it works even if you stream from an Xbox — it reads the title and game from Twitch, not from OBS.
- **Optional: which OBS scene is showing.** Off by default. For OBS 28 and newer, go to **Tools → WebSocket Server Settings**, turn on the WebSocket server, and if it asks for a password, paste it into Kin Studio. The password is saved encrypted on your PC, like your Twitch sign-in, and never goes into exports.
- This is added as a short line to the messages your Kin already gets, so it doesn't use extra Kindroid requests.
- **Optional BRB / Starting soon lines.** Off by default. When you switch to a scene with BRB, Starting soon, or Ending in the name, your Kin can say a short line, and welcome you back. Needs the OBS option and Co-host mode.

## Talk as (Experimental)
In Chat and Groups, you can send a message as a different persona. It's marked Experimental because in a live test Kindroid accepted the switch, but the persona didn't change. If you want to try it, pick your usual persona on the Personas tab (tick "Switch back to this one"), then use **Talk as** when you send a message.

## Fixes from the test builds
A few small fixes and polish from the 1.18 test builds.

## Not changed
The rest of Stream mode, the 28 Kokoro voices, Games, the adults-only setting, and exports (still without your API key or Twitch sign-in). The Android app has no stream features in this version.

## Downloads
| File | For |
|---|---|
| `Kin-Studio-Setup-1.18.0.exe` / `Kin-Studio.exe` | Windows 10/11 (x64). Installs for your user only. |
| `Kin-Studio.apk` / `Kin-Studio-1.18.0.apk` | Android (versionName 2.7, versionCode 20) |
| `Stream-Mode-Setup.html` | Stream mode setup guide |

### Android
If you have 1.14.1, 1.15.0, 1.16.0 or 1.17.0, this APK installs over it. Don't uninstall. It's signed with the same key.

### Windows
Run `Kin-Studio-Setup-1.18.0.exe`. If SmartScreen warns (the installer isn't code-signed yet), click **More info → Run anyway**. Your data in `Documents\Kin Studio\data` is kept.
