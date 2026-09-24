@echo off
rem 双击运行：扫描 imgs\wall\ 里的图片并重新生成 manifest.js
cd /d "%~dp0.."
node tools\gen_wall_manifest.js
pause
