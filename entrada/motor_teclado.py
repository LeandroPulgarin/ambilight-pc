"""Motor de teclado para la tira: avisa a servicio.js de cada pulsación con su posición.

Privacidad: solo se envía la posición horizontal aproximada de la tecla en el teclado
(0 = borde izquierdo, 1 = borde derecho), nunca qué tecla es. No se guarda nada.

Envía por UDP a 127.0.0.1:47801 un JSON por pulsación: {"x": 0.42}
"""

import json
import os
import socket
import sys
import threading

from pynput import keyboard

DESTINO = ("127.0.0.1", 47801)
# La tira representa solo el bloque principal: de Esc/Tab/Shift (0) a Retroceso/Enter (13.5).
# Lo que queda a la derecha (flechas, numérico, multimedia) se ilumina en el borde derecho.
ANCHO = 13.5


def _fila(teclas, inicio, paso=1.0):
    return {t: inicio + i * paso for i, t in enumerate(teclas)}


# Posición horizontal del centro de cada tecla (por su código virtual de Windows), en unidades
# de tecla desde el borde izquierdo de un teclado completo
POS = {}
POS.update({0x1B: 0})  # Esc
POS.update(_fila([0x70, 0x71, 0x72, 0x73], 2))  # F1-F4
POS.update(_fila([0x74, 0x75, 0x76, 0x77], 6.5))  # F5-F8
POS.update(_fila([0x78, 0x79, 0x7A, 0x7B], 11))  # F9-F12
POS.update({0xC0: 0, 0x08: 13.5, 0xBD: 11, 0xBB: 12})  # ` Retroceso - =
POS.update(_fila([ord(c) for c in "1234567890"], 1))
POS.update({0x09: 0.5, 0xDB: 11.5, 0xDD: 12.5, 0xDC: 13.5})  # Tab [ ] \
POS.update(_fila([ord(c) for c in "QWERTYUIOP"], 1.5))
POS.update({0x14: 0.8, 0xBA: 10.8, 0xDE: 11.8, 0x0D: 13.2})  # Bloq Mayús ; ' Enter
POS.update(_fila([ord(c) for c in "ASDFGHJKL"], 1.8))
POS.update({0xA0: 1.1, 0x10: 1.1, 0xA1: 13, 0xBC: 9.3, 0xBE: 10.3, 0xBF: 11.3, 0xE2: 1.8})  # Shift , . /
POS.update(_fila([ord(c) for c in "ZXCVBNM"], 2.3))
# Ctrl, Win, Alt, Espacio, AltGr, Menú, Ctrl der.
POS.update({0xA2: 0.6, 0x11: 0.6, 0x5B: 1.9, 0xA4: 3.1, 0x12: 3.1, 0x20: 6.5, 0xA5: 9.9, 0x5D: 11.2, 0xA3: 13.3})
# Impr Pant, Bloq Despl, Pausa, Insert, Inicio, RePág, Supr, Fin, AvPág y flechas
POS.update({0x2C: 15, 0x91: 16, 0x13: 17, 0x2D: 15, 0x24: 16, 0x21: 17, 0x2E: 15, 0x23: 16, 0x22: 17})
POS.update({0x26: 16, 0x25: 15, 0x28: 16, 0x27: 17})
# Teclado numérico
POS.update({0x90: 18.5, 0x6F: 19.5, 0x6A: 20.5, 0x6D: 21.5, 0x6B: 21.5})
POS.update({0x67: 18.5, 0x68: 19.5, 0x69: 20.5, 0x64: 18.5, 0x65: 19.5, 0x66: 20.5})
POS.update({0x61: 18.5, 0x62: 19.5, 0x63: 20.5, 0x60: 19, 0x6E: 20.5})
# Teclas multimedia de los Redragon (volumen, reproducción) a la derecha
POS.update({0xAD: 20, 0xAE: 20.5, 0xAF: 21, 0xB0: 21.5, 0xB1: 19.5, 0xB3: 20.5})


def morir_con_el_servicio():
    """servicio.js nos lanza con stdin en tubería: cuando se cierra (el servicio murió), salimos."""
    if sys.stdin is None:
        return
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    os._exit(0)


def main():
    threading.Thread(target=morir_con_el_servicio, daemon=True).start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    pulsadas = set()  # para ignorar la autorrepetición al mantener una tecla

    def vk_de(tecla):
        if isinstance(tecla, keyboard.KeyCode):
            return tecla.vk
        return tecla.value.vk if tecla and tecla.value else None

    def al_pulsar(tecla):
        vk = vk_de(tecla)
        if vk is None or vk in pulsadas:
            return
        pulsadas.add(vk)
        x = POS.get(vk, ANCHO / 2)  # teclas desconocidas: al centro
        sock.sendto(json.dumps({"x": round(min(x, ANCHO) / ANCHO, 3)}).encode(), DESTINO)

    def al_soltar(tecla):
        pulsadas.discard(vk_de(tecla))

    print("Escuchando el teclado", flush=True)
    with keyboard.Listener(on_press=al_pulsar, on_release=al_soltar) as listener:
        listener.join()


if __name__ == "__main__":
    main()
