// Draws the home-screen / install icons into public/ as PNGs (plus an SVG
// for browsers that take one). No image library needed: each pixel is
// shaded from distance fields of the same calendar-with-tick glyph as the
// Attendance nav icon (src/icons.jsx), with a little anti-aliasing.
//
//   node scripts/generateAppIcons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');
const TOP = [0x1d, 0x9c, 0x89];
const BOTTOM = [0x14, 0x7d, 0x6e];

// ------------------------------------------------------------------ geometry (24×24 glyph units)

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundBoxDist(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance from a point to the glyph's centre-line.
function glyphDist(x, y) {
  return Math.min(
    Math.abs(roundBoxDist(x, y, 3, 4, 18, 17, 2.5)),
    segDist(x, y, 8, 2.5, 8, 5.5),
    segDist(x, y, 16, 2.5, 16, 5.5),
    segDist(x, y, 3, 9.5, 21, 9.5),
    segDist(x, y, 8.5, 15, 10.8, 17.3),
    segDist(x, y, 10.8, 17.3, 15.5, 13)
  );
}

// ------------------------------------------------------------------ raster

// maskable: full-bleed square with the glyph inside the 80% safe zone.
// Otherwise a rounded tile on a transparent background.
function render(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const glyphScale = size * (maskable ? 0.5 : 0.58) / 24; // pixels per glyph unit
  const offset = (size - 24 * glyphScale) / 2;
  const stroke = 2.1;
  const tileRadius = size * 0.22;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const cx = i + 0.5;
      const cy = j + 0.5;
      // Background coverage
      let bg = 1;
      if (!maskable) {
        const d = roundBoxDist(cx, cy, 0, 0, size, size, tileRadius);
        bg = Math.max(0, Math.min(1, 0.5 - d));
      }
      const t = j / (size - 1);
      const r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
      const g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
      const b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;

      const gx = (cx - offset) / glyphScale;
      const gy = (cy - offset) / glyphScale;
      const dPx = (glyphDist(gx, gy) - stroke / 2) * glyphScale;
      const ink = Math.max(0, Math.min(1, 0.5 - dPx));

      const o = (j * size + i) * 4;
      px[o] = Math.round(r + (255 - r) * ink);
      px[o + 1] = Math.round(g + (255 - g) * ink);
      px[o + 2] = Math.round(b + (255 - b) * ink);
      px[o + 3] = Math.round(255 * bg);
    }
  }
  return px;
}

// ------------------------------------------------------------------ PNG encoding

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------------ output

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D9C89"/><stop offset="1" stop-color="#147D6E"/></linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <g transform="translate(12.5 12.5) scale(1.625)" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M8 2.5v3M16 2.5v3M3 9.5h18M8.5 15l2.3 2.3L15.5 13"/>
  </g>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }] // iOS rounds the corners itself
];
for (const [name, size, opts] of files) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size, opts)));
  console.log(`wrote public/${name}`);
}
fs.writeFileSync(path.join(OUT, 'icon.svg'), SVG);
console.log('wrote public/icon.svg');
