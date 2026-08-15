@echo off
REM Fix AWA0005 "Invalid Timestamp" from the E.Sun / Fugle trading API.
REM Cause: Windows Time service was stopped and the clock drifted ~seconds
REM out of sync, so the signed request timestamp gets rejected.
REM MUST be run as Administrator (right-click -> Run as administrator).

echo Checking for admin rights...
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: This must be run as Administrator.
    echo Right-click this file and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

echo Setting Windows Time service to auto-start...
sc config w32time start= auto

echo Starting Windows Time service...
net start w32time

echo Forcing a time resync...
w32tm /resync /force

echo.
echo Current time service status:
w32tm /query /status

echo.
echo Done. If no errors above, re-run the 同步玉山持倉 sync.
pause
