import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LOODY_L_PATHS, LOODY_L_VIEWBOX } from '../src/shared/logoGeometry';

const publicDir = path.resolve(process.cwd(), 'public');
fs.mkdirSync(publicDir, { recursive: true });

// 1. Write public/icon.svg using exact shared Concept A geometry
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOODY_L_VIEWBOX}" width="512" height="512">
  <defs>
    <radialGradient id="loodyBg" cx="50%" cy="40%" r="70%">
      <stop offset="0%" stop-color="#0d1b15"/>
      <stop offset="100%" stop-color="#050706"/>
    </radialGradient>
    <linearGradient id="loodyFront" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="48%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="loodyDepth" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#065f46"/>
      <stop offset="100%" stop-color="#022c22"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#loodyBg)"/>
  <path d="${LOODY_L_PATHS.stemRightWall}" fill="url(#loodyDepth)"/>
  <path d="${LOODY_L_PATHS.footTopShelf}" fill="#059669"/>
  <path d="${LOODY_L_PATHS.footRightWall}" fill="url(#loodyDepth)"/>
  <path d="${LOODY_L_PATHS.bottomWall}" fill="#022c22"/>
  <path d="${LOODY_L_PATHS.frontFace}" fill="url(#loodyFront)"/>
  <path d="${LOODY_L_PATHS.neonEdgeHighlight}" fill="none" stroke="#6ee7b7" stroke-width="1.3" stroke-linejoin="miter"/>
</svg>
`;
fs.writeFileSync(path.join(publicDir, 'icon.svg'), iconSvg, 'utf8');

// 2. Pure Node PNG encoder using zlib to rasterize the exact same Concept A L geometry
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pointInPolygon(px: number, py: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function renderLoodyIconPng(size: number, safePaddingRatio: number): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  // Polygons matching LOODY_L_PATHS on 100x100 grid:
  // frontFace: M 24 14 H 44 V 60 H 74 V 80 H 24 Z
  const frontPoly: Array<[number, number]> = [
    [24, 14], [44, 14], [44, 60], [74, 60], [74, 80], [24, 80],
  ];
  const stemRightPoly: Array<[number, number]> = [
    [44, 14], [51, 20], [51, 66], [44, 60],
  ];
  const footTopPoly: Array<[number, number]> = [
    [44, 60], [51, 66], [81, 66], [74, 60],
  ];
  const footRightPoly: Array<[number, number]> = [
    [74, 60], [81, 66], [81, 86], [74, 80],
  ];
  const bottomPoly: Array<[number, number]> = [
    [24, 80], [31, 86], [81, 86], [74, 80],
  ];

  // Transform 100x100 into safe zone
  const mapCoord = (v: number) => {
    const innerScale = 1 - safePaddingRatio * 2;
    return (v / size - safePaddingRatio) / innerScale * 100;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 2x2 supersampling for crisp edges
      let rAcc = 0, gAcc = 0, bAcc = 0;
      const samples = [
        [x + 0.25, y + 0.25],
        [x + 0.75, y + 0.25],
        [x + 0.25, y + 0.75],
        [x + 0.75, y + 0.75],
      ];
      for (const [sx, sy] of samples) {
        const nx = mapCoord(sx);
        const ny = mapCoord(sy);

        // Background radial obsidian glow
        const dx = (sx / size - 0.5) * 2;
        const dy = (sy / size - 0.42) * 2;
        const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy));
        let r = Math.round(13 * (1 - dist) + 5 * dist);
        let g = Math.round(27 * (1 - dist) + 7 * dist);
        let b = Math.round(21 * (1 - dist) + 6 * dist);

        if (pointInPolygon(nx, ny, frontPoly)) {
          const t = Math.min(1, Math.max(0, (nx - 24 + (ny - 14)) / 116));
          r = Math.round(52 * (1 - t) + 4 * t);
          g = Math.round(211 * (1 - t) + 120 * t);
          b = Math.round(153 * (1 - t) + 87 * t);
          // Subtle neon edge highlight along left & top rim
          if ((nx >= 24 && nx <= 25.3) || (ny >= 14 && ny <= 15.3 && nx <= 44) || (ny >= 60 && ny <= 61.3 && nx >= 44)) {
            r = 110; g = 231; b = 183;
          }
        } else if (pointInPolygon(nx, ny, footTopPoly)) {
          r = 5; g = 150; b = 105;
        } else if (pointInPolygon(nx, ny, stemRightPoly) || pointInPolygon(nx, ny, footRightPoly)) {
          r = 4; g = 78; b = 56;
        } else if (pointInPolygon(nx, ny, bottomPoly)) {
          r = 2; g = 44; b = 34;
        }
        rAcc += r; gAcc += g; bAcc += b;
      }
      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(rAcc / 4);
      rgba[idx + 1] = Math.round(gAcc / 4);
      rgba[idx + 2] = Math.round(bAcc / 4);
      rgba[idx + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

fs.writeFileSync(path.join(publicDir, 'pwa-192x192.png'), renderLoodyIconPng(192, 0.04));
fs.writeFileSync(path.join(publicDir, 'pwa-512x512.png'), renderLoodyIconPng(512, 0.04));
fs.writeFileSync(path.join(publicDir, 'pwa-maskable-512x512.png'), renderLoodyIconPng(512, 0.16));
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), renderLoodyIconPng(180, 0.06));

console.log('Generated LOODY official Concept A icons in public/.');
