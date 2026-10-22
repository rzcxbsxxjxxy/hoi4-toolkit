@echo off
rem HOI4 Toolkit QA Runner 一键入口(全部层 + bu 渲染结果)
rem 用法: 双击本文件,或命令行加参数 --base=... --layers=...
setlocal
set "NODE_EXE=C:\Users\123\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0run-all-tests.cjs" %*
exit /b %ERRORLEVEL%