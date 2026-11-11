; build/installer.nsh  (electron-builder: nsis.include = "build/installer.nsh")
; 1) Close any running Kin Studio hard, for this user only, before the built-in check.
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "Kin Studio.exe" /fi "USERNAME eq %USERNAME%"`
  Pop $0
  Sleep 1500
!macroend
; 2) If the OLD version's uninstaller aborts (exit 2 etc.), don't fail the update:
;    remove the old program files ourselves (user data in Documents\Kin Studio and %APPDATA% is untouched).
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Old uninstaller returned $R0, removing old program files directly."
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\*.*"
    ClearErrors
  ${endif}
!macroend
