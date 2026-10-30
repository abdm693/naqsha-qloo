/** s.structure(opts): builds everything structural from the plan. */
import type * as THREE from "three";
import type { MaterialPreset, MaterialSpec } from "@contracts/house-sdk";
import type { RoomType } from "@contracts/plan";
import type { BuildCtx } from "../core/ctx";
import { warn } from "../core/util";
import { resolvePresetName } from "../materials/library";
import type { RoomM } from "../plan/model";
import { buildWalls } from "./walls-geo";
import { buildOpenings } from "./openings-geo";
import { buildSlabs } from "./slabs-geo";
import { buildStairs } from "./stairs-geo";
import { buildDeckRailings, buildPorchColumns, buildPrivacyScreens } from "./extras-geo";
import { buildSolar, buildTank, computeSolarRect } from "./roof-geo";
import { buildPitchedRoof, pitchSpec } from "./pitched-roof";
import { buildSite } from "./site-geo";
import { buildDropGuards, buildStairWindowGuards } from "./guards";
import type { RailType } from "./railings";

export interface StructureOpts {
  exterior_wall?: MaterialSpec;
  interior_wall?: MaterialSpec;
  floors?: Record<string, MaterialSpec>;
  ceiling?: MaterialSpec;
  window_frame?: MaterialSpec;
  door?: MaterialSpec;
  glass?: MaterialSpec;
  railing?: "glass" | "metal_bars" | "solid";
  boundary_wall?: MaterialSpec;
  gate?: MaterialSpec;
  plinth?: MaterialSpec;
  roof?: unknown;
}

const FINISH_MAP: Record<string, MaterialPreset> = {
  marble: "marble_white",
  porcelain_tile: "porcelain_tile",
  terrazzo: "terrazzo",
  wood: "wood_floor_oak",
  ceramic_tile: "ceramic_tile",
  concrete: "concrete",
  grass: "grass",
  paving: "paving",
};

const TYPE_DEFAULT: Partial<Record<RoomType, MaterialSpec>> = {
  bath: "ceramic_tile",
  powder: "ceramic_tile",
  laundry: "ceramic_tile",
  kitchen: "porcelain_tile",
  dirty_kitchen: "ceramic_tile",
  store: "porcelain_tile",
  bedroom: "wood_floor_oak",
  master_bedroom: "wood_floor_oak",
  guest_bedroom: "wood_floor_oak",
  servant: "terrazzo",
  dressing: "wood_floor_oak",
  study: "wood_floor_oak",
  porch: "paving",
  garage: "concrete",
  driveway: "paving",
  balcony: "porcelain_tile",
  terrace: { preset: "porcelain_tile", color: "#cbc5bb" },
  lawn: "grass",
  courtyard: "paving",
  open_space: "paving",
};

const ALIASES: Record<string, string> = {
  bathroom: "bath", bathrooms: "bath", baths: "bath", washroom: "bath", toilet: "powder", bedrooms: "bedroom", master: "master_bedroom",
  tv_lounge: "lounge", living: "lounge", living_room: "lounge", family: "lounge", drawing_room: "drawing", stairs: "stair", staircase: "stair",
  passage: "corridor", hall: "lobby", entrance: "lobby", car_porch: "porch", garden: "lawn", kitchens: "kitchen",
};

export function floorSpecFor(room: RoomM, floors: Record<string, MaterialSpec> | undefined): MaterialSpec {
  const f: Record<string, MaterialSpec> = {};
  if (floors && typeof floors === "object") for (const [k, v] of Object.entries(floors)) f[ALIASES[k.toLowerCase()] ?? k] = v;
  return f[room.id] ?? f[room.type] ?? (room.floorFinish ? FINISH_MAP[room.floorFinish] : undefined) ?? f.default ?? TYPE_DEFAULT[room.type] ?? "marble_white";
}

export function presetOf(spec: MaterialSpec | undefined): MaterialPreset | null {
  if (!spec) return null;
  if (typeof spec === "string") return resolvePresetName(spec)?.preset ?? null;
  if ((spec as THREE.Material).isMaterial) return null;
  const p = (spec as { preset?: string }).preset;
  return p ? resolvePresetName(p)?.preset ?? null : null;
}

export function buildStructure(ctx: BuildCtx, opts: StructureOpts = {}): void {
  if (ctx.structureBuilt) {
    warn("s.structure() called more than once; extra calls are ignored");
    return;
  }
  ctx.structureBuilt = true;
  const o = (opts && typeof opts === "object" ? opts : {}) as StructureOpts;
  ctx.structureOpts = o as Record<string, unknown>;
  // a pitched roof first: it turns the roof level into an attic before any wall is derived
  ctx.pitched = pitchSpec(o.roof, ctx.plan.plan.roof?.pitched);
  if (ctx.pitched) {
    ctx.plan.enterAttic();
    ctx.resetModel();
  }
  const M = ctx.mats;
  const ext = M.get(o.exterior_wall, "plaster_white");
  const int = M.get(o.interior_wall, { preset: "paint", color: "#efebe3" });
  const wet = M.get({ preset: "porcelain_tile", color: "#e2ded6", scale_ft: 4 });
  const floorCache = new Map<string, THREE.Material>();
  const floorOf = (room: RoomM): THREE.Material => {
    let mm = floorCache.get(room.id);
    if (!mm) {
      mm = M.get(floorSpecFor(room, o.floors), "marble_white");
      floorCache.set(room.id, mm);
    }
    return mm;
  };
  const woodLike = (room: RoomM) => (presetOf(floorSpecFor(room, o.floors)) ?? "").includes("wood");
  const ceiling = M.get(o.ceiling, { preset: "paint", color: "#fbfaf7" });
  const frame = M.get(o.window_frame, "metal_black");
  const door = M.get(o.door, "wood_teak");
  const glass = M.get(o.glass, "glass_clear");
  const frosted = M.get("glass_frosted");
  const railType: RailType = o.railing === "metal_bars" || o.railing === "solid" ? o.railing : "glass";
  const boundary = M.get(o.boundary_wall, "plaster_grey");
  const gate = M.get(o.gate, "metal_black");
  const plinth = M.get(o.plinth, { preset: "plaster_grey", color: "#8f8c87" });
  const coping = M.get({ preset: "concrete", color: "#cbc7bf" });
  const handle = M.get("metal_brushed");
  const dark = M.basic("#141416", { roughness: 0.6 });
  const board = M.get("marble_white");
  const steelBlack = M.get("metal_black");

  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[naqsha/engine] structure step "${name}" failed`, e);
    }
  };
  step("walls", () => buildWalls(ctx, { ext, int, wet, floorOf, coping }));
  step("openings", () => buildOpenings(ctx, { frame, glass, frosted, door, handle, sill: frame, board, ext, dark, garage: M.get({ preset: "metal_brushed", color: "#9a9ca0" }) }));
  step("slabs", () => buildSlabs(ctx, { edge: ext, ceiling, interiorEdge: int, roof: M.get({ preset: "concrete", color: "#c4bfb6", scale_ft: 6 }), plinth, floorOf, woodLike }));
  const railMats = { glass, metal: steelBlack, rail: M.get("wood_walnut"), solid: ext, coping };
  step("stairs", () =>
    buildStairs(ctx, {
      tread: (room) => (room ? floorOf(room) : M.get("marble_white")),
      body: int,
      stringer: steelBlack,
      rail: railMats,
      railType,
    }),
  );
  step("porch", () => buildPorchColumns(ctx, ext));
  step("railings", () => buildDeckRailings(ctx, railType, { ...railMats, rail: steelBlack }));
  step("screens", () => buildPrivacyScreens(ctx, { wall: ext, coping }));
  step("guards", () => buildDropGuards(ctx, railType, railMats));
  step("stair windows", () => buildStairWindowGuards(ctx, railType, railMats));
  if (ctx.pitched) {
    const pitched = ctx.pitched;
    step("pitched roof", () => buildPitchedRoof(ctx, pitched, ext));
  } else {
    step("tank", () => buildTank(ctx, { plaster: ext, concrete: coping, pipe: M.get({ preset: "plastic", color: "#dcdad5" }) }));
    step("solar", () => {
      computeSolarRect(ctx);
      buildSolar(ctx);
    });
  }
  step("site", () =>
    buildSite(ctx, {
      wall: boundary,
      coping,
      gate,
      gateWood: M.get("wood_teak"),
      ground: (room) => (room ? M.get(floorSpecFor(room, o.floors), "paving") : M.get("paving")),
      platform: coping,
      base: M.get({ preset: "grass", color: "#4f6a33" }),
      lamp: M.emissive("#ffd9a0", 1.6),
    }),
  );
}
