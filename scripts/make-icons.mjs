// Draws the app icons (PNG) without image libraries: a blue rounded square with a white
// task-list mark and a violet "agent" dot. Run: node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BLUE = [43, 111, 235];
const WHITE = [255, 255, 255];
const VIOLET = [112, 71, 235];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// Signed distances (negative = inside), in unit coordinates.
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

function draw(size, { fullBleed }) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4; // supersampling
  // Mark geometry within the unit square; maskable icons keep it inside the 80% safe zone.
  const k = fullBleed ? 0.78 : 1;
  const m = (v) => 0.5 + (v - 0.5) * k;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
      let col = null, a = 0;
      const bg = fullBleed ? -1 : rrect(x, y, 0.5, 0.5, 0.5, 0.5, 0.225);
      if (bg <= 0) { col = BLUE; a = 1; }
      // three task rows: checkbox + bar
      for (let i = 0; i < 3; i++) {
        const cy = m(0.33 + i * 0.17);
        if (rrect(x, y, m(0.3), cy, 0.05 * k, 0.05 * k, 0.018 * k) <= 0) col = WHITE;
        const w = i === 1 ? 0.17 : 0.22;
        if (rrect(x, y, m(0.39 + w), cy, w * k, 0.034 * k, 0.034 * k) <= 0) col = WHITE;
      }
      // agent dot on the middle row
      if (circle(x, y, m(0.75), m(0.5), 0.065 * k) <= 0) col = VIOLET;
      if (circle(x, y, m(0.75), m(0.5), 0.065 * k) <= 0.012 * k && circle(x, y, m(0.75), m(0.5), 0.065 * k) > 0) col = WHITE;
      if (col) { acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255 * a; }
    }
    const n = S * S, i4 = (py * size + px) * 4, alpha = acc[3] / n;
    const cov = alpha / 255 || 1;
    buf[i4] = Math.round(acc[0] / n / cov); buf[i4 + 1] = Math.round(acc[1] / n / cov); buf[i4 + 2] = Math.round(acc[2] / n / cov); buf[i4 + 3] = Math.round(alpha);
  }
  return png(size, buf);
}

const out = new URL("../public/icons/", import.meta.url);
for (const [name, size, opts] of [
  ["icon-192.png", 192, { fullBleed: false }],
  ["icon-512.png", 512, { fullBleed: false }],
  ["maskable-512.png", 512, { fullBleed: true }],
  ["apple-touch-icon.png", 180, { fullBleed: true }],
  ["favicon-32.png", 32, { fullBleed: false }],
]) {
  writeFileSync(new URL(name, out), draw(size, opts));
  console.log("wrote", name);
}
