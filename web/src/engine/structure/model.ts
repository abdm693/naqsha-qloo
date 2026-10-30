/**
 * StructureModel: derives walls, junctions, openings, stair layouts, slabs, parapets and facade surfaces
 * from the PlanModel. Pure geometry in plan feet; no THREE objects here.
 */
import { CellGrid, expandRect, rectContains, type R } from "../core/grid";
import { NoteLog } from "../core/notes";
import { clamp, warn } from "../core/util";
import { DOOR_TYPES, type LevelM, type OpeningM, type PlanModel, type RoomM, type Side } from "../plan/model";
import { ensureStairChain, layoutStairs, reconcileTower, type StairLayout, type TowerDoor } from "./stairs-plan";
import { openingName } from "./labels";
export type { Flight, StairLayout, TowerDoor } from "./stairs-plan";

export const EXT_T = 0.75;
export const INT_T = 0.375;
export const FINISH = 0.04;
export const PLINTH_PROUD = 0.08;
const EPS = 1e-3;
const near = (a: number, b: number, e = EPS) => Math.abs(a - b) <= e;

export type Cap = { kind: "none" } | { kind: "full"; h0?: number } | { kind: "strips"; strips: [number, number][] };

export interface WallRun {
  id: string;
  level: LevelM;
  axis: "x" | "y";
  c: number;
  a: number;
  b: number;
  t: number;
  kind: "exterior" | "interior" | "parapet" | "boundary";
  neg: RoomM | null;
  pos: RoomM | null;
  /** side that is outside: -1 neg, +1 pos, 0 interior */
  out: -1 | 0 | 1;
  ea: number;
  eb: number;
  capA: Cap;
  capB: Cap;
  /** thickness of perpendicular walls meeting each end (0 = none) */
  perpA?: number;
  perpB?: number;
  h0: number;
  h1: number;
  openings: PlacedOpening[];
  topExposed: boolean;
}

export interface PlacedOpening {
  op: OpeningM;
  run: WallRun;
  u0: number;
  u1: number;
  /** absolute heights (ft) of the hole */
  bottom: number;
  top: number;
  /** room floor height the opening relates to */
  floor: number;
  swingSide: -1 | 1;
  hingeAtA: boolean;
  /** frame plane offset from the wall centerline (ft, signed in the run's across axis) */
  frameOff: number;
  isDoor: boolean;
  /** EN-F2: the rooms on the run's neg / pos side AT this opening. An exterior run keeps one enclosed room along its
   *  length but may face several outdoor rooms or terraces (its own neg/pos is only the first one), so code that asks
   *  "which room does this opening join" reads these, never `run.neg` / `run.pos`. */
  neg: RoomM | null;
  pos: RoomM | null;
}

export interface EdgeFeature {
  level: LevelM;
  kind: "porch" | "deck";
  axis: "x" | "y";
  c: number;
  a: number;
  b: number;
  room: RoomM;
  out: -1 | 1;
}

/** EN-05: a full-height privacy screen where two outdoor rooms (balconies, terraces) on an upper level meet without
 *  being open to each other, so neither becomes a way from one bedroom into another. */
export interface PrivacyScreen {
  level: LevelM;
  axis: "x" | "y";
  c: number;
  a: number;
  b: number;
  neg: RoomM;
  pos: RoomM;
}

export interface SlabSpec {
  /** level whose floor this slab is (the level above the gap) */
  level: LevelM;
  grid: CellGrid<boolean>;
  top: number;
  bottom: number;
}

export interface FacadeSurf {
  side: Side;
  plane: number;
  u0: number;
  u1: number;
  h0: number;
  h1: number;
  level: string;
  kind: "wall" | "slab" | "parapet" | "plinth";
}

export class StructureModel {
  readonly plan: PlanModel;
  readonly runs: WallRun[] = [];
  readonly runsByLevel = new Map<string, WallRun[]>();
  readonly edges: EdgeFeature[] = [];
  readonly screens: PrivacyScreen[] = [];
  /** EN-06 b: guard rails across window glass that comes within 3 ft of a flight or landing beside it (plan ft;
   *  the rail runs along `axis` at `c` from a to b, its base following the stair from ha to hb) */
  readonly stairGuards: { level: string; axis: "x" | "y"; c: number; a: number; b: number; ha: number; hb: number; op: string }[] = [];
  readonly openings: PlacedOpening[] = [];
  readonly stairs: StairLayout[] = [];
  readonly slabs: SlabSpec[] = [];
  readonly parapets: WallRun[] = [];
  plinth!: CellGrid<number>;
  readonly surfaces: FacadeSurf[] = [];
  /** as-built notes: what the engine repaired or could not repair */
  readonly notes = new NoteLog();
  /** the stair tower's door at the top landing (null when no stair reaches the roof and the plan has no mumty) */
  tower: TowerDoor | null = null;
  /** building footprint on the lowest level (rect list, expanded to wall faces) */
  footprint: R[] = [];
  /**
   * Projection envelope (plan ft): how far slabs, copings, plinths, canopies, cladding and other projections may
   * reach. On a plot edge the building touches (zero setback, i.e. a party wall) nothing may pass the outer
   * wall face (EXT_T/2 beyond the room edge). Towards a real open space a projection may reach 1.5 ft past the
   * building line where that space is under 10 ft, 3 ft where it is 10 ft or more, and never past the plot edge.
   */
  envelope: { x0: number; x1: number; y0: number; y1: number; party: Record<Side, boolean> } = {
    x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity, party: { front: false, back: false, left: false, right: false },
  };

  constructor(plan: PlanModel) {
    this.plan = plan;
    this.computeEnvelope();
    // stairs first: the stair tower grows to cover the stair as laid out before any wall is derived
    ensureStairChain(plan, this.notes);
    this.stairs.push(...layoutStairs(plan, this.notes));
    this.tower = plan.attic ? null : reconcileTower(plan, this.stairs, this.envelope, this.notes);
    for (const lv of plan.levels) {
      const runs = this.computeRuns(lv);
      this.runsByLevel.set(lv.id, runs);
      this.runs.push(...runs);
    }
    this.computeParapets();
    for (const lv of plan.levels) resolveJunctions(this.runsByLevel.get(lv.id) ?? []);
    this.placeOpenings();
    this.checkStairWindows();
    this.checkTowerDoor();
    this.computeSlabs();
    this.computePlinth();
    this.computeSurfaces();
  }

  // ── walls ──────────────────────────────────────────────────────────────────────────────────────────
  private computeRuns(lv: LevelM): WallRun[] {
    const plan = this.plan;
    const g = plan.grid(lv.id);
    const isOut = (r: RoomM | null) => !r || r.cat === "outdoor";
    type K = { kind: "interior" | "exterior" | "porch" | "deck" | "screen"; out: -1 | 0 | 1; room?: RoomM };
    const kinds = new Map<string, K>();
    const er = g.edgeRuns((neg, pos) => {
      if (neg === pos) return null;
      const en = neg?.cat === "enclosed", ep = pos?.cat === "enclosed";
      let k: K | null = null;
      let key = "";
      if (en && ep) {
        if (plan.isOpen(neg, pos)) return null;
        k = { kind: "interior", out: 0 };
        key = `int|${neg!.id}|${pos!.id}`;
      } else if (en || ep) {
        k = { kind: "exterior", out: en ? 1 : -1 };
        key = `ext|${(en ? neg : pos)!.id}|${k.out}`;
      } else if (lv.i > 0 && neg?.cat === "deck" && pos?.cat === "deck" && !plan.isOpen(neg, pos)) {
        k = { kind: "screen", out: 0 };
        key = `screen|${neg.id}|${pos.id}`;
      } else if (!lv.isRoof) {
        if (neg?.cat === "porch" && isOut(pos)) k = { kind: "porch", out: 1, room: neg };
        else if (pos?.cat === "porch" && isOut(neg)) k = { kind: "porch", out: -1, room: pos };
        else if (neg?.cat === "deck" && (isOut(pos) || pos?.cat === "porch")) k = { kind: "deck", out: 1, room: neg };
        else if (pos?.cat === "deck" && (isOut(neg) || neg?.cat === "porch")) k = { kind: "deck", out: -1, room: pos };
        if (k) key = `${k.kind}|${k.room!.id}|${k.out}`;
      }
      if (!k) return null;
      kinds.set(key, k);
      return key;
    });
    const runs: WallRun[] = [];
    for (const e of er) {
      const k = kinds.get(e.key)!;
      if (e.b - e.a < 0.05) continue;
      if (k.kind === "porch" || k.kind === "deck") {
        this.edges.push({ level: lv, kind: k.kind, axis: e.axis, c: e.c, a: e.a, b: e.b, room: k.room!, out: k.out as -1 | 1 });
        continue;
      }
      if (k.kind === "screen") {
        if (e.neg && e.pos) this.screens.push({ level: lv, axis: e.axis, c: e.c, a: e.a, b: e.b, neg: e.neg, pos: e.pos });
        continue;
      }
      const neg = e.neg, pos = e.pos;
      const floors = [neg, pos].filter((r): r is RoomM => !!r && r.cat !== "outdoor").map((r) => r.floorH);
      const floor = floors.length ? Math.max(...floors) : lv.elev;
      let h1 = lv.next - lv.slab;
      if (lv.isRoof) h1 = lv.elev + this.plan.mumtyHeight - lv.slab;
      runs.push({
        id: `wall_${lv.id}_${runs.length}`,
        level: lv,
        axis: e.axis,
        c: e.c,
        a: e.a,
        b: e.b,
        t: k.kind === "exterior" ? EXT_T : INT_T,
        kind: k.kind,
        neg,
        pos,
        out: k.out,
        ea: e.a,
        eb: e.b,
        capA: { kind: "none" },
        capB: { kind: "none" },
        h0: floor - FINISH,
        h1: Math.max(floor + 6, h1),
        openings: [],
        topExposed: false,
      });
    }
    return runs;
  }

  /** Parapets around exposed roofs (the main roof and any lower roof not covered by the storey above). */
  private computeParapets(): void {
    const plan = this.plan;
    for (const U of plan.levels) {
      if (U.i === 0) continue;
      const L = plan.levels[U.i - 1];
      const below = plan.roomsOn(L.id).filter((r) => r.cat === "enclosed" || r.cat === "porch");
      // a roof terrace (a deck on the roof level) stands behind the roof parapet like the rest of the roof
      const upper = plan.roomsOn(U.id).filter((r) => r.cat !== "outdoor" && !(U.isRoof && r.cat === "deck"));
      if (!below.length) continue;
      type V = "x" | "r";
      const items: { rect: R; val: V }[] = [
        ...below.map((r) => ({ rect: r.rect, val: "x" as V })),
        ...upper.map((r) => ({ rect: r.rect, val: "r" as V })),
      ];
      const g = CellGrid.fromRects<V>(items, (a, b) => (a === "r" || b === "r" ? "r" : "x"));
      const height = U.isRoof ? plan.parapet : Math.min(plan.parapet, 3.0);
      if (height <= 0.2) continue;
      const er = g.edgeRuns((neg, pos) => {
        if (neg === "x" && pos === null) return "p+";
        if (pos === "x" && neg === null) return "p-";
        return null;
      });
      for (const e of er) {
        const run: WallRun = {
          id: `parapet_${U.id}_${this.parapets.length}`,
          level: U,
          axis: e.axis,
          c: e.c,
          a: e.a,
          b: e.b,
          t: EXT_T,
          kind: "parapet",
          neg: null,
          pos: null,
          out: e.key === "p+" ? 1 : -1,
          ea: e.a,
          eb: e.b,
          capA: { kind: "none" },
          capB: { kind: "none" },
          h0: U.elev - FINISH,
          h1: U.elev + height,
          openings: [],
          topExposed: !(U.isRoof && plan.attic), // under a pitched roof it is a knee wall: the soffit covers it
        };
        this.parapets.push(run);
        const arr = this.runsByLevel.get(U.id) ?? [];
        arr.push(run);
        this.runsByLevel.set(U.id, arr);
      }
    }
  }

  // ── openings ───────────────────────────────────────────────────────────────────────────────────────
  private placeOpenings(): void {
    const plan = this.plan;
    const list = [...plan.openings];
    // the stair tower's door, at the top landing (B.3); kept unless a plan door on the tower already opens onto it
    const tw = this.tower;
    if (tw) {
      const own = list.some(
        (o) => o.level === tw.room.level && DOOR_TYPES.includes(o.type) && o.between.includes(tw.room.id) && Math.hypot(o.at[0] - tw.at[0], o.at[1] - tw.at[1]) < 2.2,
      );
      if (!own) list.push({ id: "roof_mumty_door", level: tw.room.level, type: "door", at: tw.at, width: tw.width, height: 7, sill: 0, between: [tw.room.id, "exterior"], swing: "out", synthetic: true });
    }
    // EN-01: doors claim their stretch of wall first (the main door before all), windows fit around them
    const rank = (o: OpeningM) => (o.type === "main_door" ? 0 : DOOR_TYPES.includes(o.type) ? 1 : 2);
    list.sort((p, q) => rank(p) - rank(q));
    for (const op of list) {
      // B.7: an opening joins rooms on its own level, and is cut only into the wall between exactly those rooms
      const named = op.between.filter((b) => b && b !== "exterior");
      const other = named.map((id) => plan.room(id)).filter((r): r is RoomM => !!r && r.level !== op.level);
      if (other.length) {
        this.skipOpening(op, `${this.openingLabel(op)} couldn't be built: it joins rooms on different floors.`);
        continue;
      }
      const known = named.filter((id) => plan.room(id));
      const wantExt = op.between.includes("exterior");
      const runs = (this.runsByLevel.get(op.level) ?? []).filter((r) => r.kind === "exterior" || r.kind === "interior");
      let best: { run: WallRun; score: number; along: number; pair: [RoomM | null, RoomM | null] } | null = null;
      for (const run of runs) {
        const along = run.axis === "x" ? op.at[0] : op.at[1];
        const across = run.axis === "x" ? op.at[1] : op.at[0];
        const dA = Math.abs(across - run.c);
        const dL = along < run.a ? run.a - along : along > run.b ? along - run.b : 0;
        if (dA > 1.5 || dL > 1.5) continue;
        // EN-F2: the rooms either side of the wall at the opening itself (an exterior wall can face several outdoor
        // rooms); the run's own pair is still accepted, so nothing that matched before is skipped now
        let pair = this.roomsAcross(run, along);
        if (!known.every((id) => pair[0]?.id === id || pair[1]?.id === id)) {
          if (!known.every((id) => run.neg?.id === id || run.pos?.id === id)) continue;
          pair = [run.neg, run.pos];
        }
        if (wantExt && run.kind !== "exterior") continue;
        const score = Math.hypot(dA, dL);
        if (!best || score < best.score) best = { run, score, along, pair };
      }
      if (!best) {
        // openings on porch/deck edges are simply open; anything else is reported
        const onEdge = this.edges.some((e) => e.level.id === op.level && distToEdge(e, op.at) < 1.5);
        // EN2-05: between rooms that are open to each other there is no wall to cut: the edge is walkable already
        const rs = known.map((id) => plan.room(id) ?? null);
        const openPlan = rs.length === 2 && plan.isOpen(rs[0], rs[1]);
        if (openPlan) warn(`opening ${op.id}: ${op.between.join(" / ")} are open-plan; no wall to cut, skipped`);
        else if (!onEdge) this.skipOpening(op, `${this.openingLabel(op)} couldn't be built: ${known.length >= 2 ? "those rooms don't share a wall" : "that room has no outside wall there"}.`);
        continue;
      }
      const run = best.run;
      const [pNeg, pPos] = best.pair;
      const isDoor = DOOR_TYPES.includes(op.type);
      const mA = run.perpA ? run.perpA / 2 + 0.12 : 0.06;
      const mB = run.perpB ? run.perpB / 2 + 0.12 : 0.06;
      const avail = run.b - run.a - mA - mB;
      const label = this.openingLabel(op);
      let w = op.width;
      if (w > avail) {
        if (avail < 1.2) {
          this.skipOpening(op, `${label} couldn't be built: its wall is only ${Math.max(0, run.b - run.a).toFixed(1)} ft long.`, isDoor ? "fail" : "warn");
          continue;
        }
        warn(`opening ${op.id}: narrowed from ${w} to ${avail.toFixed(2)} ft to fit its wall`);
        w = avail;
      }
      const lo = run.a + mA, hi = run.b - mB;
      const want = clamp(best.along - w / 2, lo, hi - w);
      // where an opening of width ww could go without crowding the others on this run (0.3 ft apart): the free gaps
      const gaps = (others: PlacedOpening[]): [number, number][] => {
        const out: [number, number][] = [];
        let a = lo;
        for (const o of [...others].sort((p, q) => p.u0 - q.u0)) {
          if (o.u0 - 0.3 > a) out.push([a, Math.min(hi, o.u0 - 0.3)]);
          a = Math.max(a, o.u1 + 0.3);
        }
        if (hi > a) out.push([a, hi]);
        return out.filter(([p, q]) => q - p > 0.05);
      };
      /** best spot for an opening of width ww (up to wMax, down to wMin) near `pref`: [u0, width] */
      const fit = (others: PlacedOpening[], pref: number, wMax: number, wMin: number, narrowCost: number): [number, number] | null => {
        let bestFit: { u0: number; w: number; cost: number } | null = null;
        for (const [p, q] of gaps(others)) {
          const ww = Math.min(wMax, q - p);
          if (ww < wMin - 1e-6) continue;
          const u = clamp(pref + (wMax - ww) / 2, p, q - ww);
          const cost = Math.abs(u + ww / 2 - (pref + wMax / 2)) + (wMax - ww) * narrowCost;
          if (!bestFit || cost < bestFit.cost) bestFit = { u0: u, w: ww, cost };
        }
        return bestFit ? [bestFit.u0, bestFit.w] : null;
      };
      let u0 = want;
      const clash = (a: number, ww: number) => run.openings.some((o) => a < o.u1 + 0.3 && a + ww > o.u0 - 0.3);
      if (clash(u0, w)) {
        // shift (full width), else narrow: windows down to 1.5 ft, doors down to 2.5 ft; a door may also make
        // a window on the same run give way (narrow or shift it) before the door itself is ever left out
        const wMin = isDoor ? Math.min(w, 2.5) : Math.min(w, 1.5);
        let spot = isDoor ? fit(run.openings, want, w, w, 0) ?? fit(run.openings, want, w, wMin, 2) : fit(run.openings, want, w, wMin, 1.5);
        if (!spot && isDoor) {
          const doors = run.openings.filter((o) => o.isDoor);
          const door = fit(doors, want, w, wMin, 2);
          if (door) {
            const [du0, dw] = door;
            const mine: PlacedOpening = { op, run, u0: du0, u1: du0 + dw, bottom: 0, top: 0, floor: 0, swingSide: 1, hingeAtA: true, frameOff: 0, isDoor: true, neg: pNeg, pos: pPos };
            // re-fit every window that now clashes with this door, around the doors and the other windows
            const wins = run.openings.filter((o) => !o.isDoor && du0 < o.u1 + 0.3 && du0 + dw > o.u0 - 0.3);
            let ok = true;
            for (const win of wins) {
              const rest = run.openings.filter((o) => o !== win);
              const ww0 = win.u1 - win.u0;
              const f = fit([...rest, mine], win.u0, ww0, Math.min(ww0, 1.5), 2);
              if (!f) {
                ok = false;
                break;
              }
              win.u0 = f[0];
              win.u1 = f[0] + f[1];
              this.notes.add({ id: `asbuilt.opening_moved:${win.op.id}`, title: "Window adjusted", status: "warn", message: `${this.openingLabel(win.op)} was ${f[1] < ww0 - 0.05 ? `narrowed to ${f[1].toFixed(1)} ft` : "moved along its wall"} to make room for a door.`, element_ids: [win.op.id, op.id] });
            }
            if (!ok) {
              // the window cannot shrink enough: leave the window out rather than the door
              for (const win of run.openings.filter((o) => !o.isDoor && du0 < o.u1 + 0.3 && du0 + dw > o.u0 - 0.3)) {
                run.openings.splice(run.openings.indexOf(win), 1);
                this.openings.splice(this.openings.indexOf(win), 1);
                this.skipOpening(win.op, `${this.openingLabel(win.op)} was left out to make room for a door.`, "warn");
              }
            }
            run.openings.sort((p, q) => p.u0 - q.u0);
            spot = door;
          }
        }
        if (!spot) {
          this.skipOpening(op, `${label} couldn't be built: another opening fills that stretch of wall.`, isDoor ? "fail" : "warn");
          continue;
        }
        if (spot[1] < w - 0.05) warn(`opening ${op.id}: narrowed from ${w.toFixed(2)} to ${spot[1].toFixed(2)} ft beside its neighbour`);
        [u0, w] = spot;
      }
      const rooms = [pNeg, pPos].filter((r): r is RoomM => !!r && r.cat !== "outdoor");
      const r0 = plan.room(op.between[0]);
      const floor = r0 && rooms.includes(r0) ? r0.floorH : rooms.length ? Math.max(...rooms.map((r) => r.floorH)) : run.h0 + FINISH;
      const wallFloor = run.h0 + FINISH;
      let bottom = isDoor ? run.h0 : Math.max(wallFloor + 0.2, floor + op.sill);
      let top = (isDoor ? wallFloor : floor + op.sill) + op.height;
      top = Math.min(top, run.h1 - 0.35);
      if (top - bottom < 0.8) {
        bottom = Math.max(run.h0, top - 0.8);
        if (top - bottom < 0.8) {
          this.skipOpening(op, `${label} couldn't be built: its wall is too low.`, isDoor ? "fail" : "warn");
          continue;
        }
      }
      // swing side
      const target = op.swing === "out" ? op.between[1] : op.between[0];
      let swingSide: -1 | 1;
      if (pNeg?.id === target) swingSide = -1;
      else if (pPos?.id === target) swingSide = 1;
      else if (run.out !== 0) swingSide = (-run.out) as -1 | 1;
      else swingSide = pNeg && pNeg.cat === "enclosed" ? -1 : 1;
      if (op.swing === "out" && run.out !== 0 && target === "exterior") swingSide = run.out as -1 | 1;
      // a tiny WC or bath (under 36 sq ft): its door opens outward, as architects draw it,
      // so the leaf never sweeps over the WC or basin
      const into = swingSide < 0 ? pNeg : pPos;
      const away = swingSide < 0 ? pPos : pNeg;
      if (into && (into.type === "powder" || into.type === "bath") && into.rect.w * into.rect.d < 36 && away && away.cat === "enclosed" && !(away.type === "powder" || away.type === "bath"))
        swingSide = (-swingSide) as -1 | 1;
      const hingeAtA = u0 - run.a <= run.b - (u0 + w);
      const frameOff = run.out !== 0 && !isDoor ? run.out * run.t * 0.18 : run.out !== 0 && op.type === "sliding_door" ? run.out * run.t * 0.12 : 0;
      const po: PlacedOpening = { op, run, u0, u1: u0 + w, bottom, top, floor, swingSide, hingeAtA, frameOff, isDoor, neg: pNeg, pos: pPos };
      run.openings.push(po);
      run.openings.sort((p, q) => p.u0 - q.u0);
      this.openings.push(po);
    }
  }

  /**
   * EN-06 b: a window beside a flight or a landing must keep its glass at least 3 ft above the treads (the pitch
   * line) or the landing. Its sill is raised when that still leaves 2 ft of glass; otherwise a guard rail is added
   * across the glazing. Both are reported.
   */
  private checkStairWindows(): void {
    for (const lay of this.stairs) {
      const lv = lay.stair.from.id;
      for (const o of this.openings) {
        if (o.isDoor || o.op.level !== lv) continue;
        const run = o.run;
        type Surf = { a: number; b: number; h: (u: number) => number; pitch: (u: number) => number; side: number };
        const surfs: Surf[] = [];
        for (const f of lay.flights) {
          if (f.axis !== run.axis) continue;
          const mid = (f.c0 + f.c1) / 2;
          const dir = run.c > mid ? 1 : -1;
          const face = run.c - (dir * run.t) / 2;
          const edge = dir > 0 ? f.c1 : f.c0;
          if (Math.abs(face - edge) > 0.7) continue;
          const s1 = f.s0 + f.sign * f.n * f.tread;
          const k = (u: number) => clamp(Math.floor(((u - f.s0) * f.sign) / f.tread), 0, f.n - 1);
          surfs.push({
            a: Math.min(f.s0, s1), b: Math.max(f.s0, s1), side: face - dir * 0.15,
            h: (u) => f.h0 + (k(u) + 1) * f.riser,
            pitch: (u) => f.h0 + clamp(((u - f.s0) * f.sign) / f.tread + 1, 1, f.n) * f.riser,
          });
        }
        for (const L of lay.landings) {
          const r = L.rect;
          const mid = run.axis === "x" ? r.y + r.d / 2 : r.x + r.w / 2;
          const dir = run.c > mid ? 1 : -1;
          const face = run.c - (dir * run.t) / 2;
          const edge = run.axis === "x" ? (dir > 0 ? r.y + r.d : r.y) : dir > 0 ? r.x + r.w : r.x;
          if (Math.abs(face - edge) > 0.7) continue;
          const [a, b] = run.axis === "x" ? [r.x, r.x + r.w] : [r.y, r.y + r.d];
          surfs.push({ a, b, side: face - dir * 0.15, h: () => L.h, pitch: () => L.h });
        }
        if (!surfs.length) continue;
        // the stretches where the glass comes within 3 ft of the surface beside it
        let worst = -Infinity;
        const spans: { s: Surf; a: number; b: number }[] = [];
        for (const sf of surfs) {
          const a = Math.max(o.u0, sf.a), b = Math.min(o.u1, sf.b);
          if (b - a < 0.1) continue;
          let cur: number | null = null;
          for (let u = a; u <= b + 1e-6; u += 0.25) {
            const h = sf.h(u);
            const bad = o.bottom < h + 3 - 0.05 && o.top > h + 0.3;
            if (bad) worst = Math.max(worst, h);
            if (bad && cur === null) cur = u;
            if ((!bad || u + 0.25 > b + 1e-6) && cur !== null) {
              spans.push({ s: sf, a: Math.max(a, cur - 0.25), b: bad ? b : u });
              cur = null;
            }
          }
        }
        if (!spans.length) continue;
        const label = this.openingLabel(o.op);
        if (o.top - (worst + 3) >= 2) {
          o.bottom = worst + 3;
          this.notes.add({ id: `asbuilt.stair_window_sill:${o.op.id}`, title: "Window sill raised beside the stair", status: "warn", message: `${label} was raised so its glass starts 3 ft above the stair beside it.`, element_ids: [o.op.id] });
          continue;
        }
        for (const sp of spans)
          this.stairGuards.push({ level: lv, axis: run.axis, c: sp.s.side, a: sp.a, b: sp.b, ha: sp.s.pitch(sp.a), hb: sp.s.pitch(sp.b), op: o.op.id });
        // EN-F4: a rail the engine adds for safety is not a problem to report (status pass: never counted or listed)
        this.notes.add({ id: `asbuilt.stair_window_guard:${o.op.id}`, title: "Guard rail across a stair window", status: "pass", message: `A guard rail was added across ${label.charAt(0).toLowerCase() + label.slice(1)}, beside the stair.`, element_ids: [o.op.id] });
      }
    }
  }

  /** Every opening left out is reported (EN-01); a missing door is a fail, a missing window a warn. */
  private skipOpening(op: OpeningM, message: string, status?: "warn" | "fail"): void {
    warn(`opening ${op.id}: ${message}`);
    const st = status ?? (DOOR_TYPES.includes(op.type) ? "fail" : "warn");
    this.notes.add({ id: `asbuilt.opening_skipped:${op.id}`, title: DOOR_TYPES.includes(op.type) ? "Door not built" : "Opening not built", status: st, message, element_ids: [op.id] });
  }

  /** "The main door", "The Kitchen window", "The door between the Kitchen and the Dining": for as-built notes. */
  openingLabel(op: OpeningM): string {
    return openingName(this.plan, op);
  }

  /** B.3.5: the 3 x 3 ft inside the roof door must be floor, never the stairwell. */
  private checkTowerDoor(): void {
    const tw = this.tower;
    if (!tw) return;
    const door = this.openings.find((o) => o.op.level === tw.room.level && o.isDoor && (o.neg === tw.room || o.pos === tw.room));
    if (!door) {
      this.notes.add({ id: "asbuilt.roof_door_missing", title: "No roof door", status: "fail", message: "The stair tower has no door onto the roof.", element_ids: [tw.room.id] });
      return;
    }
    const run = door.run;
    const into = door.neg === tw.room ? -1 : 1;
    const holes = this.stairs.filter((s) => s.holeLevel === door.op.level).flatMap((s) => s.holes);
    let bad = 0, n = 0;
    for (let i = 0; i <= 6; i++)
      for (let j = 1; j <= 6; j++) {
        const u = door.u0 + ((door.u1 - door.u0) * i) / 6, w = run.c + into * (run.t / 2 + (3 * j) / 6);
        const [x, y] = run.axis === "x" ? [u, w] : [w, u];
        n++;
        if (holes.some((h) => rectContains(h, x, y, -0.02))) bad++;
      }
    if (bad) this.notes.add({ id: "asbuilt.roof_door_over_void", title: "Roof door opens over the stairwell", status: "fail", message: `${Math.round((bad / n) * 100)}% of the 3 ft landing inside the roof door is stairwell.`, element_ids: [door.op.id] });
  }

  // ── slabs ──────────────────────────────────────────────────────────────────────────────────────────
  // ── projection envelope ────────────────────────────────────────────────────────────────────────────
  private computeEnvelope(): void {
    const plan = this.plan;
    const built = plan.rooms.filter((r) => r.cat !== "outdoor");
    if (!built.length) return;
    const bx0 = Math.min(...built.map((r) => r.rect.x)), bx1 = Math.max(...built.map((r) => r.rect.x + r.rect.w));
    const by0 = Math.min(...built.map((r) => r.rect.y)), by1 = Math.max(...built.map((r) => r.rect.y + r.rect.d));
    // reach beyond the building line (room edge = wall centre line) on a side with `gap` ft of open space
    const reach = (gap: number) => (gap < 0.5 ? EXT_T / 2 : Math.max(EXT_T / 2, Math.min(gap, gap < 10 ? 1.5 : 3)));
    const gL = bx0, gR = plan.plotW - bx1, gF = by0, gB = plan.plotD - by1;
    // the declared setback lines bound it too (LDA measures projections from them: 0 / 1.5 / 3 ft), but the
    // outer faces of the walls themselves always stay
    const sb = (plan.plan.site?.setbacks_ft ?? {}) as Partial<Record<"front" | "rear" | "left" | "right", number>>;
    const allow = (s: number) => (s <= 0 ? 0 : s >= 10 ? 3 : 1.5);
    const sbv = (k: "front" | "rear" | "left" | "right") => {
      const v = Number(sb[k]);
      return Number.isFinite(v) && v >= 0 ? v : null;
    };
    const L = sbv("left"), Rt = sbv("right"), F = sbv("front"), B = sbv("rear");
    let x0 = bx0 - reach(gL), x1 = bx1 + reach(gR), y0 = by0 - reach(gF), y1 = by1 + reach(gB);
    if (L !== null) x0 = Math.max(x0, Math.min(L - allow(L), bx0 - EXT_T / 2));
    if (Rt !== null) x1 = Math.min(x1, Math.max(plan.plotW - Rt + allow(Rt), bx1 + EXT_T / 2));
    if (F !== null) y0 = Math.max(y0, Math.min(F - allow(F), by0 - EXT_T / 2));
    if (B !== null) y1 = Math.min(y1, Math.max(plan.plotD - B + allow(B), by1 + EXT_T / 2));
    this.envelope = {
      x0, x1, y0, y1,
      party: { left: gL < 0.5, right: gR < 0.5, front: gF < 0.5, back: gB < 0.5 },
    };
  }

  /** A plan rect clipped to the projection envelope (null when nothing is left). */
  clipRect(r: R): R | null {
    const e = this.envelope;
    const x0 = Math.max(r.x, e.x0), x1 = Math.min(r.x + r.w, e.x1);
    const y0 = Math.max(r.y, e.y0), y1 = Math.min(r.y + r.d, e.y1);
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return null;
    return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
  }

  /** A run-space box (u along a wall run of `axis`, w across it) clipped to the projection envelope. */
  clipRunBox(axis: "x" | "y", u0: number, u1: number, w0: number, w1: number): [number, number, number, number] | null {
    const e = this.envelope;
    const [ua, ub] = axis === "x" ? [e.x0, e.x1] : [e.y0, e.y1];
    const [wa, wb] = axis === "x" ? [e.y0, e.y1] : [e.x0, e.x1];
    const U0 = Math.max(Math.min(u0, u1), ua), U1 = Math.min(Math.max(u0, u1), ub);
    const W0 = Math.max(Math.min(w0, w1), wa), W1 = Math.min(Math.max(w0, w1), wb);
    if (U1 - U0 < 1e-4 || W1 - W0 < 1e-4) return null;
    return [U0, U1, W0, W1];
  }

  private computeSlabs(): void {
    const plan = this.plan;
    const push = (rects: R[], r: R) => {
      const c = this.clipRect(r);
      if (c) rects.push(c);
    };
    for (const U of plan.levels) {
      if (U.i === 0) continue;
      const L = plan.levels[U.i - 1];
      const rects: R[] = [];
      for (const r of plan.roomsOn(L.id)) if (r.cat === "enclosed" || r.cat === "porch") push(rects, expandRect(r.rect, EXT_T / 2));
      for (const r of plan.roomsOn(U.id)) if (r.cat !== "outdoor") push(rects, expandRect(r.rect, EXT_T / 2));
      if (!rects.length) continue;
      const holes = this.stairs.filter((s) => s.holeLevel === U.id).flatMap((s) => s.holes);
      const g = CellGrid.fromRects<boolean>(
        [...rects.map((rect) => ({ rect, val: true })), ...holes.map((rect) => ({ rect, val: false }))],
        (a, b) => a && b,
      );
      for (let k = 0; k < g.cells.length; k++) if (g.cells[k] === false) g.cells[k] = null;
      this.slabs.push({ level: U, grid: g, top: U.elev - FINISH, bottom: U.elev - L.slab });
    }
    // mumty roof slab
    const m = plan.rooms.find((r) => r.lv.isRoof && r.cat === "enclosed");
    if (m) {
      const top = m.lv.elev + plan.mumtyHeight;
      // the mumty roof overhangs its walls by ~0.9 ft, but never past the projection envelope (party walls)
      const items = plan.rooms
        .filter((r) => r.lv.isRoof && r.cat === "enclosed")
        .map((r) => this.clipRect(expandRect(r.rect, EXT_T / 2 + 0.9)))
        .filter((r): r is R => !!r)
        .map((rect) => ({ rect, val: true }));
      if (items.length) {
        const g = CellGrid.fromRects<boolean>(items);
        this.slabs.push({ level: m.lv, grid: g, top, bottom: top - m.lv.slab - 0.1 });
      }
    }
  }

  private computePlinth(): void {
    const plan = this.plan;
    const L0 = plan.levels[0];
    const items = plan
      .roomsOn(L0.id)
      .filter((r) => r.cat !== "outdoor")
      .map((r) => ({ rect: this.clipRect(expandRect(r.rect, EXT_T / 2 + PLINTH_PROUD)), val: r.floorH - FINISH }))
      .filter((it): it is { rect: R; val: number } => !!it.rect);
    this.plinth = CellGrid.fromRects<number>(items, (a, b) => Math.max(a, b));
    this.footprint = plan
      .roomsOn(L0.id)
      .filter((r) => r.cat === "enclosed")
      .map((r) => expandRect(r.rect, EXT_T / 2));
  }

  private computeSurfaces(): void {
    const sideOf = (axis: "x" | "y", out: number): Side => (axis === "x" ? (out < 0 ? "front" : "back") : out < 0 ? "left" : "right");
    for (const r of [...this.runs, ...this.parapets]) {
      if (r.out === 0) continue;
      const kind = r.kind === "parapet" ? "parapet" : "wall";
      this.surfaces.push({ side: sideOf(r.axis, r.out), plane: r.c + (r.out * r.t) / 2, u0: r.ea, u1: r.eb, h0: r.h0, h1: r.h1 + (r.topExposed ? 0.12 : 0), level: r.level.id, kind });
    }
    for (const s of this.slabs) {
      const er = s.grid.edgeRuns((n, p) => (n && !p ? "+" : p && !n ? "-" : null));
      for (const e of er) {
        const out = e.key === "+" ? 1 : -1;
        this.surfaces.push({ side: sideOf(e.axis, out), plane: e.c, u0: e.a, u1: e.b, h0: s.bottom, h1: s.top + FINISH, level: s.level.id, kind: "slab" });
      }
    }
    const er = this.plinth.edgeRuns((n, p) => (n != null && p == null ? "+" : p != null && n == null ? "-" : null));
    for (const e of er) {
      const out = e.key === "+" ? 1 : -1;
      const h = (out > 0 ? e.neg : e.pos) ?? this.plan.ground.elev;
      this.surfaces.push({ side: sideOf(e.axis, out), plane: e.c, u0: e.a, u1: e.b, h0: this.plan.grade, h1: h as number, level: this.plan.levels[0].id, kind: "plinth" });
    }
  }

  // ── queries ────────────────────────────────────────────────────────────────────────────────────────
  /** Overall outer face of the building on one side. */
  face(side: Side, level?: string): { side: Side; from_ft: number; to_ft: number; plane_ft: number; bottom_h_ft: number; top_h_ft: number } {
    let surfs = this.surfaces.filter((s) => s.side === side && (!level || s.level === level));
    if (!surfs.length) surfs = this.surfaces.filter((s) => s.side === side);
    const plan = this.plan;
    if (!surfs.length) {
      const horiz = side === "front" || side === "back";
      return {
        side,
        from_ft: 0,
        to_ft: horiz ? plan.plotW : plan.plotD,
        plane_ft: side === "front" ? 0 : side === "back" ? plan.plotD : side === "left" ? 0 : plan.plotW,
        bottom_h_ft: plan.grade,
        top_h_ft: plan.roof.elev + plan.parapet,
      };
    }
    const outer = side === "front" || side === "left" ? Math.min(...surfs.map((s) => s.plane)) : Math.max(...surfs.map((s) => s.plane));
    const wallish = surfs.filter((s) => s.kind !== "plinth");
    return {
      side,
      from_ft: Math.min(...surfs.map((s) => s.u0)),
      to_ft: Math.max(...surfs.map((s) => s.u1)),
      plane_ft: outer,
      bottom_h_ft: Math.min(...surfs.map((s) => s.h0)),
      top_h_ft: Math.max(...(wallish.length ? wallish : surfs).map((s) => s.h1)),
    };
  }

  /** Outermost building surface plane on `side` overlapping a (u, h) region; null if nothing there. */
  outerPlane(side: Side, u0: number, u1: number, h0: number, h1: number, extra?: { side: string; plane: number; u0: number; u1: number; h0: number; h1: number }[]): number | null {
    const all = extra ? [...this.surfaces, ...extra] : this.surfaces;
    let best: number | null = null;
    for (const s of all) {
      if (s.side !== side) continue;
      if (s.u1 <= u0 + 1e-3 || s.u0 >= u1 - 1e-3 || s.h1 <= h0 + 1e-3 || s.h0 >= h1 - 1e-3) continue;
      if (best === null) best = s.plane;
      else best = side === "front" || side === "left" ? Math.min(best, s.plane) : Math.max(best, s.plane);
    }
    return best;
  }

  /** Wall runs bounding a room on one side (the room's edge), with the wall's inner face offset. */
  roomWalls(room: RoomM, side: Side): { run: WallRun; a: number; b: number; inner: number }[] {
    const r = room.rect;
    const axis = side === "front" || side === "back" ? "x" : "y";
    const c = side === "front" ? r.y : side === "back" ? r.y + r.d : side === "left" ? r.x : r.x + r.w;
    const lo = axis === "x" ? r.x : r.y, hi = axis === "x" ? r.x + r.w : r.y + r.d;
    const into = side === "front" || side === "left" ? 1 : -1;
    const out: { run: WallRun; a: number; b: number; inner: number }[] = [];
    for (const run of this.runsByLevel.get(room.level) ?? []) {
      if (run.axis !== axis || !near(run.c, c, 0.05) || run.kind === "parapet") continue;
      const a = Math.max(lo, run.a), b = Math.min(hi, run.b);
      if (b - a < 0.05) continue;
      out.push({ run, a, b, inner: c + (into * run.t) / 2 });
    }
    return out.sort((p, q) => p.a - q.a);
  }

  openingsOfRoom(room: RoomM): PlacedOpening[] {
    return this.openings.filter((o) => o.neg === room || o.pos === room);
  }

  /**
   * EN-F2: the rooms just either side of a wall run at `along` ([neg side, pos side]). An interior run joins the same
   * two rooms all along; an exterior run keeps its enclosed room but the outdoor room, porch or terrace on its open
   * side can change along it, so that side is looked up at the point itself.
   */
  roomsAcross(run: WallRun, along: number): [RoomM | null, RoomM | null] {
    if (run.kind !== "exterior" || run.out === 0) return [run.neg, run.pos];
    const u = clamp(along, run.a + 0.05, run.b - 0.05);
    const w = run.c + run.out * 0.05;
    const other = run.axis === "x" ? this.plan.roomAt(run.level.id, u, w) : this.plan.roomAt(run.level.id, w, u);
    const outside = !other ? null : other.cat !== "enclosed" ? other : run.out < 0 ? run.neg : run.pos;
    return run.out < 0 ? [outside, run.pos] : [run.neg, outside];
  }

}

function distToEdge(e: EdgeFeature, at: [number, number]): number {
  const along = e.axis === "x" ? at[0] : at[1];
  const across = e.axis === "x" ? at[1] : at[0];
  const dL = along < e.a ? e.a - along : along > e.b ? along - e.b : 0;
  return Math.hypot(across - e.c, dL);
}

// ── junctions ──────────────────────────────────────────────────────────────────────────────────────────
export function resolveJunctions(runs: WallRun[]): void {
  for (const r of runs) {
    for (const end of ["a", "b"] as const) {
      const u = end === "a" ? r.a : r.b;
      const coll = runs.find((o) => o !== r && o.axis === r.axis && near(o.c, r.c) && (end === "a" ? near(o.b, u) : near(o.a, u)));
      const perp = runs.filter((o) => o.axis !== r.axis && near(o.c, u) && o.a - EPS <= r.c && o.b + EPS >= r.c);
      const pass = perp.some((o) => o.a < r.c - EPS && o.b > r.c + EPS);
      const lowSide = perp.some((o) => near(o.b, r.c));
      const highSide = perp.some((o) => near(o.a, r.c));
      const perpThrough = pass || (lowSide && highSide);
      let adj = 0;
      let cap: Cap = { kind: "none" };
      const perpT = perp.length ? Math.max(...perp.map((o) => o.t)) : 0;
      if (end === "a") r.perpA = perpT;
      else r.perpB = perpT;
      if (!perp.length) {
        if (!coll) cap = { kind: "full" };
        else if (coll.t < r.t - EPS) cap = { kind: "strips", strips: [[-r.t / 2, -coll.t / 2], [coll.t / 2, r.t / 2]] };
        else if (coll.h1 < r.h1 - 0.05) cap = { kind: "full", h0: Math.max(r.h0, coll.h1) };
      } else {
        const tMin = Math.min(...perp.map((o) => o.t));
        const tMax = Math.max(...perp.map((o) => o.t));
        const hPerp = Math.max(...perp.map((o) => o.h1));
        if (perpThrough && coll) {
          if (r.axis === "y") adj = -tMin / 2;
          if (coll.t < r.t - EPS) cap = { kind: "strips", strips: [[-r.t / 2, -coll.t / 2], [coll.t / 2, r.t / 2]] };
        } else if (perpThrough && !coll) {
          // T-stem
          if (r.h1 > hPerp + 0.05) {
            adj = tMax / 2;
            cap = { kind: "full", h0: hPerp };
          } else adj = -tMin / 2;
        } else if (!perpThrough && coll) {
          if (coll.t < r.t - EPS) cap = { kind: "strips", strips: [[-r.t / 2, -coll.t / 2], [coll.t / 2, r.t / 2]] };
          else if (coll.h1 < r.h1 - 0.05) cap = { kind: "full", h0: Math.max(r.h0, coll.h1) };
        } else {
          // L-corner: the taller run (or the x-run on ties) owns the corner square
          const owner = r.h1 > hPerp + 0.05 || (Math.abs(r.h1 - hPerp) <= 0.05 && r.axis === "x");
          if (owner) {
            adj = tMax / 2;
            cap = { kind: "full" };
          } else {
            adj = -tMin / 2;
            if (r.h1 > hPerp + 0.05) cap = { kind: "full", h0: hPerp };
          }
        }
      }
      if (end === "a") {
        r.ea = r.a - adj;
        r.capA = cap;
      } else {
        r.eb = r.b + adj;
        r.capB = cap;
      }
    }
  }
}

