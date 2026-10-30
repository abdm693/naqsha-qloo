/**
 * Procedural texture generators. Each returns sRGB albedo (RGBA8), a height field (→ normal map) and an
 * optional roughness field, all tileable. Sizes are chosen by the caller (512–1024).
 */
import { clamp, rng, smoothstep } from "../core/util";
import { hash2, jitter, mix, mul, sampler, table, type RGB } from "./noise";

export interface TexData {
  N: number;
  albedo: Uint8Array;
  height: Float32Array | null;
  rough: Float32Array | null;
}

export type GenParams = Record<string, number | string | boolean | undefined>;
export type Gen = (N: number, base: RGB, seed: number, p: GenParams) => TexData;

function alloc(N: number, height = true, rough = false): TexData {
  return {
    N,
    albedo: new Uint8Array(N * N * 4),
    height: height ? new Float32Array(N * N) : null,
    rough: rough ? new Float32Array(N * N) : null,
  };
}

function put(d: TexData, i: number, r: number, g: number, b: number): void {
  const k = i << 2;
  d.albedo[k] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
  d.albedo[k + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
  d.albedo[k + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
  d.albedo[k + 3] = 255;
}

const pnum = (p: GenParams, k: string, d: number): number => (typeof p[k] === "number" ? (p[k] as number) : d);

// ── plaster / paint (grayscale, tinted by material.color) ─────────────────────────────────────────────
const plaster: Gen = (N, _base, seed, p) => {
  const d = alloc(N, true, true);
  const B = sampler(table(seed + 1), N), C = sampler(table(seed + 2), N), E = sampler(table(seed + 3, "ridged"), N);
  const trowel = pnum(p, "trowel", 1);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const mid = B(x, y, 6), fine = C(x, y, 24), sweep = E(x, y, 3, 5);
      const grain = hash2(x, y, seed) - 0.5;
      // very low contrast so large walls never show a tiling grid
      const v = 0.965 + 0.008 * (mid - 0.5) + 0.01 * (fine - 0.5) + 0.01 * grain - 0.012 * trowel * Math.max(0, sweep - 0.82);
      put(d, i, v, v, v);
      d.height![i] = fine * 0.45 + grain * 0.25 + trowel * 0.35 * (mid - 0.5) + trowel * 0.25 * Math.max(0, sweep - 0.8);
      d.rough![i] = 0.55 + 0.25 * (mid - 0.5) + 0.12 * (fine - 0.5);
    }
  return d;
};

// ── split-face ledgestone / slate (rows of irregular stones) ──────────────────────────────────────────
const ledgestone: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const r = rng(seed);
  const sizeMM = pnum(p, "size_mm", 1200);
  const mm = sizeMM / N;
  const rowMin = pnum(p, "rowMin", 30) / mm, rowMax = pnum(p, "rowMax", 95) / mm;
  const lenMin = pnum(p, "lenMin", 120) / mm, lenMax = pnum(p, "lenMax", 480) / mm;
  const joint = pnum(p, "joint", 6) / mm;
  const strataK = pnum(p, "strata", 1);
  const dark = pnum(p, "dark", 0);
  const palette: RGB[] = [
    base,
    mix(base, [0.36, 0.36, 0.37], 0.45),
    mix(base, [0.78, 0.76, 0.72], 0.35),
    mix(base, [0.55, 0.47, 0.38], 0.4),
    mix(base, [0.28, 0.29, 0.31], 0.5 + dark * 0.3),
    mix(base, [0.62, 0.52, 0.42], 0.55),
  ];
  const weights = [0.32, 0.2, 0.16, 0.12, 0.12, 0.08];
  const pick = (): RGB => {
    let t = r();
    for (let k = 0; k < palette.length; k++) {
      if ((t -= weights[k]) <= 0) return jitter(palette[k], r, 0.1, 0.04);
    }
    return palette[0];
  };
  // rows
  const rowStart: number[] = [], rowH: number[] = [];
  let y0 = 0;
  while (y0 < N) {
    let h = rowMin + (rowMax - rowMin) * Math.pow(r(), 1.3);
    if (N - (y0 + h) < rowMin) h = N - y0;
    rowStart.push(y0);
    rowH.push(h);
    y0 += h;
  }
  const rowOf = new Int32Array(N);
  for (let k = 0; k < rowStart.length; k++) for (let y = Math.floor(rowStart[k]); y < Math.min(N, Math.ceil(rowStart[k] + rowH[k])); y++) rowOf[y] = k;
  // stones per row
  const rows = rowStart.map(() => {
    const off = r() * N;
    const starts: number[] = [];
    let x = 0;
    while (x < N) {
      starts.push(x);
      let len = lenMin + (lenMax - lenMin) * r();
      if (N - (x + len) < lenMin * 0.6) len = N - x;
      x += len;
    }
    const ends = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : N));
    const of = new Int32Array(N);
    for (let k = 0; k < starts.length; k++) for (let xx = Math.floor(starts[k]); xx < Math.min(N, Math.ceil(ends[k])); xx++) of[xx] = k;
    const col = starts.map(() => pick());
    const hoff = starts.map(() => r());
    const so = starts.map(() => r() * 256);
    return { off, starts, ends, of, col, hoff, so };
  });
  const S1 = sampler(table(seed + 7), N), S2 = sampler(table(seed + 8), N), S3 = sampler(table(seed + 9, "ridged"), N);
  const bevel = joint * 1.6 + 1.5;
  for (let y = 0; y < N; y++) {
    const rk = rowOf[y];
    const row = rows[rk];
    const yy = y + 0.5 - rowStart[rk];
    const dy = Math.min(yy, rowH[rk] - yy);
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let xs = x + 0.5 + row.off;
      if (xs >= N) xs -= N;
      const k = row.of[Math.min(N - 1, xs | 0)];
      const dx = Math.min(xs - row.starts[k], row.ends[k] - xs);
      const wob = (S2(x, y, 8) - 0.5) * joint * 0.9;
      const edge = Math.min(dx, dy) - wob;
      const jh = joint * 0.5;
      if (edge < jh) {
        const m = 0.14 + 0.06 * S1(x, y, 16);
        const c = mul(base, m);
        put(d, i, c[0], c[1], c[2]);
        d.height![i] = 0.02 + 0.05 * S1(x, y, 8);
        d.rough![i] = 0.95;
        continue;
      }
      const so = row.so[k];
      const strata = S1(x, y, 1, 12, so, so * 0.7);
      const ridge = S3(x, y, 2, 10, so * 1.3, so);
      const grain = S2(x, y, 16, 16, so, so);
      const b = smoothstep(jh, jh + bevel, edge);
      const h = (0.5 + 0.28 * row.hoff[k] + strataK * 0.16 * (strata - 0.5) + 0.12 * (ridge - 0.5) + 0.07 * (grain - 0.5)) * (0.35 + 0.65 * b);
      d.height![i] = h;
      const shade = (0.8 + strataK * 0.32 * (strata - 0.5) + 0.12 * (ridge - 0.5) + 0.08 * (grain - 0.5)) * (0.72 + 0.28 * b);
      const c = row.col[k];
      put(d, i, c[0] * shade, c[1] * shade, c[2] * shade);
      d.rough![i] = 0.78 + 0.18 * (1 - ridge);
    }
  }
  return d;
};

// ── ashlar blocks (travertine) ────────────────────────────────────────────────────────────────────────
const travertine: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const cols = pnum(p, "cols", 2), rowsN = pnum(p, "rows", 4);
  const bw = N / cols, bh = N / rowsN;
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 3), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const row = Math.floor(y / bh);
      const off = row % 2 ? bw / 2 : 0;
      const xs = (x + off) % N;
      const col = Math.floor(xs / bw);
      const lu = xs - col * bw, lv = y - row * bh;
      const e = Math.min(lu, bw - lu, lv, bh - lv);
      const hb = hash2(col, row, seed);
      const streak = S1(x, y, 1, 14, hb * 200, 0);
      const fine = S2(x, y, 6, 30);
      const pit = S2(x, y, 24, 24, 50, 50);
      let tone = 0.93 + 0.1 * (streak - 0.5) + 0.05 * (fine - 0.5) + (hb - 0.5) * 0.08;
      let h = 0.8 + 0.05 * fine;
      if (pit > 0.72) {
        tone *= 0.82;
        h = 0.45;
      }
      const c = mix(base, mul(base, 0.86), clamp((streak - 0.4) * 1.5, 0, 1));
      if (e < 1.2) {
        put(d, i, c[0] * 0.78, c[1] * 0.78, c[2] * 0.78);
        d.height![i] = 0.3;
        d.rough![i] = 0.9;
        continue;
      }
      put(d, i, c[0] * tone, c[1] * tone, c[2] * tone);
      d.height![i] = h;
      d.rough![i] = 0.42 + 0.15 * (1 - fine);
    }
  return d;
};

// ── brick (running bond) ──────────────────────────────────────────────────────────────────────────────
const brick: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const cols = pnum(p, "cols", 4), rowsN = pnum(p, "rows", 10);
  const jointK = pnum(p, "joint", 0.08); // fraction of pitch
  const mortar: RGB = (p.mortar as string) ? hexToRGB(p.mortar as string) : [0.72, 0.7, 0.66];
  const recess = pnum(p, "recess", 1);
  const pw = N / cols, ph = N / rowsN;
  const jw = pw * jointK * 0.45, jh = ph * jointK * 1.1;
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 5), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const row = Math.floor(y / ph);
      const off = row % 2 ? pw / 2 : 0;
      const xs = (x + off) % N;
      const col = Math.floor(xs / pw);
      const lu = xs - col * pw, lv = y - row * ph;
      const wob = (S2(x, y, 16) - 0.5) * 1.2;
      const e = Math.min(lu - jw + wob, pw - lu + wob, lv - jh + wob, ph - lv + wob);
      const hb = hash2(col + 17, row * 7, seed);
      if (e < 0) {
        const t = 0.9 + 0.12 * (S1(x, y, 24) - 0.5);
        put(d, i, mortar[0] * t, mortar[1] * t, mortar[2] * t);
        d.height![i] = 0.55 - 0.45 * recess;
        d.rough![i] = 0.95;
        continue;
      }
      const burnt = hb > 0.86 ? 0.62 : hb < 0.12 ? 1.12 : 1;
      const c = jitter(base, rng((col * 131 + row * 977 + seed) | 0), 0.1, 0.05);
      const sp = S1(x, y, 12, 12, hb * 99, hb * 99);
      const tone = burnt * (0.86 + 0.24 * (sp - 0.5)) * (0.9 + 0.1 * smoothstep(0, 2.5, e));
      put(d, i, c[0] * tone, c[1] * tone, c[2] * tone);
      d.height![i] = 0.8 + 0.12 * sp * smoothstep(0, 3, e);
      d.rough![i] = 0.82 + 0.1 * sp;
    }
  return d;
};

// ── standing-seam metal roofing: raised seams running up the slope ──────────────────────────────────────
const seams: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const cols = pnum(p, "cols", 3);
  const pw = N / cols;
  const S1 = sampler(table(seed), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const e = Math.abs(((x + pw / 2) % pw) - pw / 2);
      const seam = 1 - smoothstep(1.5, 4.5, e);
      const t = 0.97 + 0.06 * (S1(x, y, 40) - 0.5) + 0.05 * seam;
      put(d, i, base[0] * t, base[1] * t, base[2] * t);
      d.height![i] = 0.5 + 0.5 * seam;
      d.rough![i] = 0.42;
    }
  return d;
};

// ── fair-faced concrete with pores, formwork joints and tie holes ─────────────────────────────────────
const concrete: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N), S3 = sampler(table(seed + 2), N);
  const panels = pnum(p, "panels", 2);
  const ties = p.ties !== false;
  const pw = N / panels;
  const tie = N / (panels * 2);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const low = S1(x, y, 1), mid = S2(x, y, 6), fine = S3(x, y, 24);
      let tone = 0.92 + 0.12 * (low - 0.5) + 0.06 * (mid - 0.5) + 0.04 * (fine - 0.5);
      let h = 0.6 + 0.1 * fine;
      const pore = hash2(x, y, seed + 9);
      if (pore > 0.996) {
        tone *= 0.55;
        h = 0.3;
      }
      if (panels > 0) {
        const lu = x % pw, lv = y % (pw / 2);
        if (lu < 1 || lv < 1) {
          tone *= 0.8;
          h = 0.4;
        }
        if (ties) {
          const tx = (x % tie) - tie / 2, ty = (y % tie) - tie / 2;
          const rr = tx * tx + ty * ty;
          if (rr < 9) {
            tone *= 0.55;
            h = 0.25;
          } else if (rr < 20) tone *= 0.9;
        }
      }
      put(d, i, base[0] * tone, base[1] * tone, base[2] * tone);
      d.height![i] = h;
      d.rough![i] = 0.7 + 0.2 * (mid - 0.5) + 0.1 * (fine - 0.5);
    }
  return d;
};

// ── wood grain helpers ────────────────────────────────────────────────────────────────────────────────
function woodColor(base: RGB, rings: number, fiber: number, tone: number): RGB {
  const late = mul(base, 0.62);
  const early = mix(base, [1, 0.92, 0.8], 0.08);
  const c = mix(early, late, rings * 0.75);
  const f = tone * (0.9 + 0.2 * (fiber - 0.5));
  return [c[0] * f, c[1] * f, c[2] * f];
}

/**
 * Joinery veneer grain (along u), rift/quarter-cut look: fine growth lines of varying weight that stay nearly
 * parallel with a slow drift, a soft-rising latewood edge, fibre and colour streaks, and pore dashes (oak).
 * Tileable: the line count per tile is an integer and line weights repeat per tile.
 */
const woodGrain: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const ringF = Math.max(4, Math.round(pnum(p, "rings", 56)));
  const warpA = pnum(p, "warp", 1.6);
  const pores = pnum(p, "pores", 0.5);
  const W1 = sampler(table(seed, "vlow"), N), W2 = sampler(table(seed + 5, "smooth"), N);
  const S2 = sampler(table(seed + 1), N), S3 = sampler(table(seed + 2), N), S4 = sampler(table(seed + 3, "smooth"), N);
  const r = rng(seed ^ 0x5bd1);
  const weight = Float32Array.from({ length: ringF }, () => 0.22 + 0.78 * Math.pow(r(), 1.6));
  const width = Float32Array.from({ length: ringF }, () => 0.14 + 0.24 * r());
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const w = W1(x, y, 1, 1), w2 = W2(x, y, 1, 3);
      const t = (y / N) * ringF + (w - 0.5) * warpA * 2 + (w2 - 0.5) * 0.22;
      const k = Math.floor(t);
      const f = t - k;
      const kk = ((k % ringF) + ringF) % ringF;
      const wd = width[kk];
      const band = smoothstep(1 - wd, 1 - wd * 0.3, f) * (1 - smoothstep(0.965, 1, f));
      const rings = clamp(band * weight[kk] * 0.9, 0, 1);
      const fiber = S2(x, y, 1, 96);
      const streak = S4(x, y, 1, 6);
      const fleck = S3(x, y, 2, 24);
      const pore = pores > 0 && band > 0.15 && hash2(x >> 2, y, seed) > 1 - 0.02 * pores ? 0.74 : 1;
      const c = woodColor(base, rings, fiber, (0.93 + 0.14 * (streak - 0.5) + 0.05 * (fleck - 0.5)) * pore);
      put(d, i, c[0], c[1], c[2]);
      d.height![i] = 0.5 + 0.1 * (fiber - 0.5) - 0.03 * rings - (pore < 1 ? 0.06 : 0);
      d.rough![i] = 0.46 + 0.12 * rings + 0.08 * (fiber - 0.5);
    }
  return d;
};

/** Staggered planks (floors, cladding boards). Planks run along u. */
const planks: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const r = rng(seed);
  const rowsN = pnum(p, "rows", 12);
  const lenMin = pnum(p, "lenMin", 0.35), lenMax = pnum(p, "lenMax", 0.75); // fraction of N
  const gap = pnum(p, "gap", 1.2);
  const ringF = pnum(p, "rings", 9);
  const vary = pnum(p, "vary", 0.12);
  const rh = N / rowsN;
  const rows = Array.from({ length: rowsN }, () => {
    const off = r() * N;
    const starts: number[] = [];
    let x = 0;
    while (x < N) {
      starts.push(x);
      let len = N * (lenMin + (lenMax - lenMin) * r());
      if (N - (x + len) < N * lenMin * 0.5) len = N - x;
      x += len;
    }
    const ends = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : N));
    const of = new Int32Array(N);
    for (let k = 0; k < starts.length; k++) for (let xx = Math.floor(starts[k]); xx < Math.min(N, Math.ceil(ends[k])); xx++) of[xx] = k;
    const col = starts.map(() => jitter(base, r, vary, 0.04));
    const so = starts.map(() => [r() * 256, r() * 256, 0.6 + r() * 0.8] as const);
    return { off, starts, ends, of, col, so };
  });
  const S1 = sampler(table(seed + 11, "vlow"), N), S2 = sampler(table(seed + 12), N), S3 = sampler(table(seed + 13), N);
  for (let y = 0; y < N; y++) {
    const rk = Math.min(rowsN - 1, Math.floor(y / rh));
    const row = rows[rk];
    const lv = y + 0.5 - rk * rh;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let xs = x + 0.5 + row.off;
      if (xs >= N) xs -= N;
      const k = row.of[Math.min(N - 1, xs | 0)];
      const lu = xs - row.starts[k];
      const le = row.ends[k] - xs;
      const e = Math.min(lv, rh - lv, lu * 3, le * 3);
      const [ou, ov, rf] = row.so[k];
      const w = S1(x, y, 1, 2, ou, ov);
      const t = (lv / rh) * ringF * rf + (w - 0.5) * 1.5 + ou * 0.01;
      const s = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
      const rings = Math.pow(s, 3);
      const fiber = S2(x, y, 2, 128, ou, ov);
      const fleck = S3(x, y, 8, 48, ou, ov);
      const c = woodColor(row.col[k], rings, fiber, 0.94 + 0.1 * (fleck - 0.5));
      if (e < gap) {
        put(d, i, c[0] * 0.35, c[1] * 0.35, c[2] * 0.35);
        d.height![i] = 0.1;
        d.rough![i] = 0.9;
        continue;
      }
      const bev = smoothstep(gap, gap + 2.5, e);
      const sh = 0.82 + 0.18 * bev;
      put(d, i, c[0] * sh, c[1] * sh, c[2] * sh);
      d.height![i] = (0.55 + 0.1 * (fiber - 0.5) - 0.06 * rings) * (0.5 + 0.5 * bev);
      d.rough![i] = 0.42 + 0.16 * rings + 0.08 * (fiber - 0.5);
    }
  }
  return d;
};

// ── marble: soft clouds, a few long interrupted veins with a grey halo ─────────────────────────────────
const marble: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const vein: RGB = p.vein ? hexToRGB(p.vein as string) : [0.55, 0.55, 0.57];
  const veinAmt = pnum(p, "veinAmt", 0.8);
  const warpA = pnum(p, "warp", 1.6);
  const slabs = pnum(p, "slabs", 2);
  const cloud = pnum(p, "cloud", 0.07);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N), S3 = sampler(table(seed + 2, "smooth"), N), S4 = sampler(table(seed + 3), N);
  const sw = N / slabs;
  const r = rng(seed);
  const slabP = Array.from({ length: slabs * slabs }, () => ({ ox: r() * 256, oy: r() * 256, a: 0.35 + r() * 0.5, b: 0.8 + r() * 0.6, t: (r() - 0.5) * 0.04, a2: 0.9 + r(), b2: 0.2 + r() * 0.4 }));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const sx = Math.floor(x / sw), sy = Math.floor(y / sw);
      const sp = slabP[sy * slabs + sx];
      const lu = x - sx * sw, lv = y - sy * sw;
      const w1 = S1(x, y, 1, 1, sp.ox, sp.oy), w2 = S2(x, y, 3, 3, sp.oy, sp.ox);
      const t = (lu * sp.a + lv * sp.b) / sw + (w1 - 0.5) * warpA + (w2 - 0.5) * 0.35;
      const s1 = Math.abs(Math.sin(t * Math.PI * 1.35));
      const mask = smoothstep(0.38, 0.62, S3(x, y, 1, 1, sp.ox * 0.5, sp.oy * 0.5));
      const major = (1 - smoothstep(0.0, 0.03 + 0.03 * w2, s1)) * (0.35 + 0.65 * mask);
      const halo = Math.exp(-s1 * 7) * 0.45 * (0.4 + 0.6 * mask);
      const t2 = (lu * sp.b2 - lv * sp.a2) / sw * 1.8 + (w2 - 0.5) * 1.6 + (w1 - 0.5) * 0.6;
      const s2 = Math.abs(Math.sin(t2 * Math.PI * 1.7));
      const minor = (1 - smoothstep(0, 0.018, s2)) * 0.28 * smoothstep(0.45, 0.7, S4(x, y, 2, 2, sp.ox, sp.oy));
      const cl = S4(x, y, 2, 2, sp.oy, sp.ox);
      const v = clamp((major + minor + halo * 0.35) * veinAmt, 0, 1);
      const tone = 1 + cloud * (cl - 0.5) * 2 + sp.t;
      const c = mix(mul(base, tone), vein, v);
      const e = Math.min(lu, sw - lu, lv, sw - lv);
      if (e < 0.8) {
        put(d, i, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9);
        d.height![i] = 0.5;
        d.rough![i] = 0.4;
        continue;
      }
      put(d, i, c[0], c[1], c[2]);
      d.height![i] = 0.9 - v * 0.02;
      d.rough![i] = 0.06 + 0.04 * (cl - 0.5) + v * 0.03;
    }
  return d;
};

// ── tiles (porcelain / ceramic) ───────────────────────────────────────────────────────────────────────
const tiles: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const n = pnum(p, "tiles", 2);
  const grout = pnum(p, "grout", 1.6);
  const groutC: RGB = p.groutColor ? hexToRGB(p.groutColor as string) : mul(base, 0.82);
  const stone = pnum(p, "stone", 0.5);
  const gloss = pnum(p, "gloss", 0.18);
  const tw = N / n;
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N), S3 = sampler(table(seed + 2), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const tx = Math.floor(x / tw), ty = Math.floor(y / tw);
      const lu = x + 0.5 - tx * tw, lv = y + 0.5 - ty * tw;
      const e = Math.min(lu, tw - lu, lv, tw - lv);
      if (e < grout * 0.5) {
        const t = 0.95 + 0.1 * (S3(x, y, 32) - 0.5);
        put(d, i, groutC[0] * t, groutC[1] * t, groutC[2] * t);
        d.height![i] = 0.15;
        d.rough![i] = 0.9;
        continue;
      }
      const hb = hash2(tx, ty, seed);
      const cl = S1(x, y, 2, 2, hb * 100, hb * 50);
      const vein = S2(x, y, 3, 1, hb * 80, 0);
      const veinL = 1 - smoothstep(0.0, 0.05, Math.abs(vein - 0.5));
      const tone = 1 + (hb - 0.5) * 0.04 + stone * (0.06 * (cl - 0.5) - 0.05 * veinL);
      const b = smoothstep(grout * 0.5, grout * 0.5 + 1.5, e);
      put(d, i, base[0] * tone, base[1] * tone, base[2] * tone);
      d.height![i] = 0.6 + 0.3 * b;
      d.rough![i] = gloss + 0.06 * (cl - 0.5);
    }
  return d;
};

// ── terrazzo (canvas-drawn chips) ─────────────────────────────────────────────────────────────────────
const terrazzo: Gen = (N, base, seed) => {
  const d = alloc(N, true, true);
  const cv = makeCanvas(N);
  const g = cv.getContext("2d") as CanvasRenderingContext2D | null;
  const S1 = sampler(table(seed), N);
  const r = rng(seed);
  if (g) {
    g.fillStyle = "#000";
    g.fillRect(0, 0, N, N);
    const chipCols = ["#f4f2ee", "#cfcac2", "#8f8a84", "#3b3936", "#b77a5a", "#d9c4a5", "#93a08f", "#fffdf8"];
    const count = Math.round(N * N * 0.0042);
    for (let k = 0; k < count; k++) {
      const big = r() < 0.12;
      const rad = (big ? 7 + r() * 12 : 1.5 + r() * 5) * (N / 1024);
      const cx = r() * N, cy = r() * N;
      const sides = 5 + Math.floor(r() * 3);
      const col = chipCols[Math.floor(r() * chipCols.length)];
      const pts: [number, number][] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2 + r() * 0.6;
        const rr = rad * (0.55 + r() * 0.6);
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      for (const ox of [-N, 0, N])
        for (const oy of [-N, 0, N]) {
          const px = cx + ox, py = cy + oy;
          if (px < -rad * 2 || px > N + rad * 2 || py < -rad * 2 || py > N + rad * 2) continue;
          g.beginPath();
          pts.forEach(([a, b], s) => (s ? g.lineTo(px + a, py + b) : g.moveTo(px + a, py + b)));
          g.closePath();
          g.fillStyle = col;
          g.fill();
        }
    }
  }
  const img = g ? g.getImageData(0, 0, N, N).data : new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const k = i << 2;
    const x = i % N, y = (i / N) | 0;
    const n = S1(x, y, 16);
    const isChip = img[k] + img[k + 1] + img[k + 2] > 0;
    if (isChip) {
      put(d, i, (img[k] / 255) * (0.96 + 0.06 * n), (img[k + 1] / 255) * (0.96 + 0.06 * n), (img[k + 2] / 255) * (0.96 + 0.06 * n));
      d.rough![i] = 0.16;
    } else {
      const t = 0.95 + 0.08 * (n - 0.5) + 0.03 * (hash2(x, y, seed) - 0.5);
      put(d, i, base[0] * t, base[1] * t, base[2] * t);
      d.rough![i] = 0.26;
    }
    d.height![i] = isChip ? 0.62 : 0.6;
  }
  return d;
};

// ── fabrics ───────────────────────────────────────────────────────────────────────────────────────────
const weave: Gen = (N, _base, seed, p) => {
  const d = alloc(N, true, false);
  const th = pnum(p, "thread", 4); // px per thread
  const slub = pnum(p, "slub", 0.3);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const ix = Math.floor(x / th), iy = Math.floor(y / th);
      const fu = (x % th) / th, fv = (y % th) / th;
      const warpTop = (ix + iy) % 2 === 0;
      const prof = warpTop ? Math.sin(fu * Math.PI) : Math.sin(fv * Math.PI);
      const sl = S1(x, y, warpTop ? 2 : 32, warpTop ? 32 : 2);
      const tone = 0.8 + 0.14 * prof + slub * 0.2 * (sl - 0.5) + 0.05 * (S2(x, y, 4) - 0.5);
      put(d, i, tone, tone, tone);
      d.height![i] = 0.35 + 0.55 * prof * (0.8 + 0.4 * sl);
    }
  return d;
};

const velvet: Gen = (N, _base, seed) => {
  const d = alloc(N, true, false);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const a = S1(x, y, 2), b = S2(x, y, 12);
      const t = 0.88 + 0.14 * (a - 0.5) + 0.05 * (b - 0.5) + 0.03 * (hash2(x, y, seed) - 0.5);
      put(d, i, t, t, t);
      d.height![i] = 0.5 + 0.2 * b + 0.06 * hash2(x, y, seed + 3);
    }
  return d;
};

const leather: Gen = (N, _base, seed) => {
  const d = alloc(N, true, true);
  const S1 = sampler(table(seed, "ridged"), N), S2 = sampler(table(seed + 1), N), S3 = sampler(table(seed + 2, "ridged"), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const cell = S1(x, y, 8), cell2 = S3(x, y, 20), low = S2(x, y, 2);
      const crease = smoothstep(0.75, 0.98, cell) * 0.6 + smoothstep(0.8, 0.98, cell2) * 0.4;
      const t = 0.9 + 0.1 * (low - 0.5) - crease * 0.12;
      put(d, i, t, t, t);
      d.height![i] = 0.7 - crease * 0.5;
      d.rough![i] = 0.45 + 0.15 * crease + 0.08 * (low - 0.5);
    }
  return d;
};

// ── outdoor ───────────────────────────────────────────────────────────────────────────────────────────
const grass: Gen = (N, base, seed) => {
  const d = alloc(N, true, true);
  const cv = makeCanvas(N);
  const g = cv.getContext("2d") as CanvasRenderingContext2D | null;
  const r = rng(seed);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  if (g) {
    // base mottling
    const img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = (i / N) | 0;
      const a = S1(x, y, 1), b = S2(x, y, 6);
      const c = mix(mix(base, [0.36, 0.42, 0.16], clamp((a - 0.55) * 2, 0, 1) * 0.6), mul(base, 0.55), clamp((0.45 - b) * 2, 0, 1) * 0.7);
      const k = i << 2;
      img.data[k] = c[0] * 200;
      img.data[k + 1] = c[1] * 200;
      img.data[k + 2] = c[2] * 200;
      img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // blades
    const blades = Math.round(N * N * 0.03);
    g.lineCap = "round";
    for (let k = 0; k < blades; k++) {
      const x = r() * N, y = r() * N;
      const len = (3 + r() * 9) * (N / 1024) * 2.2;
      const a = r() * Math.PI * 2;
      const lt = 0.55 + r() * 0.75;
      const yellow = r() < 0.12 ? 0.35 : 0;
      const c = mix(mul(base, lt), [0.62, 0.6, 0.3], yellow);
      g.strokeStyle = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
      g.lineWidth = (0.8 + r() * 1.2) * (N / 1024) * 1.6;
      for (const ox of [0, x < len ? N : x > N - len ? -N : 0])
        for (const oy of [0, y < len ? N : y > N - len ? -N : 0]) {
          g.beginPath();
          g.moveTo(x + ox, y + oy);
          g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
          g.stroke();
        }
    }
  }
  const px = g ? g.getImageData(0, 0, N, N).data : new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const k = i << 2;
    put(d, i, px[k] / 255, px[k + 1] / 255, px[k + 2] / 255);
    const l = (px[k] * 0.3 + px[k + 1] * 0.6 + px[k + 2] * 0.1) / 255;
    d.height![i] = l;
    d.rough![i] = 0.85 + 0.1 * (1 - l);
  }
  return d;
};

/** Interlocking pavers in basketweave, with chamfers and sand joints. */
const paving: Gen = (N, base, seed, p) => {
  const d = alloc(N, true, true);
  const units = pnum(p, "units", 8); // 200 mm units per tile side
  const uw = N / units;
  const joint = Math.max(1, uw * 0.03);
  const ch = uw * 0.04;
  const pal: RGB[] = [base, mul(base, 0.78), mix(base, [0.62, 0.58, 0.52], 0.35), mul(base, 1.12), mix(base, [0.32, 0.32, 0.33], 0.4)];
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const ux = Math.floor(x / uw), uy = Math.floor(y / uw);
      let lu = x + 0.5 - ux * uw, lv = y + 0.5 - uy * uw;
      const horiz = (ux + uy) % 2 === 0;
      let pid: number, pw: number, ph: number;
      if (horiz) {
        pid = lv < uw / 2 ? 0 : 1;
        if (pid) lv -= uw / 2;
        pw = uw; ph = uw / 2;
      } else {
        pid = lu < uw / 2 ? 0 : 1;
        if (pid) lu -= uw / 2;
        pw = uw / 2; ph = uw;
      }
      const e = Math.min(lu, pw - lu, lv, ph - lv);
      const hb = hash2(ux * 2 + pid, uy * 3 + pid, seed);
      const c0 = pal[Math.floor(hb * pal.length) % pal.length];
      if (e < joint) {
        const t = 0.65 + 0.15 * S2(x, y, 32);
        put(d, i, 0.62 * t, 0.57 * t, 0.48 * t);
        d.height![i] = 0.15;
        d.rough![i] = 0.95;
        continue;
      }
      const sp = S1(x, y, 16, 16, hb * 50, hb * 70);
      const spk = hash2(x, y, seed + 4) > 0.97 ? 0.85 : 1;
      const b = smoothstep(joint, joint + ch, e);
      const tone = (0.9 + 0.16 * (sp - 0.5)) * spk * (0.82 + 0.18 * b);
      put(d, i, c0[0] * tone, c0[1] * tone, c0[2] * tone);
      d.height![i] = 0.3 + 0.6 * b + 0.05 * sp;
      d.rough![i] = 0.8 + 0.12 * sp;
    }
  return d;
};

const gravel: Gen = (N, base, seed) => {
  const d = alloc(N, true, true);
  const cv = makeCanvas(N);
  const g = cv.getContext("2d") as CanvasRenderingContext2D | null;
  const r = rng(seed);
  if (g) {
    g.fillStyle = "#2a2826";
    g.fillRect(0, 0, N, N);
    const count = Math.round(N * N * 0.004);
    for (let k = 0; k < count; k++) {
      const x = r() * N, y = r() * N;
      const rad = (2.5 + r() * 5) * (N / 512);
      const c = jitter(base, r, 0.25, 0.08);
      const rot = r() * Math.PI;
      const asp = 0.6 + r() * 0.4;
      for (const ox of [-N, 0, N])
        for (const oy of [-N, 0, N]) {
          const px = x + ox, py = y + oy;
          if (px < -rad || px > N + rad || py < -rad || py > N + rad) continue;
          const gr = g.createRadialGradient(px - rad * 0.3, py - rad * 0.3, rad * 0.1, px, py, rad);
          gr.addColorStop(0, `rgb(${Math.min(255, c[0] * 290) | 0},${Math.min(255, c[1] * 290) | 0},${Math.min(255, c[2] * 290) | 0})`);
          gr.addColorStop(1, `rgb(${(c[0] * 120) | 0},${(c[1] * 120) | 0},${(c[2] * 120) | 0})`);
          g.fillStyle = gr;
          g.beginPath();
          g.ellipse(px, py, rad, rad * asp, rot, 0, Math.PI * 2);
          g.fill();
        }
    }
  }
  const px = g ? g.getImageData(0, 0, N, N).data : new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const k = i << 2;
    put(d, i, px[k] / 255, px[k + 1] / 255, px[k + 2] / 255);
    const l = (px[k] + px[k + 1] + px[k + 2]) / 765;
    d.height![i] = l;
    d.rough![i] = 0.75 + 0.2 * (1 - l);
  }
  return d;
};

const soil: Gen = (N, base, seed) => {
  const d = alloc(N, true, true);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N), S3 = sampler(table(seed + 2, "ridged"), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const a = S1(x, y, 2), b = S2(x, y, 12), c = S3(x, y, 24);
      const clod = smoothstep(0.7, 0.95, c);
      const t = 0.85 + 0.25 * (a - 0.5) + 0.1 * (b - 0.5) + clod * 0.15 + 0.06 * (hash2(x, y, seed) - 0.5);
      put(d, i, base[0] * t, base[1] * t, base[2] * t);
      d.height![i] = 0.4 + 0.3 * b + 0.3 * clod;
      d.rough![i] = 0.92;
    }
  return d;
};

const asphalt: Gen = (N, base, seed) => {
  const d = alloc(N, true, true);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const a = S1(x, y, 1), b = S2(x, y, 10);
      const h = hash2(x, y, seed);
      let t = 0.9 + 0.18 * (a - 0.5) + 0.08 * (b - 0.5);
      let hh = 0.5 + 0.2 * b;
      if (h > 0.93) {
        t *= 1.5;
        hh = 0.85;
      } else if (h < 0.06) {
        t *= 0.6;
        hh = 0.3;
      }
      put(d, i, base[0] * t, base[1] * t, base[2] * t);
      d.height![i] = hh;
      d.rough![i] = 0.88 - 0.08 * (a - 0.5);
    }
  return d;
};

const water: Gen = (N, base, seed) => {
  const d = alloc(N, true, false);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const a = S1(x, y, 3), b = S2(x, y, 9);
      const t = 0.95 + 0.1 * (a - 0.5);
      put(d, i, base[0] * t, base[1] * t, base[2] * t);
      d.height![i] = a * 0.7 + b * 0.3;
    }
  return d;
};

/** Brushed metal: roughness streaks only (albedo stays white, color comes from the material). */
const brushed: Gen = (N, _base, seed) => {
  const d = alloc(N, true, true);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const s = S1(x, y, 1, 128), t = S2(x, y, 2, 64);
      put(d, i, 1, 1, 1);
      d.height![i] = s * 0.5 + t * 0.2;
      d.rough![i] = 0.22 + 0.16 * (s - 0.5) + 0.08 * (t - 0.5);
    }
  return d;
};

/** Faint smudges in roughness for glossy surfaces (lacquer, ceramic, mirror). */
const smudge: Gen = (N, _base, seed) => {
  const d = alloc(N, false, true);
  const S1 = sampler(table(seed), N), S2 = sampler(table(seed + 1), N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const s = S1(x, y, 2), t = S2(x, y, 8);
      put(d, i, 1, 1, 1);
      d.rough![i] = 0.5 + 0.35 * (s - 0.5) + 0.15 * (t - 0.5);
    }
  return d;
};

export const GENERATORS: Record<string, Gen> = {
  plaster, ledgestone, travertine, brick, seams, concrete, woodGrain, planks, marble, tiles, terrazzo, weave, velvet, leather,
  grass, paving, gravel, soil, asphalt, water, brushed, smudge,
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────
export function makeCanvas(N: number, H = N): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = N;
    c.height = H;
    return c;
  }
  return new OffscreenCanvas(N, H);
}

function hexToRGB(hex: string): RGB {
  let s = hex.replace("#", "").trim();
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
