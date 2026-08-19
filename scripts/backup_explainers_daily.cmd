@echo off
REM ===========================================================================
REM backup_explainers_daily.cmd  (Ed 2026-08-18)
REM ---------------------------------------------------------------------------
REM Runs the explainer backup once a day, driven by Windows Task Scheduler.
REM
REM WHY LOCAL AND NOT THE PLATFORM SCHEDULER. lib/scheduler.js runs on Render.
REM Render cannot reach a OneDrive folder on this machine, and the whole point
REM of this backup is to hold a copy somewhere that is NOT Supabase — so the
REM job has to run where the destination actually exists.
REM
REM Consequence worth knowing: this only runs when this machine is on. That is
REM acceptable because the videos change rarely; it is NOT a substitute for a
REM server-side copy if the library ever becomes business-critical.
REM
REM Log is appended, newest run at the bottom, so a silent failure is visible.
REM ===========================================================================
setlocal
set REPO=C:\Users\edget\hoa-doc-search
set DEST=C:\Users\edget\OneDrive - Bedrock Association Management, LLC\Bedrock AI Videos
set LOG=%DEST%\_backup_log.txt

cd /d "%REPO%" || exit /b 1

echo. >> "%LOG%"
echo ==== %DATE% %TIME% ==== >> "%LOG%"
node scripts/backup_explainers.js --to="%DEST%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo RESULT: FAILED >> "%LOG%"
  exit /b 1
) else (
  echo RESULT: ok >> "%LOG%"
)
endlocal
