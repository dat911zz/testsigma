@echo on
setlocal enabledelayedexpansion

REM Get the current working directory
for %%I in ("%CD%") do set "WORKING_DIR=%%~fI"

REM Get the root folder (two levels up from the script location)
for %%I in ("%~dp0..\..") do set "ROOT_FOLDER=%%~fI"

REM Parameters
set "BUILD_OS_NAME=%1"
set "OS_PATH_SUFFIX=%2"
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
xcopy /s /e /i "%ROOT_FOLDER%\.testsigma_os\%OS_PATH_SUFFIX%\nginx" "%BUILD_FOLDER%\"

REM Testsigma UI Build
set "UI_BUILD_FILE_PREFIX=TestsigmaUI"
set "UI_BUILD_FOLDER=%BUILD_FOLDER%\%UI_BUILD_FILE_PREFIX%"
rmdir /s /q "%UI_BUILD_FOLDER%"
mkdir "%UI_BUILD_FOLDER%"
xcopy /s /e /i "%WORKING_DIR%\ui\dist\testsigma-angular\*" "%UI_BUILD_FOLDER%"

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
xcopy /s /e /i "%ROOT_FOLDER%\.testsigma_os\%OS_PATH_SUFFIX%\jre" "%SERVER_BUILD_FOLDER%"

REM Copy Windows-specific files
if "%OS_PATH_SUFFIX%"=="windows" (
    copy "%ROOT_FOLDER%\.testsigma_os\windows\windows-kill.exe" "%SERVER_BUILD_FOLDER%\"
)

pause