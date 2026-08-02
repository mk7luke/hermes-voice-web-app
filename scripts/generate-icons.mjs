/**
 * Generates the PWA icon set as PNGs with no image dependencies.
 *
 * Encodes PNG by hand (IHDR / IDAT / IEND with zlib deflate). This keeps a
 * binary asset reproducible from source rather than committed as an opaque
 * blob, and avoids pulling a canvas or image library into a project that
 * otherwise needs neither.
 *
 *   node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../client/public/icons');

const BG = [11, 13, 16]; // --bg
const ACCENT = [94, 234, 212]; // --accent

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Draw the mark: a filled circle with a vertical "microphone" capsule.
 * `inset` shrinks the artwork for maskable variants, whose outer ~10% may be
 * cropped to whatever shape the launcher prefers.
 */
function render(size, inset) {
  const centre = size / 2;
  const radius = (size / 2) * (1 - inset);

  const capsuleWidth = radius * 0.42;
  const capsuleTop = centre - radius * 0.52;
  const capsuleBottom = centre + radius * 0.08;
  const capsuleRadius = capsuleWidth / 2;

  const stemTop = capsuleBottom;
  const stemBottom = centre + radius * 0.46;
  const stemWidth = radius * 0.09;

  const baseY = stemBottom;
  const baseWidth = radius * 0.5;

  const rows = [];
  for (let y = 0; y < size; y += 1) {
    // Filter byte 0 (None) per scanline.
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const dx = x - centre;
      const dy = y - centre;

      let colour = BG;
      const insideDisc = dx * dx + dy * dy <= radius * radius;

      if (insideDisc) {
        colour = [20, 24, 29];

        // Microphone capsule: a rectangle with rounded caps.
        const withinCapsuleX = Math.abs(dx) <= capsuleRadius;
        const withinCapsuleY = y >= capsuleTop && y <= capsuleBottom;
        const inCapsuleBody =
          withinCapsuleX && y >= capsuleTop + capsuleRadius && y <= capsuleBottom - capsuleRadius;
        const inTopCap =
          dx * dx + (y - (capsuleTop + capsuleRadius)) ** 2 <= capsuleRadius * capsuleRadius;
        const inBottomCap =
          dx * dx + (y - (capsuleBottom - capsuleRadius)) ** 2 <= capsuleRadius * capsuleRadius;

        if ((withinCapsuleX && withinCapsuleY && inCapsuleBody) || inTopCap || inBottomCap) {
          colour = ACCENT;
        }

        // Stem.
        if (Math.abs(dx) <= stemWidth / 2 && y >= stemTop && y <= stemBottom) {
          colour = ACCENT;
        }

        // Base bar.
        if (Math.abs(dx) <= baseWidth / 2 && y >= baseY && y <= baseY + stemWidth) {
          colour = ACCENT;
        }
      }

      const offset = 1 + x * 3;
      row[offset] = colour[0];
      row[offset + 1] = colour[1];
      row[offset + 2] = colour[2];
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, inset: 0 },
  { name: 'icon-512.png', size: 512, inset: 0 },
  // Maskable icons need padding so launcher-applied crops do not clip the mark.
  { name: 'icon-512-maskable.png', size: 512, inset: 0.18 },
];

for (const { name, size, inset } of targets) {
  writeFileSync(join(OUT_DIR, name), render(size, inset));
  process.stdout.write(`wrote ${name} (${size}x${size})\n`);
}
