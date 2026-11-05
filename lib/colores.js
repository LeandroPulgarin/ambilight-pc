// Conversiones de los formatos de color que manda Alexa (vía API Hue) a RGB

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// h 0..360, s y v 0..1
const hsvToRgb = (h, s, v) => {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return clamp(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
};

// Hue: hue 0..65535, sat 0..254
const hueSatToRgb = (hue, sat) => hsvToRgb((hue / 65535) * 360, sat / 254, 1);

// Espacio CIE xy (fórmula de Philips, gamut amplio), a brillo máximo
const xyToRgb = (x, y) => {
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const gamma = (c) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  [r, g, b] = [r, g, b].map((c) => Math.max(0, gamma(c)));
  const max = Math.max(r, g, b, 1e-6);
  return [r, g, b].map((c) => clamp((c / max) * 255));
};

// Temperatura de color en mireds (lo que manda Alexa para "blanco cálido", etc.)
const ctToRgb = (mireds) => {
  const t = 1e6 / mireds / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b =
    t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r), clamp(g), clamp(b)];
};

// RGB -> hue/sat de Hue, para informar a Alexa del color actual
const rgbToHueSat = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + 360) % 360;
  return {
    hue: Math.round((h / 360) * 65535),
    sat: max ? Math.round((d / max) * 254) : 0,
  };
};

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Color no válido: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

module.exports = { hsvToRgb, hueSatToRgb, xyToRgb, ctToRgb, rgbToHueSat, hexToRgb };
