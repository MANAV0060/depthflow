@echo off
title Depthflow - Real-Time Order Flow Platform
cd /d "%~dp0"

echo =====================================================================
echo                 DEPTHFLOW - ORDER FLOW PLATFORM
echo =====================================================================
echo.

:: Detect Python executable
set "PYTHON_EXE=python"
python --version >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    ) else (
        echo [ERROR] Python not found in PATH or standard install directory.
        echo Please install Python 3.10+ or add it to your system PATH.
        pause
        exit /b 1
    )
)

echo [1/3] Checking MT5 WebSocket Bridge on port 5555...
netstat -ano | findstr :5555 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo       * MT5 Bridge is already running on port 5555.
) else (
    echo       * Starting MT5 Bridge Server in background...
    start "Depthflow MT5 Bridge" /min "%PYTHON_EXE%" tools/mt5_bridge.py
    ping 127.0.0.1 -n 3 >nul
)

echo.
echo [2/3] Checking Web Server on port 8080...
netstat -ano | findstr :8080 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo       * Web Server is already running on port 8080.
) else (
    echo       * Starting Web Server on port 8080 with dev_server...
    start "Depthflow Web Server" /min "%PYTHON_EXE%" tools/dev_server.py
    ping 127.0.0.1 -n 2 >nul
)

echo.
echo [3/3] Opening Depthflow in your default browser...
start http://localhost:8080/

echo.
echo =====================================================================
echo  Depthflow is LIVE at: http://localhost:8080/
echo  WebSocket MT5 Bridge: ws://localhost:5555
echo =====================================================================
ping 127.0.0.1 -n 4 >nul
exit
