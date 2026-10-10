@echo off
setlocal
set "URL=https://kin-studio.grok.me"
echo Opening Kin Studio in Chrome as a Windows app...
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%URL%"
  goto :eof
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app="%URL%"
  goto :eof
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" --app="%URL%"
  goto :eof
)
where chrome >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" chrome --app="%URL%"
  goto :eof
)
echo Chrome was not found. Install Google Chrome, then run this again.
pause
