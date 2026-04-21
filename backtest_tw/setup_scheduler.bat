@echo off
REM ============================================================
REM  setup_scheduler.bat
REM  Register "TW Stock Daily Scan" in Windows Task Scheduler
REM  Run this ONCE as Administrator to set up the daily job.
REM ============================================================

set TASK_NAME=TW Stock Daily Scan
set PYTHON=python
set SCRIPT=C:\CC AI Agent\backtest_tw\run_daily.py
set WORK_DIR=C:\CC AI Agent\backtest_tw

REM Delete existing task if present (silent)
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

REM Create task: every weekday (Mon-Fri) at 15:30 Taipei time
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%PYTHON%\" \"%SCRIPT%\"" ^
  /sc WEEKLY ^
  /d MON,TUE,WED,THU,FRI ^
  /st 15:30 ^
  /sd 01/01/2026 ^
  /rl HIGHEST ^
  /f

echo.
echo Task registered: %TASK_NAME%
echo Runs at 15:30 every weekday.
echo.
echo To test immediately:
echo   schtasks /run /tn "%TASK_NAME%"
echo.
echo To delete:
echo   schtasks /delete /tn "%TASK_NAME%" /f
pause
