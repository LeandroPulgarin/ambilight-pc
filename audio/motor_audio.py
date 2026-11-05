"""Motor de audio para el modo música de la tira.

- Pregunta a Windows (SMTC) si alguna app está reproduciendo (Spotify, YouTube en el navegador...).
- Captura en loopback lo que suena por la salida física y lo separa en graves/medios/agudos.
- Envía ~45 lecturas por segundo a servicio.js por UDP (127.0.0.1:47800) en JSON:
  {"r": reproduciendo, "b": graves, "m": medios, "a": agudos, "n": nivel, "t": título, "app": app}
  con valores 0..1 normalizados con ganancia automática.

Uso: python motor_audio.py [--dispositivo "texto del nombre de la salida"]
"""

import argparse
import asyncio
import json
import os
import socket
import sys
import threading
import time
import warnings

import numpy as np
import soundcard as sc
from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Estado,
)

# soundcard avisa de "data discontinuity" cuando el sistema va cargado; no afecta al análisis
warnings.filterwarnings("ignore")

DESTINO = ("127.0.0.1", 47800)
RATE = 48000
BLOQUE = 1024  # ~21 ms por lectura
VENTANA = 2048  # muestras para la FFT
BANDAS = {"b": (30, 150), "m": (150, 2000), "a": (2000, 10000)}
SILENCIO_RMS = 1e-4

medios = {"r": False, "t": "", "app": ""}


def vigilar_medios():
    """Hilo aparte: cada segundo consulta qué está reproduciendo Windows."""

    async def bucle():
        mgr = await Manager.request_async()
        while True:
            try:
                activa = None
                for s in mgr.get_sessions():
                    if s.get_playback_info().playback_status == Estado.PLAYING:
                        activa = s
                        break
                if activa:
                    props = await activa.try_get_media_properties_async()
                    medios.update(r=True, t=f"{props.artist} - {props.title}".strip(" -"),
                                  app=activa.source_app_user_model_id)
                else:
                    medios.update(r=False, t="", app="")
            except Exception:
                pass
            await asyncio.sleep(1)

    asyncio.run(bucle())


def morir_con_el_servicio():
    """servicio.js nos lanza con stdin en tubería: cuando se cierra (el servicio murió), salimos."""
    if sys.stdin is None:
        return
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    os._exit(0)


def elegir_salida(texto):
    """Por defecto la salida física (no las virtuales de Sonar), que recibe la mezcla de todo."""
    salidas = sc.all_speakers()
    if texto:
        for s in salidas:
            if texto.lower() in s.name.lower():
                return s
    fisicas = [s for s in salidas if "sonar" not in s.name.lower()]
    return fisicas[0] if fisicas else sc.default_speaker()


class Banda:
    """Normaliza una banda con un pico que decae despacio (ganancia automática)."""

    def __init__(self):
        self.pico = 1e-6

    def __call__(self, v):
        self.pico = max(v, self.pico * 0.997, 1e-6)
        return min(1.0, v / self.pico)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dispositivo", default="")
    args = ap.parse_args()

    threading.Thread(target=vigilar_medios, daemon=True).start()
    threading.Thread(target=morir_con_el_servicio, daemon=True).start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    freqs = np.fft.rfftfreq(VENTANA, 1 / RATE)
    mascaras = {k: (freqs >= lo) & (freqs < hi) for k, (lo, hi) in BANDAS.items()}
    norm = {k: Banda() for k in [*BANDAS, "n"]}
    hann = np.hanning(VENTANA)
    buffer = np.zeros(VENTANA)

    while True:
        salida = elegir_salida(args.dispositivo)
        print(f"Escuchando: {salida.name}", flush=True)
        try:
            mic = sc.get_microphone(id=str(salida.name), include_loopback=True)
            with mic.recorder(samplerate=RATE, channels=2, blocksize=BLOQUE) as rec:
                while True:
                    mono = rec.record(numframes=BLOQUE).mean(axis=1)
                    buffer = np.concatenate([buffer[len(mono):], mono])
                    rms = float(np.sqrt(np.mean(mono ** 2)))
                    msg = {"r": medios["r"], "t": medios["t"], "app": medios["app"]}
                    if rms < SILENCIO_RMS:
                        msg.update(b=0, m=0, a=0, n=0)
                    else:
                        espectro = np.abs(np.fft.rfft(buffer * hann))
                        for k, m in mascaras.items():
                            msg[k] = round(norm[k](float(np.sqrt(np.mean(espectro[m] ** 2)))), 3)
                        msg["n"] = round(norm["n"](rms), 3)
                    sock.sendto(json.dumps(msg).encode(), DESTINO)
        except Exception as e:
            # La salida desapareció (auriculares desconectados, cambio de dispositivo...)
            print(f"Error de captura: {e}; reintentando en 3 s", flush=True)
            time.sleep(3)


if __name__ == "__main__":
    main()
