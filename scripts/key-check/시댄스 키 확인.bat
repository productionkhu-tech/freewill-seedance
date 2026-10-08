@echo off
rem Seedance key check - shows which Seedance keys are on this PC. Key values are never shown. Changes nothing.
rem The PowerShell file next to this one (same name, .ps1) does the work.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dpn0.ps1"
pause
