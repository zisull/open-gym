@echo off
rem 扫描 video\ 目录，生成影院放映单 video\manifest.js
cd /d "%~dp0.."
node tools\gen_video_manifest.js
echo.
pause
