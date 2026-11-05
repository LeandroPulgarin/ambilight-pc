"""Motor de la lámpara Tuya (RGB Floor Lamp, 20 tramos): le aplica por red local los colores que
le pide servicio.js.

Recibe por UDP (127.0.0.1:47804) mensajes {"on": true/false, "zonas": [[r, g, b], ...]} con una o
varias zonas de abajo a arriba. Usa paint_colour_data (DP 61), que cambia el color al instante;
colour_data (DP 24) hace un fundido propio que se ve raro al seguir la pantalla.

Formato de DP 61 deducido leyendo lo que genera la app al pintar (base64 de):
  00 02 00 14 | 00 | hhhh ssss vvvv                      -> toda la lámpara de un color
  00 02 00 14 | 01 | hhhh ssss vvvv | 80+n | t1 .. tn     -> solo los n tramos indicados
(02 = modo pintar; 00 lo pone en blanco. 0x14 = 20 tramos, numerados de abajo, 0, a arriba, 19.)
La lámpara solo aplica un color por orden, así que cada zona es una orden distinta.

La clave local está en tuya/devices.json (obtenida con el asistente de tinytuya).
"""

import base64
import colorsys
import json
import os
import socket
import sys
import threading
import time

import tinytuya

AQUI = os.path.dirname(os.path.abspath(__file__))
DISPOSITIVOS = os.path.join(AQUI, "..", "tuya", "devices.json")
PUERTO = 47804
IP_INICIAL = "192.168.1.4"
VERSION = 3.5
TRAMOS = 20
# Entre órdenes. Aguantó 7-8 por segundo en una prueba corta, pero luego se colgó y se cayó del
# WiFi (quizá también por conexiones extra abiertas a la vez), así que se va con margen.
INTERVALO = 0.25
UMBRAL = 10  # diferencia mínima en algún canal RGB para volver a pintar una zona
LATIDO = 10  # segundos entre comprobaciones de que la conexión sigue viva


def morir_con_el_servicio():
    """servicio.js nos lanza con stdin en tubería: cuando se cierra (el servicio murió), salimos."""
    if sys.stdin is None:
        return
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    os._exit(0)


def hsv(rgb):
    """RGB 0..255 -> bytes hhhh ssss vvvv (h 0..360, s y v 0..1000; v mínimo 10)."""
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    return (round(h * 360) % 360).to_bytes(2, "big") + round(s * 1000).to_bytes(2, "big") + \
        max(10, round(v * 1000)).to_bytes(2, "big")


def orden_toda(rgb):
    return bytes([0x00, 0x02, 0x00, TRAMOS, 0x00]) + hsv(rgb)


def orden_tramos(rgb, tramos):
    return bytes([0x00, 0x02, 0x00, TRAMOS, 0x01]) + hsv(rgb) + bytes([0x80 | len(tramos), *tramos])


def tramos_de_zona(i, n):
    """Tramos (de abajo a arriba) que corresponden a la zona i de n."""
    return list(range(round(i * TRAMOS / n), round((i + 1) * TRAMOS / n)))


def diferencia(a, b):
    return 999 if a is None or b is None else max(abs(x - y) for x, y in zip(a, b))


class Lampara:
    def __init__(self, dev_id, clave):
        self.id = dev_id
        self.clave = clave
        self.ip = IP_INICIAL
        self.b = None
        self.encendida = None
        self.pintado = []  # color que tiene cada zona, según lo último enviado
        self.ultimo_latido = 0.0

    def conectar(self):
        b = tinytuya.BulbDevice(self.id, self.ip, self.clave, version=VERSION)
        b.set_socketPersistent(True)
        b.set_socketTimeout(1.5)
        estado = b.status()
        if not estado or "dps" not in estado:
            encontrada = tinytuya.find_device(self.id)  # quizá cambió de IP
            if encontrada and encontrada.get("ip"):
                self.ip = encontrada["ip"]
                print(f"Lámpara encontrada en {self.ip}", flush=True)
            raise RuntimeError("la lámpara no respondió")
        self.b = b
        self.encendida = estado["dps"].get("20")
        self.pintado = []
        self.ultimo_latido = time.time()
        print(f"Lámpara conectada en {self.ip}", flush=True)

    def comprobar(self):
        """Cada LATIDO segundos confirma que la conexión persistente sigue viva."""
        if time.time() - self.ultimo_latido < LATIDO:
            return
        r = self.b.status()
        if not r or "dps" not in r:
            raise RuntimeError("la lámpara dejó de responder")
        self.encendida = r["dps"].get("20")
        self.ultimo_latido = time.time()

    def paso(self, on, zonas):
        """Aplica como mucho una orden hacia el estado pedido. Devuelve True si envió algo."""
        if self.b is None:
            self.conectar()
        self.comprobar()
        if not on:
            if self.encendida is not False:
                self.b.set_value(20, False)
                self.encendida = False
                return True
            return False
        if self.encendida is not True:
            self.b.set_value(20, True)
            self.encendida = True
            self.pintado = []
            return True
        if not zonas:
            return False
        n = len(zonas)
        if len(self.pintado) != n:
            self.pintado = [None] * n
        if n == 1:
            if diferencia(zonas[0], self.pintado[0]) < UMBRAL:
                return False
            self.enviar(orden_toda(zonas[0]))
            self.pintado[0] = zonas[0]
            return True
        # Varias zonas: primero la que más ha cambiado
        i = max(range(n), key=lambda k: diferencia(zonas[k], self.pintado[k]))
        if diferencia(zonas[i], self.pintado[i]) < UMBRAL:
            return False
        self.enviar(orden_tramos(zonas[i], tramos_de_zona(i, n)))
        self.pintado[i] = zonas[i]
        return True

    def enviar(self, datos):
        self.b.set_value(61, base64.b64encode(datos).decode(), nowait=True)


def main():
    threading.Thread(target=morir_con_el_servicio, daemon=True).start()
    with open(DISPOSITIVOS, encoding="utf-8") as f:
        d = json.load(f)[0]
    lampara = Lampara(d["id"], d["key"])

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", PUERTO))
    sock.settimeout(INTERVALO)

    pedido = None  # último {"on", "zonas"} recibido
    while True:
        try:
            while True:  # vaciar la cola y quedarse con el más reciente
                datos, _ = sock.recvfrom(4096)
                pedido = json.loads(datos)
                sock.settimeout(0)
        except (BlockingIOError, socket.timeout):
            pass
        except Exception:
            pass
        sock.settimeout(INTERVALO)
        if pedido is None:
            continue
        try:
            if lampara.paso(bool(pedido.get("on")), pedido.get("zonas")):
                time.sleep(INTERVALO)
        except Exception as e:
            print(f"Lámpara sin respuesta ({e}); reintento en 5 s", flush=True)
            lampara.b = None
            time.sleep(5)


if __name__ == "__main__":
    main()
