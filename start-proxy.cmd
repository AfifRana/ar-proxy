@echo off
REM Starts the AgentRouter proxy in a minimised window.
REM Set AR_VERBOSE=1 before running to see request logs.
REM Pass --log (stdout) or --log-file=traffic.log to dump headers + bodies.
REM Any arguments given to this script are forwarded to proxy.js.

cd /d "%~dp0"
set "AR_PROXY_PORT=8320"
start "ar-proxy" /min node proxy.js %*
