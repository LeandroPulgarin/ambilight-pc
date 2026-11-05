# Bitácora de la prueba Hue Sync (5 de noviembre de 2026)

## Objetivo

Antes de comprar tiras LED y pagar la app **Hue Sync** del TV, comprobar si un Hue Bridge emulado
([diyHue](https://github.com/diyhue/diyHue)) en este PC funciona con las apps oficiales de Hue,
usando la tira USB del monitor como luz de prueba. Lo que se quiere validar con el TV es la
sincronización con la PS5 por HDMI, Netflix y YouTube, y que los colores se refresquen con fluidez.

## Equipo

- PC con Windows 11 y Docker Desktop (WSL2). Ethernet `192.168.1.16`, MAC `2c:f0:5d:69:88:9f`.
- Tira USB Robobloq/SyncLight (HID `1A86:FE07`, 54 LEDs, 14 + 26 + 14), controlada por `servicio.js`.
- TV Samsung **Q7F** (2025), Tizen 10 (actualizado el 5/11/2026), región de la tienda: México.
  La app Hue Sync ya estaba instalada.
- iPhone con la app Philips Hue (cuenta creada con país Colombia).
- Un ESP32 sin usar, para la instalación definitiva con WLED.

## Decisiones

| Decisión | Motivo |
|---|---|
| Probar con la **app del TV**, no con Hue Sync para PC | La app de PC es gratis, pero hace lo mismo que el ambilight propio de este proyecto. Lo que hay que validar es el TV: HDMI, apps integradas y fluidez. |
| diyHue en **Docker** (imagen `diyhue/core:latest` del 23/10/2026) | Es la instalación que recomienda diyHue, y la de Windows sin Docker no está mantenida. La imagen incluye los arreglos de Entertainment para TV Samsung (PR #1104, agosto de 2026). |
| Docker en **modo bridge**, con la IP y la MAC de la Ethernet | Docker Desktop en Windows no tiene `network_mode: host`. La app Hue no empareja si la MAC no coincide (el certificado se genera con ella). |
| La tira se presenta como un **WLED falso** (`lib/wled.js`) | diyHue no soporta luces USB, y para WLED manda el stream sin cifrar por UDP (DNRGB, puerto 21324), que es fácil de reenviar a la tira. Es el mismo camino que seguirá el ESP32 con WLED real, así que la prueba es representativa. |
| **5 zonas** (Izquierda, 3 arriba, Derecha) | Hue Sync manda un color por luz, con un máximo de 10 por área. Con 5 se ve cómo reparte los bordes sin complicar la prueba. |
| WLED falso en el **puerto 8090**, alta manual de las luces (`agregar-luces.js`) | diyHue ocupa el 80. Acepta `ip:puerto` para WLED, pero el descubrimiento automático solo prueba el 80, así que las luces se dan de alta por su API con `host.docker.internal:8090`. |
| **SSDP y mDNS** (`lib/mdns.js`) desde `servicio.js` | El multicast del contenedor no sale a la red de casa. El servicio anuncia el puente en nombre de diyHue, con el mismo bridgeid (`2CF05DFFFE69889F`). |
| Modo prueba **opcional** (`TIRA_HUESYNC=1`) en una rama aparte (`prueba-diyhue`) | En modo prueba se apaga el puente de Alexa, porque diyHue necesita los puertos 80 y 443. `main` sigue funcionando igual. |
| Botón de enlace con `abrir-enlace.ps1` | La web de diyHue pide login para "pulsar" el botón. El script fija `lastlinkbuttonpushed` en el futuro y reinicia el contenedor. Usa la hora Unix en UTC, porque `Get-Date -UFormat %s` de PowerShell 5.1 usa la hora local y daba 5 horas de desfase. |
| **No pagar** la app del TV todavía | Lo que se podía validar sin pagar está validado. Antes de pagar, primero se compran las tiras y se monta el ESP32, para hacer la prueba completa de una sola vez. |

## Resultados

| Prueba | Resultado |
|---|---|
| diyHue responde como Hue Bridge (HTTP 80, HTTPS 443, `bridgeid` correcto) | OK |
| Del contenedor al WLED falso: HTTP (`/json`) y stream UDP | OK. El stream llegó a la tira a 30 FPS. |
| Control de las 5 zonas por la API de diyHue (un color distinto en cada una) | OK |
| La app Hue del iPhone encuentra el bridge | OK. Primero dice "no se encontró ningún bridge" (busca en la nube de Philips) y después lo encuentra en la red local. |
| Emparejamiento del iPhone (`Hue#iPhone`, con `clientkey` de Entertainment) | OK |
| Encender y apagar desde la app | OK |
| Ver las luces en la app | Solo después de meterlas en una habitación ("Sala"). La app no muestra luces que no estén en ninguna habitación. |
| Área de entretenimiento "TV" (tipo pantalla) con las 5 zonas | OK, creada desde el iPhone |
| App Hue Sync del TV | **Pendiente**: pide pagar antes de buscar el bridge |
| Stream real de Entertainment (DTLS) desde el TV | **Pendiente** |

Observaciones:
- El paso de conectar el bridge a la cuenta Hue se omite sin problema. diyHue siempre dice que no está
  conectado a la nube de Philips, y no hace falta para el control local ni para Entertainment.
- Mientras la prueba estaba activa, el Echo consultaba a diyHue (`/api/alexa/lights/…`), porque tiene la
  misma identidad de puente que el de Alexa del servicio. No causó problemas.

## Riesgos abiertos

- **Tizen 10** salió el mismo día de la prueba y nadie lo ha probado con diyHue.
- El [issue #1099](https://github.com/diyhue/diyHue/issues/1099) reporta que el stream se corta cuando el TV entra en reposo.
- La app del TV necesita diyHue encendido en algún equipo de la red: el PC encendido o, más adelante, una Raspberry Pi.
- Precio de la app: en 2024 se hablaba de USD 129,99 de pago único o unos USD 3 al mes. Hay que comprobarlo en la tienda (región México).

## Próximos pasos

1. Comprar la tira LED (WS2812B o SK6812, 5 V, con la densidad y el largo según el TV) y la fuente de alimentación.
2. Instalar **WLED** en el ESP32 y montar la tira detrás del TV. Configurar en WLED los segmentos (hasta 10 zonas) y el
   puerto realtime UDP 21324, que es el de por defecto.
3. Con WLED real ya no hace falta el WLED falso: diyHue lo encuentra por mDNS o por su IP en el puerto 80.
   Dar de alta los segmentos en diyHue, meterlos en una habitación y crear el área de entretenimiento.
4. Arrancar la prueba (`.\huesync\iniciar-prueba.ps1` en la rama `prueba-diyhue`), abrir el emparejamiento
   (`.\huesync\abrir-enlace.ps1`), pagar el **plan mensual** de Hue Sync en el TV y emparejarlo.
5. Probar PS5 por HDMI, Netflix, YouTube y HDR. Ver los FPS con `docker logs -f diyhue` (línea `Entertainment FPS`).
   Probar también qué pasa cuando el TV entra en reposo.
6. Decidir: si funciona bien, buscar dónde dejar diyHue encendido siempre y cancelar o mantener la suscripción.
   Si no, alternativa sin suscripción: WLED con HyperHDR y una capturadora HDMI.

## Estado al cerrar la sesión

- El servicio volvió al modo normal en `main` (Alexa y el panel en el puerto 80). El contenedor `diyhue` quedó detenido.
- `huesync/config/` (fuera de git) guarda la configuración de diyHue: el usuario del iPhone, la habitación
  "Sala", el área "TV" y las 5 luces. Al volver a arrancar la prueba se conserva todo.
