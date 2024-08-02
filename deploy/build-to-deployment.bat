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

if "%OS_TYPE%"=="darwin*" (
    echo This script does not support modification of files in Windows as it does in MacOS with sed command.
) else (
    echo This script does not support modification of files in Windows as it does in Unix-like systems with sed command.
)


cd /d "%CURRENT_DIR%"