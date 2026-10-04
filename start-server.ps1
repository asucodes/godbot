# Starts the Paper 1.21.6 demo server. Safe to re-run; does nothing if already running.
$java = 'D:\xerocrpyt\cline-godbot\runtime\jdk-21.0.12.1+1-jre\bin\java.exe'
$dir  = 'D:\xerocrpyt\cline-godbot\server-1216'
$port = Test-NetConnection -ComputerName 127.0.0.1 -Port 25565 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($port) { Write-Host 'Server already listening on 25565'; exit 0 }
Start-Process $java -ArgumentList '-Xms2G','-Xmx2G','-jar','paper.jar','--nogui' `
  -WorkingDirectory $dir `
  -RedirectStandardOutput "$dir\server.log" -RedirectStandardError "$dir\server.err"
Write-Host 'Server starting... wait ~30s for "Done" in server.log'
