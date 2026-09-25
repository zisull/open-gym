@echo off
rem 以「独立应用窗口」启动游戏：没有地址栏和标签页，像本地软件一样
rem 浏览器配置与游戏存档都留在本文件旁边的 .playdata 文件夹里，删掉这个文件夹就等于恢复出厂
rem 也可以继续直接双击 index.html 玩（走系统默认浏览器，窗口会带地址栏，存档是另一份）
setlocal
cd /d "%~dp0"
set "DP=%~dp0"
set "URL=file:///%DP:\=/%index.html"

set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

if defined BROWSER goto app
echo  未找到 Edge 或 Chrome，已改用系统默认浏览器打开，功能完全一样。
start "" "%~dp0index.html"
goto done

:app
if not exist "%~dp0.playdata" mkdir "%~dp0.playdata"
start "" "%BROWSER%" --user-data-dir="%~dp0.playdata" --no-first-run --no-default-browser-check --window-size=1600,900 --window-position=120,80 --app="%URL%"

:done
endlocal
