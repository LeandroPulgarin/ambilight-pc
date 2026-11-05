// Efectos de teclado: cada pulsación genera luz en la tira, en el color actual.
//
// La tira se recorre como el bloque principal del teclado de izquierda a derecha: LED 1
// (abajo a la izquierda) = Esc/Tab/Shift izquierdo, LED central de arriba = centro del
// teclado, último LED (abajo a la derecha) = Retroceso/Enter/Shift derecho.

const { hsvToRgb, rgbToHueSat } = require("./colores");

const escala = ([r, g, b], f) => [r * f, g * f, b * f].map((v) => Math.round(Math.max(0, Math.min(255, v))));
const mezcla = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
const BLANCO = [255, 255, 255];
const NIVELES = 8; // el brillo se cuantiza para que haya pocos tramos y pocos paquetes

// Parámetros de cada efecto:
//  dur: ms que vive cada pulsación     vel: LEDs/s a los que avanza la luz
//  ancho: grosor del frente en LEDs     blanco: cuánto se aclara la luz hacia blanco
//  fondo: brillo del resto de la tira mientras se escribe
const EFECTOS = {
  chispa: { dur: 600, vel: 0, ancho: 1.6, blanco: 0.25, fondo: 0.4 },
  onda: { dur: 700, vel: 40, ancho: 2.2, blanco: 0.25, fondo: 0.4 },
  intensa: { dur: 800, vel: 55, ancho: 2.8, blanco: 0.3, fondo: 0.12 },
  arcoiris: { dur: 900, vel: 36, ancho: 3, blanco: 0.1, fondo: 0.3 },
  cometas: { dur: 1100, vel: 55, ancho: 1.2, blanco: 0.35, fondo: 0.25 },
  velocidad: { fondo: 0.15 },
};
const EFECTOS_TECLADO = Object.keys(EFECTOS);

// Aunque se crucen muchas ondas, la mezcla hacia la luz no pasa de aquí, para que al escribir
// rápido no quede la tira entera encendida
const MAX_LUZ = 0.85;

// velocidad 0..100 → multiplicador 0,5x..2x (50 = normal). Las ondas rápidas también duran
// menos, así se acumulan menos
const factorVelocidad = (v = 50) => Math.pow(2, (Math.max(0, Math.min(100, v)) - 50) / 50);

class Teclado {
  constructor(numLeds) {
    this.n = numLeds;
    this.ondas = []; // { pos, t0, k }
    this.k = 0; // contador de pulsaciones, para variar el tono en "arcoiris"
    this.fondo = 1; // factor de brillo del fondo, baja al escribir y sube al parar
    this.pulsaciones = []; // instantes de las últimas teclas, para "velocidad"
    this.llenado = 0; // nivel suavizado de "velocidad"
  }

  // x: 0..1, posición horizontal de la tecla en el teclado
  pulsar(x) {
    const ahora = Date.now();
    this.ondas.push({ pos: x * (this.n - 1), t0: ahora, k: this.k++ });
    if (this.ondas.length > 30) this.ondas.shift();
    this.pulsaciones.push(ahora);
  }

  activo() {
    return this.ondas.length > 0 || this.fondo < 0.999 || this.llenado > 0.01;
  }

  // Superpone el efecto a un cuadro base (array de [r,g,b]). escribiendo: si hubo teclas hace poco
  cuadro(base, color, efecto, escribiendo, velocidad = 50) {
    const f = factorVelocidad(velocidad);
    const def = EFECTOS[efecto] || EFECTOS.onda;
    const p = { ...def, dur: def.dur / f, vel: def.vel * f };
    const ahora = Date.now();
    this.ondas = this.ondas.filter((o) => ahora - o.t0 < (p.dur || 0));
    this.pulsaciones = this.pulsaciones.filter((t) => ahora - t < 2000);

    // El fondo baja rápido al empezar a escribir y vuelve despacio al parar
    const objetivo = escribiendo ? p.fondo : 1;
    this.fondo += (objetivo - this.fondo) * (objetivo < this.fondo ? 0.25 : 0.06);
    if (Math.abs(this.fondo - objetivo) < 0.002) this.fondo = objetivo;
    const fondo = base.map((c) => escala(c, this.fondo));

    if (efecto === "velocidad") return this._velocidad(fondo, color);
    if (efecto === "cometas") return this._cometas(fondo, color, p, ahora);

    const tonoBase = (rgbToHueSat(color).hue / 65535) * 360;
    return fondo.map((c, i) => {
      let salida = c;
      let total = 0; // luz ya aplicada a este LED, para respetar MAX_LUZ
      for (const o of this.ondas) {
        const edad = (ahora - o.t0) / 1000;
        const vida = 1 - (edad * 1000) / p.dur;
        const d = Math.abs(i - o.pos) - edad * p.vel;
        // La onda intensa se desvanece de forma lineal (dura más visible); el resto, cuadrática
        const caida = efecto === "intensa" ? vida : vida * vida;
        let luz = Math.exp(-(d * d) / (p.ancho * p.ancho)) * caida;
        if (efecto === "intensa") luz = Math.min(1, luz * 1.5);
        luz = Math.round(Math.min(1, luz, MAX_LUZ - total) * NIVELES) / NIVELES;
        if (luz <= 0) continue;
        total += luz;
        const propio = efecto === "arcoiris" ? hsvToRgb((tonoBase + o.k * 47) % 360, 1, 1) : color;
        salida = mezcla(salida, mezcla(propio, BLANCO, p.blanco), luz);
      }
      return salida;
    });
  }

  // Dos cometas por tecla, uno hacia cada extremo, con la estela detrás de la cabeza
  _cometas(fondo, color, p, ahora) {
    const cabeza = mezcla(color, BLANCO, p.blanco);
    const luz = new Array(this.n).fill(0);
    for (const o of this.ondas) {
      const edad = (ahora - o.t0) / 1000;
      const vida = 1 - (edad * 1000) / p.dur;
      const avance = edad * p.vel;
      for (const dir of [-1, 1]) {
        const pos = o.pos + dir * avance;
        for (let i = 0; i < this.n; i++) {
          const detras = (pos - i) * dir; // > 0: el LED está en la estela
          if (detras < -p.ancho || detras > 10) continue;
          const v = detras < 0 ? 1 + detras / p.ancho : Math.exp(-detras / 3);
          luz[i] = Math.max(luz[i], v * vida);
        }
      }
    }
    return fondo.map((c, i) => mezcla(c, cabeza, Math.round(Math.min(luz[i], MAX_LUZ) * NIVELES) / NIVELES));
  }

  // La tira se llena desde abajo por los dos lados según las teclas por segundo
  _velocidad(fondo, color) {
    const porSegundo = this.pulsaciones.length / 2;
    const objetivo = Math.min(1, porSegundo / 9); // ~9 teclas/s (unas 100 palabras/min) = lleno
    this.llenado += (objetivo - this.llenado) * (objetivo > this.llenado ? 0.2 : 0.05);
    const mitad = this.n / 2;
    const alto = this.llenado * mitad;
    return fondo.map((c, i) => (Math.min(i, this.n - 1 - i) < alto ? color : c));
  }
}

module.exports = { Teclado, EFECTOS_TECLADO };
