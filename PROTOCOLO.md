# Protocolo USB del ambilight SyncLight (Robobloq)

Reconstruido leyendo el código de SyncLight 3.8.6 (`C:\Program Files\SyncLight\resources\app.asar`).
Código formateado de referencia en `analisis/main.pretty.js`. Los módulos clave son `60895` (protocolo HID), `5786` (transporte HID) y `51545` (dispositivo HID).

## Dispositivo

| Campo | Valor |
|---|---|
| VID / PID | `0x1A86` / `0xFE07` (chip WCH) |
| Fabricante USB | `ROBOBLOQ` |
| Interfaz usada | 0 (usage page `0xFF00`, HID genérico). La interfaz 1 (error código 10 en Windows) no se usa |
| Firmware | 1.7.3 |
| LEDs | 54 |
| Tamaño de pantalla configurado | 24" |

## Transporte

- Reports HID de salida de 64 bytes. Cada escritura va precedida de un byte `0x00` (report ID).
- Si un paquete supera los 64 bytes se trocea en bloques de 64.
- Las respuestas llegan como reports de entrada que empiezan por `RB` o `SC`. Se emparejan con la petición por el byte de secuencia (offset 3).

## Formato de paquete `RB`

```
offset  0   1   2        3     4        5..n-2   n-1
        'R' 'B' longitud seq   comando  datos    checksum
```

- `longitud` = longitud total del paquete (1 byte).
- `seq` = contador 1..254, se usa para emparejar la respuesta.
- `checksum` = suma de todos los bytes anteriores mod 256.

## Comandos

| Cmd | Nombre | Datos | Respuesta | Notas |
|---|---|---|---|---|
| `0x80` | setSyncScreen | — | no | Variante `SC` con longitud de 16 bits para firmware > 1.0.2 |
| `0x81` | writeDeviceInfo | `u16 id, displaySize, ?, 1, u16 leds` | sí | Configuración. **No usar sin entenderla** |
| `0x82` | readDeviceInfo | — | sí | Ver "Respuesta de info" |
| `0x83` | readDeviceUUID | — | sí | |
| `0x85` | setLedEffect | `tipo, índice` | — | tipo 2 = Dinámico, 3 = Ritmo; índice 0..6 |
| `0x86` | setSectionLED | `[desde, R, G, B, hasta] × N` | no | LEDs desde 1; `hasta = 254` = hasta el final |
| `0x87` | setBrightness | `valor` | — | Deslizador 0..100 en la app |
| `0x89` | setAutoOff | `activo, minutos` | — | |
| `0x8A` | setDynamicSpeed | `valor` | — | |
| `0x8B` | setSoundSensitivity | `valor` | — | Micrófono integrado (modo Ritmo) |
| `0x91` | setExternalAudio | `u16` | — | |
| `0x93` | setOpenUrl | `0/1` | — | La app lo manda tras leer la info |
| `0x95` | setLampsAmount | `n` | sí | Firmware ≥ 1.7.1. Cambia el número de LEDs |
| `0x96` | setWhiteBright | `a, b` | sí | |
| `0x97` | turnOffLight | — | sí | Solo firmware ≥ 1.8.0. En 1.7.3 se apaga con setSectionLED en negro |
| `0x98` | setComputerRhythm | `índice, nivel` | sí | Solo firmware ≥ 1.8.2 (ritmo con el audio del PC) |

### Respuesta de info (`0x82`)

| Offset | Campo |
|---|---|
| 5..7 | id (`001600`) |
| 8 | tamaño de pantalla (pulgadas) |
| 11 | número de LEDs |
| 12..19 | uuid |
| 21..23 | versión de firmware |

### Ejemplos

Toda la tira roja:
```
52 42 0B 05 86 01 FF 00 00 FE 28     (seq = 05)
```

Apagar (firmware < 1.8.0): `setSectionLED [1, 0, 0, 0, 254]`.

## Sincronización con la pantalla

En firmware 1.x la app captura la pantalla y manda segmentos `[desde, R, G, B, hasta]` con `setSectionLED`, como mucho 11 segmentos (55 valores) por paquete y 20 ms entre paquetes. El firmware no sabe nada de la pantalla: el ambilight lo calcula el PC.

Los efectos Dinámicos y Ritmo (con el micrófono integrado) los genera el propio firmware. Basta con mandar `setLedEffect` una vez.
