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
