"""Motor de pantalla (ambilight): captura los bordes del monitor y envía un color por LED.

La tira (vista de frente) empieza abajo a la izquierda, sube por el lado izquierdo, cruza
por arriba y baja por el derecho. Así que se envían, en este orden:
  lado izquierdo de abajo a arriba, borde superior de izquierda a derecha, lado derecho de
  arriba a abajo.

Envía ~30 veces por segundo a servicio.js por UDP (127.0.0.1:47802): {"c": [r, g, b, r, g, b, ...]}

Uso: python motor_pantalla.py --izq 14 --arriba 26 --der 14 [--salida 0]
"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import warnings

import dxcam
import numpy as np

warnings.filterwarnings("ignore")

DESTINO = ("127.0.0.1", 47802)
FPS = 30
REDUCCION = 8  # se analiza 1 de cada 8 píxeles en cada eje (1920x1080 -> 240x135)
PROFUNDIDAD = 0.12  # franja del borde que se promedia (12 % del ancho/alto)
SATURACION = 1.25  # realce de color: los bordes promediados tienden a salir grisáceos
NEGRO = 10  # por debajo de esto el LED se apaga (barras negras de películas, fondos oscuros)


def morir_con_el_servicio():
    """servicio.js nos lanza con stdin en tubería: cuando se cierra (el servicio murió), salimos."""
    if sys.stdin is None:
        return
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    os._exit(0)


def tramos(franja, n, eje):
    """Divide la franja en n tramos a lo largo del eje y devuelve el color medio de cada uno."""
    return np.array([t.mean(axis=(0, 1)) for t in np.array_split(franja, n, axis=eje)])


def colores_bordes(img, izq, arriba, der):
    alto, ancho, _ = img.shape
    dx = max(1, int(ancho * PROFUNDIDAD))
    dy = max(1, int(alto * PROFUNDIDAD))
    lado_izq = tramos(img[:, :dx], izq, 0)[::-1]  # de abajo a arriba
    borde_sup = tramos(img[:dy, :], arriba, 1)  # de izquierda a derecha
    lado_der = tramos(img[:, -dx:], der, 0)  # de arriba a abajo
    c = np.concatenate([lado_izq, borde_sup, lado_der])

    gris = c.mean(axis=1, keepdims=True)
    c = gris + (c - gris) * SATURACION
    c[c.max(axis=1) < NEGRO] = 0
    return np.clip(c, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--izq", type=int, default=14)
    ap.add_argument("--arriba", type=int, default=26)
    ap.add_argument("--der", type=int, default=14)
    ap.add_argument("--salida", type=int, default=0)
    args = ap.parse_args()

    threading.Thread(target=morir_con_el_servicio, daemon=True).start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    while True:
        cam = None
        try:
            # BGRA es el formato nativo: así no hace falta OpenCV para convertir
            cam = dxcam.create(output_idx=args.salida, output_color="BGRA")
            cam.start(target_fps=FPS, video_mode=True)
            print(f"Capturando la pantalla {args.salida} ({cam.width}x{cam.height})", flush=True)
            while True:
                cuadro = cam.get_latest_frame()
                if cuadro is None:
                    raise RuntimeError("la captura no devolvió imagen")
                img = cuadro[::REDUCCION, ::REDUCCION, 2::-1].astype(np.float32)  # BGRA -> RGB
                c = colores_bordes(img, args.izq, args.arriba, args.der)
                sock.sendto(json.dumps({"c": c.flatten().tolist()}).encode(), DESTINO)
        except Exception as e:
            # Cambio de resolución, pantalla de bloqueo/UAC, juego a pantalla completa exclusiva...
            print(f"Captura interrumpida ({e}); reintentando en 2 s", flush=True)
            try:
                if cam:
                    cam.stop()
                    del cam
            except Exception:
                pass
            time.sleep(2)


if __name__ == "__main__":
    main()
