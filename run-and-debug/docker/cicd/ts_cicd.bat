@echo off
setlocal enabledelayedexpansion
REM Define variables
set SCRIPT_DIR=%~dp0

if "%API_KEY%"=="" (
	set API_KEY=<API_KEY>
)
if "%EXECUTION_IDS%"=="" (
	set EXECUTION_IDS=398,399,3169,3228,398,398,3169,398,398
	REM 3195,3189,3196,3197,3215,3194,3216,3217
	REM 3216
)
if "%WAIT_TIME%"=="" (
	set WAIT_TIME=30
)
if "%TS_DOMAIN%"=="" (
	set TS_DOMAIN=https://local.testsigmaos.com
)
if "%STORE_URL%"=="" (
	set STORE_URL=http://10.100.110.114:8080/reports
)
if "%STORE_PATH%"=="" (
	set STORE_PATH=C:\Users\Administrator.WINDOWS2019\Downloads
)
if "%MAX_CONCURRENT%"=="" (
	set MAX_CONCURRENT=3
)
set EXECUTION_RESULT_IDS=
set REPORT_FOLDER_PATH=%STORE_PATH%\reports
set REPORT_TS_TEST_RESULT_ROOT_URL=%TS_DOMAIN%/ui/td/runs
set HAVE_ERROR=0



echo:
echo [92mStarting auto-testing process...[0m
REM Get the directory of the current .bat file
echo =========PARAMS=========
echo [*] Test plans: %EXECUTION_IDS%
echo [*] The script directory is: %SCRIPT_DIR%
echo [*] Current Testsigma domain: %TS_DOMAIN%
echo [*] Report file storage path: %STORE_PATH%
echo [*] Report file url view path: %STORE_URL%
echo [*] Interval: %WAIT_TIME%s
echo [*] Max concurrent tasks: %MAX_CONCURRENT%

set INDEX=0
for %%e in (%EXECUTION_IDS%) do (
    set "EXECUTION_IDS[!INDEX!]=%%e"
    set /a INDEX+=1
)
set TOTAL_TASKS=%INDEX%
echo [*] Total tasks found: %TOTAL_TASKS%
echo:

set INDEX=0
set CURRENT_INDEX=0
set RUNNING_TASKS=0

set P_CURRENT_INDEX=0
set P_RUNNING_TASKS=0

:ProcessTasks
if !RUNNING_TASKS! lss !MAX_CONCURRENT! (
	if !CURRENT_INDEX! geq !TOTAL_TASKS! (
		call :CheckRunningTasks
		set RUNNING_TASKS=0	
	) else (
		echo ========================
		call :ResetVar
		call :RunTestPlan !EXECUTION_IDS[%CURRENT_INDEX%]!
		set /a P_CURRENT_INDEX=CURRENT_INDEX+1
		set /a P_RUNNING_TASKS=RUNNING_TASKS+1
		echo Run: !EXECUTION_IDS[%CURRENT_INDEX%]!, !P_RUNNING_TASKS!, !P_CURRENT_INDEX!/%TOTAL_TASKS%
		echo:
		set /a CURRENT_INDEX+=1
		set /a RUNNING_TASKS+=1	
		goto :ProcessTasks
	)	
) else (
	call :CheckRunningTasks
	set RUNNING_TASKS=0
	if !CURRENT_INDEX! lss !TOTAL_TASKS! (
		echo %CURRENT_INDEX%/%TOTAL_TASKS%
		goto :ProcessTasks
	)
)
if !CURRENT_INDEX! geq !TOTAL_TASKS! (
	if !HAVE_ERROR! equ 1 (
		exit 1
	)
	exit /b
)
exit /b

:CheckRunningTasks
for %%r in (%EXECUTION_RESULT_IDS%) do (
	set EXECUTION_RESULT_ID=%%r
	call :CheckStatus
	call :GenReport
	call :ResetVar
	echo:
)
set EXECUTION_IDS=
set EXECUTION_RESULT_IDS=
exit /b

:ResetVar
set STATUS=0
set RESULT=0
set TOTAL_COUNT=0
set TOTAL_PASSED=0
set ERRORLEVEL=0
set ERRORMSG=
exit /b

:RunTestPlan
set EXECUTION_ID=%1
REM Trigger TestSigma test plan and capture the response
echo [%EXECUTION_ID%] Triggering TestSigma Test Plan with id: %EXECUTION_ID%
for /f "tokens=*" %%i in ('curl -X POST -H "Content-type: application/json" ^
-H "Accept:application/json" ^
-H "Authorization: Bearer %API_KEY%" ^
%TS_DOMAIN%/api/v1/test_plan_results ^
-d "{\"testPlanId\": \"%EXECUTION_ID%\"}" ^| %SCRIPT_DIR%\jq.exe -r ".id"') do (
set EXECUTION_RESULT_ID=%%i
)
if not %EXECUTION_RESULT_ID%==null (
	set EXECUTION_RESULT_IDS=%EXECUTION_RESULT_IDS% %EXECUTION_RESULT_ID%
)
echo Result ids: %EXECUTION_RESULT_IDS%
exit /b

REM Check the status of the test plan
:CheckStatus
if %EXECUTION_RESULT_ID%==null (
	set ERRORLEVEL=404
	set ERRORMSG=EXECUTION_ID not found.
	goto ProcessError
)
echo:
echo [%EXECUTION_RESULT_ID%] Checking status of TestSigma Test Run id: %EXECUTION_RESULT_ID%

curl -X GET -H "Content-type: application/json" ^
-H "Accept:application/json" ^
-H "Authorization: Bearer %API_KEY%" ^
%TS_DOMAIN%/api/v1/test_plan_results/%EXECUTION_RESULT_ID% ^
-o "%SCRIPT_DIR%\tmp.json" ^
-s

if not %ERRORLEVEL%==0 (
	goto ProcessError
)
REM Read the response from temp.json
for /f "tokens=*" %%b in ('%SCRIPT_DIR%\jq.exe -r ".status" %SCRIPT_DIR%\tmp.json') do set STATUS=%%b
for /f "tokens=*" %%c in ('%SCRIPT_DIR%\jq.exe -r ".result" %SCRIPT_DIR%\tmp.json') do set RESULT=%%c
for /f "tokens=*" %%d in ('%SCRIPT_DIR%\jq.exe -r ".total_count" %SCRIPT_DIR%\tmp.json') do set TOTAL_COUNT=%%d
for /f "tokens=*" %%e in ('%SCRIPT_DIR%\jq.exe -r ".passed_count" %SCRIPT_DIR%\tmp.json') do set TOTAL_PASSED=%%e
REM Break point
if "%STATUS%"=="" (
	set ERRORLEVEL=2
	set ERRORMSG=Error during started test plan.
	goto ProcessError
)
if not "%STATUS%"=="STATUS_COMPLETED" (
	if "%TOTAL_COUNT%"==0 (
		set ERRORLEVEL=2
		set ERRORMSG=Error during started test plan.
		goto ProcessError
	)
	echo [93m[%EXECUTION_RESULT_ID%] Status: %STATUS%; Result: %RESULT%; Total passed: %TOTAL_PASSED%/%TOTAL_COUNT%[0m
	waitfor SomethingThatIsNeverHappening /t %WAIT_TIME% 2>NUL
	goto CheckStatus
)

set FNAME=junit-report-%EXECUTION_RESULT_ID%.xml.txt
set REPORT_FNAME=%REPORT_FOLDER_PATH%/%FNAME%
exit /b

:GenReport
if %ERRORLEVEL%==0 (
	REM Check if the 'reports' directory exists
	if not exist "%REPORT_FOLDER_PATH%\reports" (
		echo [%EXECUTION_RESULT_ID%] Directory 'reports' does not exist. Creating it
		mkdir "%REPORT_FOLDER_PATH%\reports"
	)
	REM Export JUnit report
	echo [%EXECUTION_RESULT_ID%] Exporting JUnit report to %REPORT_FILE_PATH%
	curl -X GET -H "Content-type: application/json" ^
	-H "Accept: application/xml" ^
	-H "Authorization: Bearer %API_KEY%" ^
	%TS_DOMAIN%/api/v1/reports/junit/%EXECUTION_RESULT_ID% ^
	-o "%REPORT_FNAME%" ^
	-s

	call :ShowReportResult
)
exit /b

:ShowReportResult
if exist "%REPORT_FNAME%" (
	echo [%EXECUTION_RESULT_ID%] JUnit report successfully exported to: %REPORT_FNAME%
) else (
	echo [91m[%EXECUTION_RESULT_ID%][!] Error: Failed to export the JUnit report.[0m
)
echo [%EXECUTION_RESULT_ID%] Report file URL: [95m%STORE_URL%/%FNAME%[0m
echo [%EXECUTION_RESULT_ID%] Test run result URL: [95m%REPORT_TS_TEST_RESULT_ROOT_URL%/%EXECUTION_RESULT_ID%[0m
echo [%EXECUTION_RESULT_ID%] Status: %STATUS%; Result: %RESULT%; Total passed: [92m%TOTAL_PASSED%/%TOTAL_COUNT%[0m
if "%RESULT%"=="FAILURE" (
	set ERRORLEVEL=1
	set ERRORMSG=Failed test case detected, please check Report URL or Testsigma dashboard for more information.
	goto ProcessError
)
echo [92m[%EXECUTION_RESULT_ID%] Test cases passed[0m	
exit /b

:NextIteration
echo:
exit /b

:ProcessError
REM Process error
echo [91m[%EXECUTION_RESULT_ID%] Error found. Level: %ERRORLEVEL%[0m
echo [91m[%EXECUTION_RESULT_ID%] Error details: %ERRORMSG%[0m
set HAVE_ERROR=1
goto NextIteration
exit /b