// news-image-20261119 — "The World in One Picture"
// A program that draws one image summing up the world news of Thursday
// 19 November 2026 and writes it to /output/entry.png (or $MAKEFUN_OUTPUT_DIR).
// Pure Node 22 standard library: no network, no model calls, no dependencies.
// The image is drawn deterministically from code: a newspaper front page with
// the day's lead story (the first-ever Trump–Xi–Putin trilateral summit in
// Shenzhen) and six more of the day's biggest stories, plus a footer strip.
// A tiny 5x7 bitmap font (written here, uppercase only) renders all text, and
// a small PNG encoder (zlib deflate + CRC32) writes the file. Running the
// program twice produces byte-identical output.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Canvas: a plain RGB framebuffer with a few drawing primitives.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const PAPER: RGB = [247, 242, 231];
const INK: RGB = [22, 22, 22];
const NAVY: RGB = [26, 47, 90];
const NAVY_DARK: RGB = [16, 32, 64];
const RED: RGB = [176, 42, 42];
const GOLD: RGB = [196, 148, 44];
const WHITE: RGB = [255, 255, 255];
const GREY: RGB = [96, 94, 88];
const LIGHT: RGB = [233, 227, 211];
const BLUE: RGB = [46, 90, 160];
const SKY: RGB = [140, 180, 220];
const GREEN: RGB = [46, 125, 60];
const ORANGE: RGB = [214, 110, 30];

const buf = new Uint8Array(W * H * 3);

function px(x: number, y: number, c: RGB): void {
  // Floor here, not at the call sites: several shapes pass fractional
  // coordinates, and a fractional index into the byte buffer would land
  // the pixel on a different row entirely (or nowhere at all).
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

function rect(x: number, y: number, w: number, h: number, c: RGB): void {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) px(i, j, c);
  }
}

function hline(x0: number, x1: number, y: number, c: RGB): void {
  for (let x = x0; x <= x1; x++) px(x, y, c);
}

function vline(x: number, y0: number, y1: number, c: RGB): void {
  for (let y = y0; y <= y1; y++) px(x, y, c);
}

// Bresenham line.
function line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    px(x, y, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function circle(cx: number, cy: number, r: number, c: RGB): void {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r) px(cx + x, cy + y, c);
    }
  }
}

function ring(cx: number, cy: number, r: number, c: RGB, thick = 2): void {
  for (let a = 0; a < 360; a += 1) {
    const rad = (a * Math.PI) / 180;
    for (let t = 0; t < thick; t++) {
      px(Math.round(cx + (r - t) * Math.cos(rad)), Math.round(cy + (r - t) * Math.sin(rad)), c);
    }
  }
}

function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  for (let y = -ry; y <= ry; y++) {
    for (let x = -rx; x <= rx; x++) {
      if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) px(cx + x, cy + y, c);
    }
  }
}

// Filled triangle.
function triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGB): void {
  const minX = Math.min(x0, x1, x2);
  const maxX = Math.max(x0, x1, x2);
  const minY = Math.min(y0, y1, y2);
  const maxY = Math.max(y0, y1, y2);
  const d = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  if (d === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = ((x1 - x) * (y2 - y) - (y1 - y) * (x2 - x)) / d;
      const b = ((x2 - x) * (y0 - y) - (y2 - y) * (x0 - x)) / d;
      const g = 1 - a - b;
      if (a >= 0 && b >= 0 && g >= 0) px(x, y, c);
    }
  }
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font. Each glyph is 7 rows of 5 bits, most significant bit left.
// Uppercase, digits and common punctuation only — every string in the image
// is written in capitals, as a newspaper headline would be.
// ---------------------------------------------------------------------------

const FONT: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ',': [0, 0, 0, 0, 0b01100, 0b00100, 0b01000],
  ':': [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
  ';': [0, 0b01100, 0b01100, 0, 0b01100, 0b00100, 0b01000],
  "'": [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
  '-': [0, 0, 0, 0b01110, 0, 0, 0],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  '&': [0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101],
  '%': [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  $: [0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0, 0b00100],
  '+': [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  '=': [0, 0, 0b11111, 0, 0b11111, 0, 0],
  '"': [0b01010, 0b01010, 0, 0, 0, 0, 0],
  '\u2022': [0, 0, 0b01100, 0b01100, 0b01100, 0, 0],
  '\u2014': [0, 0, 0, 0b11111, 0, 0, 0],
  '\u2019': [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
};

// Draw one glyph; returns the advance width in pixels.
function drawChar(x: number, y: number, scale: number, c: RGB, ch: string): number {
  const g = FONT[ch] ?? FONT['?'];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if ((g[row] >> (4 - col)) & 1) {
        rect(x + col * scale, y + row * scale, scale, scale, c);
      }
    }
  }
  return 6 * scale;
}

function textWidth(text: string, scale: number): number {
  let w = 0;
  for (const ch of text) w += ch === ' ' ? 6 * scale : 6 * scale;
  return w - scale; // no trailing gap
}

function drawText(x: number, y: number, scale: number, c: RGB, text: string): number {
  let cx = x;
  for (const ch of text) cx += drawChar(cx, y, scale, c, ch);
  return cx;
}

function drawTextCentered(cx: number, y: number, scale: number, c: RGB, text: string): void {
  drawText(cx - Math.floor(textWidth(text, scale) / 2), y, scale, c, text);
}

// Greedy word wrap: returns lines that fit maxWidth at the given scale.
function wrapText(text: string, maxWidth: number, scale: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (textWidth(next, scale) <= maxWidth || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawWrapped(x: number, y: number, scale: number, c: RGB, text: string, maxWidth: number, lineGap: number): number {
  const lines = wrapText(text, maxWidth, scale);
  let cy = y;
  for (const ln of lines) {
    drawText(x, cy, scale, c, ln);
    cy += 7 * scale + lineGap;
  }
  return cy;
}

// ---------------------------------------------------------------------------
// Small pictograms, drawn from shapes. Each fits in a ~w x h box.
// ---------------------------------------------------------------------------

function drawGlobe(cx: number, cy: number, r: number): void {
  circle(cx, cy, r, SKY);
  ring(cx, cy, r, NAVY, 3);
  // Meridians and equator.
  for (let k = -2; k <= 2; k++) {
    const rx = Math.abs(k) === 2 ? Math.round(r * 0.45) : Math.round(r * 0.8);
    const ry = r;
    for (let a = 0; a < 360; a += 2) {
      const rad = (a * Math.PI) / 180;
      const ex = Math.round(rx * Math.cos(rad));
      const ey = Math.round(ry * Math.sin(rad));
      if (ex * ex + ey * ey <= r * r) px(cx + ex, cy + ey, NAVY);
    }
  }
  hline(cx - r, cx + r, cy, NAVY);
  // Continents as simple blobs.
  ellipse(Math.round(cx - r * 0.35), Math.round(cy - r * 0.35), Math.round(r * 0.34), Math.round(r * 0.2), GREEN);
  ellipse(Math.round(cx + r * 0.4), Math.round(cy - r * 0.1), Math.round(r * 0.26), Math.round(r * 0.3), GREEN);
  ellipse(Math.round(cx - r * 0.1), Math.round(cy + r * 0.45), Math.round(r * 0.3), Math.round(r * 0.18), GREEN);
  ellipse(Math.round(cx + r * 0.55), Math.round(cy + r * 0.5), Math.round(r * 0.16), Math.round(r * 0.14), GREEN);
}

function drawFlagUSA(x: number, y: number, w: number, h: number): void {
  const stripe = Math.max(2, Math.round(h / 13));
  for (let i = 0; i < 13; i++) {
    rect(x, y + i * stripe, w, stripe, i % 2 === 0 ? RED : WHITE);
  }
  rect(x, y, Math.round(w * 0.4), stripe * 7, NAVY);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      px(x + 3 + c * 5, y + 3 + r * 4, WHITE);
    }
  }
  rect(x, y, w, 1, INK);
  rect(x, y + h - 1, w, 1, INK);
}

function drawFlagChina(x: number, y: number, w: number, h: number): void {
  rect(x, y, w, h, RED);
  // One big star (5-point, drawn as a plus of pixels) and four small ones.
  const star = (sx: number, sy: number, s: number): void => {
    px(sx, sy - s, GOLD);
    px(sx, sy + s, GOLD);
    px(sx - s, sy, GOLD);
    px(sx + s, sy, GOLD);
    px(sx, sy, GOLD);
    px(sx - 1, sy - 1, GOLD);
    px(sx + 1, sy - 1, GOLD);
    px(sx - 1, sy + 1, GOLD);
    px(sx + 1, sy + 1, GOLD);
  };
  star(x + Math.round(w * 0.2), y + Math.round(h * 0.3), 4);
  star(x + Math.round(w * 0.45), y + Math.round(h * 0.15), 2);
  star(x + Math.round(w * 0.55), y + Math.round(h * 0.32), 2);
  star(x + Math.round(w * 0.5), y + Math.round(h * 0.5), 2);
  star(x + Math.round(w * 0.38), y + Math.round(h * 0.55), 2);
}

function drawFlagRussia(x: number, y: number, w: number, h: number): void {
  const third = Math.round(h / 3);
  rect(x, y, w, third, WHITE);
  rect(x, y + third, w, third, BLUE);
  rect(x, y + 2 * third, w, h - 2 * third, RED);
  rect(x, y, w, 1, INK);
  rect(x, y + h - 1, w, 1, INK);
}

// Scales of justice.
function drawScales(cx: number, cy: number, s: number): void {
  const c = NAVY;
  vline(cx, cy - 26 * s, cy + 22 * s, c);
  hline(cx - 22 * s, cx + 22 * s, cy - 26 * s, c);
  circle(cx, cy - 26 * s, 3 * s, c);
  for (const side of [-1, 1]) {
    const bx = cx + side * 22 * s;
    line(bx, cy - 26 * s, bx - 8 * s, cy - 6 * s, c);
    line(bx, cy - 26 * s, bx + 8 * s, cy - 6 * s, c);
    hline(bx - 8 * s, bx + 8 * s, cy - 6 * s, c);
    triangle(bx - 9 * s, cy - 6 * s, bx + 9 * s, cy - 6 * s, bx, cy + 6 * s, GOLD);
  }
  rect(cx - 14 * s, cy + 22 * s, 28 * s, 3 * s, c);
}

// A bridge: two towers, a deck and a hanging arc.
function drawBridge(cx: number, cy: number, s: number): void {
  const c = NAVY;
  const x0 = cx - 30 * s;
  const x1 = cx + 30 * s;
  hline(x0, x1, cy + 14 * s, c);
  hline(x0, x1, cy + 17 * s, c);
  for (const tx of [cx - 20 * s, cx + 20 * s]) {
    rect(tx - 2 * s, cy - 18 * s, 4 * s, 32 * s, c);
  }
  // Suspension arc between the towers.
  for (let a = 0; a <= 180; a += 3) {
    const rad = (a * Math.PI) / 180;
    const x = Math.round(cx + 20 * s * Math.cos(rad));
    const y = Math.round(cy - 18 * s + 12 * s * Math.sin(rad));
    px(x, y, c);
    px(x, y + 1, c);
  }
  // A break in the deck: the strike.
  rect(cx - 3 * s, cy + 10 * s, 6 * s, 5 * s, PAPER);
  triangle(cx - 6 * s, cy + 8 * s, cx + 6 * s, cy + 8 * s, cx, cy - 4 * s, RED);
  triangle(cx - 4 * s, cy + 2 * s, cx + 4 * s, cy + 2 * s, cx, cy - 8 * s, ORANGE);
}

// A tank in profile.
function drawTank(cx: number, cy: number, s: number): void {
  const c = GREEN;
  rect(cx - 26 * s, cy - 6 * s, 40 * s, 10 * s, c);
  rect(cx - 12 * s, cy - 14 * s, 18 * s, 9 * s, c);
  hline(cx + 6 * s, cx + 30 * s, cy - 11 * s, c);
  hline(cx + 6 * s, cx + 30 * s, cy - 10 * s, c);
  for (let i = 0; i < 5; i++) {
    circle(cx - 20 * s + i * 9 * s, cy + 7 * s, 3 * s, INK);
  }
  rect(cx - 28 * s, cy + 4 * s, 44 * s, 2 * s, INK);
}

// Flame / explosion.
function drawFlame(cx: number, cy: number, s: number): void {
  triangle(cx - 14 * s, cy + 16 * s, cx + 14 * s, cy + 16 * s, cx - 6 * s, cy - 10 * s, ORANGE);
  triangle(cx - 8 * s, cy + 16 * s, cx + 10 * s, cy + 16 * s, cx + 4 * s, cy - 18 * s, RED);
  triangle(cx - 6 * s, cy + 16 * s, cx + 6 * s, cy + 16 * s, cx, cy - 24 * s, GOLD);
  circle(cx, cy + 8 * s, 4 * s, GOLD);
}

// Rising chart with an arrow.
function drawChart(cx: number, cy: number, s: number): void {
  const c = NAVY;
  vline(cx - 26 * s, cy - 22 * s, cy + 18 * s, c);
  hline(cx - 26 * s, cx + 28 * s, cy + 18 * s, c);
  const pts: Array<[number, number]> = [
    [-22, 12],
    [-12, 8],
    [-2, 10],
    [8, -2],
    [18, -8],
    [26, -20],
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    line(cx + pts[i][0] * s, cy + pts[i][1] * s, cx + pts[i + 1][0] * s, cy + pts[i + 1][1] * s, GREEN);
    line(cx + pts[i][0] * s, cy + pts[i][1] * s + 1, cx + pts[i + 1][0] * s, cy + pts[i + 1][1] * s + 1, GREEN);
  }
  triangle(cx + 26 * s, cy - 20 * s, cx + 18 * s, cy - 18 * s, cx + 24 * s, cy - 10 * s, GREEN);
}

// Cyclone spiral: concentric arcs.
function drawCyclone(cx: number, cy: number, s: number): void {
  for (let r = 4; r <= 26; r += 6) {
    const start = (r * 40) % 360;
    for (let a = start; a < start + 240; a += 3) {
      const rad = (a * Math.PI) / 180;
      px(Math.round(cx + r * s * Math.cos(rad)), Math.round(cy + r * s * Math.sin(rad)), BLUE);
      px(Math.round(cx + r * s * Math.cos(rad)), Math.round(cy + r * s * Math.sin(rad)) + 1, BLUE);
    }
  }
  circle(cx, cy, 3 * s, RED);
}

// ---------------------------------------------------------------------------
// Page layout: a newspaper front page, 1024 x 1024.
// ---------------------------------------------------------------------------

function drawPanel(x: number, y: number, w: number, h: number, accent: RGB, kicker: string, headline: string, body: string, icon: (cx: number, cy: number) => void): void {
  rect(x, y, w, h, WHITE);
  rect(x, y, w, 6, accent);
  rect(x, y, w, 1, INK);
  rect(x, y + h - 1, w, 1, INK);
  rect(x, y, 1, h, INK);
  rect(x + w - 1, y, 1, h, INK);
  const pad = 16;
  drawText(x + pad, y + 16, 2, RED, kicker);
  const afterHead = drawWrapped(x + pad, y + 38, 3, INK, headline, w - 2 * pad, 3);
  drawWrapped(x + pad, afterHead + 4, 2, GREY, body, w - 2 * pad, 2);
  icon(x + Math.floor(w / 2), y + h - 34);
}

function drawPage(): void {
  rect(0, 0, W, H, PAPER);
  // Frame.
  rect(0, 0, W, 4, INK);
  rect(0, H - 4, W, 4, INK);
  rect(0, 0, 4, H, INK);
  rect(W - 4, 0, 4, H, INK);

  // Masthead.
  rect(16, 16, 992, 118, NAVY);
  rect(16, 16, 992, 4, GOLD);
  drawTextCentered(512, 38, 5, WHITE, 'THE WORLD IN ONE PICTURE');
  drawTextCentered(512, 96, 2, GOLD, 'THURSDAY 19 NOVEMBER 2026  \u2022  WORLD NEWS IN ONE IMAGE');
  hline(16, 1008, 140, GOLD);
  hline(16, 1008, 141, GOLD);

  // Hero: the Shenzhen trilateral summit.
  const hx = 24;
  const hy = 152;
  const hw = 976;
  const hh = 296;
  rect(hx, hy, hw, hh, WHITE);
  rect(hx, hy, hw, 6, RED);
  rect(hx, hy, hw, 1, INK);
  rect(hx, hy + hh - 1, hw, 1, INK);
  rect(hx, hy, 1, hh, INK);
  rect(hx + hw - 1, hy, 1, hh, INK);
  drawText(hx + 24, hy + 22, 2, RED, 'LEAD STORY  \u2022  SHENZHEN, CHINA  \u2022  APEC SIDELINES');
  drawText(hx + 24, hy + 52, 5, INK, 'THREE POWERS,');
  drawText(hx + 24, hy + 92, 5, INK, 'ONE TABLE');
  drawWrapped(
    hx + 24,
    hy + 146,
    2,
    INK,
    'TRUMP, XI AND PUTIN HOLD THE FIRST-EVER TRILATERAL SUMMIT AND ISSUE A JOINT DECLARATION: DIALOGUE ON NUCLEAR RISKS, AND STABLE ENERGY FLOWS.',
    560,
    3,
  );
  drawText(hx + 24, hy + 252, 2, GREY, 'UKRAINE AND IRAN DISCUSSED. NO DEAL ON EITHER.');

  // Globe + the three flags on the right of the hero.
  drawGlobe(852, hy + 108, 78);
  drawFlagUSA(716, hy + 216, 72, 48);
  drawFlagChina(800, hy + 216, 72, 48);
  drawFlagRussia(884, hy + 216, 72, 48);
  drawTextCentered(752, hy + 272, 2, GREY, 'USA');
  drawTextCentered(836, hy + 272, 2, GREY, 'CHINA');
  drawTextCentered(920, hy + 272, 2, GREY, 'RUSSIA');

  // Row 2: justice, bridge, Gaza.
  const rowY = 464;
  const rowH = 224;
  const pw = 316;
  const gap = 14;
  drawPanel(24, rowY, pw, rowH, NAVY, 'THE HAGUE \u2022 JUSTICE', 'MYANMAR GUILTY OF GENOCIDE', 'ICJ FINDS GENOCIDAL INTENT IN THE 2017 CRACKDOWN. 10,000 KILLED.', (cx, cy) => drawScales(cx, cy, 1));
  drawPanel(24 + pw + gap, rowY, pw, rowH, RED, 'UKRAINE \u2022 WAR', 'KERCH BRIDGE HIT A 3RD TIME', 'UKRAINE HALTS RAIL TRAFFIC ON THE CRIMEA BRIDGE. THIRD IN A WEEK.', (cx, cy) => drawBridge(cx, cy, 1));
  drawPanel(24 + 2 * (pw + gap), rowY, pw, rowH, ORANGE, 'GAZA \u2022 CEASEFIRE', 'ISRAELI TANKS CROSS THE LINE', 'OPERATION NEAR NUSEIRAT. HAMAS: CEASEFIRE VIOLATION.', (cx, cy) => drawTank(cx, cy, 1));

  // Row 3: Gulf, IPO, cyclone.
  const rowY2 = 702;
  drawPanel(24, rowY2, pw, rowH, RED, 'THE GULF \u2022 ESCALATION', 'US STRIKES IRAN, GULF HIT BACK', 'US HITS QESHM. IRAN HITS KUWAIT, BAHRAIN. HOUTHIS HIT RIYADH TOWER.', (cx, cy) => drawFlame(cx, cy, 1));
  drawPanel(24 + pw + gap, rowY2, pw, rowH, GREEN, 'MARKETS \u2022 TECH', 'ANTHROPIC IPO SMASHES RECORDS', '$83 A SHARE. ABOUT $81 BILLION RAISED IN THE BIGGEST AI LISTING YET.', (cx, cy) => drawChart(cx, cy, 1));
  drawPanel(24 + 2 * (pw + gap), rowY2, pw, rowH, BLUE, 'CLIMATE \u2022 WEATHER', 'CYCLONE AKVAN NEARS INDIA', 'LANDFALL DUE ON THE ANDHRA-ODISHA COAST AS COP31 TALKS END.', (cx, cy) => drawCyclone(cx, cy, 1));

  // Footer strip.
  drawTextCentered(512, 946, 2, INK, 'ALSO: IAEA \u2014 N. KOREA EXPANDS URANIUM ENRICHMENT  \u2022  BOAT SINKS OFF SENEGAL');
  drawTextCentered(512, 968, 2, INK, 'UNREST IN BANGLADESH  \u2022  PLANE CRASH KILLS 19  \u2022  DENMARK BACKS GREENLAND DEAL');
  drawTextCentered(512, 994, 2, GREY, 'SOURCES: AP \u2022 REUTERS \u2022 BBC \u2022 DPA');
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder: 8-bit RGB, filter 0, zlib deflate, correct CRC32.
// No ancillary chunks, so the bytes depend only on the pixels.
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function encodePNG(): Uint8Array {
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(buf.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, W);
  v.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------

function main(): void {
  drawPage();
  const png = encodePNG();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
  console.log(`wrote entry.png: ${png.length} bytes, ${W}x${H}`);
}

main();
