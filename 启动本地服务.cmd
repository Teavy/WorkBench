@echo off
setlocal
cd /d "%~dp0"

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [Error] Node.js and npm are required. Install Node.js, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Installing project dependencies...
  call npm.cmd ci
  if errorlevel 1 (
    echo [Error] Dependency installation failed.
    pause
    exit /b 1
  )
)

powershell.exe -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { $response=Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/chroma/projects' -UseBasicParsing -TimeoutSec 2; if($response.StatusCode -eq 200 -and $response.Headers['Content-Type'] -like 'application/json*'){ exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 (
  echo Local server is already running. Opening the browser...
  start "" "http://127.0.0.1:3000/#chroma"
  exit /b 0
)

echo Starting local server at http://127.0.0.1:3000/#chroma
echo Keep this window open while using the app. Press Ctrl+C to stop the server.

start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $url='http://127.0.0.1:3000/'; for($i=0; $i -lt 60; $i++){ try { $response=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; if($response.StatusCode -eq 200){ Start-Process ($url+'#chroma'); break } } catch {}; Start-Sleep -Seconds 1 }"
call npm.cmd run dev -- --strictPort

if errorlevel 1 (
  echo [Error] The local server stopped with an error.
  pause
  exit /b 1
)
endlocal
