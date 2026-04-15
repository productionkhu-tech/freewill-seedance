@echo off
chcp 65001 >nul
title Seedance Video Generator

echo.
echo   ========================================
echo     Seedance Video Generator
echo   ========================================
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo   [Setup] Installing dependencies...
    call npm install
    echo.
)

echo   [Start] Starting server...
echo   [Info]  Opening http://localhost:3000 in browser...
echo.

:: Open browser after a short delay
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

:: Start the dev server
call npx tsx server.ts
