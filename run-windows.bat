@echo off
REM Double-click to install (first time) and start Annotate Studio.
cd /d "%~dp0"
call npm install
if errorlevel 1 goto :fail
call npm run app
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Something went wrong. Read the message above, or open SETUP.md.
pause
exit /b 1
