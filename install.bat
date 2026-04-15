@echo off
title Freewill Seedance 2.0 - Install

echo.
echo   ========================================
echo     Freewill Seedance 2.0 Installer
echo   ========================================
echo.
echo   [1/2] Downloading latest version...
echo         Please wait (1-2 min)...
echo.

set "INSTALLER=%~dp0FreewillSeedanceSetup.exe"

powershell -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { $r=Invoke-RestMethod -Uri 'https://api.github.com/repos/productionkhu-tech/freewill-seedance/releases/latest'; $exe=$r.assets | Where-Object { $_.name -like '*.exe' -and $_.name -notlike '*blockmap*' } | Select-Object -First 1; if($exe){ Write-Host ('        Version: '+$r.tag_name); Invoke-WebRequest -Uri $exe.browser_download_url -OutFile '%INSTALLER%'; Write-Host '        Download complete!' } else { Write-Host '        No EXE found in release'; exit 1 } } catch { Write-Host ('        Error: '+$_.Exception.Message); exit 1 }"

if not exist "%INSTALLER%" (
    echo.
    echo   Download failed. Check your internet connection.
    echo.
    pause
    exit /b 1
)

echo.
echo   [2/2] Launching installer...
start "" "%INSTALLER%"

echo.
echo   ========================================
echo     Setup wizard is now open.
echo     Follow the steps to complete install.
echo   ========================================
echo.
pause
