@echo off
rem Deliberately ASCII-only. cmd tracks batch file position in bytes, so a
rem UTF-8 file with Chinese lines can lose an "echo" prefix and execute the
rem rest of the line. All Chinese text lives in tools\setup.js.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node
node tools\setup.js %*
goto end

:no_node
echo.
echo   Node.js not found. Install an LTS build first:
echo     https://nodejs.org/
echo     mirror: https://npmmirror.com/mirrors/node/
echo   Then double-click this file again.
echo   Note: playing the game needs no install at all - use the other .bat.
echo.
pause

:end
endlocal
