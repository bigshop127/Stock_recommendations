@echo off
rem Fixes the PowerShell 7 startup crash:
rem   ArgumentOutOfRangeException: totalWidth ('-13') ... ShowUpdateNotification
rem The crash is in PowerShell's update-check banner, so turn the check off.
rem Run this from cmd.exe or Windows PowerShell 5.1, then reopen Windows Terminal.

setx POWERSHELL_UPDATECHECK Off
if errorlevel 1 (
  echo Failed to set POWERSHELL_UPDATECHECK.
  exit /b 1
)
echo Done. Close ALL Windows Terminal windows and reopen them.
