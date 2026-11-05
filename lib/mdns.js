// Anunciador mDNS mínimo del servicio _hue._tcp, para que las apps Hue (móvil y TV) encuentren
// el puente diyHue. diyHue corre en Docker Desktop, cuyos contenedores no pueden mandar multicast
// a la red de casa, así que el servicio anuncia en su nombre la IP del PC (puerto 443).

const dgram = require("dgram");

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const TIPO = "_hue._tcp.local";
const TTL = 120;

const A = 1;
const PTR = 12;
const TXT = 16;
const SRV = 33;
const ANY = 255;

const nombreDns = (nombre) =>
  Buffer.concat([
    ...nombre.split(".").map((p) => {
      const b = Buffer.from(p, "utf8");
      return Buffer.concat([Buffer.from([b.length]), b]);
    }),
    Buffer.from([0]),
  ]);

const leerNombre = (buf, o) => {
  const partes = [];
  let saltos = 0;
  let fin = -1;
  while (o < buf.length && saltos < 20) {
    const len = buf[o];
    if (len === 0) {
      o++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (fin < 0) fin = o + 2;
      o = ((len & 0x3f) << 8) | buf[o + 1];
      saltos++;
      continue;
    }
    partes.push(buf.toString("utf8", o + 1, o + 1 + len));
    o += 1 + len;
  }
  return { nombre: partes.join("."), siguiente: fin >= 0 ? fin : o };
};

const registro = (nombre, tipo, datos, { flush = false } = {}) => {
  const cab = Buffer.alloc(10);
  cab.writeUInt16BE(tipo, 0);
  cab.writeUInt16BE(flush ? 0x8001 : 0x0001, 2); // clase IN (bit de cache-flush en registros únicos)
  cab.writeUInt32BE(TTL, 4);
  cab.writeUInt16BE(datos.length, 8);
  return Buffer.concat([nombreDns(nombre), cab, datos]);
};

class AnuncioHue {
  constructor({ ip, bridgeId, log = console.log, puerto = 443 }) {
    this.ip = ip;
    this.bridgeId = bridgeId.toLowerCase();
    this.log = log;
    this.puerto = puerto;
    this.instancia = `Philips Hue - ${bridgeId.slice(-6).toUpperCase()}.${TIPO}`;
    this.host = `${this.bridgeId}.local`;
  }

  _respuesta() {
    const srv = Buffer.alloc(6);
    srv.writeUInt16BE(0, 0); // prioridad
    srv.writeUInt16BE(0, 2); // peso
    srv.writeUInt16BE(this.puerto, 4);
    const txt = Buffer.concat(
      [`bridgeid=${this.bridgeId}`, "modelid=BSB002"].map((t) => {
        const b = Buffer.from(t);
        return Buffer.concat([Buffer.from([b.length]), b]);
      }),
    );
    const registros = [
      registro(TIPO, PTR, nombreDns(this.instancia)),
      registro(this.instancia, SRV, Buffer.concat([srv, nombreDns(this.host)]), { flush: true }),
      registro(this.instancia, TXT, txt, { flush: true }),
      registro(this.host, A, Buffer.from(this.ip.split(".").map(Number)), { flush: true }),
    ];
    const cab = Buffer.alloc(12);
    cab.writeUInt16BE(0x8400, 2); // respuesta autoritativa
    cab.writeUInt16BE(registros.length, 6);
    return Buffer.concat([cab, ...registros]);
  }

  _preguntaPorHue(msg) {
    if (msg.length < 12 || msg.readUInt16BE(2) & 0x8000) return false; // es una respuesta
    const n = msg.readUInt16BE(4);
    let o = 12;
    for (let i = 0; i < n && o < msg.length; i++) {
      const { nombre, siguiente } = leerNombre(msg, o);
      const tipo = msg.readUInt16BE(siguiente);
      o = siguiente + 4;
      const nom = nombre.toLowerCase();
      if ((tipo === PTR || tipo === ANY) && nom === TIPO) return true;
      if (nom === this.instancia.toLowerCase() || nom === this.host) return true;
    }
    return false;
  }

  iniciar() {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg) => {
      try {
        if (this._preguntaPorHue(msg)) this.anunciar();
      } catch {}
    });
    sock.on("error", (e) => this.log(`mDNS: ${e.message}`));
    sock.bind(MDNS_PORT, () => {
      this.unirse();
      sock.setMulticastTTL(255);
      this.log(`mDNS: anunciando ${this.instancia} en ${this.ip}:${this.puerto}`);
      this.anunciar();
    });
    this.sock = sock;
    // Anuncio periódico: algunos clientes solo escuchan sin preguntar
    setInterval(() => this.anunciar(), 60000);
  }

  unirse(ip = this.ip) {
    if (!this.sock) return;
    try {
      this.sock.dropMembership(MDNS_ADDR, this.ip);
    } catch {}
    this.ip = ip;
    try {
      this.sock.setMulticastInterface(this.ip);
      this.sock.addMembership(MDNS_ADDR, this.ip);
    } catch (e) {
      this.log(`mDNS: no se pudo suscribir en ${this.ip} (${e.message})`);
    }
  }

  anunciar() {
    if (!this.sock) return;
    this.sock.send(this._respuesta(), MDNS_PORT, MDNS_ADDR);
  }
}

module.exports = { AnuncioHue };
