@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\three npm install
start "" http://localhost:8321
node server.js
