// Efectos del modo música: convierten la lectura del motor de audio en colores LED a LED.
//
// Disposición de la tira (vista de frente): el LED 1 está abajo a la izquierda, sube por el
// lado izquierdo, cruza por arriba y baja por el derecho hasta el último (abajo a la derecha).
// Los efectos usan pocos tramos de color iguales para que cada cuadro quepa en 1-2 paquetes.
//
// "intensidad" (0..100) es cuánto se nota la música: con 0 la tira casi no cambia y con 100
// el brillo llega a bajar al 10 %.

const { hsvToRgb } = require("./colores");

const escala = ([r, g, b], f) => [r * f, g * f, b * f].map((v) => Math.round(Math.max(0, Math.min(255, v))));
const mezcla = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
const BLANCO = [255, 255, 255];

const EFECTOS = ["suave", "latido", "espectro", "aurora", "pulso", "vumetro"];

class Musica {
  constructor(numLeds) {
    this.n = numLeds;
    this.nivel = 0; // nivel suavizado (sube rápido, baja despacio)
    this.pico = 0; // marcador de pico que cae poco a poco
    this.tono = 0; // para el color base cuando la tira está en un efecto y no en un color
    this.lento = 0; // envolvente muy suavizada para "suave"
    this.golpe = 0; // energía del último golpe de bajo para "latido"
    this.mediaGraves = 0; // media lenta de los graves, para detectar golpes por encima de ella
    this.zonas = { b: 0, m: 0, a: 0 }; // bandas suavizadas para "espectro"
    this.fase = 0; // desplazamiento de "aurora"
  }

  // Ataque inmediato y caída lenta, para que el efecto "respire" con el ritmo
  _suavizar(lectura) {
    const v = Math.min(1, 0.65 * lectura.b + 0.35 * lectura.n);
    this.nivel = v > this.nivel ? v : this.nivel * 0.82 + v * 0.18;
    this.pico = Math.max(this.nivel, this.pico - 0.012);
  }

  // base: color [r,g,b] o null para ir rotando el tono
  cuadro(efecto, lectura, base, intensidad = 70) {
    this._suavizar(lectura);
    const tranquilo = efecto !== "pulso" && efecto !== "vumetro";
    if (!base) {
      // En los efectos tranquilos el tono avanza muy despacio (una vuelta cada ~3 minutos)
      this.tono = (this.tono + (tranquilo ? 0.06 : 0.4 + lectura.a * 2)) % 360;
      base = hsvToRgb(this.tono, 1, 1);
    }
    const prof = 0.9 * (Math.max(0, Math.min(100, intensidad)) / 100);
    switch (efecto) {
      case "latido":
        return this._latido(lectura, base, prof);
      case "espectro":
        return this._espectro(lectura, base, prof);
      case "aurora":
        return this._aurora(base, prof);
      case "pulso":
        return this._pulso(lectura, base);
      case "vumetro":
        return this._vumetro(lectura, base);
      default:
        return this._suave(base, prof);
    }
  }

  _toda(c) {
    return Array.from({ length: this.n }, () => c);
  }

  // Respiración: toda la tira igual, sin movimiento ni destellos; el brillo sigue la música
  // con constantes de tiempo de ~0,3-0,8 s. La curva cuadrática hace que se perciba más.
  _suave(base, prof) {
    const k = this.nivel > this.lento ? 0.1 : 0.04;
    this.lento += (this.nivel - this.lento) * k;
    return this._toda(escala(base, 1 - prof + prof * this.lento * this.lento));
  }

  // Un golpe de luz cuando el bajo supera claramente su media, que se apaga en ~1 s
  _latido(lectura, base, prof) {
    this.mediaGraves += (lectura.b - this.mediaGraves) * 0.02;
    if (lectura.b > this.mediaGraves * 1.35 + 0.15 && lectura.b > this.golpe) this.golpe = lectura.b;
    else this.golpe *= 0.94;
    return this._toda(escala(base, 1 - prof + prof * this.golpe));
  }

  // Graves en el lado izquierdo, medios arriba y agudos en el derecho, cada zona con su brillo
  _espectro(lectura, base, prof) {
    for (const k of ["b", "m", "a"]) {
      const v = lectura[k];
      this.zonas[k] += (v - this.zonas[k]) * (v > this.zonas[k] ? 0.3 : 0.08);
    }
    // Proporciones de un 24" 16:9: lados de ~30 cm y arriba de ~53 cm
    const lado = Math.round(this.n * 0.26);
    const color = (k) => escala(base, 1 - prof + prof * this.zonas[k]);
    const [cb, cm, ca] = [color("b"), color("m"), color("a")];
    return Array.from({ length: this.n }, (_, i) => (i < lado ? cb : i >= this.n - lado ? ca : cm));
  }

  // Ondas suaves del color que fluyen despacio por la tira; la música acelera un poco el flujo
  // y la intensidad decide el contraste entre crestas y valles. El brillo se cuantiza en 8
  // niveles para que haya pocos tramos y quepa en pocos paquetes.
  _aurora(base, prof) {
    const k = this.nivel > this.lento ? 0.1 : 0.04;
    this.lento += (this.nivel - this.lento) * k;
    this.fase = (this.fase + 0.002 + 0.006 * this.lento) % 1;
    return Array.from({ length: this.n }, (_, i) => {
      const onda = 0.5 + 0.5 * Math.sin(2 * Math.PI * (i / this.n * 1.5 + this.fase));
      const f = Math.round((1 - prof * (1 - onda) * (1.2 - this.lento * 0.6)) * 8) / 8;
      return escala(base, Math.max(0.08, f));
    });
  }

  // Los dos lados suben desde abajo a la vez y se juntan arriba en el centro a volumen máximo
  _vumetro(lectura, base) {
    const mitad = this.n / 2;
    const alto = this.nivel * mitad;
    const marca = Math.min(mitad - 1, Math.round(this.pico * mitad));
    const encendido = mezcla(escala(base, 0.55 + 0.45 * this.nivel), BLANCO, lectura.a * 0.25);
    const fondo = escala(base, 0.08);
    return Array.from({ length: this.n }, (_, i) => {
      const d = Math.min(i, this.n - 1 - i); // distancia al extremo de abajo más cercano
      if (d === marca && this.pico > 0.05) return BLANCO;
      return d < alto ? encendido : fondo;
    });
  }

  // Toda la tira late con los graves; los agudos le dan un brillo blanco
  _pulso(lectura, base) {
    return this._toda(mezcla(escala(base, 0.12 + 0.88 * this.nivel), BLANCO, lectura.a * 0.3 * this.nivel));
  }
}

module.exports = { Musica, EFECTOS };
