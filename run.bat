@echo off
title Depthflow - Real-Time Order Flow Platform
cd /d "%~dp0"

echo =====================================================================
echo                 DEPTHFLOW - ORDER FLOW PLATFORM
echo =====================================================================
echo.
echo [1/3] Checking MT5 WebSocket Bridge on port 5555...

netstat -ano | findstr :5555 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo       * MT5 Bridge is already running on port 5555.
) else (
    echo       * Starting MT5 Bridge Server in background...
    start "Depthflow MT5 Bridge" /min python tools/mt5_bridge.py
    timeout /t 2 /nobreak >nul
)

echo.
echo [2/3] Checking Web Server on port 8080...
netstat -ano | findstr :8080 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo       * Web Server is already running on port 8080.
) else (
    echo       * Starting Web Server on port 8080...
    start "Depthflow Web Server" /min python -m http.server 8080
    timeout /t 1 /nobreak >nul
)

echo.
echo [3/3] Opening Depthflow in your default browser...
start http://localhost:8080/

echo.
echo =====================================================================
echo  Depthflow is LIVE at: http://localhost:8080/
echo  (You can minimize this window or press any key to close it)
echo =====================================================================
timeout /t 5 >nul
exit
