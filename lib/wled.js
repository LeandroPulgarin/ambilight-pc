// Emulación mínima de un dispositivo WLED para que diyHue trate la tira USB como luces de red.
//
// diyHue habla con WLED de dos formas:
//  - HTTP JSON (GET /json, POST /json) para encender, apagar y poner un color fijo desde la app Hue.
//  - UDP "realtime" (puerto 21324) durante Hue Entertainment / Hue Sync: diyHue descifra el stream
//    DTLS del TV y manda a cada segmento su color en modo DNRGB, unas 25-60 veces por segundo.
//
// Cada segmento de WLED es una luz distinta en diyHue (y en el área de entretenimiento de Hue Sync).

const http = require("http");
const dgram = require("dgram");

// Modos del protocolo realtime UDP de WLED (byte 0 del paquete)
const WARLS = 1; // [índice, r, g, b] × n
const DRGB = 2; // [r, g, b] × n desde el LED 0
const DNRGB = 4; // [inicioHi, inicioLo, r, g, b, ...] desde el LED inicio

class WledFalso {
  // segmentos: [{ nombre, inicio, largo }] en orden de LEDs de la tira
  constructor({ nombre, mac, numLeds, segmentos, puertoHttp = 8090, puertoUdp = 21324, log = console.log }) {
    this.nombre = nombre;
    this.mac = mac.replace(/:/g, "").toLowerCase();
    this.numLeds = numLeds;
    this.puertoHttp = puertoHttp;
    this.puertoUdp = puertoUdp;
    this.log = log;
    this.segs = segmentos.map((s, id) => ({ id, ...s, on: true, bri: 255, col: [255, 255, 255] }));
    this.encendido = true;
    this.brillo = 255;
    this.cuadroStream = Array.from({ length: numLeds }, () => [0, 0, 0]);
    this.streamHasta = 0; // hasta cuándo vale el último paquete UDP (byte de timeout)
    this.manual = false; // diyHue ya mandó al menos un estado por HTTP
    this.paquetes = 0;
    this.fps = 0;
    this.ultimoCambio = 0;
  }

  iniciar() {
    this._http = http.createServer((req, res) => this._atenderHttp(req, res));
    this._http.on("error", (e) => this.log(`WLED: error HTTP ${e.message}`));
    this._http.listen(this.puertoHttp, () => this.log(`WLED falso en el puerto HTTP ${this.puertoHttp}`));

    this._udp = dgram.createSocket("udp4");
    this._udp.on("message", (msg) => this._atenderUdp(msg));
    this._udp.on("error", (e) => this.log(`WLED: error UDP ${e.message}`));
    this._udp.bind(this.puertoUdp, () => this.log(`WLED falso escuchando realtime UDP en ${this.puertoUdp}`));

    // FPS reales del stream, para el registro y el panel
    let antes = 0;
    let enStream = false;
    setInterval(() => {
      this.fps = this.paquetes - antes;
      antes = this.paquetes;
      const ahora = this.streaming();
      if (ahora !== enStream) {
        enStream = ahora;
        this.log(ahora ? "Hue Sync: stream iniciado" : "Hue Sync: stream terminado");
      }
    }, 1000);
  }

  streaming() {
    return Date.now() < this.streamHasta;
  }

  // La tira la controla diyHue: stream en curso o un color puesto desde la app Hue
  activo() {
    return this.streaming() || this.manual;
  }

  // Colores LED a LED que debe mostrar la tira ahora
  cuadro() {
    if (this.streaming()) return this.cuadroStream.map((c) => c.slice());
    const cuadro = Array.from({ length: this.numLeds }, () => [0, 0, 0]);
    if (!this.encendido) return cuadro;
    for (const s of this.segs) {
      if (!s.on) continue;
      const k = (s.bri / 255) * (this.brillo / 255);
      const col = s.col.map((v) => Math.round(v * k));
      for (let i = s.inicio; i < s.inicio + s.largo && i < this.numLeds; i++) cuadro[i] = col;
    }
    return cuadro;
  }

  _atenderUdp(msg) {
    if (msg.length < 2) return;
    const modo = msg[0];
    const espera = msg[1]; // segundos sin paquetes antes de volver al estado normal (255 = nunca)
    const pon = (i, o) => {
      if (i >= 0 && i < this.numLeds && o + 2 < msg.length) this.cuadroStream[i] = [msg[o], msg[o + 1], msg[o + 2]];
    };
    if (modo === DNRGB && msg.length >= 4) {
      const inicio = msg.readUInt16BE(2);
      for (let o = 4, i = inicio; o + 2 < msg.length; o += 3, i++) pon(i, o);
    } else if (modo === DRGB) {
      for (let o = 2, i = 0; o + 2 < msg.length; o += 3, i++) pon(i, o);
    } else if (modo === WARLS) {
      for (let o = 2; o + 3 < msg.length; o += 4) pon(msg[o], o + 1);
    } else return;
    this.paquetes++;
    this.streamHasta = Date.now() + (espera === 255 ? 3600e3 : Math.max(1, espera) * 1000);
  }

  _info() {
    return {
      ver: "0.14.4",
      vid: 2405180,
      leds: { count: this.numLeds, rgbw: false, wv: 0, cct: 0, pwr: 0, fps: this.fps, maxpwr: 0, maxseg: 32 },
      str: false,
      name: this.nombre,
      udpport: this.puertoUdp,
      live: this.streaming(),
      lm: this.streaming() ? "Hue Sync" : "",
      lip: "",
      ws: -1,
      fxcount: 1,
      palcount: 1,
      arch: "esp32",
      core: "v3.3.6",
      brand: "WLED",
      product: "FOSS",
      mac: this.mac,
      ip: "",
    };
  }

  _estado() {
    return {
      on: this.encendido,
      bri: this.brillo,
      transition: 0,
      ps: -1,
      pl: -1,
      lor: 0,
      mainseg: 0,
      seg: this.segs.map((s) => ({
        id: s.id,
        start: s.inicio,
        stop: s.inicio + s.largo,
        len: s.largo,
        grp: 1,
        spc: 0,
        on: s.on,
        bri: s.bri,
        col: [s.col, [0, 0, 0], [0, 0, 0]],
        fx: 0,
        sx: 128,
        ix: 128,
        pal: 0,
        sel: s.id === 0,
        rev: false,
        mi: false,
        n: s.nombre,
      })),
    };
  }

  // Aplica un estado JSON de WLED (lo que manda diyHue al usar la app Hue)
  _aplicar(json) {
    if (typeof json.on === "boolean") this.encendido = json.on;
    if (json.on === "t") this.encendido = !this.encendido;
    if (Number.isFinite(json.bri)) this.brillo = Math.max(0, Math.min(255, json.bri));
    for (const cambio of Array.isArray(json.seg) ? json.seg : json.seg ? [json.seg] : []) {
      const s = this.segs[cambio.id ?? 0];
      if (!s) continue;
      if (typeof cambio.on === "boolean") s.on = cambio.on;
      if (Number.isFinite(cambio.bri)) s.bri = Math.max(0, Math.min(255, cambio.bri));
      if (Array.isArray(cambio.col) && Array.isArray(cambio.col[0]))
        s.col = cambio.col[0].slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))));
    }
    // Encender un segmento desde la app enciende el dispositivo, como en WLED real
    if (this.segs.some((s) => s.on)) this.encendido = true;
    this.manual = true;
    this.ultimoCambio = Date.now();
  }

  _atenderHttp(req, res) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url.split("?")[0].replace(/\/$/, "");
      const json = (obj) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && (url === "/json" || url === "/json/state")) {
        try {
          this._aplicar(JSON.parse(body || "{}"));
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: e.message }));
        }
        return json({ success: true });
      }
      if (req.method === "GET") {
        if (url === "/json") return json({ state: this._estado(), info: this._info(), effects: ["Solid"], palettes: ["Default"] });
        if (url === "/json/info") return json(this._info());
        if (url === "/json/state") return json(this._estado());
      }
      res.writeHead(404);
      res.end();
    });
  }
}

// Segmentos para la tira montada en 3 lados (izquierda de abajo a arriba, arriba de izquierda a
// derecha, derecha de arriba a abajo). La parte de arriba se divide en 3 para que Hue Sync tenga
// 5 zonas: suficientes para ver cómo reparte los colores sin pasar del límite de 10 luces.
const segmentosTira = ([izq, arriba, der]) => {
  const t1 = Math.round(arriba / 3);
  const t3 = Math.round(arriba / 3);
  const t2 = arriba - t1 - t3;
  let i = 0;
  const seg = (nombre, largo) => {
    const s = { nombre, inicio: i, largo };
    i += largo;
    return s;
  };
  return [
    seg("Izquierda", izq),
    seg("Arriba izquierda", t1),
    seg("Arriba centro", t2),
    seg("Arriba derecha", t3),
    seg("Derecha", der),
  ];
};

module.exports = { WledFalso, segmentosTira };
