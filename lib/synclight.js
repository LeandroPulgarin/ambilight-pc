// Protocolo USB HID del ambilight SyncLight (Robobloq), VID 0x1A86 / PID 0xFE07.
// Reconstruido a partir de SyncLight 3.8.6 (módulos 60895 y 5786 del bundle main).
// Detalles en PROTOCOLO.md.

const HID = require("node-hid");

const VID = 0x1a86;
const PID = 0xfe07;

const CMD = {
  setSyncScreen: 0x80,
  writeDeviceInfo: 0x81,
  readDeviceInfo: 0x82,
  readDeviceUUID: 0x83,
  setLedEffect: 0x85,
  setSectionLED: 0x86,
  setBrightness: 0x87,
  setAutoOff: 0x89,
  setDynamicSpeed: 0x8a,
  setSoundSensitivity: 0x8b,
  setExternalAudio: 0x91,
  setOpenUrl: 0x93,
  setLampsAmount: 0x95,
  setWhiteBright: 0x96,
  turnOffLight: 0x97,
  setComputerRhythm: 0x98,
};

// Tipos de efecto que usa la interfaz de SyncLight (cada uno con índices 0..6)
const EFFECT_TYPE = { dinamico: 2, ritmo: 3 };

// Último byte = suma de los anteriores mod 256 (el hueco ya está a 0 al calcularla)
const checksum = (buf) => {
  let s = 0;
  for (const b of buf) s += b;
  return s % 256;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SyncLight {
  constructor(device) {
    this.device = device;
    this.seq = 1;
    this.pending = new Map();
    // Se dispara al desconectar el USB o tras suspender; el servicio lo usa para reconectar
    this.onError = null;
    this.device.on("data", (data) => this._onData(data));
    this.device.on("error", (e) => this.onError && this.onError(e));
  }

  static find() {
    return HID.devices().find(
      (d) => d.vendorId === VID && d.productId === PID && d.interface === 0,
    );
  }

  static open() {
    const info = SyncLight.find();
    if (!info) throw new Error("No se encontró el ambilight (1A86:FE07)");
    return new SyncLight(new HID.HID(info.path));
  }

  close() {
    this.device.close();
  }

  _nextSeq() {
    this.seq = this.seq >= 254 ? 1 : this.seq + 1;
    return this.seq;
  }

  _onData(data) {
    const head = data.toString("latin1", 0, 2);
    if (head !== "RB" && head !== "SC") return;
    const resolve = this.pending.get(data[3]);
    if (resolve) {
      this.pending.delete(data[3]);
      resolve(Buffer.from(data));
    }
  }

  // Paquete "RB": [R, B, longitud, seq, comando, ...datos, checksum]
  _packet(cmd, payload = []) {
    const len = 6 + payload.length;
    const buf = Buffer.alloc(len);
    buf.write("RB", 0, "latin1");
    buf[2] = len;
    buf[3] = this._nextSeq();
    buf[4] = cmd;
    Buffer.from(payload).copy(buf, 5);
    buf[len - 1] = checksum(buf);
    return buf;
  }

  // Trocea en reports de 64 bytes, cada uno precedido del report ID 0
  _send(buf) {
    for (let i = 0; i < buf.length; i += 64) {
      const chunk = buf.subarray(i, i + 64);
      this.device.write([0, ...chunk]);
    }
  }

  async _request(buf, timeoutMs = 500) {
    const seq = buf[3];
    const reply = new Promise((resolve) => {
      this.pending.set(seq, resolve);
      setTimeout(() => {
        if (this.pending.delete(seq)) resolve(null);
      }, timeoutMs);
    });
    this._send(buf);
    return reply;
  }

  async getInfo() {
    const r = await this._request(this._packet(CMD.readDeviceInfo));
    if (!r) return null;
    return {
      id: r.subarray(5, 8).toString("hex"),
      displaySize: r[8],
      lampsAmount: r[11],
      uuid: r.subarray(12, 20).toString("hex"),
      version: [r[21], r[22], r[23]].join("."),
      raw: r.toString("hex"),
    };
  }

  // Cada segmento: { from, to, r, g, b }. LEDs numerados desde 1; to = 254 significa "hasta el final"
  setSegments(segments) {
    const payload = [];
    for (const s of segments) payload.push(s.from, s.r, s.g, s.b, s.to);
    this._send(this._packet(CMD.setSectionLED, payload));
  }

  setColor(r, g, b) {
    this.setSegments([{ from: 1, to: 254, r, g, b }]);
  }

  // Colores LED a LED (ambilight propio). Se agrupan en segmentos de LEDs consecutivos iguales
  setPixels(colors) {
    const segs = [];
    colors.forEach(([r, g, b], i) => {
      const last = segs[segs.length - 1];
      if (last && last.r === r && last.g === g && last.b === b) last.to = i + 1;
      else segs.push({ from: i + 1, to: i + 1, r, g, b });
    });
    // SyncLight manda como mucho 11 segmentos (55 valores) por paquete en firmware 1.x
    for (let i = 0; i < segs.length; i += 11)
      this.setSegments(segs.slice(i, i + 11));
  }

  setBrightness(value) {
    this._send(this._packet(CMD.setBrightness, [value]));
  }

  setEffect(type, index) {
    this._send(this._packet(CMD.setLedEffect, [type, index]));
  }

  setDynamicSpeed(value) {
    this._send(this._packet(CMD.setDynamicSpeed, [value]));
  }

  setSoundSensitivity(value) {
    this._send(this._packet(CMD.setSoundSensitivity, [value]));
  }

  // enabled: 0/1; minutes: tiempo hasta el apagado automático
  setAutoOff(enabled, minutes) {
    this._send(this._packet(CMD.setAutoOff, [enabled, minutes]));
  }

  // El comando turnOffLight solo existe desde firmware 1.8.0; antes se apaga pintando de negro
  async turnOff(version = "0.0.0") {
    const [maj, min] = version.split(".").map(Number);
    if (maj > 1 || (maj === 1 && min >= 8))
      return this._request(this._packet(CMD.turnOffLight));
    this.setColor(0, 0, 0);
  }
}

module.exports = { SyncLight, CMD, EFFECT_TYPE, VID, PID, sleep };
