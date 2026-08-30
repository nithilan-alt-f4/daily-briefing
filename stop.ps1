# Stop only this project's server (never touches other node processes like omniroute)
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -notlike '*omniroute*' }
if ($proc) {
  $proc | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped server PID $($_.ProcessId)" }
} else {
  Write-Host "No server running"
}
