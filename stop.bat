@echo off
title Stop Depthflow Services
cd /d "%~dp0"

echo =====================================================================
echo                STOPPING DEPTHFLOW SERVICES
echo =====================================================================
echo.

echo Stopping processes on port 8080 (Web Server)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
    echo Terminated process PID %%a on port 8080
)

echo.
echo Stopping processes on port 5555 (MT5 Bridge)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5555 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
    echo Terminated process PID %%a on port 5555
)

echo.
echo =====================================================================
echo  All Depthflow services have been stopped.
echo =====================================================================
ping 127.0.0.1 -n 3 >nul
exit
