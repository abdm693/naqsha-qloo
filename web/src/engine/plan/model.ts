/**
 * PlanModel: a normalized, forgiving view of a BuildingPlan. Argon's plans can be imperfect, so everything is
 * defaulted, clamped and snapped here (never throws). All values are plan FEET.
 */
import type { BuildingPlan, Opening, OpeningType, Rect, Room, RoomType, Stair } from "@contracts/plan";
import { CellGrid, rectContains } from "../core/grid";
import { clamp, num, warn } from "../core/util";

export type RoomCat = "enclosed" | "porch" | "deck" | "outdoor";
export type Side = "front" | "back" | "left" | "right";

export interface LevelM {
  id: string;
  name: string;
  index: number;
  /** finished floor level (ft above road crown) */
  elev: number;
  height: number;
  /** thickness of the slab ABOVE this level (its ceiling slab) */
  slab: number;
  /** FFL of the level above (or elev + height for the top) */
  next: number;
  isRoof: boolean;
  /** position in model.levels (bottom → top) */
  i: number;
}

export interface RoomM {
  id: string;
  name: string;
  type: RoomType;
  level: string;
  lv: LevelM;
  rect: Rect;
  cat: RoomCat;
  open: Set<string>;
  floorFinish?: Room["floor_finish"];
  /** finished floor height of this room (ft above road crown) */
  floorH: number;
  /** ceiling height, absolute (ft above road crown) */
  ceilH: number;
  /** synthesized rooms (mumty) */
  synthetic?: boolean;
  /** EN-F3: an upper-floor open space over a court below: no floor, no slab, open to the sky (cat "outdoor") */
  void?: boolean;
}

export interface OpeningM {
  id: string;
  level: string;
  type: OpeningType;
  at: [number, number];
  width: number;
  height: number;
  sill: number;
  between: [string, string];
  swing: "in" | "out";
  synthetic?: boolean;
}

export interface StairM {
  id: string;
  from: LevelM;
  to: LevelM;
  rect: Rect;
  kind: "dogleg" | "straight" | "l_shape";
  width: number;
  riser_in: number;
  tread_in: number;
  start: "+x" | "-x" | "+y" | "-y";
  /** added by the engine (e.g. the missing flight from the top storey to the roof) */
  synthetic?: boolean;
}

const DECK: RoomType[] = ["balcony", "terrace"];
const OUTDOOR: RoomType[] = ["lawn", "driveway", "open_space", "courtyard"];
const ROOM_TYPES: RoomType[] = [
  "drawing", "lounge", "dining", "kitchen", "dirty_kitchen", "bedroom", "master_bedroom", "guest_bedroom", "bath",
  "powder", "dressing", "study", "prayer", "store", "laundry", "servant", "stair", "lobby", "corridor", "porch",
  "garage", "balcony", "terrace", "courtyard", "lawn", "driveway", "open_space",
];

export function roomCat(t: RoomType): RoomCat {
  if (t === "porch") return "porch";
  if (DECK.includes(t)) return "deck";
  if (OUTDOOR.includes(t)) return "outdoor";
  return "enclosed";
}

const OPENING_DEFAULTS: Record<OpeningType, { w: number; h: number; sill: number }> = {
  main_door: { w: 4, h: 7.5, sill: 0 },
  door: { w: 3, h: 7, sill: 0 },
  double_door: { w: 5, h: 7.5, sill: 0 },
  sliding_door: { w: 8, h: 7.5, sill: 0 },
  window: { w: 5, h: 4.5, sill: 3 },
  corner_window: { w: 6, h: 5, sill: 2.5 },
  ventilator: { w: 2, h: 1.5, sill: 6 },
  arch: { w: 4, h: 7.5, sill: 0 },
  garage_door: { w: 9, h: 7.5, sill: 0 },
};
export const DOOR_TYPES: OpeningType[] = ["main_door", "door", "double_door", "sliding_door", "arch", "garage_door"];

const DEFAULT_PALETTE = ["#f4f1ec", "#8b877f", "#a26a3c", "#1f1f22", "#d9d3c7"];

export class PlanModel {
  readonly plan: BuildingPlan;
  readonly levels: LevelM[] = [];
  readonly levelById = new Map<string, LevelM>();
  readonly rooms: RoomM[] = [];
  readonly roomById = new Map<string, RoomM>();
  readonly openings: OpeningM[] = [];
  readonly stairs: StairM[] = [];
  readonly plotW: number;
  readonly plotD: number;
  /** yard / site grade inside the plot (ft above road crown) */
  readonly grade: number;
  readonly ground: LevelM;
  readonly roof: LevelM;
  /** the roof level is a floored attic under a pitched roof (enterAttic) */
  attic = false;
  readonly parapet: number;
  readonly palette: string[];
  private grids = new Map<string, CellGrid<RoomM>>();

  constructor(input: BuildingPlan) {
    const plan = (input ?? {}) as BuildingPlan;
    this.plan = plan;
    const site = (plan.site ?? {}) as BuildingPlan["site"];
    const rawRooms: Room[] = Array.isArray(plan.rooms) ? plan.rooms : [];

    // ── plot ────────────────────────────────────────────────────────────────────
    let maxX = 0, maxY = 0;
    for (const r of rawRooms) {
      if (!r?.rect) continue;
      maxX = Math.max(maxX, num(r.rect.x, 0) + num(r.rect.w, 0));
      maxY = Math.max(maxY, num(r.rect.y, 0) + num(r.rect.d, 0));
    }
    this.plotW = num(site.plot?.width_ft, Math.max(25, maxX), 10, 400);
    this.plotD = num(site.plot?.depth_ft, Math.max(40, maxY), 10, 600);
    this.parapet = num(plan.roof?.parapet_ft, 3.5, 0, 8);
    const pal = Array.isArray(plan.style?.palette) ? plan.style.palette.filter((c) => typeof c === "string" && /^#?[0-9a-f]{3,8}$/i.test(c.trim())) : [];
    this.palette = pal.length >= 3 ? pal.map((c) => (c.startsWith("#") ? c : `#${c}`)) : DEFAULT_PALETTE;

    // ── levels ──────────────────────────────────────────────────────────────────
    const rawLevels = Array.isArray(plan.levels) ? plan.levels.filter((l) => l && typeof l.id === "string") : [];
    const lv = rawLevels
      .map((l, k) => ({
        id: String(l.id),
        name: typeof l.name === "string" && l.name ? l.name : String(l.id),
        index: num(l.index, k),
        elev: num(l.elevation_ft, NaN),
        height: num(l.height_ft, 11, 2, 25),
        slab: num(l.slab_ft, 0.5, 0.3, 1.5),
      }))
      .sort((a, b) => a.index - b.index || (a.elev || 0) - (b.elev || 0));
    if (!lv.length) lv.push({ id: "ground", name: "Ground Floor", index: 0, elev: 1.5, height: 11, slab: 0.5 });
    // the roof level: last level named/id'd roof, or synthesize one
    const isRoofish = (l: { id: string; name: string }) => /roof/i.test(l.id) || /roof/i.test(l.name);
    let roofIdx = lv.findIndex(isRoofish);
    if (roofIdx >= 0 && roofIdx !== lv.length - 1) {
      const [r] = lv.splice(roofIdx, 1);
      lv.push(r);
    }
    if (roofIdx < 0) {
      const top = lv[lv.length - 1];
      lv.push({ id: "roof", name: "Roof", index: top.index + 1, elev: NaN, height: this.parapet, slab: top.slab });
      warn("plan has no roof level; synthesized one");
    }
    roofIdx = lv.length - 1;
    for (let k = 0; k < lv.length; k++) {
      const l = lv[k];
      if (k === 0) {
        if (!Number.isFinite(l.elev)) l.elev = 1.5;
        l.elev = clamp(l.elev, -20, 10);
      } else {
        const p = lv[k - 1];
        const want = p.elev + p.height;
        if (!Number.isFinite(l.elev) || l.elev < p.elev + 6 || l.elev > p.elev + 25) {
          if (Number.isFinite(l.elev)) warn(`level ${l.id}: elevation ${l.elev} inconsistent; using ${want}`);
          l.elev = want;
        }
      }
    }
    lv.forEach((l, k) => {
      const isRoof = k === roofIdx;
      const next = k + 1 < lv.length ? lv[k + 1].elev : l.elev + (isRoof ? Math.max(l.height, this.parapet) : l.height);
      const m: LevelM = { id: l.id, name: l.name, index: l.index, elev: l.elev, height: isRoof ? l.height : next - l.elev, slab: l.slab, next, isRoof, i: k };
      this.levels.push(m);
      this.levelById.set(m.id, m);
    });
    this.ground = this.levels.find((l) => l.index === 0 && !l.isRoof) ?? this.levels[0];
    this.roof = this.levels[this.levels.length - 1];
    this.grade = clamp(this.ground.elev - 1.0, 0, 0.5);

    // ── rooms (snap edges across levels so stacked walls align) ──────────────────
    const xsAll: number[] = [], ysAll: number[] = [];
    const prelim: { r: Room; rect: Rect; lv: LevelM }[] = [];
    const seen = new Set<string>();
    for (const r of rawRooms) {
      if (!r || typeof r !== "object" || !r.rect) continue;
      let l = this.levelById.get(String(r.level));
      if (!l) {
        warn(`room ${r.id}: unknown level "${r.level}", skipped`);
        continue;
      }
      if (l.isRoof && roomCat(r.type) === "outdoor") continue;
      const x = clamp(num(r.rect.x, 0), 0, this.plotW);
      const y = clamp(num(r.rect.y, 0), 0, this.plotD);
      const w = clamp(num(r.rect.w, 0), 0, this.plotW - x);
      const d = clamp(num(r.rect.d, 0), 0, this.plotD - y);
      if (w < 1 || d < 1) {
        warn(`room ${r.id}: degenerate rect, skipped`);
        continue;
      }
      let id = typeof r.id === "string" && r.id ? r.id : `room_${prelim.length}`;
      while (seen.has(id)) id += "_";
      seen.add(id);
      prelim.push({ r: { ...r, id }, rect: { x, y, w, d }, lv: l });
      xsAll.push(x, x + w);
      ysAll.push(y, y + d);
    }
    const snapX = clusterSnap([...xsAll, 0, this.plotW], 0.2);
    const snapY = clusterSnap([...ysAll, 0, this.plotD], 0.2);
    for (const p of prelim) {
      const x0 = snapX(p.rect.x), x1 = snapX(p.rect.x + p.rect.w);
      const y0 = snapY(p.rect.y), y1 = snapY(p.rect.y + p.rect.d);
      const type: RoomType = ROOM_TYPES.includes(p.r.type) ? p.r.type : "lounge";
      if (type !== p.r.type) warn(`room ${p.r.id}: unknown type "${p.r.type}", treated as lounge`);
      let cat = roomCat(type);
      if (cat === "outdoor" && p.lv !== this.ground) cat = "deck";
      const room: RoomM = {
        id: p.r.id,
        name: typeof p.r.name === "string" && p.r.name ? p.r.name : p.r.id,
        type,
        level: p.lv.id,
        lv: p.lv,
        rect: { x: x0, y: y0, w: Math.max(1, x1 - x0), d: Math.max(1, y1 - y0) },
        cat,
        open: new Set(Array.isArray(p.r.open_to) ? p.r.open_to.map(String) : []),
        floorFinish: p.r.floor_finish,
        floorH: 0,
        ceilH: 0,
      };
      this.rooms.push(room);
      this.roomById.set(room.id, room);
    }
    // EN-F3: an open space on an upper floor that sits over a court (a ground-floor open space or courtyard, or a void
    // over one) for more than half its area is a VOID: no floor, no slab, no privacy screens, the court below open to
    // the sky, and its edges against terraces or floors guarded like any drop. One over enclosed rooms stays a floored
    // light court (a deck, B.9).
    for (const r of [...this.rooms].sort((a, b) => a.lv.i - b.lv.i)) {
      if (r.lv === this.ground || r.lv.isRoof || (r.type !== "open_space" && r.type !== "courtyard")) continue;
      const below = this.levels[r.lv.i - 1];
      const court = (b: RoomM) => b.level === below.id && (b.void || (b.lv === this.ground && (b.type === "open_space" || b.type === "courtyard")));
      const over = this.rooms.filter(court).reduce((a, b) => a + overlapArea(r.rect, b.rect), 0);
      if (over > 0.5 * r.rect.w * r.rect.d) {
        r.cat = "outdoor";
        r.void = true;
      }
    }
    // symmetric open_to
    for (const r of this.rooms) for (const o of r.open) this.roomById.get(o)?.open.add(r.id);

    // ── roof: mumty as a synthetic enclosed room on the roof level ───────────────
    const mumty = plan.roof?.mumty;
    const mumtyH = num(mumty?.height_ft, 9.5, 7, 13);
    this.mumtyHeight = mumtyH;
    // (the structure model later reconciles this rect with the stair as laid out: it always covers the top flight
    // and its top landing, and an enclosed roof room that contains the top stair is used as the tower instead)
    const mr0 = mumty?.rect;
    const overlapsRoofRoom = (x: number, y: number, w: number, d: number) =>
      this.rooms.some((r) => r.level === this.roof.id && r.cat === "enclosed" && r.rect.x < x + w - 0.5 && x < r.rect.x + r.rect.w - 0.5 && r.rect.y < y + d - 0.5 && y < r.rect.y + r.rect.d - 0.5);
    if (mr0 && !overlapsRoofRoom(num(mr0.x, 0), num(mr0.y, 0), num(mr0.w, 8), num(mr0.d, 12))) {
      const mr = mumty.rect;
      const rect = {
        x: snapX(clamp(num(mr.x, 0), 0, this.plotW)),
        y: snapY(clamp(num(mr.y, 0), 0, this.plotD)),
        w: num(mr.w, 8, 4, 30),
        d: num(mr.d, 12, 4, 30),
      };
      rect.w = snapX(rect.x + rect.w) - rect.x;
      rect.d = snapY(rect.y + rect.d) - rect.y;
      const room: RoomM = {
        id: "roof_mumty", name: "Mumty (stair tower)", type: "stair", level: this.roof.id, lv: this.roof, rect, cat: "enclosed",
        open: new Set(), floorFinish: "marble", floorH: 0, ceilH: 0, synthetic: true,
      };
      this.rooms.push(room);
      this.roomById.set(room.id, room);
    }

    // floor + ceiling heights
    for (const r of this.rooms) this.setHeights(r, rawRooms.find((x) => x && x.id === r.id));

    // ── openings ────────────────────────────────────────────────────────────────
    const ops: Opening[] = Array.isArray(plan.openings) ? plan.openings : [];
    ops.forEach((o, k) => {
      if (!o || typeof o !== "object") return;
      const l = this.levelById.get(String(o.level));
      if (!l) {
        warn(`opening ${o.id}: unknown level "${o.level}", skipped`);
        return;
      }
      const type: OpeningType = (OPENING_DEFAULTS as Record<string, unknown>)[o.type] ? o.type : "window";
      const d = OPENING_DEFAULTS[type];
      const at = Array.isArray(o.at) ? o.at : [NaN, NaN];
      const ax = num(at[0], NaN), ay = num(at[1], NaN);
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
        warn(`opening ${o.id}: invalid "at", skipped`);
        return;
      }
      const isDoor = DOOR_TYPES.includes(type);
      const between = (Array.isArray(o.between) ? o.between.map(String) : []) as string[];
      this.openings.push({
        id: typeof o.id === "string" && o.id ? o.id : `op_${k}`,
        level: l.id,
        type,
        at: [ax, ay],
        width: num(o.width_ft, d.w, 1, 30),
        height: num(o.height_ft, d.h, 0.8, 12),
        sill: isDoor ? 0 : num(o.sill_ft, d.sill, 0, 9),
        between: [between[0] ?? "", between[1] ?? "exterior"],
        swing: o.swing === "out" ? "out" : "in",
      });
    });

    // ── stairs ──────────────────────────────────────────────────────────────────
    const st: Stair[] = Array.isArray(plan.stairs) ? plan.stairs : [];
    for (const s of st) {
      if (!s || typeof s !== "object") continue;
      const from = this.levelById.get(String(s.from_level));
      const to = this.levelById.get(String(s.to_level));
      if (!from || !to || to.elev <= from.elev) {
        warn(`stair ${s.id}: invalid levels, skipped`);
        continue;
      }
      let rect: Rect | null = null;
      if (s.rect && [s.rect.x, s.rect.y, s.rect.w, s.rect.d].every((v) => Number.isFinite(Number(v)))) {
        rect = { x: num(s.rect.x, 0), y: num(s.rect.y, 0), w: num(s.rect.w, 7, 2.5, 40), d: num(s.rect.d, 11, 2.5, 40) };
      }
      if (!rect) {
        const sr = this.rooms.find((r) => r.level === from.id && r.type === "stair");
        if (!sr) {
          warn(`stair ${s.id}: no rect and no stair room, skipped`);
          continue;
        }
        rect = { x: sr.rect.x + 0.375, y: sr.rect.y + 0.375, w: sr.rect.w - 0.75, d: sr.rect.d - 0.75 };
      }
      const kind = s.kind === "straight" || s.kind === "l_shape" ? s.kind : "dogleg";
      this.stairs.push({
        id: typeof s.id === "string" ? s.id : `stair_${this.stairs.length}`,
        from,
        to,
        rect,
        kind,
        width: num(s.width_ft, 3.5, 2.5, 8),
        riser_in: num(s.riser_in, 7, 4, 9),
        tread_in: num(s.tread_in, 10, 8, 16),
        start: ["+x", "-x", "+y", "-y"].includes(s.start) ? s.start : "+y",
      });
    }
  }

  readonly mumtyHeight: number;

  private setHeights(r: RoomM, src?: Room): void {
    const l = r.lv;
    if (l === this.ground || l.i === 0) {
      if (r.cat === "outdoor") r.floorH = this.grade;
      else if (r.cat === "porch") r.floorH = Math.max(this.grade + 0.25, l.elev - 0.5);
      else r.floorH = l.elev;
    } else r.floorH = l.elev;
    const slabBottom = l.next - l.slab;
    if (l.isRoof) r.ceilH = l.elev + this.mumtyHeight - l.slab;
    else if (r.cat === "enclosed" && src?.ceiling_height_ft) r.ceilH = clamp(r.floorH + num(src.ceiling_height_ft, 10), r.floorH + 7, slabBottom);
    else r.ceilH = slabBottom;
  }

  /**
   * Under a pitched roof the roof level is an attic: no stair tower or roof room stands on it (their walls would come up
   * through the roof), and the stair arrives on the open slab behind a guard rail.
   */
  enterAttic(): void {
    this.attic = true;
    for (let i = this.rooms.length - 1; i >= 0; i--) {
      const r = this.rooms[i];
      if (!r.lv.isRoof || r.cat !== "enclosed") continue;
      this.rooms.splice(i, 1);
      this.roomById.delete(r.id);
    }
    for (let i = this.openings.length - 1; i >= 0; i--) if (this.openings[i].level === this.roof.id) this.openings.splice(i, 1);
    this.grids.delete(this.roof.id);
  }

  /** Add a synthesized room (e.g. the stair tower) after construction; level grids are rebuilt lazily. */
  addRoom(room: RoomM): void {
    this.rooms.push(room);
    this.roomById.set(room.id, room);
    this.setHeights(room);
    this.grids.delete(room.level);
  }

  /** Replace a room's rect (e.g. when the stair tower grows to cover the stair as laid out). */
  setRoomRect(room: RoomM, rect: Rect): void {
    room.rect = { ...rect };
    this.grids.delete(room.level);
  }

  /** Synthesized stair (e.g. a missing top flight to the roof). */
  addStair(s: StairM): void {
    this.stairs.push(s);
  }

  get storeys(): LevelM[] {
    return this.levels.filter((l) => !l.isRoof);
  }
  levelAbove(l: LevelM): LevelM | null {
    return this.levels[l.i + 1] ?? null;
  }
  levelBelow(l: LevelM): LevelM | null {
    return l.i > 0 ? this.levels[l.i - 1] : null;
  }
  roomsOn(levelId: string): RoomM[] {
    return this.rooms.filter((r) => r.level === levelId);
  }
  room(id: string): RoomM | undefined {
    return this.roomById.get(id);
  }

  /** Grid of rooms on a level (priority: enclosed > porch > deck > outdoor, then smaller area). */
  grid(levelId: string): CellGrid<RoomM> {
    let g = this.grids.get(levelId);
    if (!g) {
      const pri: Record<RoomCat, number> = { enclosed: 0, porch: 1, deck: 2, outdoor: 3 };
      const items = this.roomsOn(levelId)
        .slice()
        .sort((a, b) => pri[b.cat] - pri[a.cat] || b.rect.w * b.rect.d - a.rect.w * a.rect.d)
        .map((r) => ({ rect: r.rect, val: r }));
      g = CellGrid.fromRects(items, undefined, [0, this.plotW], [0, this.plotD]);
      this.grids.set(levelId, g);
    }
    return g;
  }

  /** Room containing plan point (x, y) on a level. */
  roomAt(levelId: string, x: number, y: number): RoomM | null {
    const g = this.grid(levelId);
    const v = g.valueAt(x, y);
    if (v) return v;
    // fall back to a direct test (points exactly on outer edges)
    for (const r of this.roomsOn(levelId)) if (rectContains(r.rect, x, y)) return r;
    return null;
  }

  isOpen(a: RoomM | null, b: RoomM | null): boolean {
    return !!a && !!b && (a.open.has(b.id) || b.open.has(a.id));
  }
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y));
}

/** Cluster nearby coordinates (within tol) and return a snapping function to each cluster's most common value. */
function clusterSnap(vals: number[], tol: number): (v: number) => number {
  const s = vals.filter(Number.isFinite).map((v) => Math.round(v * 1000) / 1000).sort((a, b) => a - b);
  const reps: { lo: number; hi: number; rep: number }[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] - s[j] <= tol) j++;
    const counts = new Map<number, number>();
    for (let k = i; k <= j; k++) counts.set(s[k], (counts.get(s[k]) ?? 0) + 1);
    let rep = s[i], best = -1;
    for (const [v, c] of counts) if (c > best || (c === best && Math.abs(v - Math.round(v * 2) / 2) < Math.abs(rep - Math.round(rep * 2) / 2))) { rep = v; best = c; }
    reps.push({ lo: s[i], hi: s[j], rep });
    i = j + 1;
  }
  return (v: number) => {
    const r = Math.round(v * 1000) / 1000;
    for (const c of reps) if (r >= c.lo - 1e-6 && r <= c.hi + 1e-6) return c.rep;
    return r;
  };
}

export function sideOfRect(r: Rect, side: Side): { axis: "x" | "y"; c: number; a: number; b: number } {
  switch (side) {
    case "front": return { axis: "x", c: r.y, a: r.x, b: r.x + r.w };
    case "back": return { axis: "x", c: r.y + r.d, a: r.x, b: r.x + r.w };
    case "left": return { axis: "y", c: r.x, a: r.y, b: r.y + r.d };
    default: return { axis: "y", c: r.x + r.w, a: r.y, b: r.y + r.d };
  }
}
