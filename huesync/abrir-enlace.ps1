# Equivale a pulsar el botón de enlace del puente durante unos minutos: cualquier app Hue de la
# red (móvil, TV, agregar-luces.js) puede emparejarse mientras dure. Después se cierra sola.
# diyHue guarda el último "pulsado" en config.yaml y acepta usuarios hasta 30 s después; aquí se
# pone en el futuro y se reinicia el contenedor para que lo lea.
#   .\huesync\abrir-enlace.ps1            # 5 minutos
#   .\huesync\abrir-enlace.ps1 -Minutos 10
param([int]$Minutos = 5)
$ErrorActionPreference = "Stop"
$config = Join-Path $PSScriptRoot "config\config.yaml"

Push-Location $PSScriptRoot
try {
    docker compose stop | Out-Null
    # Hora Unix en UTC (Get-Date -UFormat %s de PowerShell 5.1 usa la hora local)
    $hasta = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $Minutos * 60 - 30
    $texto = [IO.File]::ReadAllText($config)
    $texto = [regex]::Replace($texto, "lastlinkbuttonpushed: [\d.]+", "lastlinkbuttonpushed: $hasta")
    [IO.File]::WriteAllText($config, $texto)
    docker compose start | Out-Null
} finally { Pop-Location }
"Emparejamiento abierto durante $Minutos minutos (hasta las $((Get-Date).AddMinutes($Minutos).ToString('HH:mm')))"
