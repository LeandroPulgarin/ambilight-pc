// Da de alta en diyHue las 5 zonas de la tira (los segmentos del WLED falso de servicio.js).
//
// Uso: node huesync/agregar-luces.js
//  1. Pide un usuario a la API de diyHue. La primera vez hay que pulsar el "botón" de enlace
//     en la web de diyHue (http://192.168.1.16/#linkbutton) mientras el script espera.
//  2. Lee los segmentos del WLED falso y crea una luz por segmento.
//
// diyHue llega a este PC desde Docker por host.docker.internal; si no, pasar otra dirección:
//   node huesync/agregar-luces.js --wled 192.168.1.16:8090

const fs = require("fs");
const path = require("path");

const DIYHUE = "http://127.0.0.1";
const WLED_LOCAL = "http://127.0.0.1:8090";
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const WLED_DESDE_DOCKER = arg("--wled", "host.docker.internal:8090");
const USUARIO_PATH = path.join(__dirname, "config", "usuario-tira.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pedirUsuario = async () => {
  try {
    const u = fs.readFileSync(USUARIO_PATH, "utf8").trim();
    const r = await (await fetch(`${DIYHUE}/api/${u}/config`)).json();
    if (r.bridgeid) return u;
  } catch {}
  console.log("Pulsa el botón de enlace en http://192.168.1.16/#linkbutton (esperando 2 minutos)...");
  for (let i = 0; i < 60; i++) {
    const r = await (
      await fetch(`${DIYHUE}/api`, { method: "POST", body: JSON.stringify({ devicetype: "tira-ambilight#pc" }) })
    ).json();
    const u = r?.[0]?.success?.username;
    if (u) {
      fs.mkdirSync(path.dirname(USUARIO_PATH), { recursive: true });
      fs.writeFileSync(USUARIO_PATH, u);
      return u;
    }
    await sleep(2000);
  }
  throw new Error("No se pulsó el botón de enlace a tiempo");
};

const main = async () => {
  const wled = await (await fetch(`${WLED_LOCAL}/json`)).json();
  const usuario = await pedirUsuario();
  console.log(`Usuario de diyHue: ${usuario}`);

  const existentes = Object.values(await (await fetch(`${DIYHUE}/api/${usuario}/lights`)).json());
  for (const seg of wled.state.seg) {
    const nombre = `Tira ${seg.n}`;
    if (existentes.some((l) => l.name === nombre)) {
      console.log(`Ya existe: ${nombre}`);
      continue;
    }
    const cuerpo = {
      ip: WLED_DESDE_DOCKER,
      protocol: "wled",
      config: {
        lightName: nombre,
        lightModelID: "LCT015", // bombilla de color: vale para áreas de entretenimiento
        ledCount: seg.len,
        segmentId: seg.id,
        segment_start: seg.start,
        udp_port: wled.info.udpport,
        mdns_name: wled.info.name,
        mac: wled.info.mac,
      },
    };
    const r = await (
      await fetch(`${DIYHUE}/api/${usuario}/lights`, { method: "POST", body: JSON.stringify(cuerpo) })
    ).json();
    console.log(`${nombre}: ${JSON.stringify(r)}`);
    await sleep(500);
  }
  await sleep(1500);
  const luces = await (await fetch(`${DIYHUE}/api/${usuario}/lights`)).json();
  console.log("\nLuces en diyHue:");
  for (const [id, l] of Object.entries(luces)) console.log(`  ${id}: ${l.name} (${l.modelid})`);
};

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
