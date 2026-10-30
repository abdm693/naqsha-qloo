/**
 * Material library: ~46 PBR presets with procedural, seeded, tileable textures (no downloads).
 * Geometry UVs are in METERS (box-projected), so each preset declares the physical size its texture covers.
 */
import * as THREE from "three";
import type { MaterialPreset, MaterialSpec } from "@contracts/house-sdk";
import { color as toColor, colorHex, hashStr, num, warn } from "../core/util";
import type { GenParams } from "./gen";
import { runTexJob, type TexJob, type TexResult } from "./texjob";
import { hexRGB } from "./noise";

export type Quality = "high" | "medium";

interface TexDef {
  gen: string;
  /** meters covered by one texture repeat (u, v) */
  size: [number, number];
  N: number;
  normal: number;
  /** grayscale texture tinted by material.color (vs. baked colors) */
  tint?: boolean;
  params?: GenParams;
  seed?: number;
}

interface PresetDef {
  base: string;
  tex?: TexDef;
  roughness: number;
  metalness?: number;
  physical?: Partial<THREE.MeshPhysicalMaterialParameters>;
  glass?: "clear" | "tinted" | "frosted";
  env?: number;
}

const WOOD = (base: string, rings = 50, pores = 0.5): PresetDef => ({
  base,
  tex: { gen: "woodGrain", size: [1.1, 1.1], N: 1024, normal: 0.55, params: { rings, warp: 1.4, pores } },
  roughness: 0.52,
});
const PLASTER = (base: string, trowel = 1): PresetDef => ({
  base,
  tex: { gen: "plaster", size: [2.4, 2.4], N: 512, normal: 0.45 * trowel + 0.25, tint: true, params: { trowel } },
  roughness: 0.88,
});

export const PRESETS: Record<MaterialPreset, PresetDef> = {
  plaster_white: PLASTER("#f1efea"),
  plaster_warm: PLASTER("#ebe2d3"),
  plaster_grey: PLASTER("#b4b2ad"),
  paint: { ...PLASTER("#eeeae3", 0.35), roughness: 0.78 },
  stone_cladding: {
    base: "#8f8b84",
    tex: { gen: "ledgestone", size: [1.2, 1.2], N: 1024, normal: 7, params: { size_mm: 1200, rowMin: 32, rowMax: 95, lenMin: 140, lenMax: 520, joint: 7, strata: 1 } },
    roughness: 0.88,
  },
  slate_cladding: {
    base: "#5e6264",
    tex: { gen: "ledgestone", size: [1.0, 1.0], N: 1024, normal: 8, params: { size_mm: 1000, rowMin: 18, rowMax: 60, lenMin: 160, lenMax: 560, joint: 4, strata: 1.7, dark: 1 } },
    roughness: 0.84,
  },
  travertine: { base: "#d8cbb2", tex: { gen: "travertine", size: [1.2, 1.2], N: 1024, normal: 1.6, params: { cols: 2, rows: 4 } }, roughness: 0.5 },
  brick_red: { base: "#a4553d", tex: { gen: "brick", size: [0.96, 0.85], N: 512, normal: 3, params: { cols: 4, rows: 10 } }, roughness: 0.88 },
  brick_exposed: { base: "#8c4b36", tex: { gen: "brick", size: [0.92, 0.66], N: 512, normal: 3.4, params: { cols: 4, rows: 8, mortar: "#6c625a", recess: 0.7 } }, roughness: 0.9 },
  concrete: { base: "#a9a7a1", tex: { gen: "concrete", size: [2.4, 2.4], N: 512, normal: 1.0, params: { panels: 2 } }, roughness: 0.8 },
  wood_cladding: { base: "#9e6739", tex: { gen: "planks", size: [1.8, 1.8], N: 1024, normal: 2.2, params: { rows: 12, lenMin: 0.5, lenMax: 1.0, gap: 2.2, rings: 6 } }, roughness: 0.62 },
  marble_white: { base: "#efedea", tex: { gen: "marble", size: [2.4, 2.4], N: 1024, normal: 0.25, params: { vein: "#77777d", veinAmt: 1.15, cloud: 0.05 } }, roughness: 0.1 },
  marble_beige: { base: "#ddd0b9", tex: { gen: "marble", size: [2.4, 2.4], N: 1024, normal: 0.25, params: { vein: "#f3ece0", veinAmt: 0.55, cloud: 0.09, warp: 2.2 } }, roughness: 0.12 },
  marble_black: { base: "#1d1d20", tex: { gen: "marble", size: [2.4, 2.4], N: 1024, normal: 0.25, params: { vein: "#e6e2da", veinAmt: 0.9, cloud: 0.12 } }, roughness: 0.1 },
  terrazzo: { base: "#e7e3dc", tex: { gen: "terrazzo", size: [1.2, 1.2], N: 1024, normal: 0.2 }, roughness: 0.24 },
  porcelain_tile: { base: "#dcd8d0", tex: { gen: "tiles", size: [1.2, 1.2], N: 1024, normal: 1.0, params: { tiles: 2, grout: 1.8, stone: 1, gloss: 0.22 } }, roughness: 0.24 },
  ceramic_tile: { base: "#e9e7e2", tex: { gen: "tiles", size: [0.6, 0.6], N: 512, normal: 1.2, params: { tiles: 2, grout: 2.4, stone: 0.25, gloss: 0.14 } }, roughness: 0.16 },
  wood_floor_oak: { base: "#b78d5f", tex: { gen: "planks", size: [2.4, 2.4], N: 1024, normal: 1.4, params: { rows: 12, rings: 9, vary: 0.12 } }, roughness: 0.48 },
  wood_floor_walnut: { base: "#6e4b33", tex: { gen: "planks", size: [2.4, 2.4], N: 1024, normal: 1.4, params: { rows: 12, rings: 8, vary: 0.14 } }, roughness: 0.45 },
  wood_teak: WOOD("#a56b3e", 40, 0.4),
  wood_walnut: WOOD("#5e3e2a", 46, 0.5),
  wood_oak: WOOD("#b99067", 56, 1),
  wood_white_oak: WOOD("#cfb795", 60, 1),
  lacquer: { base: "#f1eee8", tex: { gen: "smudge", size: [1.5, 1.5], N: 256, normal: 0 }, roughness: 0.3, physical: { clearcoat: 0.6, clearcoatRoughness: 0.12 } },
  metal_black: { base: "#1e1f22", tex: { gen: "smudge", size: [1.0, 1.0], N: 256, normal: 0 }, roughness: 0.42, metalness: 0.55 },
  metal_brushed: { base: "#c9cacc", tex: { gen: "brushed", size: [0.5, 0.5], N: 512, normal: 0.2 }, roughness: 0.3, metalness: 1 },
  metal_gold: { base: "#c99b4a", tex: { gen: "smudge", size: [0.8, 0.8], N: 256, normal: 0 }, roughness: 0.26, metalness: 1 },
  metal_bronze: { base: "#7b5536", tex: { gen: "smudge", size: [0.8, 0.8], N: 256, normal: 0 }, roughness: 0.34, metalness: 1 },
  glass_clear: { base: "#ffffff", roughness: 0.02, glass: "clear" },
  glass_tinted: { base: "#a9b4b6", roughness: 0.03, glass: "tinted" },
  glass_frosted: { base: "#f2f4f4", roughness: 0.4, glass: "frosted" },
  mirror: { base: "#f2f2f2", roughness: 0.025, metalness: 1 },
  fabric: { base: "#bdb6aa", tex: { gen: "weave", size: [0.1, 0.1], N: 256, normal: 1.1, tint: true, params: { thread: 4, slub: 0.3 } }, roughness: 0.92 },
  velvet: { base: "#4d5c57", tex: { gen: "velvet", size: [0.4, 0.4], N: 256, normal: 0.6, tint: true }, roughness: 0.78, physical: { sheen: 1, sheenRoughness: 0.4 } },
  leather: { base: "#6b4630", tex: { gen: "leather", size: [0.35, 0.35], N: 512, normal: 1.6, tint: true }, roughness: 0.5 },
  linen: { base: "#e2dccf", tex: { gen: "weave", size: [0.14, 0.14], N: 256, normal: 1.3, tint: true, params: { thread: 6, slub: 1 } }, roughness: 0.95 },
  ceramic_white: { base: "#f6f6f3", tex: { gen: "smudge", size: [1.0, 1.0], N: 256, normal: 0 }, roughness: 0.08, physical: { clearcoat: 1, clearcoatRoughness: 0.05 } },
  plastic: { base: "#e7e7e4", roughness: 0.45 },
  roof_shingle: { base: "#57585c", tex: { gen: "brick", size: [1.0, 0.86], N: 512, normal: 3, params: { cols: 3, rows: 6, mortar: "#26272a", joint: 0.05, recess: 0.8 } }, roughness: 0.92 },
  roof_tile: { base: "#a65a3a", tex: { gen: "brick", size: [1.2, 1.0], N: 512, normal: 4, params: { cols: 5, rows: 6, mortar: "#5b2e1f", joint: 0.09, recess: 1 } }, roughness: 0.78 },
  roof_slate: { base: "#4b5056", tex: { gen: "brick", size: [1.0, 0.9], N: 512, normal: 2.6, params: { cols: 4, rows: 7, mortar: "#2a2d31", joint: 0.05, recess: 0.8 } }, roughness: 0.7 },
  roof_metal: { base: "#6d7276", tex: { gen: "seams", size: [1.35, 1.35], N: 512, normal: 3, params: { cols: 3 } }, roughness: 0.42, metalness: 0.65 },
  grass: { base: "#5b7c34", tex: { gen: "grass", size: [1.4, 1.4], N: 1024, normal: 1.6 }, roughness: 0.92 },
  paving: { base: "#8d8a85", tex: { gen: "paving", size: [1.6, 1.6], N: 1024, normal: 2.6, params: { units: 8 } }, roughness: 0.86 },
  gravel: { base: "#a69e93", tex: { gen: "gravel", size: [0.6, 0.6], N: 512, normal: 3 }, roughness: 0.85 },
  soil: { base: "#5b4535", tex: { gen: "soil", size: [1.5, 1.5], N: 512, normal: 2 }, roughness: 0.95 },
  water: { base: "#2a4a50", tex: { gen: "water", size: [3, 3], N: 512, normal: 0.7 }, roughness: 0.04, physical: { clearcoat: 0.5 } },
  asphalt: { base: "#3b3c3e", tex: { gen: "asphalt", size: [1.5, 1.5], N: 512, normal: 1.4 }, roughness: 0.9 },
};

const PRESET_NAMES = Object.keys(PRESETS) as MaterialPreset[];

/** Map free text ("white plaster", "teak", "#ffffff") to a preset (+ color). */
export function resolvePresetName(s: string): { preset: MaterialPreset; color?: string } | null {
  const t = s.trim().toLowerCase();
  if ((PRESETS as Record<string, PresetDef>)[t]) return { preset: t as MaterialPreset };
  if (/^#?[0-9a-f]{6}$/.test(t) || /^#?[0-9a-f]{3}$/.test(t)) return { preset: "paint", color: t.startsWith("#") ? t : `#${t}` };
  const rules: [RegExp, MaterialPreset][] = [
    [/glass.*(tint|smok|bronze|grey|gray)/, "glass_tinted"], [/frost/, "glass_frosted"], [/glass|glaz/, "glass_clear"], [/mirror/, "mirror"],
    [/slate/, "slate_cladding"], [/travertine/, "travertine"], [/stone|ledge|rock/, "stone_cladding"],
    [/black.*marble|marble.*black|nero/, "marble_black"], [/beige.*marble|marble.*beige|botticino/, "marble_beige"], [/marble/, "marble_white"],
    [/terrazzo/, "terrazzo"], [/porcelain/, "porcelain_tile"], [/ceramic.*tile|tile/, "ceramic_tile"],
    [/walnut.*floor|floor.*walnut/, "wood_floor_walnut"], [/floor|parquet|plank/, "wood_floor_oak"],
    [/clad/, "wood_cladding"], [/teak/, "wood_teak"], [/walnut/, "wood_walnut"], [/white.*oak/, "wood_white_oak"], [/oak|wood|timber/, "wood_oak"],
    [/lacquer|gloss/, "lacquer"], [/gold|brass/, "metal_gold"], [/bronze|copper/, "metal_bronze"], [/steel|chrome|brushed|silver|alumin/, "metal_brushed"],
    [/metal|iron|black/, "metal_black"], [/velvet/, "velvet"], [/leather/, "leather"], [/linen/, "linen"], [/fabric|textile|cloth/, "fabric"],
    [/ceramic|porcelain|sanitary/, "ceramic_white"], [/plastic/, "plastic"], [/grass|lawn|turf/, "grass"], [/pav|cobble|block/, "paving"],
    [/gravel|pebble/, "gravel"], [/soil|earth|mud/, "soil"], [/water|pool/, "water"], [/asphalt|road|tarmac/, "asphalt"],
    [/brick/, "brick_red"], [/concrete|cement/, "concrete"], [/grey.*plaster|plaster.*grey|gray/, "plaster_grey"],
    [/warm|cream|beige/, "plaster_warm"], [/paint/, "paint"], [/plaster|stucco|white|render/, "plaster_white"],
  ];
  for (const [re, p] of rules) if (re.test(t)) return { preset: p };
  return null;
}

// ── textures (global cache: survives rebuilds; generated in a worker pool) ───────────────────────────
interface TexSet {
  map: THREE.DataTexture | null;
  normalMap: THREE.DataTexture | null;
  roughnessMap: THREE.DataTexture | null;
  roughMean: number;
  ready: boolean;
  N: number;
  /** material slots holding placeholder clones, swapped for full-resolution clones on arrival */
  slots: { mat: THREE.MeshStandardMaterial; slot: "map" | "normalMap" | "roughnessMap"; ru: number; rv: number }[];
  users: { mat: THREE.MeshStandardMaterial; target: number }[];
}
const texCache = new Map<string, TexSet>();
let texMs = 0;
export function textureTimeMs(): number {
  return texMs;
}

/** What each generator produces + a roughness-mean estimate used until the real maps arrive. */
const CAPS: Record<string, { h: boolean; r: boolean; est: number }> = {
  plaster: { h: true, r: true, est: 0.5 }, ledgestone: { h: true, r: true, est: 0.84 }, travertine: { h: true, r: true, est: 0.5 },
  brick: { h: true, r: true, est: 0.86 }, concrete: { h: true, r: true, est: 0.7 }, woodGrain: { h: true, r: true, est: 0.55 },
  planks: { h: true, r: true, est: 0.5 }, marble: { h: true, r: true, est: 0.08 }, tiles: { h: true, r: true, est: 0.25 },
  terrazzo: { h: true, r: true, est: 0.22 }, weave: { h: true, r: false, est: 1 }, velvet: { h: true, r: false, est: 1 },
  leather: { h: true, r: true, est: 0.5 }, grass: { h: true, r: true, est: 0.9 }, paving: { h: true, r: true, est: 0.82 },
  gravel: { h: true, r: true, est: 0.8 }, soil: { h: true, r: true, est: 0.92 }, asphalt: { h: true, r: true, est: 0.88 },
  seams: { h: true, r: true, est: 0.5 }, water: { h: true, r: false, est: 1 }, brushed: { h: true, r: true, est: 0.22 }, smudge: { h: false, r: true, est: 0.5 },
};

function dataTex(data: Uint8Array, N: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function solid(N: number, r: number, g: number, b: number): Uint8Array {
  const a = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    a[i * 4] = r;
    a[i * 4 + 1] = g;
    a[i * 4 + 2] = b;
    a[i * 4 + 3] = 255;
  }
  return a;
}

// worker pool
let workers: { w: Worker; busy: number }[] | null = null;
let workerFailed = false;
let jobSeq = 0;
const waiting = new Map<number, (r: TexResult) => void>();
const inflight = new Set<Promise<void>>();
function pool(): { w: Worker; busy: number }[] | null {
  if (workers || workerFailed) return workers;
  try {
    if (typeof Worker === "undefined") throw new Error("no Worker");
    const n = Math.max(1, Math.min(4, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4) - 1));
    workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./texworker.ts", import.meta.url), { type: "module" });
      const slot = { w, busy: 0 };
      w.onmessage = (e: MessageEvent<TexResult>) => {
        slot.busy--;
        const cb = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        cb?.(e.data);
      };
      w.onerror = (e) => {
        console.warn("[naqsha/engine] texture worker error; falling back to main thread", e.message);
        workerFailed = true;
      };
      workers.push(slot);
    }
  } catch {
    workerFailed = true;
    workers = null;
  }
  return workers;
}

function runAsync(job: TexJob): Promise<TexResult> {
  const p = pool();
  if (!p || workerFailed) {
    return new Promise((res) => {
      const go = () => res(runTexJob(job));
      if (typeof setTimeout !== "undefined") setTimeout(go, 0);
      else go();
    });
  }
  return new Promise((res) => {
    waiting.set(job.id, res);
    const slot = p.reduce((a, b) => (b.busy < a.busy ? b : a));
    slot.busy++;
    slot.w.postMessage(job);
  });
}

/** Resolves when every procedural texture requested so far has been generated and applied. */
export async function texturesReady(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

function buildTexSet(def: TexDef, baseHex: string, q: Quality): TexSet {
  const N = q === "high" ? def.N : Math.max(128, def.N >> 1);
  const key = `${def.gen}|${N}|${def.tint ? "tint" : baseHex}|${JSON.stringify(def.params ?? {})}|${def.seed ?? 0}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const caps = CAPS[def.gen] ?? { h: true, r: true, est: 0.6 };
  const base = hexRGB(def.tint ? "#ffffff" : baseHex);
  const isWhite = def.gen === "brushed" || def.gen === "smudge";
  const P = 4;
  const set: TexSet = {
    map: isWhite ? null : dataTex(solid(P, (base[0] * 255) | 0, (base[1] * 255) | 0, (base[2] * 255) | 0), P, true),
    normalMap: caps.h && def.normal > 0 ? dataTex(solid(P, 128, 128, 255), P, false) : null,
    roughnessMap: caps.r ? dataTex(solid(P, (caps.est * 255) | 0, (caps.est * 255) | 0, (caps.est * 255) | 0), P, false) : null,
    roughMean: caps.est,
    ready: false,
    N,
    slots: [],
    users: [],
  };
  texCache.set(key, set);
  const seed = (def.seed ?? 0) + (hashStr(def.gen) % 997);
  const job: TexJob = { id: ++jobSeq, gen: def.gen, N, base: def.tint ? "#ffffff" : baseHex, seed, params: def.params ?? {}, normal: def.normal, wantAlbedo: !isWhite };
  const t0 = performance.now();
  const p = runAsync(job).then((res) => {
    texMs += performance.now() - t0;
    if (set.map && res.albedo) set.map = dataTex(res.albedo, N, true);
    if (set.normalMap && res.normal) set.normalMap = dataTex(res.normal, N, false);
    if (set.roughnessMap && res.rough) set.roughnessMap = dataTex(res.rough, N, false);
    set.roughMean = res.roughMean;
    set.ready = true;
    for (const sl of set.slots) {
      const full = sl.slot === "map" ? set.map : sl.slot === "normalMap" ? set.normalMap : set.roughnessMap;
      if (!full) continue;
      const c = full.clone();
      c.repeat.set(sl.ru, sl.rv);
      const old = sl.mat[sl.slot];
      sl.mat[sl.slot] = c;
      old?.dispose();
    }
    set.slots.length = 0;
    for (const u of set.users) u.mat.roughness = Math.min(2.5, u.target / set.roughMean);
  });
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  return set;
}

// ── material creation ─────────────────────────────────────────────────────────────────────────────────
interface NormSpec {
  preset: MaterialPreset;
  color?: string;
  scale_ft?: number;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissive_intensity?: number;
}

export class MaterialLib {
  readonly quality: Quality;
  private cache = new Map<string, THREE.Material>();
  readonly created: THREE.Material[] = [];

  constructor(quality: Quality) {
    this.quality = quality;
  }

  /** Normalize any MaterialSpec (never throws). `fallback` is used for empty/invalid specs. */
  normalize(spec: MaterialSpec | undefined | null, fallback: MaterialPreset | NormSpec): NormSpec | THREE.Material {
    const fb: NormSpec = typeof fallback === "string" ? { preset: fallback } : fallback;
    if (spec == null) return fb;
    if (typeof spec === "object" && (spec as THREE.Material).isMaterial) return spec as THREE.Material;
    if (typeof spec === "string") {
      const r = resolvePresetName(spec);
      if (!r) {
        warn(`unknown material "${spec}", using ${fb.preset}`);
        return fb;
      }
      if (!(PRESETS as Record<string, unknown>)[spec]) warn(`material "${spec}" interpreted as ${r.preset}`);
      return r;
    }
    if (typeof spec === "object") {
      const o = spec as Record<string, unknown>;
      let preset: MaterialPreset = fb.preset;
      let colorOverride = typeof o.color === "string" ? o.color : undefined;
      if (typeof o.preset === "string") {
        const r = resolvePresetName(o.preset);
        if (r) {
          preset = r.preset;
          if (!colorOverride && r.color) colorOverride = r.color;
        } else warn(`unknown material preset "${o.preset}", using ${fb.preset}`);
      } else if (colorOverride) preset = "paint";
      return {
        preset,
        color: colorOverride ? colorHex(colorOverride) : fb.color,
        scale_ft: typeof o.scale_ft === "number" && o.scale_ft > 0 ? num(o.scale_ft, 1, 0.1, 100) : undefined,
        roughness: typeof o.roughness === "number" ? num(o.roughness, 0.5, 0, 1) : undefined,
        metalness: typeof o.metalness === "number" ? num(o.metalness, 0, 0, 1) : undefined,
        emissive: typeof o.emissive === "string" ? colorHex(o.emissive) : undefined,
        emissive_intensity: typeof o.emissive_intensity === "number" ? num(o.emissive_intensity, 1, 0, 50) : undefined,
      };
    }
    return fb;
  }

  /** Get a (cached) THREE material for a spec. */
  get(spec: MaterialSpec | undefined | null, fallback: MaterialPreset | NormSpec = "plaster_white"): THREE.Material {
    const n = this.normalize(spec, fallback);
    if ((n as THREE.Material).isMaterial) return n as THREE.Material;
    const s = n as NormSpec;
    const key = JSON.stringify(s);
    let m = this.cache.get(key);
    if (!m) {
      m = this.create(s);
      m.name = s.preset + (s.color ? `:${s.color}` : "");
      this.cache.set(key, m);
      this.created.push(m);
    }
    return m;
  }

  /** Plain color helper (no texture), used for small parts (handles, emissive bulbs, screens). */
  basic(hex: string, opts: { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number; toneMapped?: boolean } = {}): THREE.MeshStandardMaterial {
    const key = `basic|${hex}|${JSON.stringify(opts)}`;
    let m = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: toColor(hex), roughness: opts.roughness ?? 0.5, metalness: opts.metalness ?? 0 });
      if (opts.emissive) {
        m.emissive = toColor(opts.emissive);
        m.emissiveIntensity = opts.emissiveIntensity ?? 1;
      }
      if (opts.toneMapped === false) m.toneMapped = false;
      m.name = `basic:${hex}`;
      this.cache.set(key, m);
      this.created.push(m);
    }
    return m;
  }

  /** Emissive "light" material (fixtures, LED strips). */
  emissive(hex: string, intensity = 2): THREE.MeshStandardMaterial {
    return this.basic("#ffffff", { emissive: hex, emissiveIntensity: intensity, roughness: 0.4 });
  }

  /** Additive glow (fake light pools / wall washes) with a canvas gradient texture. */
  glow(hex: string, shape: GlowShape, opacity = 0.6): THREE.MeshBasicMaterial {
    const key = `glow|${hex}|${shape}|${opacity}`;
    let m = this.cache.get(key) as THREE.MeshBasicMaterial | undefined;
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: toColor(hex),
        map: glowTexture(shape),
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      m.name = `glow:${shape}`;
      this.cache.set(key, m);
      this.created.push(m);
    }
    return m;
  }

  private create(s: NormSpec): THREE.Material {
    const def = PRESETS[s.preset] ?? PRESETS.plaster_white;
    const colorHexStr = s.color ?? def.base;
    if (def.glass) return this.glass(def, s);
    let set: TexSet | null = null;
    if (def.tex) set = buildTexSet(def.tex, def.tex.tint ? "#ffffff" : colorHexStr, this.quality);
    const physical = !!def.physical;
    const targetRough = s.roughness ?? def.roughness;
    const params: THREE.MeshPhysicalMaterialParameters = {
      color: def.tex && !def.tex.tint && set?.map ? new THREE.Color(1, 1, 1) : toColor(colorHexStr),
      roughness: set?.roughnessMap ? Math.min(2.5, targetRough / set.roughMean) : targetRough,
      metalness: s.metalness ?? def.metalness ?? 0,
      envMapIntensity: def.env ?? 1,
    };
    const mat = physical ? new THREE.MeshPhysicalMaterial({ ...params, ...def.physical }) : new THREE.MeshStandardMaterial(params);
    // joinery wood: geometry builders run the grain along each member's long side (see MeshBuilder.grainAuto)
    if (def.tex?.gen === "woodGrain") mat.userData.grain = true;
    if (def.physical?.sheen) (mat as THREE.MeshPhysicalMaterial).sheenColor = toColor(colorHexStr).lerp(new THREE.Color(1, 1, 1), 0.35);
    if (set && def.tex) {
      const sc = s.scale_ft ? (s.scale_ft * 0.3048) / def.tex.size[0] : 1;
      const ru = 1 / (def.tex.size[0] * sc), rv = 1 / (def.tex.size[1] * sc);
      const sm = mat as THREE.MeshStandardMaterial;
      const rep = (t: THREE.DataTexture | null, slot: "map" | "normalMap" | "roughnessMap") => {
        if (!t) return;
        const c = t.clone();
        c.repeat.set(ru, rv);
        sm[slot] = c;
        if (!set.ready) set.slots.push({ mat: sm, slot, ru, rv });
      };
      rep(set.map, "map");
      if (set.normalMap) {
        rep(set.normalMap, "normalMap");
        sm.normalScale.set(1, 1);
      }
      if (set.roughnessMap) {
        rep(set.roughnessMap, "roughnessMap");
        set.users.push({ mat: sm, target: targetRough });
      }
    }
    if (s.emissive) {
      mat.emissive = toColor(s.emissive);
      mat.emissiveIntensity = s.emissive_intensity ?? 1;
    }
    return mat;
  }

  /**
   * Glass without the transmission pass (which re-renders every opaque mesh and doubles draw calls). Clear and
   * tinted glass use "premultiplied" blending: the pane dims what is behind it by `opacity` and adds its
   * reflections at full strength, which reads like real glass. Frosted glass is a plain translucent white.
   */
  private glass(def: PresetDef, s: NormSpec): THREE.Material {
    const col = toColor(s.color ?? def.base);
    const rough = s.roughness ?? def.roughness;
    if (def.glass === "frosted") {
      return new THREE.MeshPhysicalMaterial({
        color: col,
        metalness: 0,
        roughness: rough,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
        envMapIntensity: 1.2,
      });
    }
    const tinted = def.glass === "tinted";
    const m = new THREE.MeshPhysicalMaterial({
      // the body colour only tints: keep it dark so the pane does not haze what is behind it
      color: col.clone().multiplyScalar(tinted ? 0.09 : 0.075),
      metalness: 0,
      roughness: rough,
      transparent: true,
      opacity: tinted ? 0.46 : 0.14,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.0,
      specularIntensity: 1,
      ior: 1.5,
    });
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.userData.glass = def.glass;
    return m;
  }

  dispose(): void {
    // textures are cached globally (shared across builds); dispose only material instances
    for (const m of this.created) m.dispose();
    this.created.length = 0;
    this.cache.clear();
  }
}

export function isPreset(s: string): s is MaterialPreset {
  return PRESET_NAMES.includes(s as MaterialPreset);
}

// ── glow textures ─────────────────────────────────────────────────────────────────────────────────────
const glowCache = new Map<string, THREE.Texture>();
export type GlowShape = "radial" | "cone_up" | "cone_down" | "cone_ud" | "band";
function glowTexture(shape: GlowShape): THREE.Texture {
  let t = glowCache.get(shape);
  if (t) return t;
  const W = 128, H = shape === "band" ? 32 : 128;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      let a = 0;
      if (shape === "radial") {
        const r = Math.hypot(u - 0.5, v - 0.5) * 2;
        a = Math.pow(Math.max(0, 1 - r), 2.2);
      } else if (shape === "band") {
        const dy = Math.abs(v - 0.5) * 2;
        const dx = Math.min(u, 1 - u) * 8;
        a = Math.pow(Math.max(0, 1 - dy), 2) * Math.min(1, dx);
      } else {
        // cone: source at v=0.5 (center), spreading toward v=1 (up) or v=0 (down)
        const dv = shape === "cone_up" ? v - 0.5 : shape === "cone_ud" ? Math.abs(v - 0.5) : 0.5 - v;
        if (dv > 0) {
          const spread = 0.05 + dv * 0.75;
          const du = Math.abs(u - 0.5);
          a = Math.max(0, 1 - du / spread) * Math.pow(Math.max(0, 1 - dv * 2), 1.4);
          a = Math.pow(a, 1.6);
        }
        const r = Math.hypot(u - 0.5, (v - 0.5) * 2);
        a = Math.max(a, Math.pow(Math.max(0, 1 - r * 6), 2) * 0.8);
      }
      const k = (y * W + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(Math.min(1, a) * 255);
    }
  // premultiply into rgb for additive blending (alpha drives intensity)
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3] / 255;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(255 * a);
  }
  t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  glowCache.set(shape, t);
  return t;
}
