# Start the server detached (background) - terminal stays free
$workdir = Split-Path -Parent $MyInvocation.MyCommand.Path
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -notlike '*omniroute*' }
if ($existing) {
  Write-Host "Server already running (PID $($existing.ProcessId -join ', '))"
} else {
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $workdir -WindowStyle Hidden -RedirectStandardOutput "$workdir\server.log" -RedirectStandardError "$workdir\server_err.log"
  Write-Host "Server started in background -> http://localhost:3000"
}
