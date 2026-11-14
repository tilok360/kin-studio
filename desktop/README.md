# Windows installer build (electron-builder)

Keep `appId` = `com.electron.kin-studio` so updates replace the existing install
(uninstall key `da10084a-5eb1-5d7e-b550-df93cfd4a30c`).

`build/installer.nsh` closes a running Kin Studio before installing and, if the
previous version's uninstaller exits non-zero (the "Failed to uninstall old
application files: 2" error), removes the old program files instead of failing.
User data in `Documents\Kin Studio\data` and `%APPDATA%\Kin Studio` is not touched.

Build from a packaged app folder (`win-unpacked` with `resources/app.asar`):

    npx electron-builder@26 --config electron-builder.json --win nsis --x64 --prepackaged path/to/win-unpacked

On Linux this needs `wine` on PATH. Use the same electron-builder major version for every release.

## App sources (`desktop/app/`)

`main.js`, `preload.js`, `store.js` and `package.json` are the Electron app that goes in `resources/app.asar`.
They were copied unchanged from the shipped 1.15.0 `app.asar`, then 1.17 added Stream mode:

- `stream-server.js`: the local OBS overlay server on `127.0.0.1:47830-47839` (`/overlay`, `/overlay/avatar`,
  `/overlay/captions`, SSE `/overlay/events`), the Joystick OAuth loopback `/callback`, the encrypted token store
  (`%APPDATA%\Kin Studio\stream-secrets.json`, Windows DPAPI through `safeStorage`), and an HTTPS helper limited
  to `id.twitch.tv`, `api.twitch.tv` and `api.joystick.tv`.
- `main.js`: `stream:*` IPC and global hotkeys (`globalShortcut`).
- `preload.js`: `window.KinDesktop.stream`.

To pack: put `desktop/app/*` at the asar root and copy `public/` to `www/`. This includes `stream-core.js`,
`stream-mode.js` and `stream-overlay.html`, plus the existing `kokoro-runtime/` and `og.jpg` from the previous asar.
Avatar pictures are stored in `%APPDATA%\Kin Studio\stream-avatar\`.
