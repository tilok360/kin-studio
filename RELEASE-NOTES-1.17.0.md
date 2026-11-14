# Kin Studio 1.17.0

Stream mode: your Kin as your Twitch co-host. Windows app only.

## Stream mode (new Stream tab)
- **Co-host on its own.** The Kin reads chat, picks the most fun messages, and answers people by name. It greets first-time chatters, thanks follows, subs, gift subs, bits and raids (several at once get one line), and says something or asks chat a question when it goes quiet. A "What's happening" box tells it what game you're playing.
- **Command-only mode** if you prefer: viewers type `!kin` plus a message. Includes a cooldown per viewer and a queue limit.
- **Talks in its own voice.** Replies use the Kin's Kokoro voice from the Voices tab. You can also post the reply in chat (cut to 500 characters).
- **On stream as a talking avatar.** A local OBS Browser Source (`http://localhost:47830/overlay`, or separate `/overlay/avatar` and `/overlay/captions`). Transparent background and animated captions. Upload your Kin's selfies: the mouth moves with the voice, it blinks, it bobs, and mood pictures (happy, laughing, surprised, sad, angry, thinking) swap in.
- **You stay in control.** Global hotkeys work while the game has focus: mute (Ctrl+Alt+M), skip the current reply (Ctrl+Alt+S), pause auto-chat (Ctrl+Alt+P). There's a "Say this" box for feeding the Kin a line, and an optional "wait while I'm talking" that watches your mic.
- **Easy Twitch sign-in.** Press Connect Twitch and type the code at twitch.tv/activate. You don't need a developer account. The sign-in is stored encrypted on your PC, never in exports.
- **Safe by default.** Chat is checked before it goes to Kindroid, and replies are checked again before they're spoken or shown. Names and messages with blocked words are never read out. You can add your own blocked words, block users, and switch on mod-only or an allow list. Twitch is always kept safe-for-work.
- **Plays nicely with Kindroid's limit.** Stream mode uses at most 5 of Kindroid's 10 requests per 30 seconds (adjustable) and shares the app's queue, so Chat and Games keep working.
- **Test button.** Sends a fake viewer message through the whole chain (filter, Kindroid, voice, overlay) without posting to your chat.
- Setup guide: `Stream-Mode-Setup.html` (attached to this release).

Joystick.tv support is coming later.

## Not changed
The 28 Kokoro voices, the adults-only setting, exports (still without your API key or Twitch sign-in). The Android app has no stream features in this version.

## Downloads
| File | For |
|---|---|
| `Kin-Studio-Setup-1.17.0.exe` / `Kin-Studio.exe` | Windows 10/11 (x64). Installs for your user only. |
| `Kin-Studio.apk` / `Kin-Studio-1.17.0.apk` | Android (versionName 2.6, versionCode 17) |
| `Stream-Mode-Setup.html` | Stream mode setup guide |

### Android
If you have 1.14.1, 1.15.0 or 1.16.0, this APK installs over it. Don't uninstall. It's signed with the same key.

### Windows
Run `Kin-Studio-Setup-1.17.0.exe`. If SmartScreen warns (the installer isn't code-signed yet), click **More info → Run anyway**. Your data in `Documents\Kin Studio\data` is kept.
