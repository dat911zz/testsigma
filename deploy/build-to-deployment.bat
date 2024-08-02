@echo off
setlocal enabledelayedexpansion
set UI_BUILD_CONF=dev
set LOCAL_AGENT_TAG=latest

:loop
if "%~1"=="" goto :end
for /f "delims== tokens=1,2" %%a in ("%~1") do (
    if "%%~a"=="--UI_BUILD_CONF" (
        set UI_BUILD_CONF=%%~b
    ) else if "%%~a"=="--LOCAL_AGENT_TAG" (
        set LOCAL_AGENT_TAG=%%~b
    ) else (
        echo ***************************
        echo * Error: Invalid argument.*
        echo ***************************
        exit /b 1
    )
)
shift
goto :loop
:end

set CURRENT_DIR=%cd%
cd /d "%CURRENT_DIR%\.."
set ROOT_FOLDER=%cd%
set OS_TYPE=%OS%

echo "root: %ROOT_FOLDER%"
cd /d "%ROOT_FOLDER%/ui"

set NODE_OPTIONS=--openssl-legacy-provider --max_old_space_size=4096

call npm install --legacy-peer-deps
call "%ROOT_FOLDER%/ui/node_modules/.bin/ng" build --configuration=%UI_BUILD_CONF%

set JAVA_HOME=%ROOT_FOLDER%\.testsigma_os\.jdks\openjdk-22.0.1
set mvn=%ROOT_FOLDER%\server\mvnw.cmd

cd /d "%ROOT_FOLDER%/automator"
call %mvn% clean install

cd /d "%ROOT_FOLDER%/agent"
call %mvn% clean install

cd /d "%ROOT_FOLDER%/agent-launcher"
call %mvn% clean install
echo "ostype: %OS_TYPE%"
if "%OS_TYPE%"=="darwin*" (
    echo This script does not support modification of files in Windows as it does in MacOS with sed command.
) else (
    echo This script does not support modification of files in Windows as it does in Unix-like systems with sed command.
)

cd /d "%ROOT_FOLDER%/server"
call %mvn% clean install
echo "server:"
pause

if "%OS_TYPE%"=="darwin*" (
    echo This script does not support modification of files in Windows as it does in MacOS with sed command.
) else (
    echo This script does not support modification of files in Windows as it does in Unix-like systems with sed command.
)

cd /d "%CURRENT_DIR%"

@echo on
setlocal enabledelayedexpansion

REM Get the current working directory
for %%I in ("%CD%") do set "WORKING_DIR=%%~fI\installer"

REM Get the root folder (two levels up from the script location)
for %%I in ("%~dp0..") do set "ROOT_FOLDER=%%~fI"

REM Parameters
set "BUILD_OS_NAME=%1"
set "OS_PATH_SUFFIX=1.0.0"
set "VERSION=%3"

echo Generating %OS_PATH_SUFFIX% testsigma build

set "BUILD_FILE_PREFIX=Testsigma"
set "BUILD_FOLDER=%ROOT_FOLDER%\%BUILD_FILE_PREFIX%"
set "ZIP_FILE_NAME=%BUILD_FILE_PREFIX%-%BUILD_OS_NAME%-%VERSION%.zip"

REM Clean up existing files
if exist "%ZIP_FILE_NAME%" del /q "%ZIP_FILE_NAME%"
if exist "%BUILD_FOLDER%" rmdir /s /q "%BUILD_FOLDER%"

REM Create the build folder
mkdir "%BUILD_FOLDER%"

REM Nginx Build
copy "%ROOT_FOLDER%\deploy\installer\scripts\posix\start_nginx.sh" "%BUILD_FOLDER%\"
copy "%ROOT_FOLDER%\deploy\installer\scripts\posix\stop_nginx.sh" "%BUILD_FOLDER%\"
copy "%ROOT_FOLDER%\deploy\installer\scripts\windows\start_nginx.bat" "%BUILD_FOLDER%\"
copy "%ROOT_FOLDER%\deploy\installer\scripts\windows\stop_nginx.bat" "%BUILD_FOLDER%\"

REM Set execute permissions for start_nginx.sh
icacls "%BUILD_FOLDER%\start_nginx.sh" /grant Everyone:RX
REM Set execute permissions for stop_nginx.sh
icacls "%BUILD_FOLDER%\stop_nginx.sh" /grant Everyone:RX

REM Copy Nginx files
xcopy /s /e /i "%ROOT_FOLDER%\.testsigma_os\%OS_PATH_SUFFIX%\nginx" "%BUILD_FOLDER%\nginx"

REM Testsigma UI Build
set "UI_BUILD_FILE_PREFIX=TestsigmaUI"
set "UI_BUILD_FOLDER=%BUILD_FOLDER%\%UI_BUILD_FILE_PREFIX%"
rmdir /s /q "%UI_BUILD_FOLDER%"
mkdir "%UI_BUILD_FOLDER%"
xcopy /s /e /i "%ROOT_FOLDER%\ui\dist\testsigma-angular\*" "%UI_BUILD_FOLDER%"

REM Testsigma Server Build
set "SERVER_BUILD_FILE_PREFIX=TestsigmaServer"
set "SERVER_BUILD_FOLDER=%BUILD_FOLDER%\%SERVER_BUILD_FILE_PREFIX%"
rmdir /s /q "%SERVER_BUILD_FOLDER%"
mkdir "%SERVER_BUILD_FOLDER%"
mkdir "%SERVER_BUILD_FOLDER%\lib"
mkdir "%SERVER_BUILD_FOLDER%\jre"

REM Copy server files
copy "%ROOT_FOLDER%\server\target\testsigma-server.jar" "%SERVER_BUILD_FOLDER%\"
xcopy /s /e /i "%ROOT_FOLDER%\server\target\lib\*" "%SERVER_BUILD_FOLDER%\lib\"
copy "%ROOT_FOLDER%\server\src\main\scripts\posix\start.sh" "%SERVER_BUILD_FOLDER%\"
copy "%ROOT_FOLDER%\server\src\main\scripts\windows\start.bat" "%SERVER_BUILD_FOLDER%\"
copy "%ROOT_FOLDER%\server\src\main\scripts\posix\stop.sh" "%SERVER_BUILD_FOLDER%\"
copy "%ROOT_FOLDER%\server\src\main\scripts\windows\stop.bat" "%SERVER_BUILD_FOLDER%\"
xcopy /s /e /i "%ROOT_FOLDER%\.testsigma_os\%OS_PATH_SUFFIX%\jre" "%SERVER_BUILD_FOLDER%\jre"

REM Copy Windows-specific files
if "%OS_PATH_SUFFIX%"=="windows" (
    copy "%ROOT_FOLDER%\.testsigma_os\windows\windows-kill.exe" "%SERVER_BUILD_FOLDER%\"
)
pause