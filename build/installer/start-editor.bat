@echo off
cd /d "%~dp0editor"
rem 先清掉可能还占着 8321 的旧实例, 免得浏览器连到旧服务看到旧界面/卡在"读取中"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8321" ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
start "" http://127.0.0.1:8321/
node server.js
pause
