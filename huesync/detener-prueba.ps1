# Sale del modo prueba Hue Sync: para diyHue y vuelve a lanzar el servicio normal (Alexa en el 80).
$ErrorActionPreference = "Stop"
$raiz = Split-Path $PSScriptRoot -Parent

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*servicio.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "Servicio de prueba detenido (PID $($_.ProcessId))" }

Push-Location $PSScriptRoot
try { docker compose stop } finally { Pop-Location }

Start-Process wscript.exe -ArgumentList "`"$raiz\iniciar-servicio.vbs`""
"Servicio normal arrancado (Alexa y panel en http://192.168.1.16)"
