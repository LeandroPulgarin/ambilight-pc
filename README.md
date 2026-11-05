# Tira LED ambilight (SyncLight / Robobloq)

Control propio de la tira USB, sin depender de SyncLight. Protocolo en `PROTOCOLO.md`.

## Servicio (`servicio.js`)

Arranca solo con Windows (acceso directo "Tira LED ambilight" en la carpeta Inicio, que ejecuta `iniciar-servicio.vbs` sin ventana).

- Guarda el último estado en `estado.json` y lo vuelve a aplicar al reconectar la tira o al volver de suspensión/hibernación.
- Emula un puente Philips Hue para Alexa (puerto 80 + SSDP 1900; reglas de firewall creadas con `firewall-alexa.ps1`).
- Escucha en el puerto 443 solo para cortar al instante los intentos HTTPS del Echo; si no, el Echo espera hasta agotar el tiempo y dice "el dispositivo no responde".
- La red de casa debe estar como **privada** en Windows: Node tiene reglas de bloqueo para redes públicas.
- Registro en `servicio.log`. Con la variable `TIRA_DEBUG=1` registra cada petición del Echo y su tiempo de respuesta.

Para pararlo: Administrador de tareas → `node.exe` (el que ejecuta `servicio.js`). Para quitarlo del inicio, borra el acceso directo de `shell:startup`.

## Panel web

Abre `http://192.168.1.16` desde el móvil o el PC (misma red de casa). Desde ahí: encender/apagar, color, brillo, modo música (efecto e intensidad) y efectos integrados de la tira. En el móvil se puede añadir a la pantalla de inicio.

El código está en `panel/index.html` y lo sirve `servicio.js`. Solo acepta peticiones de la red local.

## Modo música

`audio/motor_audio.py` (lanzado por el servicio con el Python de `.venv`) detecta si Windows está reproduciendo algo y analiza el audio de la salida física. Mientras suena, el servicio dibuja el efecto elegido con el color actual de la tira:

| Efecto | Tipo |
|---|---|
| Respiración (`suave`), Latido, Espectro, Aurora | Tranquilos; la intensidad (0-100) decide cuánto se nota la música |
| Pulso, Vúmetro | Con más movimiento |

## Teclado

`entrada/motor_teclado.py` avisa de cada pulsación con su posición horizontal (nunca qué tecla es). El bloque principal del teclado (de Esc/Tab/Shift a Retroceso/Enter) se reparte por toda la tira; flechas y numérico van al borde derecho. Efectos: chispa, onda, onda intensa, arcoíris, cometas y velocidad, con rapidez ajustable.

## Ambilight

`pantalla/motor_pantalla.py` captura los bordes del monitor (API de duplicación de Windows vía `dxcam`) y manda un color por LED: lado izquierdo de abajo a arriba, borde superior de izquierda a derecha y lado derecho de arriba a abajo (14 + 26 + 14 LEDs). Solo corre mientras el ambilight está activo.

- **Automático con pantalla completa** (`entrada/motor_ventana.py`): se activa tras 1,5 s con un video, película o juego a pantalla completa y se desactiva 2 s después de salir, devolviendo la tira a su estado.
- **Siempre activo**: modo `pantalla` manual.
- **Suavizado** 0-100 para cambios de color más tranquilos.

## Alexa

Di "Alexa, descubre dispositivos" (o en la app: Dispositivos → + → Añadir dispositivo → Philips Hue → Detectar). Aparecen:

| Dispositivo | Qué hace |
|---|---|
| **LED monitor** | Encender/apagar, brillo y color ("Alexa, pon LED monitor en azul") |
| **LED monitor dinámico** | Activa el efecto dinámico del firmware |
| **LED monitor música** | Activa el modo música (micrófono de la tira) |
| **LED monitor ambilight** | Activa el ambilight; apagarlo vuelve al último color |
| **PC** (enchufe) | "Alexa, apaga el PC" lo suspende. Encenderlo necesitaría otro aparato con Wake-on-LAN |

Solo "LED monitor" apaga la tira; apagar los efectos o el ambilight vuelve al último color.

Alexa conserva el nombre del primer descubrimiento; si cambia aquí, renómbralo también en la app.

Solo funciona con el PC encendido (no suspendido).

## Línea de comandos (`cli.js`)

```
node cli.js estado | info
node cli.js color 255 0 0      |  node cli.js color #ff8800
node cli.js brillo 50
node cli.js pantalla | pantalla auto on | pantalla suavizado 70
node cli.js teclado on | intensa | rapidez 70
node cli.js sensibilidad 30
node cli.js efecto dinamico 3  |  node cli.js efecto ritmo 0
node cli.js velocidad 70
node cli.js encender | apagar
node cli.js arcoiris 10 | recorrido
node cli.js musica on | off | intensidad 70
node cli.js musica suave | latido | espectro | aurora | pulso | vumetro
```

Con el servicio en marcha, los comandos pasan por él para que el estado guardado esté al día.
