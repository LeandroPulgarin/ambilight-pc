# Prueba Hue Sync (TV Samsung → diyHue → tira USB)

Prueba de concepto para validar la app **Hue Sync** del TV sin comprar un Hue Bridge ni tiras nuevas.

```
TV (app Hue Sync) ──red──▶ PC: diyHue en Docker (puente Hue falso) ──UDP──▶ servicio.js (WLED falso) ──USB──▶ tira
```

- **diyHue** (`docker-compose.yml`) hace de Hue Bridge en los puertos 80, 443 y 2100/udp (Entertainment).
- **servicio.js** con `TIRA_HUESYNC=1`:
  - apaga el puente de Alexa y mueve el panel a `http://192.168.1.16:8080`;
  - ofrece la tira a diyHue como un WLED (`lib/wled.js`, HTTP 8090 + realtime UDP 21324) con 5 zonas: Izquierda, Arriba izquierda, Arriba centro, Arriba derecha, Derecha;
  - anuncia el puente por SSDP y mDNS (`lib/mdns.js`), porque desde Docker Desktop el multicast no sale a la red.

## Uso

```powershell
.\huesync\iniciar-prueba.ps1        # para el servicio normal, arranca diyHue y el modo prueba
.\huesync\abrir-enlace.ps1          # "pulsa" el botón del puente 5 minutos (para emparejar el TV o el móvil)
node huesync\agregar-luces.js       # solo la primera vez: da de alta las 5 zonas en diyHue
.\huesync\detener-prueba.ps1        # vuelve al servicio normal (Alexa, panel en el puerto 80)
```

Emparejar el TV: abrir la ventana de enlace, buscar el puente desde la app Hue Sync del TV, crear un área de
entretenimiento con las 5 zonas colocadas como están en el monitor y empezar a sincronizar.

Para ver si llega el stream y a cuántos FPS: `Invoke-RestMethod http://192.168.1.16:8080/tira | % hueSync`,
o `docker logs -f diyhue` (línea `Entertainment FPS`).

`huesync/config/` guarda la configuración de diyHue (usuarios y claves del puente): no se sube al repo.
