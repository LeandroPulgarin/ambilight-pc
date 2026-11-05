# Abre en el firewall solo lo que necesita el puente Hue, y solo para la red local.
# Ejecutar como administrador (una sola vez).

$node = (Get-Command node).Source

Remove-NetFirewallRule -DisplayName "Tira LED - Hue HTTP", "Tira LED - Hue SSDP" -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName "Tira LED - Hue HTTP" -Direction Inbound -Action Allow `
  -Program $node -Protocol TCP -LocalPort 80 -RemoteAddress LocalSubnet -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "Tira LED - Hue SSDP" -Direction Inbound -Action Allow `
  -Program $node -Protocol UDP -LocalPort 1900 -RemoteAddress LocalSubnet -Profile Any | Out-Null

Get-NetFirewallRule -DisplayName "Tira LED - *" | Select-Object DisplayName, Enabled, Action |
  Format-Table | Out-File -Encoding utf8 "$PSScriptRoot\firewall-resultado.txt"
