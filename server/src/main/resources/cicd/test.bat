@echo off

:: Define a list of tasks
set LIST=google.com,yahoo.com,bing.com

:: Iterate over the list and run each task asynchronously without opening new windows
for %%I in (%LIST%) do (
    :: start /b cmd /c echo [%%I] && ping %%I
	call :MyFn test
)

:: Notify that all tasks have been started
echo All tasks started asynchronously in the same window.

:MyFn
set P1=%1
echo run function with %P1%

pause
