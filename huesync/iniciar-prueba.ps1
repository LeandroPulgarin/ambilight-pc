# Pasa al modo prueba Hue Sync: para el servicio normal (Alexa en el puerto 80), arranca diyHue
# en Docker y vuelve a lanzar servicio.js con TIRA_HUESYNC=1 (panel en el puerto 8080).
# Para volver a la normalidad: huesync\detener-prueba.ps1
$ErrorActionPreference = "Stop"
$raiz = Split-Path $PSScriptRoot -Parent

function Detener-Servicio {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like "*servicio.js*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "Servicio detenido (PID $($_.ProcessId))" }
}

Detener-Servicio
Start-Sleep -Seconds 1

Push-Location $PSScriptRoot
try { docker compose up -d } finally { Pop-Location }

# Mismo arranque sin ventana que iniciar-servicio.vbs, con la variable del modo prueba
$psi = New-Object System.Diagnostics.ProcessStartInfo "node", "`"$raiz\servicio.js`""
$psi.WorkingDirectory = $raiz
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables["TIRA_HUESYNC"] = "1"
$p = [System.Diagnostics.Process]::Start($psi)
"Servicio en modo prueba Hue Sync (PID $($p.Id))"
"  diyHue:  http://192.168.1.16"
"  Panel:   http://192.168.1.16:8080"
