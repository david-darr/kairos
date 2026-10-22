@echo off
rem kairos - Kairos in the terminal. The installer puts this in the install
rem folder; in a source checkout it runs from cli\. It uses the app's bundled
rem Python, then the checkout's .venv, then python on PATH.
setlocal
set "KAIROS_CLI_HOME=%~dp0"
set "PY="
if exist "%KAIROS_CLI_HOME%runtime\python.exe" set "PY=%KAIROS_CLI_HOME%runtime\python.exe"
if not defined PY if exist "%KAIROS_CLI_HOME%resources\backend\runtime\python.exe" set "PY=%KAIROS_CLI_HOME%resources\backend\runtime\python.exe"
if not defined PY if exist "%KAIROS_CLI_HOME%..\.venv\Scripts\python.exe" set "PY=%KAIROS_CLI_HOME%..\.venv\Scripts\python.exe"
if not defined PY set "PY=python"
set "CLI_DIR=%KAIROS_CLI_HOME%"
if exist "%KAIROS_CLI_HOME%resources\backend\cli\kairos_cli" set "CLI_DIR=%KAIROS_CLI_HOME%resources\backend\cli\"
if not defined KAIROS_APP_EXE if exist "%KAIROS_CLI_HOME%Kairos.exe" set "KAIROS_APP_EXE=%KAIROS_CLI_HOME%Kairos.exe"
set "PYTHONPATH=%CLI_DIR%;%PYTHONPATH%"
"%PY%" -X utf8 -m kairos_cli %*
endlocal & exit /b %ERRORLEVEL%
