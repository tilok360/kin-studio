# Kin Studio 1.18.0 (draft)

Talk as a different persona, and edit what your Kin has learned. Windows, Android and the web app all get both.

> **Heads up:** both features use parts of Kindroid's API that Kindroid hasn't documented. Other API users found them, and Kindroid's support calls them "undocumented, unsupported, and may change." If Kindroid changes them, Kin Studio tells you plainly and doesn't send anything half-done. Kindroid is also planning a new API, so these may need updating later.

## Talk as (new, in Chat and Groups) — Experimental
> **Experimental.** In a live test on Nov 14, Kindroid accepted the persona setting (it answered OK), but the persona didn't change. It hasn't been tested with a real persona ID yet, so we don't know whether it switches. The app labels it Experimental everywhere it appears. If it works for you, tell us in the Discord.

- Pick a persona under **Talk as** and your message goes to the Kin as that persona. Kin Studio switches your persona, sends the message, then switches back to your usual one. The switch back always runs, even if the send fails or you cancel.
- **This switches your persona everywhere in your Kindroid account while it sends,** including the Kindroid app. It takes a second or two, but if you message from the Kindroid app at that exact moment, that message could go out as the wrong persona. The app warns you the first time.
- Set it up on the Personas tab:
  - Tick **"Switch back to this one"** on your usual persona. Kindroid can't tell apps which persona you normally use, so Talk as stays off until you pick one.
  - Optionally add the persona's **Kindroid persona ID** for a full switch, including the backstory. Without an ID, Talk as only changes the name and gender your Kins see. A persona attached to a chat inside Kindroid overrides that. Copy the ID exactly. Kindroid accepts any ID without checking, so a wrong one won't show an error. It just won't switch.
- Your choice is remembered for each Kin and each group.
- Each message sent this way uses 3 of Kindroid's 10 requests per 30 seconds (switch, send, switch back). They share the app's usual queue, so Chat, Games and Stream mode still don't trip the limit.
- If Kindroid refuses the switch, nothing is sent, and the app asks if you want to send it as your current persona instead.
- If the switch back fails, the app tells you, and the Personas tab shows a **Switch back now** button until it's fixed.
- In Groups, the persona is switched while your message posts. The Kins' replies come after the switch back.

## Learned context editor (new, in Characters)
- A new **Learned context** section on each character sends **Growth & relationship**, **Important facts** and **Ongoing threads** to Kindroid.
- Kindroid replaces all three fields at once and can't send its current text back to apps. So first copy the three fields from the Kindroid app, paste them in, then edit. The app reminds you before every push.
- Length limits match the Kindroid app: 800, 1,200 and 800 characters. Anything too long is caught before sending.
- **Revision number.** Kindroid counts every change to Learned context, including lines your Kin learns on its own, and refuses a push made against an old count. The Kindroid app doesn't show this number.
  - If you leave it blank, Kin Studio tries 0. That's a guess.
  - If Kindroid refuses, you'll see: "Kindroid said the learned context changed… Nothing was changed." Re-copy the fields from Kindroid, then push again.
  - Kindroid doesn't send the current number back when it refuses (checked Nov 14). If a later Kindroid update starts including it, a **Use revision N** button fills it in for you.
- When Kindroid rejects a push, the app now shows Kindroid's own reason, like a missing field or a negative revision.
- If the AI ID is wrong, Kindroid answers with a server error instead of "not found". The app now says to check the AI ID.
- Every push is saved on your device with its time and revision, including refused ones (the last 15 per Kin). **Put back in the fields** brings an old copy back.
- The regular **Push to Kindroid** button is unchanged and never touches Learned context.

## Stream mode: stream awareness (new, Windows)
Your Kin now knows what's going on in your stream, not just in chat. Find it in **Stream → 8. Stream awareness**.
- **Title, game and live/offline from Twitch.** On by default. Kin Studio reads your stream title, category and whether you're live every 3 minutes (you can pick 2–10), plus once when you press Start. It uses your Twitch sign-in from step 2 and reads the **Channel** by name, so it works when your Kin signs in with its own Twitch account.
- **Which OBS scene is showing.** Off by default. OBS 28 and newer have this built in: in OBS go to **Tools → WebSocket Server Settings**, tick **Enable WebSocket server**, and if **Enable Authentication** is ticked, press **Show Connect Info** and paste the Server Password into Kin Studio. The password is saved encrypted on your PC, like your Twitch sign-in, and never goes into exports. **Test OBS connection** shows the current scene.
- **No extra Kindroid messages.** All of this goes in as one short line with the messages your Kin already gets, for example `[Stream: playing Hunt: Showdown, title "Swamp run", live now, scene: Gameplay]`. The line shows under the settings so you can see exactly what your Kin sees.
- **Same safety check.** The title, game and scene name go through the blocked-word check. If one has a blocked word, it's left out.
- **Optional scene lines.** Off by default. When you switch to a scene with BRB, Break, Away, Starting, Soon, Intro, Ending or Outro in its name, the Kin says one short line ("be right back", "starting soon", goodbye), and welcomes you back when you leave a BRB or Starting soon scene. At most one every 2 minutes (adjustable), and it uses Stream mode's usual share of Kindroid's limit. Needs the OBS option on and Co-host mode.
- Your Kin can't see the screen itself. Kindroid's API doesn't take pictures.

## Not changed
The rest of Stream mode, the 28 Kokoro voices, Games, the adults-only setting, and exports (still without your API key or Twitch sign-in).

## Downloads
| File | For |
|---|---|
| `Kin-Studio-Setup-1.18.0.exe` / `Kin-Studio.exe` | Windows 10/11 (x64) |
| `Kin-Studio.apk` / `Kin-Studio-1.18.0.apk` | Android (versionName 2.7, versionCode 18) |

Android: installs over 1.14.1 or newer. Don't uninstall. Windows: run the installer. Your data in `Documents\Kin Studio\data` is kept.
