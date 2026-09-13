@echo off
REM Starts the AgentRouter proxy in a minimised window.
REM Usage: start-proxy.cmd [node|python] [proxy args...]
REM   start-proxy.cmd node --log
REM   start-proxy.cmd python --verbose
REM Language defaults to node, or set AR_PROXY_LANG=python to change the default.
REM Set AR_VERBOSE=1 before running to see request logs.
REM set "AR_PROXY_PORT=8320"
REM Pass --log (stdout) or --log-file=traffic.log to dump headers + bodies.
REM Remaining arguments given to this script are forwarded to the proxy.

setlocal
cd /d "%~dp0"

set "AR_LANG=%~1"
if /i "%AR_LANG%"=="node" (
    shift
) else if /i "%AR_LANG%"=="python" (
    shift
) else (
    set "AR_LANG=%AR_PROXY_LANG%"
)
if "%AR_LANG%"=="" set "AR_LANG=node"

if /i "%AR_LANG%"=="python" (
    start "ar-proxy" /min python python\proxy.py %*
) else (
    start "ar-proxy" /min node node\proxy.js %*
)
