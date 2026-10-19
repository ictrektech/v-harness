/**
 * Generate the VOS app icon: a dark rounded square with a light "V" glyph.
 *
 * Kept as a script rather than a binary so the mark stays reproducible and can
 * be replaced wholesale when a designer supplies the official artwork.
 *
 *   node ictrek.app/scripts/gen-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 256;
const SAMPLES = 4;
const BACKGROUND = [16, 19, 26];
const FOREGROUND = [245, 247, 250];
const RADIUS = 56;
const STROKE = 19;

const here = dirname(fileURLToPath(import.meta.url));

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Distance from a point to a segment.
 * @returns {number}
 */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Signed distance to a rounded rectangle; negative inside.
 * @returns {number}
 */
function roundedRectDistance(px, py, left, top, right, bottom, radius) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const halfWidth = (right - left) / 2 - radius;
  const halfHeight = (bottom - top) / 2 - radius;
  const qx = Math.abs(px - centerX) - halfWidth;
  const qy = Math.abs(py - centerY) - halfHeight;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/** Glyph geometry: a symmetric V with round caps. */
const GLYPH = [
  [78, 72, 128, 184],
  [128, 184, 178, 72],
];

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const step = 1 / SAMPLES;

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let background = 0;
    let foreground = 0;
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const px = x + (sx + 0.5) * step;
        const py = y + (sy + 0.5) * step;
        if (roundedRectDistance(px, py, 0, 0, SIZE, SIZE, RADIUS) > 0) continue;
        background += 1;
        const near = GLYPH.some(([ax, ay, bx, by]) => segmentDistance(px, py, ax, ay, bx, by) <= STROKE / 2);
        if (near) foreground += 1;
      }
    }
    const total = SAMPLES * SAMPLES;
    const index = (y * SIZE + x) * 4;
    const coverage = background / total;
    if (coverage === 0) continue;
    const mix = foreground / Math.max(background, 1);
    pixels[index] = Math.round(BACKGROUND[0] + (FOREGROUND[0] - BACKGROUND[0]) * mix);
    pixels[index + 1] = Math.round(BACKGROUND[1] + (FOREGROUND[1] - BACKGROUND[1]) * mix);
    pixels[index + 2] = Math.round(BACKGROUND[2] + (FOREGROUND[2] - BACKGROUND[2]) * mix);
    pixels[index + 3] = Math.round(255 * coverage);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;
header[10] = 0;
header[11] = 0;
header[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = join(here, '..', 'src', 'icon.png');
writeFileSync(target, png, { mode: 0o644 });
console.log(`wrote ${target} (${String(png.length)} bytes)`);
