// Minimal QR Code generator (byte mode, error-correction level M, versions 1–15) → boolean matrix / SVG.
// Follows ISO/IEC 18004; structure inspired by the public-domain approach of Project Nayuki's reference design.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const MAX_VER = 15;

const rawModules = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v];

// GF(256) arithmetic with polynomial 0x11D
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gmul(poly[j], EXP[i]); }
    poly = next;
  }
  return poly.slice(1); // leading coefficient is 1
}
function rsRemainder(data, gen) {
  const rem = new Array(gen.length).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift(); rem.push(0);
    for (let i = 0; i < gen.length; i++) rem[i] ^= gmul(gen[i], f);
  }
  return rem;
}

function alignPositions(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2, size = v * 4 + 17;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const res = [6];
  for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
  return res;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= MAX_VER; ver++) if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  if (ver > MAX_VER) throw new Error('Text too long for QR code');
  const size = ver * 4 + 17;

  // ---- data bits ----
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach(b => put(b, 8));
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // ---- error correction + interleave ----
  const nb = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = nb - raw % nb, shortLen = Math.floor(raw / nb) - eccLen, gen = rsGenerator(eccLen);
  const blocks = []; let k = 0;
  for (let i = 0; i < nb; i++) {
    const len = shortLen + (i < shortBlocks ? 0 : 1);
    const d = data.slice(k, k + len); k += len;
    blocks.push({ d, e: rsRemainder(d, gen) });
  }
  const codewords = [];
  for (let i = 0; i <= shortLen; i++) for (let j = 0; j < nb; j++) if (i < blocks[j].d.length) codewords.push(blocks[j].d[i]);
  for (let i = 0; i < eccLen; i++) for (let j = 0; j < nb; j++) codewords.push(blocks[j].e[i]);

  // ---- function patterns ----
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignPositions(ver);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = mask => {
    const d = (0 << 3) | mask; // ECC level M has format bits 00
    let rem = d; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412, bit = i => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i)); set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const bit = ((v >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b, bit); set(b, a, bit); }
  }

  // ---- place codewords (zig-zag) ----
  const all = []; for (const c of codewords) for (let i = 7; i >= 0; i--) all.push((c >>> i) & 1);
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && idx < all.length) m[y][x] = all[idx++] === 1;
    }
  }

  // ---- masking: pick the lowest-penalty pattern ----
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0, (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const penalty = g => {
    let p = 0;
    const lineScore = get => { for (let a = 0; a < size; a++) { let run = 1, hist = []; for (let b = 1; b <= size; b++) { if (b < size && get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) p += 3 + run - 5; hist.push(run); run = 1; } } } };
    lineScore((a, b) => g[a][b]); lineScore((a, b) => g[b][a]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (g[y][x] === g[y][x + 1] && g[y][x] === g[y + 1][x] && g[y][x] === g[y + 1][x + 1]) p += 3;
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], rev = [...pat].reverse();
    const scan = get => { for (let a = 0; a < size; a++) for (let b = 0; b + 11 <= size; b++) { let f = true, r = true; for (let i = 0; i < 11; i++) { const v = get(a, b + i) ? 1 : 0; if (v !== pat[i]) f = false; if (v !== rev[i]) r = false; } if (f) p += 40; if (r) p += 40; } };
    scan((a, b) => g[a][b]); scan((a, b) => g[b][a]);
    const dark = g.flat().filter(Boolean).length, total = size * size;
    p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10 - 0;
    return p;
  };
  let best = null, bestPen = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row, y) => row.map((v, x) => (!fn[y][x] && MASKS[mask](x, y) ? !v : v)));
    // temporarily draw format info for this mask so the penalty sees it
    const saved = m.map(r => [...r]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y][x] = g[y][x];
    drawFormat(mask);
    const result = m.map(r => [...r]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y][x] = saved[y][x];
    const pen = penalty(result);
    if (pen < bestPen) { bestPen = pen; best = result; }
  }
  return best;
}

export function qrSvg(text, { scale = 5, quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const mx = qrMatrix(text), n = mx.length, dim = (n + quiet * 2) * scale;
  let path = '';
  mx.forEach((row, y) => row.forEach((v, x) => { if (v) path += `M${(x + quiet) * scale} ${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
