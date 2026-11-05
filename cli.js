#!/usr/bin/env node
// Uso: node cli.js <comando> [args]   (ver "node cli.js ayuda")
// Si servicio.js está en marcha, los cambios pasan por él (así recuerda el estado);
// si no, se habla directamente con la tira.

const { SyncLight, EFFECT_TYPE, sleep } = require("./lib/synclight");
const { hsvToRgb, hexToRgb } = require("./lib/colores");
const { EFECTOS } = require("./lib/musica");
const { EFECTOS_TECLADO } = require("./lib/teclado");

const AYUDA = `
Comandos:
  info                          Lee la información del dispositivo (no cambia nada)
  estado                        Estado guardado por el servicio
  color <r> <g> <b>             Toda la tira de un color (0-255)
  color <#rrggbb>               Igual, en hexadecimal
  brillo <0-100>                Brillo
  lampara <on|off>              La lámpara Tuya sigue el color de la tira (requiere servicio)
  pantalla                      Ambilight: la tira copia los bordes de la pantalla (requiere servicio)
  pantalla suavizado <0-100>    Cuánto se suavizan los cambios de color del ambilight
  pantalla auto <on|off>        Ambilight automático solo con algo a pantalla completa
  efecto <dinamico|ritmo> <0-6> Efecto integrado del firmware
  velocidad <0-100>             Velocidad de los efectos dinámicos
  sensibilidad <0-100>          Sensibilidad del micrófono de la tira (efectos de ritmo)
  teclado <on|off>              Efectos de luz al escribir (requiere servicio)
  teclado <efecto>              chispa, onda, intensa, arcoiris, cometas o velocidad
  teclado rapidez <0-100>       Rapidez de las ondas (50 = normal)
  musica <on|off>               Modo música automático al reproducir algo (requiere servicio)
  musica <efecto>               suave, latido, espectro, aurora, pulso o vumetro
  musica intensidad <0-100>     Cuánto se nota la música
  encender                      Vuelve al último color/efecto
  apagar                        Apaga las luces
  arcoiris [segundos]           Demo: arcoíris LED a LED generado desde el PC
  recorrido                     Prueba de orientación: LED 1 rojo, último azul y un punto blanco de 1 al último
`;

// Devuelve el estado del servicio, o null si no está en marcha
const servicio = async (cambios) => {
  try {
    const res = await fetch("http://127.0.0.1/tira", {
      method: cambios ? "POST" : "GET",
      body: cambios ? JSON.stringify(cambios) : undefined,
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

// Traduce un comando a cambios de estado (formato de servicio.js)
const aCambios = (cmd, args) => {
  switch (cmd) {
    case "color": {
      const rgb = args.length === 1 ? hexToRgb(args[0]) : args.map(Number);
      return { encendida: true, modo: "color", color: rgb };
    }
    case "brillo":
      return { encendida: true, brillo: Number(args[0]) };
    case "efecto": {
      const tipo = EFFECT_TYPE[args[0]];
      if (tipo === undefined) throw new Error("Tipo: dinamico | ritmo");
      return { encendida: true, modo: "efecto", efecto: { tipo, indice: Number(args[1] ?? 0) } };
    }
    case "velocidad":
      return { velocidad: Number(args[0]) };
    case "sensibilidad":
      return { sensibilidad: Number(args[0]) };
    case "lampara":
      if (args[0] === "on" || args[0] === "off") return { lamparaSync: args[0] === "on" };
      if (args[0] === "zonas") return { lamparaZonas: Number(args[1]) };
      throw new Error("Uso: lampara on | off | zonas <1-5>");
    case "pantalla":
      if (args[0] === "suavizado") return { suavizadoPantalla: Number(args[1]) };
      if (args[0] === "auto") return { pantallaAuto: args[1] !== "off" };
      return { encendida: true, modo: "pantalla" };
    case "teclado":
      if (args[0] === "on" || args[0] === "off") return { tecladoActivo: args[0] === "on" };
      if (EFECTOS_TECLADO.includes(args[0])) return { efectoTeclado: args[0] };
      if (args[0] === "rapidez") return { velocidadTeclado: Number(args[1]) };
      throw new Error(`Uso: teclado on | off | rapidez <0-100> | ${EFECTOS_TECLADO.join(" | ")}`);
    case "musica":
      if (args[0] === "on" || args[0] === "off") return { musicaAuto: args[0] === "on" };
      if (EFECTOS.includes(args[0])) return { efectoMusica: args[0] };
      if (args[0] === "intensidad") return { intensidadMusica: Number(args[1]) };
      throw new Error(`Uso: musica on | off | intensidad <0-100> | ${EFECTOS.join(" | ")}`);
    case "encender":
      return { encendida: true };
    case "apagar":
      return { encendida: false };
  }
  return null;
};

const directo = async (light, cmd, cambios) => {
  const info = await light.getInfo();
  if (cmd === "apagar") return light.turnOff(info ? info.version : undefined);
  if (cambios.brillo !== undefined) light.setBrightness(cambios.brillo);
  if (cambios.velocidad !== undefined) light.setDynamicSpeed(cambios.velocidad);
  if (cambios.color && cmd === "color") light.setColor(...cambios.color);
  if (cambios.efecto) light.setEffect(cambios.efecto.tipo, cambios.efecto.indice);
  if (cmd === "encender") console.log("Sin servicio no hay estado guardado; usa color o efecto");
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "ayuda") return console.log(AYUDA);

  if (cmd === "estado") {
    console.log((await servicio()) ?? "El servicio no está en marcha");
    return;
  }

  const cambios = aCambios(cmd, args);
  if (cambios) {
    const res = await servicio(cambios);
    if (res) return console.log("ok (vía servicio)");
  } else if (!["info", "arcoiris", "recorrido"].includes(cmd)) {
    return console.log(AYUDA);
  }

  const light = SyncLight.open();
  try {
    if (cmd === "info") {
      console.log(await light.getInfo());
    } else if (cmd === "arcoiris") {
      const info = await light.getInfo();
      const leds = info && info.lampsAmount ? info.lampsAmount : 60;
      const end = Date.now() + Number(args[0] ?? 10) * 1000;
      for (let t = 0; Date.now() < end; t += 4) {
        const colors = Array.from({ length: leds }, (_, i) =>
          hsvToRgb((t + (i * 360) / leds) % 360, 1, 1),
        );
        light.setPixels(colors);
        await sleep(40);
      }
    } else if (cmd === "recorrido") {
      const info = await light.getInfo();
      const leds = info && info.lampsAmount ? info.lampsAmount : 60;
      for (let vuelta = 0; vuelta < 2; vuelta++)
        for (let p = 0; p < leds; p++) {
          const colors = Array.from({ length: leds }, (_, i) =>
            i === p ? [255, 255, 255] : i === 0 ? [255, 0, 0] : i === leds - 1 ? [0, 0, 255] : [0, 0, 0],
          );
          light.setPixels(colors);
          await sleep(90);
        }
    } else {
      await directo(light, cmd, cambios);
      console.log("ok (directo)");
    }
    await sleep(100);
  } finally {
    light.close();
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
