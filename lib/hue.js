// Emulación mínima de un puente Philips Hue (API v1) para que un Echo descubra las luces
// en la red local, sin nube. El Echo exige que la API esté en el puerto 80.
//
// Descubrimiento: el Echo envía un M-SEARCH SSDP (UDP 1900, multicast) y le respondemos
// con la URL de description.xml; luego consulta /api/<usuario>/lights y manda PUT .../state.

const dgram = require("dgram");
const net = require("net");

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

class HueBridge {
  // lights: [{ id, name, kind: "color" | "onoff", getState(), setState(cambios) }]
  // activo(): si es false el puente no responde al descubrimiento ni a la API (otro PC lo atiende)
  constructor({ ip, mac, lights, log = console.log, activo = () => true }) {
    this.ip = ip;
    this.mac = mac.toLowerCase();
    this.lights = lights;
    this.log = log;
    this.activo = activo;
    const macHex = this.mac.replace(/:/g, "");
    this.serial = macHex;
    this.bridgeId = (macHex.slice(0, 6) + "fffe" + macHex.slice(6)).toUpperCase();
    this.uuid = `2f402f80-da50-11e1-9b23-${macHex}`;
  }

  startSsdp() {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString();
      if (!text.startsWith("M-SEARCH") || !this.activo()) return;
      if (!/ssdp:all|upnp:rootdevice|device:basic:1/i.test(text)) return;
      for (const st of [
        "upnp:rootdevice",
        `uuid:${this.uuid}`,
        "urn:schemas-upnp-org:device:basic:1",
      ]) {
        const res = Buffer.from(this._ssdpResponse(st));
        sock.send(res, rinfo.port, rinfo.address);
      }
    });
    sock.on("error", (e) => this.log(`SSDP error: ${e.message}`));
    sock.bind(SSDP_PORT, () => {
      this.joinMulticast();
      this.log(`SSDP escuchando en ${this.ip}:${SSDP_PORT}`);
    });
    this.ssdp = sock;
  }

  // Windows pierde la suscripción multicast cuando la tarjeta de red se reinicia (al despertar
  // de suspensión o al cambiar su configuración); hay que volver a suscribirse.
  joinMulticast(ip = this.ip) {
    if (!this.ssdp) return;
    try {
      this.ssdp.dropMembership(SSDP_ADDR, this.ip);
    } catch {}
    this.ip = ip;
    try {
      this.ssdp.addMembership(SSDP_ADDR, this.ip);
    } catch (e) {
      this.log(`SSDP: no se pudo suscribir en ${this.ip} (${e.message})`);
    }
  }

  // El Echo intenta primero HTTPS (443). Si nadie responde, el firewall descarta en silencio,
  // el Echo espera hasta agotar el tiempo y dice "el dispositivo no responde" antes de
  // reintentar por HTTP. Cortando la conexión al instante pasa a HTTP sin esperar.
  startHttpsReject() {
    const srv = net.createServer((s) => s.resetAndDestroy());
    srv.on("error", (e) => this.log(`Puerto 443 no disponible: ${e.message}`));
    srv.listen(443);
    this.httpsReject = srv;
  }

  // Aviso SSDP "alive" por multicast: el Echo se entera de la IP actual sin esperar a su
  // próxima búsqueda (al pasar el puente de un PC a otro)
  anunciar() {
    if (!this.ssdp) return;
    for (const nt of ["upnp:rootdevice", `uuid:${this.uuid}`, "urn:schemas-upnp-org:device:basic:1"]) {
      const msg =
        "NOTIFY * HTTP/1.1\r\n" +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        "CACHE-CONTROL: max-age=100\r\n" +
        `LOCATION: http://${this.ip}:80/description.xml\r\n` +
        "SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0\r\n" +
        "NTS: ssdp:alive\r\n" +
        `hue-bridgeid: ${this.bridgeId}\r\n` +
        `NT: ${nt}\r\n` +
        `USN: uuid:${this.uuid}${nt === `uuid:${this.uuid}` ? "" : `::${nt}`}\r\n` +
        "\r\n";
      this.ssdp.send(Buffer.from(msg), SSDP_PORT, SSDP_ADDR);
    }
  }

  _ssdpResponse(st) {
    return (
      "HTTP/1.1 200 OK\r\n" +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      "EXT:\r\n" +
      "CACHE-CONTROL: max-age=100\r\n" +
      `LOCATION: http://${this.ip}:80/description.xml\r\n` +
      "SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0\r\n" +
      `hue-bridgeid: ${this.bridgeId}\r\n` +
      `ST: ${st}\r\n` +
      `USN: uuid:${this.uuid}::${st === `uuid:${this.uuid}` ? "" : st}\r\n` +
      "\r\n"
    );
  }

  _description() {
    return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>http://${this.ip}:80/</URLBase>
<device>
<deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
<friendlyName>Philips hue (${this.ip})</friendlyName>
<manufacturer>Royal Philips Electronics</manufacturer>
<manufacturerURL>http://www.philips.com</manufacturerURL>
<modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
<modelName>Philips hue bridge 2012</modelName>
<modelNumber>929000226503</modelNumber>
<modelURL>http://www.meethue.com</modelURL>
<serialNumber>${this.serial}</serialNumber>
<UDN>uuid:${this.uuid}</UDN>
<presentationURL>index.html</presentationURL>
</device>
</root>`;
  }

  _lightJson(light) {
    const s = light.getState();
    // Formato Hue: 8 bytes + "-0b". Debe ser estable o Alexa duplica el dispositivo
    const uniqueid = `${this.mac}:00:${String(light.id).padStart(2, "0")}-0b`;
    // Enchufe: Alexa no lo incluye en "apaga las luces" (lo usa el PC, que se suspende)
    if (light.kind === "enchufe") {
      return {
        state: { on: s.on, alert: "none", mode: "homeautomation", reachable: true },
        type: "On/Off plug-in unit",
        name: light.name,
        modelid: "LOM001",
        manufacturername: "Philips",
        productname: "Hue Smart plug",
        uniqueid,
        swversion: "1.65.11_hB798F2BF",
      };
    }
    // Los efectos se declaran como luz regulable para que Alexa los muestre como luces
    if (light.kind === "onoff") {
      return {
        state: { on: s.on, bri: s.bri, alert: "none", mode: "homeautomation", reachable: true },
        type: "Dimmable light",
        name: light.name,
        modelid: "LWB010",
        manufacturername: "Philips",
        productname: "Hue white lamp",
        uniqueid,
        swversion: "1.46.13_r26312",
      };
    }
    return {
      state: {
        on: s.on,
        bri: s.bri,
        hue: s.hue,
        sat: s.sat,
        effect: "none",
        xy: s.xy,
        ct: s.ct,
        alert: "none",
        colormode: s.colormode,
        mode: "homeautomation",
        reachable: true,
      },
      type: "Extended color light",
      name: light.name,
      modelid: "LCT015",
      manufacturername: "Philips",
      productname: "Hue color lamp",
      uniqueid,
      swversion: "1.46.13_r26312",
    };
  }

  _allLights() {
    const out = {};
    for (const l of this.lights) out[l.id] = this._lightJson(l);
    return out;
  }

  _config() {
    return {
      name: "Philips hue",
      bridgeid: this.bridgeId,
      mac: this.mac,
      // Puente de 1.ª generación: sin HTTPS, para que el Echo no lo intente
      modelid: "BSB001",
      apiversion: "1.17.0",
      swversion: "1709131301",
      ipaddress: this.ip,
      linkbutton: true,
    };
  }

  // Devuelve true si la petición era de la API Hue y ya se respondió
  handle(req, res, body) {
    const json = (data) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const url = req.url.split("?")[0].replace(/\/+$/, "");
    if (!this.activo()) return false;

    if (req.method === "GET" && url === "/description.xml") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(this._description());
      return true;
    }
    if (!url.startsWith("/api")) return false;

    if (req.method === "POST" && url === "/api") {
      json([{ success: { username: "alexa" } }]);
      return true;
    }

    const parts = url.split("/").slice(2); // [usuario, recurso, id, "state"]
    const [, resource, id, sub] = parts;

    if (req.method === "GET" && parts.length <= 1) {
      json({ lights: this._allLights(), groups: {}, config: this._config(), schedules: {}, scenes: {}, rules: {}, sensors: {}, resourcelinks: {} });
    } else if (req.method === "GET" && resource === "config") {
      json(this._config());
    } else if (req.method === "GET" && resource === "lights" && !id) {
      json(this._allLights());
    } else if (resource === "lights" && id) {
      const light = this.lights.find((l) => String(l.id) === id);
      if (!light) {
        json([{ error: { type: 3, address: `/lights/${id}`, description: "resource not available" } }]);
      } else if (req.method === "PUT" && sub === "state") {
        let cambios = {};
        try {
          cambios = JSON.parse(body || "{}");
        } catch {}
        this.log(`Alexa -> "${light.name}": ${JSON.stringify(cambios)}`);
        light.setState(cambios);
        json(
          Object.entries(cambios).map(([k, v]) => ({
            success: { [`/lights/${id}/state/${k}`]: v },
          })),
        );
      } else {
        json(this._lightJson(light));
      }
    } else if (req.method === "GET" && resource === "groups") {
      json({});
    } else {
      json([]);
    }
    return true;
  }
}

module.exports = { HueBridge };
