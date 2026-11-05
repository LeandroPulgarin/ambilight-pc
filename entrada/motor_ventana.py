"""Vigila si la ventana activa está a pantalla completa (video, juego, presentación).

Una vez por segundo envía a servicio.js por UDP (127.0.0.1:47803): {"fs": true/false, "app": "brave.exe"}

Se considera pantalla completa si:
  - la ventana activa cubre todo su monitor y no tiene barra de título (una ventana
    maximizada sí la tiene), o
  - Windows informa de una aplicación a pantalla completa (SHQueryUserNotificationState),
    lo que cubre los juegos en pantalla completa exclusiva.
"""

import ctypes
import json
import os
import socket
import sys
import threading
import time
from ctypes import wintypes

DESTINO = ("127.0.0.1", 47803)
user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32

GWL_STYLE = -16
WS_CAPTION = 0x00C00000
MONITOR_DEFAULTTONEAREST = 2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
QUNS_BUSY = 2  # una aplicación a pantalla completa
QUNS_RUNNING_D3D_FULL_SCREEN = 3  # juego Direct3D en pantalla completa exclusiva
ESCRITORIO = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"}
# Pantallas del sistema a pantalla completa que no son contenido (bloqueo, inicio de sesión)
IGNORAR = {"lockapp.exe", "logonui.exe"}

user32.GetWindowLongW.restype = ctypes.c_long
user32.MonitorFromWindow.restype = wintypes.HMONITOR
kernel32.OpenProcess.restype = wintypes.HANDLE


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


def morir_con_el_servicio():
    """servicio.js nos lanza con stdin en tubería: cuando se cierra (el servicio murió), salimos."""
    if sys.stdin is None:
        return
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    os._exit(0)


def nombre_proceso(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(512)
        tam = wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(tam)):
            return os.path.basename(buf.value)
        return ""
    finally:
        kernel32.CloseHandle(h)


def pantalla_completa():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return False, ""
    clase = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, clase, 256)
    if clase.value in ESCRITORIO:
        return False, ""

    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), ctypes.byref(mi))
    m = mi.rcMonitor
    cubre = rect.left <= m.left and rect.top <= m.top and rect.right >= m.right and rect.bottom >= m.bottom
    sin_titulo = (user32.GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION) != WS_CAPTION

    quns = ctypes.c_int(0)
    shell32.SHQueryUserNotificationState(ctypes.byref(quns))

    completa = (cubre and sin_titulo) or quns.value in (QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN)
    if not completa:
        return False, ""
    app = nombre_proceso(hwnd)
    if app.lower() in IGNORAR:
        return False, ""
    return True, app


def main():
    threading.Thread(target=morir_con_el_servicio, daemon=True).start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    print("Vigilando la pantalla completa", flush=True)
    while True:
        try:
            completa, app = pantalla_completa()
        except Exception:
            completa, app = False, ""
        sock.sendto(json.dumps({"fs": completa, "app": app}).encode(), DESTINO)
        time.sleep(1)


if __name__ == "__main__":
    main()
