// Servicio en segundo plano para la tira:
//  - Guarda el último estado en estado.json y lo vuelve a aplicar al reconectar el USB
//    o al volver de suspensión/hibernación.
//  - Emula un puente Philips Hue para controlarla con Alexa (puerto 80 + SSDP).
//  - Expone GET/POST /tira (solo desde la red local) para cli.js y el panel web.
//  - Sirve el panel web (panel/index.html) en http://<ip-del-pc>/
//  - Modo música: arranca audio/motor_audio.py y, mientras Windows reproduce algo, dibuja
//    un efecto que sigue la música con el color actual de la tira.
//  - Teclado: arranca entrada/motor_teclado.py y cada pulsación lanza una onda de luz en la
//    posición equivalente de la tira.
//  - Ambilight: pantalla/motor_pantalla.py copia los bordes del monitor. Se activa a mano
//    (modo "pantalla") o solo con algo a pantalla completa (entrada/motor_ventana.py).
//  - Lámpara Tuya: luces/motor_lampara.py le aplica por red local el color de la tira.
//
// Uso: node servicio.js   (arranca solo con Windows mediante iniciar-servicio.vbs)

const fs = require("fs");
const path = require("path");
const http = require("http");
const dgram = require("dgram");
const { spawn } = require("child_process");
const HID = require("node-hid");
const { SyncLight, EFFECT_TYPE, sleep } = require("./lib/synclight");
const { HueBridge } = require("./lib/hue");
const { Musica, EFECTOS } = require("./lib/musica");
const { Teclado, EFECTOS_TECLADO } = require("./lib/teclado");
const { hsvToRgb, hueSatToRgb, xyToRgb, ctToRgb, rgbToHueSat } = require("./lib/colores");
const { WledFalso, segmentosTira } = require("./lib/wled");
const { AnuncioHue } = require("./lib/mdns");

// Modo de prueba Hue Sync (TIRA_HUESYNC=1): diyHue en Docker ocupa los puertos 80/443 como
// puente Hue y la tira se le ofrece como un WLED. El puente de Alexa se apaga, el panel pasa
// al puerto 8080 y este servicio solo anuncia el puente (SSDP/mDNS) en nombre de diyHue.
const HUESYNC = process.env.TIRA_HUESYNC === "1";
const PUERTO_PANEL = HUESYNC ? 8080 : 80;
let wled = null;

const ESTADO_PATH = path.join(__dirname, "estado.json");
const LOG_PATH = path.join(__dirname, "servicio.log");
const POLL_MS = 3000;
// Si entre dos ticks pasa mucho más que POLL_MS, el PC estuvo suspendido
const SALTO_SUSPENSION_MS = 20000;
// La tira puede ir a cualquiera de los PCs de casa y el servicio corre en todos: solo atiende a
// Alexa y a la lámpara el que la tiene conectada. Todos usan la misma identidad de puente Hue
// (la MAC del PC personal, con la que Alexa descubrió las luces) para que no se dupliquen.
const PUENTE_MAC = "2c:f0:5d:69:88:9f";

const log = (msg) => {
  const line = `${new Date().toLocaleString("es")}  ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
};

// ---------- Estado persistente ----------

const ESTADO_INICIAL = {
  encendida: true,
  modo: "efecto", // "color" | "efecto" | "pantalla" (ambilight)
  color: [255, 255, 255],
  brillo: 100, // 0..100
  efecto: { tipo: EFFECT_TYPE.dinamico, indice: 0 },
  velocidad: 70,
  sensibilidad: 50, // 0..100, micrófono integrado de la tira (efectos de ritmo)
  musicaAuto: true, // activar el modo música al reproducir algo
  efectoMusica: "suave", // uno de EFECTOS en lib/musica.js
  intensidadMusica: 70, // 0..100, cuánto respira el efecto "suave"
  tecladoActivo: true, // ondas de luz al escribir
  efectoTeclado: "onda", // uno de EFECTOS_TECLADO en lib/teclado.js
  velocidadTeclado: 50, // 0..100 → ondas a 0,5x..2x (50 = normal)
  suavizadoPantalla: 50, // 0..100, cuánto se suavizan en el tiempo los colores del ambilight
  pantallaAuto: true, // activar el ambilight solo mientras algo está a pantalla completa
  lamparaSync: true, // la lámpara Tuya sigue el color de la tira (requiere tuya/devices.json)
  lamparaZonas: 4, // 1..5 zonas de la lámpara en ambilight (copian el lado izquierdo de la pantalla)
};

let estado = { ...ESTADO_INICIAL };
try {
  estado = { ...ESTADO_INICIAL, ...JSON.parse(fs.readFileSync(ESTADO_PATH, "utf8")) };
} catch {}

const guardar = () => {
  try {
    fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
  } catch (e) {
    log(`No se pudo guardar el estado: ${e.message}`);
  }
};

// ---------- Dispositivo ----------

let light = null;
let version = "0.0.0";
let numLeds = 54;
// Mientras suena música o se escribe, el bucle de render controla la tira y aplicar() no
// debe pisarlo
let musicaActiva = false;
let controlando = false;

const desconectar = (motivo) => {
  if (!light) return;
  log(`Tira desconectada (${motivo})`);
  try {
    light.close();
  } catch {}
  light = null;
};

const aplicar = async () => {
  if (!light) return;
  try {
    if (!estado.encendida) {
      await light.turnOff(version);
      return;
    }
    light.setBrightness(estado.brillo);
    if (controlando || estado.modo === "pantalla") return;
    await sleep(60);
    if (estado.modo === "color") {
      light.setColor(...estado.color);
    } else {
      light.setEffect(estado.efecto.tipo, estado.efecto.indice);
      await sleep(60);
      if (estado.efecto.tipo === EFFECT_TYPE.ritmo) light.setSoundSensitivity(estado.sensibilidad);
      else light.setDynamicSpeed(estado.velocidad);
    }
  } catch (e) {
    desconectar(e.message);
  }
};

const conectar = async () => {
  if (light) return;
  const info = SyncLight.find();
  if (!info) return;
  try {
    light = new SyncLight(new HID.HID(info.path));
    light.onError = (e) => desconectar(e.message);
    const datos = await light.getInfo();
    if (datos) version = datos.version;
    if (datos && datos.lampsAmount) numLeds = datos.lampsAmount;
    log(`Tira conectada (firmware ${version}, ${datos ? datos.lampsAmount : "?"} LEDs)`);
    alConectar();
    await aplicar();
  } catch (e) {
    log(`No se pudo abrir la tira: ${e.message}`);
    light = null;
  }
};

// Cambia el estado, lo guarda y lo manda a la tira
const cambiar = async (parcial) => {
  estado = { ...estado, ...parcial };
  guardar();
  await aplicar();
};

let refrescarRed = async () => {};
// Al conectar la tira este PC pasa a ser el puente de Alexa: se anuncia en la red
let alConectar = () => {};

// Anota qué despertó al PC (tarjeta de red, teclado, botón...), para detectar despertares
// no deseados por tráfico de red ahora que la Ethernet despierta por coincidencia de patrones
const registrarOrigenDespertar = () => {
  const p = spawn("powercfg", ["/lastwake"], { windowsHide: true });
  let salida = "";
  p.stdout.on("data", (d) => (salida += d));
  p.on("close", () => {
    const util = salida
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(Tipo|Type|Descripci|Description|Nombre descriptivo|Friendly Name|Instance)/i.test(l));
    log(`Origen del despertar: ${util.join(" | ") || "desconocido (botón de encendido, tapa o temporizador)"}`);
  });
  p.on("error", () => {});
};

let ultimoTick = Date.now();
setInterval(async () => {
  const ahora = Date.now();
  if (ahora - ultimoTick > SALTO_SUSPENSION_MS) {
    log("Vuelta de suspensión/hibernación detectada");
    registrarOrigenDespertar();
    // El handle HID suele quedar inservible tras dormir: se reabre y se reaplica el estado
    desconectar("reanudación");
    // La red tarda unos segundos en volver tras despertar
    setTimeout(() => refrescarRed(), 10000);
  }
  ultimoTick = ahora;
  await conectar();
}, POLL_MS);

// ---------- Motores en Python (audio y teclado) ----------

const PYTHONW = path.join(__dirname, ".venv", "Scripts", "pythonw.exe");

// Lanza un script de Python sin ventana, recibe sus mensajes UDP y lo reinicia si se cae.
// Con siempre: false no arranca hasta llamar a iniciar(), y detener() lo cierra.
// Sin puerto, el motor solo recibe órdenes (como la lámpara) y no se escucha nada de él.
const motor = (nombre, script, puerto, alRecibir, { siempre = true, args = () => [] } = {}) => {
  if (puerto) {
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg) => {
      try {
        alRecibir(JSON.parse(msg));
      } catch {}
    });
    udp.on("error", (e) => log(`${nombre}: error UDP ${e.message}`));
    udp.bind(puerto, "127.0.0.1");
  }

  let proceso = null;
  let quiere = false;
  const arrancar = () => {
    if (!quiere || proceso) return;
    if (!fs.existsSync(PYTHONW)) return log(`${nombre} desactivado: falta el entorno .venv`);
    // -X utf8 para que los acentos lleguen bien al registro (-I ignora PYTHONIOENCODING)
    const p = spawn(PYTHONW, ["-I", "-X", "utf8", path.join(__dirname, script), ...args()], {
      windowsHide: true,
    });
    proceso = p;
    p.stdout.on("data", (d) => log(`${nombre}: ${d.toString().trim()}`));
    p.stderr.on("data", (d) => log(`${nombre} (error): ${d.toString().trim()}`));
    p.on("exit", (code) => {
      if (proceso === p) proceso = null;
      if (!quiere) return;
      log(`${nombre} terminado (código ${code}); se reinicia en 5 s`);
      setTimeout(arrancar, 5000);
    });
  };
  const control = {
    iniciar() {
      quiere = true;
      arrancar();
    },
    detener() {
      quiere = false;
      if (!proceso) return;
      // Cerrar su stdin hace que el script salga solo (ver morir_con_el_servicio)
      proceso.stdin.end();
      proceso.kill();
      proceso = null;
    },
  };
  if (siempre) control.iniciar();
  return control;
};

// ---------- Modo música, teclado y pantalla (ambilight) ----------

const FPS = 30;
// Sin lecturas del motor durante este tiempo se da la música por terminada
const LECTURA_CADUCA_MS = 1000;
// Tras la última tecla, el efecto de teclado sigue este tiempo antes de devolver la tira
const TECLADO_REPOSO_MS = 2500;

let lectura = null;
let lecturaEn = 0;
let ultimaTecla = 0;
let tonoLibre = 0; // color que rota despacio cuando la tira está en un efecto y no en un color
const musica = new Musica(numLeds);
const teclado = new Teclado(numLeds);

motor("Motor de audio", "audio/motor_audio.py", 47800, (m) => {
  lectura = m;
  lecturaEn = Date.now();
});
motor("Motor de teclado", "entrada/motor_teclado.py", 47801, (m) => {
  if (!estado.encendida || !estado.tecladoActivo || typeof m.x !== "number") return;
  ultimaTecla = Date.now();
  teclado.pulsar(Math.max(0, Math.min(1, m.x)));
});

// Reparto de LEDs por lado en un monitor 16:9 montado por 3 lados: 9 + 16 + 9 partes
const reparto = (n) => {
  const lado = Math.round((n * 9) / 34);
  return [lado, n - 2 * lado, lado];
};

let pantallaNueva = null; // último cuadro del motor: [r, g, b, r, g, b, ...]
let pantallaSuave = null; // el mismo, suavizado en el tiempo
const motorPantalla = motor(
  "Motor de pantalla",
  "pantalla/motor_pantalla.py",
  47802,
  (m) => {
    if (Array.isArray(m.c)) pantallaNueva = m.c;
  },
  {
    siempre: false,
    args: () => {
      const [izq, arriba, der] = reparto(numLeds);
      return ["--izq", String(izq), "--arriba", String(arriba), "--der", String(der)];
    },
  },
);

// Pantalla completa automática: con margen para que un Alt+Tab rápido o los controles del
// video no enciendan y apaguen el ambilight
const ENTRAR_COMPLETA_MS = 1500;
const SALIR_COMPLETA_MS = 2000;
let pantallaCompleta = false; // decisión ya filtrada por los márgenes
let appCompleta = "";
let completaDesde = 0;
let normalDesde = 0;
let ambilightActivo = false; // modo pantalla manual o por pantalla completa

motor("Vigilante de pantalla completa", "entrada/motor_ventana.py", 47803, (m) => {
  const ahora = Date.now();
  if (m.fs) {
    normalDesde = 0;
    completaDesde ||= ahora;
    if (!pantallaCompleta && ahora - completaDesde >= ENTRAR_COMPLETA_MS) {
      pantallaCompleta = true;
      appCompleta = m.app || "";
      if (estado.pantallaAuto) log(`Pantalla completa (${appCompleta}): ambilight automático`);
    }
  } else {
    completaDesde = 0;
    normalDesde ||= ahora;
    if (pantallaCompleta && ahora - normalDesde >= SALIR_COMPLETA_MS) {
      pantallaCompleta = false;
      if (estado.pantallaAuto) log("Fin de la pantalla completa");
    }
  }
});

// suavizado 0..100 → cuánto se acerca cada cuadro al nuevo color (1 = sin suavizar)
const pasoSuavizado = (s) => 0.05 + 0.95 * Math.pow(1 - Math.max(0, Math.min(100, s)) / 100, 2);

// Una vez por cuadro: acerca los colores suavizados a los últimos capturados
const suavizarPantalla = () => {
  if (!pantallaNueva || pantallaNueva.length !== numLeds * 3) return;
  if (!pantallaSuave || pantallaSuave.length !== pantallaNueva.length) pantallaSuave = pantallaNueva.slice();
  const k = pasoSuavizado(estado.suavizadoPantalla);
  for (let i = 0; i < pantallaSuave.length; i++) pantallaSuave[i] += (pantallaNueva[i] - pantallaSuave[i]) * k;
};

const cuadroPantalla = () => {
  if (!pantallaSuave) return Array.from({ length: numLeds }, () => [0, 0, 0]);
  return Array.from({ length: numLeds }, (_, i) => [0, 1, 2].map((c) => Math.round(pantallaSuave[i * 3 + c])));
};

const media = (cols) => {
  if (!cols.length) return [0, 0, 0];
  return [0, 1, 2].map((c) => Math.round(cols.reduce((s, col) => s + col[c], 0) / cols.length));
};

// Colores medios de cada lado, para que el panel pinte el resplandor del monitor
const resumenPantalla = () => {
  if (!ambilightActivo || !pantallaSuave) return null;
  const cuadro = cuadroPantalla();
  const [izq, arriba] = reparto(numLeds);
  return {
    izq: media(cuadro.slice(0, izq)),
    arriba: media(cuadro.slice(izq, izq + arriba)),
    der: media(cuadro.slice(izq + arriba)),
  };
};

let hueSyncActivo = false;

setInterval(async () => {
  const ahora = Date.now();
  // Hue Sync (vía diyHue) manda sobre todo lo demás mientras controla la tira
  const hueSync = Boolean(wled && wled.activo());
  if (hueSync !== hueSyncActivo) {
    hueSyncActivo = hueSync;
    // Los colores de Hue ya traen su brillo: la tira a tope mientras dure
    if (hueSync && light) light.setBrightness(100);
  }
  const enPantalla =
    !hueSync && estado.encendida && (estado.modo === "pantalla" || (estado.pantallaAuto && pantallaCompleta));
  ambilightActivo = enPantalla;
  if (enPantalla) motorPantalla.iniciar();
  else {
    motorPantalla.detener();
    pantallaNueva = pantallaSuave = null;
  }
  // En modo pantalla el ambilight ya sigue a los videos: el modo música no se activa
  const sonando = Boolean(
    !hueSync &&
      !enPantalla &&
      estado.encendida &&
      estado.musicaAuto &&
      lectura &&
      lectura.r &&
      ahora - lecturaEn < LECTURA_CADUCA_MS,
  );
  if (sonando !== musicaActiva) {
    musicaActiva = sonando;
    log(sonando ? `Modo música: ${lectura.t || "reproducción detectada"} (${lectura.app})` : "Modo música: fin");
  }
  const escribiendo =
    !hueSync && estado.encendida && estado.tecladoActivo && ahora - ultimaTecla < TECLADO_REPOSO_MS;
  const usaTeclado = escribiendo || (!hueSync && estado.encendida && estado.tecladoActivo && teclado.activo());

  const antes = controlando;
  controlando = hueSync || enPantalla || musicaActiva || usaTeclado;
  if (!hueSync && !enPantalla && !musicaActiva) cuadroBase = null;
  if (antes && !controlando) return aplicar(); // devolver la tira a su color o efecto
  if (!controlando || !light) return;

  musica.n = teclado.n = numLeds;
  let cuadro;
  let color;
  if (hueSync) {
    cuadro = wled.cuadro();
    color = media(cuadro);
  } else if (enPantalla) {
    suavizarPantalla();
    cuadro = cuadroPantalla();
    color = media(cuadro); // las ondas del teclado toman el color medio de la pantalla
  } else {
    color = estado.modo === "color" ? estado.color : null;
    if (!color) {
      tonoLibre = (tonoLibre + 0.06) % 360;
      color = hsvToRgb(tonoLibre, 1, 1);
    }
    cuadro = musicaActiva
      ? musica.cuadro(estado.efectoMusica, lectura, estado.modo === "color" ? estado.color : null, estado.intensidadMusica)
      : Array.from({ length: numLeds }, () => color);
  }
  // La lámpara sigue la pantalla o la música, no las ondas del teclado
  if (hueSync || enPantalla || musicaActiva) cuadroBase = cuadro;
  if (usaTeclado)
    cuadro = teclado.cuadro(cuadro, color, estado.efectoTeclado, escribiendo, estado.velocidadTeclado);
  try {
    light.setPixels(cuadro);
  } catch (e) {
    desconectar(e.message);
  }
}, 1000 / FPS);

// ---------- Lámpara Tuya ----------

const LAMPARA_CLAVES = path.join(__dirname, "tuya", "devices.json");
let cuadroBase = null; // último cuadro de pantalla o música (sin las ondas del teclado)

const motorLampara = motor("Motor de lámpara", "luces/motor_lampara.py", null, null, { siempre: false });
const udpLampara = dgram.createSocket("udp4");

// Zonas de color (de abajo a arriba) que debe mostrar la lámpara según lo que haga la tira.
// La lámpara está a la izquierda del monitor: en ambilight copia el lado izquierdo de la pantalla.
const zonasLampara = () => {
  let zonas;
  if (ambilightActivo && cuadroBase) {
    const [izq] = reparto(numLeds);
    const lado = cuadroBase.slice(0, izq); // LEDs del lado izquierdo, de abajo a arriba
    const n = estado.lamparaZonas;
    zonas = Array.from({ length: n }, (_, i) =>
      media(lado.slice(Math.floor((i * lado.length) / n), Math.floor(((i + 1) * lado.length) / n))),
    );
  } else if (cuadroBase) zonas = [media(cuadroBase)];
  else if (estado.modo === "color") zonas = [estado.color];
  // Efecto de la tira: no se puede copiar, así que un tono que da una vuelta cada 3 minutos
  else zonas = [hsvToRgb((Date.now() / 500) % 360, 1, 1)];
  return zonas.map((c) => c.map((v) => Math.round((v * estado.brillo) / 100)));
};

setInterval(() => {
  const activa = estado.lamparaSync && light && fs.existsSync(LAMPARA_CLAVES);
  if (!activa) return motorLampara.detener();
  motorLampara.iniciar();
  const msg = JSON.stringify({ on: estado.encendida, zonas: estado.encendida ? zonasLampara() : null });
  udpLampara.send(msg, 47804, "127.0.0.1");
}, 150);

// ---------- Luces para Alexa ----------

// Alexa da la orden por fallida si al releer el estado no ve exactamente lo que pidió,
// así que se recuerdan sus valores tal cual (estado.alexa) mientras nadie más los cambie.
const briHue = () =>
  estado.alexa?.bri ?? Math.max(1, Math.round((estado.brillo * 254) / 100));

const estadoColorHue = () => {
  const a = estado.alexa || {};
  const hs = rgbToHueSat(estado.color);
  return {
    hue: a.hue ?? hs.hue,
    sat: a.sat ?? hs.sat,
    xy: a.xy ?? [0.3227, 0.329],
    ct: a.ct ?? 366,
    colormode: a.colormode ?? "hs",
  };
};

const luzEfecto = (id, name, tipo) => ({
  id,
  name,
  kind: "onoff",
  getState: () => ({
    on: estado.encendida && estado.modo === "efecto" && estado.efecto.tipo === tipo,
    bri: briHue(),
  }),
  setState: (c) => {
    const p = {};
    if (c.bri !== undefined) {
      p.brillo = Math.round((c.bri * 100) / 254);
      p.alexa = { ...estado.alexa, bri: c.bri };
    }
    // Solo "LED monitor" apaga la tira: apagar un efecto vuelve al último color si estaba activo
    if (c.on === false) {
      const activo = estado.modo === "efecto" && estado.efecto.tipo === tipo;
      return cambiar(activo ? { ...p, modo: "color" } : p);
    }
    const indice = estado.efecto.tipo === tipo ? estado.efecto.indice : 0;
    return cambiar({ ...p, encendida: true, modo: "efecto", efecto: { tipo, indice } });
  },
});

const luces = [
  {
    id: 1,
    name: "LED monitor",
    kind: "color",
    getState: () => ({
      on: estado.encendida,
      bri: briHue(),
      ...estadoColorHue(),
    }),
    setState: (c) => {
      const p = {};
      const alexa = { ...estado.alexa };
      if (c.on !== undefined) p.encendida = c.on;
      if (c.bri !== undefined) {
        p.brillo = Math.round((c.bri * 100) / 254);
        p.encendida = true;
        alexa.bri = c.bri;
      }
      if (c.xy) Object.assign(alexa, { xy: c.xy, colormode: "xy" });
      else if (c.hue !== undefined || c.sat !== undefined)
        Object.assign(alexa, { hue: c.hue ?? alexa.hue, sat: c.sat ?? alexa.sat, colormode: "hs" });
      else if (c.ct !== undefined) Object.assign(alexa, { ct: c.ct, colormode: "ct" });
      p.alexa = alexa;
      let rgb = null;
      if (c.xy) rgb = xyToRgb(c.xy[0], c.xy[1]);
      else if (c.hue !== undefined || c.sat !== undefined) {
        const actual = rgbToHueSat(estado.color);
        rgb = hueSatToRgb(c.hue ?? actual.hue, c.sat ?? actual.sat);
      } else if (c.ct !== undefined) rgb = ctToRgb(c.ct);
      if (rgb) {
        p.color = rgb;
        p.modo = "color";
        p.encendida = true;
      }
      return cambiar(p);
    },
  },
  luzEfecto(2, "LED monitor dinámico", EFFECT_TYPE.dinamico),
  luzEfecto(3, "LED monitor música", EFFECT_TYPE.ritmo),
  {
    id: 4,
    name: "LED monitor ambilight",
    kind: "onoff",
    getState: () => ({ on: estado.encendida && estado.modo === "pantalla", bri: briHue() }),
    setState: (c) => {
      const p = {};
      if (c.bri !== undefined) {
        p.brillo = Math.round((c.bri * 100) / 254);
        p.alexa = { ...estado.alexa, bri: c.bri };
      }
      // Apagarlo solo quita el "siempre activo" y vuelve al último color: la tira sigue encendida
      if (c.on === false) return cambiar(estado.modo === "pantalla" ? { ...p, modo: "color" } : p);
      return cambiar({ ...p, encendida: true, modo: "pantalla" });
    },
  },
  {
    // "Alexa, apaga el PC" suspende el equipo. Encenderlo no es posible desde aquí: con el PC
    // dormido este servicio no corre (haría falta otro aparato que mande Wake-on-LAN).
    id: 5,
    name: "PC",
    kind: "enchufe",
    // Tras la orden de apagar, Alexa relee el estado: si siguiera "encendido" diría que falló
    getState: () => ({ on: Date.now() - pcApagadoEn > 60000 }),
    setState: (c) => {
      if (c.on !== false) return;
      pcApagadoEn = Date.now();
      log("Alexa: suspender el PC");
      // Se espera a que Alexa reciba la respuesta y relea el estado antes de dormir
      setTimeout(suspenderPC, 2000);
    },
  },
];

let pcApagadoEn = 0;

// rundll32 powrprof.dll,SetSuspendState hiberna si la hibernación está activada; así no.
// Sin "detached": en Windows eso deja a PowerShell sin consola y no llega a ejecutarse.
const suspenderPC = () => {
  const p = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  p.on("error", (e) => log(`No se pudo suspender el PC: ${e.message}`));
};

// IP de la interfaz con salida a la red (la que verá el Echo). No envía ningún paquete.
const ipLocal = () =>
  new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.connect(53, "8.8.8.8", () => {
      const ip = s.address().address;
      s.close();
      resolve(ip);
    });
    s.on("error", () => resolve("127.0.0.1"));
  });

// ---------- HTTP (puerto 80): API Hue + control local ----------

const esLocal = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

// Este PC o un equipo de la red de casa (el firewall ya limita el puerto 80 a la subred local)
const esRedLocal = (req) => {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return esLocal(req) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
};

const PANEL = path.join(__dirname, "panel", "index.html");

// Solo se aceptan estos campos desde /tira, con su validación
const CAMPOS = {
  encendida: (v) => typeof v === "boolean",
  modo: (v) => ["color", "efecto", "pantalla"].includes(v),
  color: (v) => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isInteger(c) && c >= 0 && c <= 255),
  brillo: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  efecto: (v) => v && [EFFECT_TYPE.dinamico, EFFECT_TYPE.ritmo].includes(v.tipo) && v.indice >= 0 && v.indice <= 6,
  velocidad: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  sensibilidad: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  musicaAuto: (v) => typeof v === "boolean",
  efectoMusica: (v) => EFECTOS.includes(v),
  intensidadMusica: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  tecladoActivo: (v) => typeof v === "boolean",
  efectoTeclado: (v) => EFECTOS_TECLADO.includes(v),
  velocidadTeclado: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  suavizadoPantalla: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  pantallaAuto: (v) => typeof v === "boolean",
  lamparaSync: (v) => typeof v === "boolean",
  lamparaZonas: (v) => Number.isInteger(v) && v >= 1 && v <= 5,
};

const validar = (cambios) => {
  const limpio = {};
  for (const [k, v] of Object.entries(cambios)) {
    if (!CAMPOS[k]) throw new Error(`Campo desconocido: ${k}`);
    if (!CAMPOS[k](v)) throw new Error(`Valor no válido para ${k}: ${JSON.stringify(v)}`);
    limpio[k] = v;
  }
  return limpio;
};

const estadoPublico = () => ({
  ...estado,
  alexa: undefined,
  conectada: !!light,
  version,
  numLeds,
  sonando: musicaActiva ? { titulo: lectura?.t || "", app: lectura?.app || "" } : null,
  pantalla: resumenPantalla(),
  ambilight: ambilightActivo,
  pantallaCompleta: ambilightActivo && estado.modo !== "pantalla" ? appCompleta : null,
  hueSync: wled ? { activo: hueSyncActivo, stream: wled.streaming(), fps: wled.fps } : null,
});

const iniciar = async () => {
  const ip = await ipLocal();
  const bridge = new HueBridge({ ip, mac: PUENTE_MAC, lights: luces, log, activo: () => !!light });
  alConectar = () => bridge.anunciar();
  let anuncioHue = null;
  if (HUESYNC) {
    // La tira, como WLED para diyHue. El TV no habla con ella: solo diyHue (en Docker, en este PC)
    wled = new WledFalso({ nombre: "Tira-PC", mac: PUENTE_MAC, numLeds, segmentos: segmentosTira(reparto(numLeds)), log });
    wled.iniciar();
    anuncioHue = new AnuncioHue({ ip, bridgeId: bridge.bridgeId, log });
    anuncioHue.iniciar();
  }

  const server = http.createServer((req, res) => {
    if (process.env.TIRA_DEBUG && !esLocal(req)) {
      const t0 = Date.now();
      res.on("finish", () =>
        log(`[debug] ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${res.statusCode} en ${Date.now() - t0} ms`),
      );
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const esPanel = req.url === "/" || req.url.startsWith("/tira");
      // El Echo consulta las luces cada pocos segundos y el panel el estado: no se registran
      if (!esLocal(req) && !esPanel && !(req.method === "GET" && req.url.includes("/lights")))
        log(`HTTP ${req.socket.remoteAddress} ${req.method} ${req.url}`);
      if (esPanel && !esRedLocal(req)) {
        res.writeHead(403);
        return res.end();
      }
      if (req.url === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return fs.createReadStream(PANEL).pipe(res);
      }
      if (req.url.startsWith("/tira")) {
        if (req.method === "POST") {
          try {
            const cambios = validar(JSON.parse(body || "{}"));
            if (cambios.color || cambios.brillo !== undefined) cambios.alexa = null;
            await cambiar(cambios);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end(e.message);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(estadoPublico()));
      }
      if (!bridge.handle(req, res, body)) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  server.on("error", (e) => {
    log(`Error HTTP: ${e.message}${e.code === "EADDRINUSE" ? " (¿ya hay otro servicio en marcha?)" : ""}`);
    process.exit(1);
  });
  server.listen(PUERTO_PANEL, () => {
    if (HUESYNC) {
      // El SSDP apunta a http://IP:80/description.xml, que ahora sirve diyHue
      log(`Servicio iniciado en modo prueba Hue Sync. Panel en http://${ip}:${PUERTO_PANEL}; puente diyHue en http://${ip}`);
      bridge.startSsdp();
    } else {
      log(`Servicio iniciado. Puente Hue en http://${ip}:80`);
      bridge.startSsdp();
      bridge.startHttpsReject();
    }
  });

  // Cada minuto (y tras despertar) se rehace la suscripción SSDP y se sigue a la IP si cambia
  refrescarRed = async () => {
    const nueva = await ipLocal();
    if (nueva !== bridge.ip) log(`La IP cambió: ${bridge.ip} -> ${nueva}`);
    bridge.joinMulticast(nueva);
    if (anuncioHue) anuncioHue.unirse(nueva);
  };
  setInterval(refrescarRed, 60000);

  await conectar();
};

iniciar();
