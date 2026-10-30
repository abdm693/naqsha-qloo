/** Landscape: lawns (with instanced grass tufts), paving, planters, trees, hedges and the street context. */
import * as THREE from "three";
import type { MaterialSpec } from "@contracts/house-sdk";
import type { Pt, Rect } from "@contracts/plan";
import type { BuildCtx } from "./core/ctx";
import { CellGrid, rectIntersect, type R } from "./core/grid";
import { MeshBuilder } from "./core/meshbuilder";
import { Kit, lathe, mat4, unitCyl } from "./core/shapes";
import { FT, clamp, hashStr, num, rng, warn } from "./core/util";
import { makeCanvas } from "./materials/gen";
import type { RoomM } from "./plan/model";
import { openingNameLow, sentenceName as sentence } from "./structure/labels";
import { massRoof, pitchSpec, type PitchSpec } from "./structure/pitched-roof";
import { resolvePresetName } from "./materials/library";
import { carWays, onWalkwayRect, parking } from "./furniture/parking";
import { CLEAR_H, CLEAR_W, freeAcross, keepsReach, outdoorItems, outdoorModel, overlaps, passagesClear, reachedWith, type Box, type OutdoorModel, type Passage } from "./outdoor";

type TreeKind = "palm" | "ashoka" | "neem" | "ornamental" | "bush";

function normRect(r: Partial<Rect> | undefined): Rect | null {
  if (!r) return null;
  let x = num(r.x, NaN), y = num(r.y, NaN), w = num(r.w, NaN), d = num(r.d, NaN);
  if (![x, y, w, d].every(Number.isFinite)) return null;
  if (w < 0) { x += w; w = -w; }
  if (d < 0) { y += d; d = -d; }
  if (w < 0.2 || d < 0.2) return null;
  return { x: clamp(x, -300, 600), y: clamp(y, -300, 800), w: Math.min(w, 400), d: Math.min(d, 400) };
}

export function landscapeAPI(ctx: BuildCtx) {
  const M = ctx.mats;
  const plan = ctx.plan;
  const FOOTPATH = 6;

  /** surface height (ft) at a plan point: registered ground surfaces, else plot grade / footpath / road. */
  const groundAt = (x: number, y: number): number => {
    let h = -1;
    for (const g of ctx.ground) if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.d) h = Math.max(h, g.h);
    if (h >= 0) return h;
    if (x >= 0 && x <= plan.plotW && y >= 0 && y <= plan.plotD) {
      const r = plan.roomAt(plan.levels[0].id, x, y);
      if (r && r.cat !== "outdoor") return r.floorH;
      return plan.grade;
    }
    if (y < 0 && y >= -FOOTPATH) return plan.grade;
    if (y < -FOOTPATH) return 0;
    return plan.grade;
  };
  const tag = (kind: string, label: string) => ({ kind: `landscape:${kind}`, label, level: plan.levels[0].id });
  const context = (o: THREE.Object3D) => {
    o.userData.mergeGroup = "context";
    return o;
  };
  /** street context (road, footpaths, poles, neighbours): kind "context" so viewers can ghost or hide it */
  const ctag = (label: string) => ({ kind: "context", label, level: plan.levels[0].id });

  function surface(rect: Rect, mat: THREE.Material, kind: string, label: string, lift: number): number {
    // skip if a site surface already covers ≥ 90% of this rect with the same material
    const same = ctx.ground.find((g) => (g.obj as THREE.Mesh).material === mat && overlapFrac(g, rect) > 0.9);
    const base = Math.max(...[plan.grade, ...ctx.ground.filter((g) => rectIntersect(g, rect)).map((g) => g.h)]);
    if (same) return same.h;
    const h = (rect.y < 0 && rect.y + rect.d <= 0 ? plan.grade : base) + lift;
    const mb = new MeshBuilder();
    mb.faceY(h * FT, rect.x * FT, (rect.x + rect.w) * FT, rect.y * FT, (rect.y + rect.d) * FT, 1);
    const mesh = new THREE.Mesh(mb.build()!, mat);
    mesh.receiveShadow = true;
    ctx.add(mesh, tag(kind, label));
    ctx.collider(mesh);
    ctx.ground.push({ ...rect, h, obj: mesh, kind: "landscape" });
    return h;
  }

  function lawn(r: Rect): void {
    const rect = normRect(r);
    if (!rect) return warn("landscape.lawn: invalid rect");
    const h = surface(rect, M.get("grass"), "lawn", "Lawn", 0.03);
    grassTufts(ctx, rect, h);
    // slim steel edging around the lawn
    const kit = new Kit();
    const edge = M.get("metal_black");
    const e = 0.06, t = 0.12;
    kit.box(edge, (rect.x + rect.w / 2) * FT, (h + t / 4) * FT, rect.y * FT, rect.w * FT, (t / 2) * FT, e * FT);
    kit.box(edge, (rect.x + rect.w / 2) * FT, (h + t / 4) * FT, (rect.y + rect.d) * FT, rect.w * FT, (t / 2) * FT, e * FT);
    kit.box(edge, rect.x * FT, (h + t / 4) * FT, (rect.y + rect.d / 2) * FT, e * FT, (t / 2) * FT, rect.d * FT);
    kit.box(edge, (rect.x + rect.w) * FT, (h + t / 4) * FT, (rect.y + rect.d / 2) * FT, e * FT, (t / 2) * FT, rect.d * FT);
    ctx.add(kit.build(), tag("lawn_edge", "Lawn edging"));
  }

  function paving(r: Rect, material?: MaterialSpec): void {
    const rect = normRect(r);
    if (!rect) return warn("landscape.paving: invalid rect");
    surface(rect, M.get(material, "paving"), "paving", "Paving", 0.035);
    paved.push({ x0: rect.x, x1: rect.x + rect.w, y0: rect.y, y1: rect.y + rect.d });
  }

  // ── EN-F1: where planting may stand ─────────────────────────────────────────────────────────────────────
  // Whatever the design asks: nothing planted within 3 ft outside an exterior door, sliding door, arch or gate (its
  // width plus 1 ft each side), nothing on the gate-to-door walkway or a car's way in, and in a passage (an outdoor
  // room under 8 ft) a clear walking width of 3 ft is left between 0 and 7 ft above the ground; nor may planting cut
  // the 3 ft route from the gate to a door or an outdoor room it reached. An item that breaks this is slid along,
  // made a slim columnar form against the boundary wall (trees), moved into a wider outdoor space, or left out, each
  // with a warning in the build log. Footprints are what the item actually builds (canopy, fronds, shrubs): the box
  // the walkthrough treats as solid.
  const placed: Box[] = ctx.plantings;
  let reachMemo: { n: number; v: { doors: boolean[]; rooms: boolean[] } } | null = null;
  const model = (): OutdoorModel | null => (ctx.structureBuilt ? outdoorModel(ctx) : null);
  const solids = (): Box[] => [...outdoorItems(ctx), ...placed];
  // (the way from the gate is judged against the planting alone: outdoor furniture that closes it is moved at the end
  // of the build, see keepOutdoorReach)
  const reachNow = () => {
    const n = placed.length;
    if (!reachMemo || reachMemo.n !== n) reachMemo = { n, v: reachedWith(ctx, placed) };
    return reachMemo.v;
  };
  const keeps = (f: Box) => keepsReach(ctx, placed, f, reachNow());
  // (a verge shrub whose leaves reach over the boundary wall's footing is still out in the street)
  const inPlot = (f: Box) => f.x1 > 0.4 && f.y1 > 0.4 && f.x0 < plan.plotW - 0.4 && f.y0 < plan.plotD - 0.4;
  /** paths and patios the design paved: nothing moved is planted on them */
  const paved: Box[] = [];
  /** the objects one builder call adds (each ctx.add is one element) */
  const capture = (fn: () => void): THREE.Object3D[] => {
    const g = ctx.sectionGroup;
    const n = g.children.length;
    fn();
    return g.children.slice(n);
  };
  /** plan footprint (ft) of the elements that come lower than 7 ft above `base` */
  const footprint = (objs: THREE.Object3D[], base: number): Box | null => {
    let f: Box | null = null;
    for (const o of objs) {
      o.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(o);
      if (bb.isEmpty() || bb.min.y / FT >= base + CLEAR_H - 0.05) continue;
      const b = { x0: bb.min.x / FT, x1: bb.max.x / FT, y0: -bb.max.z / FT, y1: -bb.min.z / FT };
      f = f ? { x0: Math.min(f.x0, b.x0), x1: Math.max(f.x1, b.x1), y0: Math.min(f.y0, b.y0), y1: Math.max(f.y1, b.y1) } : b;
    }
    return f;
  };
  /** slide by (dx, dy), lift by dh and, for a slim form, narrow by k about the trunk at (px, py) */
  const transform = (objs: THREE.Object3D[], px: number, py: number, k: number, dx: number, dy: number, dh: number) => {
    for (const o of objs) {
      o.scale.set(k, 1, k);
      o.position.set((px * (1 - k) + dx) * FT, dh * FT, -(py * (1 - k) + dy) * FT);
      o.updateMatrixWorld(true);
    }
  };
  const moved = (f: Box, px: number, py: number, k: number, dx: number, dy: number): Box => ({
    x0: px + (f.x0 - px) * k + dx, x1: px + (f.x1 - px) * k + dx, y0: py + (f.y0 - py) * k + dy, y1: py + (f.y1 - py) * k + dy,
  });
  const removeAll = (objs: THREE.Object3D[]) => {
    for (const o of objs) {
      o.removeFromParent();
      o.traverse((q) => (q as THREE.Mesh).geometry?.dispose());
    }
  };
  const rectOf = (r: Rect): Box => ({ x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.d });
  /** the passage (outdoor room under 8 ft) a point stands in */
  const passageAt = (m: OutdoorModel, x: number, y: number): Passage | null => m.passages.find((p) => x >= p.room.rect.x && x <= p.room.rect.x + p.room.rect.w && y >= p.room.rect.y && y <= p.room.rect.y + p.room.rect.d) ?? null;
  /**
   * Why a footprint may not stand here (null: it may). `strict` also keeps it from standing across a passage from a
   * door (a preference when moving); `moving` keeps it off walls and the other planting (the spot the design gave
   * stays as long as it breaks no rule); `reach` also asks that the 3 ft route from the gates still reaches every door
   * and outdoor room it reached.
   */
  let lowItem = false;
  const why = (f: Box, strict: boolean, moving: boolean, reach = true): string | null => {
    const m = model();
    if (!m) return null;
    const z = m.zones.find((q) => overlaps(f, q.box));
    if (z) {
      const op = plan.openings.find((o) => o.id === z.id);
      return `stood within 3 ft of ${z.kind === "gate" ? "a gate" : op ? openingNameLow(plan, op) : "a door"}`;
    }
    if (!inPlot(f)) return null;
    if (strict)
      for (const q of m.zones) {
        if (q.kind !== "door") continue;
        for (const p of m.passages) {
          const r = p.room.rect;
          if (!overlaps(q.box, rectOf(r))) continue;
          const across: Box = q.axis === "x" ? { x0: q.a - 1, x1: q.b + 1, y0: r.y, y1: r.y + r.d } : { x0: r.x, x1: r.x + r.w, y0: q.a - 1, y1: q.b + 1 };
          if (overlaps(f, across)) return "stood across the passage from a door";
        }
      }
    const P = parking(ctx);
    if (onWalkwayRect(P, f)) return "stood on the walkway from the gate to the main door";
    if (carWays(P, plan.plotW, plan.plotD).some((w) => overlaps(f, w))) return "stood in a car's way in";
    if (moving && m.fixed.some((b) => overlaps(f, b, 0.03))) return "met a wall";
    // (a shrub may stand under a tree's canopy)
    if (moving && !lowItem && placed.some((b) => overlaps(f, b, 0.1))) return "met other planting";
    const pass = m.passages.find((p) => !passagesClear({ ...m, passages: [p] }, f, solids()));
    if (pass) return `left less than 3 ft clear in the ${sentence(pass.room.name)}`;
    if (reach && !keeps(f)) return "cut the 3 ft way from the gate to a door or a yard";
    return null;
  };
  const fits = (f: Box, strict: boolean, moving: boolean): boolean => !why(f, strict, moving);
  const at1 = (n: number) => n.toFixed(1);

  /**
   * Settle what one planting call built (`objs`, its trunk or centre at (x, y) on ground `base`) where the rules let it
   * stand: as asked; slid along (a passage, the street verge) or nearby; a slim column against the boundary wall
   * (`slim`); in a wider outdoor space (`wider`); else left out. The street verge only slides along the street.
   */
  const settle = (objs: THREE.Object3D[], x: number, y: number, base: number, label: string, how: { slim: "first" | "later" | "never"; wider: boolean }): void => {
    const m = model();
    const f0 = footprint(objs, base);
    if (!m || !f0 || !objs.length) return;
    // (a shrub, under 4 ft: may stand under another tree's canopy when it is moved)
    lowItem = objs.every((o) => new THREE.Box3().setFromObject(o).max.y / FT < base + 4);
    const g0 = plan.levels[0].id;
    const room = plan.roomAt(g0, x, y);
    if (room && room.cat === "enclosed") {
      placed.push(f0);
      return;
    }
    const reason = why(f0, false, false);
    if (!reason) {
      placed.push(f0);
      return;
    }
    const street = !room && y < 0;
    const done = (f: Box, k: number, dx: number, dy: number, what: string) => {
      transform(objs, x, y, k, dx, dy, groundAt(x + dx, y + dy) - base);
      placed.push(f);
      warn(`landscape: ${label} at (${at1(x)}, ${at1(y)}) ${reason}; ${what}.`);
    };
    const passage = room ? passageAt(m, x, y) : null;
    const onPaving = (px: number, py: number) => paved.some((b) => px > b.x0 - 0.5 && px < b.x1 + 0.5 && py > b.y0 - 0.5 && py < b.y1 + 0.5);
    const within = (f: Box, r: Rect, e: number) => f.x0 >= r.x - e && f.x1 <= r.x + r.w + e && f.y0 >= r.y - e && f.y1 <= r.y + r.d + e;
    // a. slide it along the passage (or the street verge), or nearby in its own space, as it is
    const slide = (): boolean => {
      const offs: [number, number][] = [];
      if (passage || street) {
        const ax = passage ? passage.axis : "x";
        for (let d = 0.5; d <= 12; d += 0.5) for (const s of [1, -1]) offs.push(ax === "x" ? [s * d, 0] : [0, s * d]);
      } else
        for (let r = 0.5; r <= 6; r += 0.5)
          for (let a = 0; a < 16; a++) offs.push([Math.round(Math.cos((a / 16) * Math.PI * 2) * r * 4) / 4, Math.round(Math.sin((a / 16) * Math.PI * 2) * r * 4) / 4]);
      for (const strict of [true, false])
        for (const [dx, dy] of offs) {
          const f = moved(f0, x, y, 1, dx, dy);
          const home = street ? f.x0 >= -0.5 && f.x1 <= plan.plotW + 0.5 : room ? plan.roomAt(g0, x + dx, y + dy) === room && within(f, room.rect, 0.6) && !onPaving(x + dx, y + dy) : false;
          if (home && fits(f, strict, !street)) {
            done(f, 1, dx, dy, `moved ${at1(Math.hypot(dx, dy))} ft${passage ? ` along the ${sentence(room!.name)}` : street ? " along the street" : ""}`);
            return true;
          }
        }
      return false;
    };
    // b. a slim columnar form against the boundary wall of the passage it stands in (3 ft left clear beside it)
    const slim = (): boolean => {
      if (!passage || !room) return false;
      const r = passage.room.rect;
      const ax = passage.axis;
      const [lo, hi] = ax === "y" ? [r.x, r.x + r.w] : [r.y, r.y + r.d];
      const lim = ax === "y" ? plan.plotW : plan.plotD;
      // hug the long side on the plot boundary (else the side farther from the middle of the plot)
      const toHigh = hi >= lim - 0.01 ? true : lo <= 0.01 ? false : (lo + hi) / 2 > lim / 2;
      const [fc0, fc1] = ax === "y" ? [f0.x0, f0.x1] : [f0.y0, f0.y1];
      const pc = ax === "y" ? x : y;
      for (const strict of [true, false])
        for (let d = 0; d <= 12; d += 0.5)
          for (const s of d ? [1, -1] : [1]) {
            const du = s * d;
            const u = (ax === "y" ? y : x) + du;
            const [a0, a1] = freeAcross(m, passage, u, solids());
            const room2 = a1 - a0 - CLEAR_W - 0.1;
            if (room2 < 0.8) continue;
            const k = Math.min(1, room2 / (fc1 - fc0));
            const dc = toHigh ? a1 - 0.05 - (pc + (fc1 - pc) * k) : a0 + 0.05 - (pc + (fc0 - pc) * k);
            const [dx, dy] = ax === "y" ? [dc, du] : [du, dc];
            const f = moved(f0, x, y, k, dx, dy);
            if (!within(f, r, 0.05) || !fits(f, strict, true)) continue;
            done(f, k, dx, dy, `made a slim column ${at1(k * (fc1 - fc0))} ft wide against the boundary wall${d ? `, ${at1(d)} ft along` : ""}, leaving 3 ft clear`);
            return true;
          }
      return false;
    };
    // b2. in a wider space with no room for it as it is: a slimmer form (down to half its spread) against the plot's
    // boundary wall where that space meets it
    const slimOpen = (): boolean => {
      if (!room || passage || room.cat !== "outdoor") return false;
      const r = room.rect;
      const B = 0.375 + 0.05;
      const edges: ("left" | "right" | "back" | "front")[] = [];
      if (r.x <= 0.01) edges.push("left");
      if (r.x + r.w >= plan.plotW - 0.01) edges.push("right");
      if (r.y + r.d >= plan.plotD - 0.01) edges.push("back");
      if (r.y <= 0.01) edges.push("front");
      const cands: { k: number; dx: number; dy: number; dist: number }[] = [];
      for (let k = 0.9; k >= 0.499; k -= 0.1)
        for (const e of edges) {
          const alongX = e === "front" || e === "back";
          const [lo, hi] = alongX ? [r.x, r.x + r.w] : [r.y, r.y + r.d];
          for (let u = lo + 0.5; u <= hi - 0.5; u += 0.5) {
            const sc = moved(f0, x, y, k, 0, 0);
            const dx = alongX ? u - x : e === "left" ? B - sc.x0 : plan.plotW - B - sc.x1;
            const dy = !alongX ? u - y : e === "front" ? B - sc.y0 : plan.plotD - B - sc.y1;
            if (onPaving(x + dx, y + dy)) continue;
            cands.push({ k, dx, dy, dist: Math.hypot(dx, dy) });
          }
        }
      cands.sort((a, b) => b.k - a.k || a.dist - b.dist);
      let tries = 0;
      for (const c of cands) {
        const f = moved(f0, x, y, c.k, c.dx, c.dy);
        if (!within(f, r, 0.6) || plan.roomAt(g0, x + c.dx, y + c.dy) !== room) continue;
        if (why(f, true, true, false)) continue;
        if (++tries > 40) break;
        if (!keeps(f)) continue;
        done(f, c.k, c.dx, c.dy, `made a slimmer form (${Math.round(c.k * 100)} % of its spread) against the boundary wall, ${at1(c.dist)} ft away`);
        return true;
      }
      return false;
    };
    // c. into a wider outdoor space (a lawn, a yard, a courtyard: 8 ft or more each way, never the driveway), within
    // 30 ft of where it was asked for
    const wider = (): boolean => {
      const cands: { dx: number; dy: number; dist: number; to: RoomM }[] = [];
      for (const to of m.outdoor) {
        if (to.type === "driveway" || Math.min(to.rect.w, to.rect.d) < 8) continue;
        const r = to.rect;
        for (let px = r.x + 1; px <= r.x + r.w - 1; px += 1)
          for (let py = r.y + 1; py <= r.y + r.d - 1; py += 1) if (Math.hypot(px - x, py - y) <= 30) cands.push({ dx: px - x, dy: py - y, dist: Math.hypot(px - x, py - y), to });
      }
      cands.sort((a, b) => a.dist - b.dist);
      let tries = 0;
      for (const c of cands) {
        const f = moved(f0, x, y, 1, c.dx, c.dy);
        const r = c.to.rect;
        if (!within(f, { x: r.x + 0.5, y: r.y + 0.5, w: r.w - 1, d: r.d - 1 }, 0) || onPaving(x + c.dx, y + c.dy)) continue;
        if (why(f, true, true, false)) continue;
        if (++tries > 40) break;
        if (!keeps(f)) continue;
        done(f, 1, c.dx, c.dy, `moved to the ${sentence(c.to.name)}`);
        return true;
      }
      return false;
    };
    const steps: (() => boolean)[] = [slide];
    if (!street) {
      if (how.slim === "first") steps.push(slim, slimOpen);
      if (how.wider) steps.push(wider);
      if (how.slim === "later") steps.push(slim, slimOpen);
    }
    for (const st of steps) if (st()) return;
    removeAll(objs);
    warn(`landscape: ${label} at (${at1(x)}, ${at1(y)}) ${reason}; left out (no spot nearby keeps the way clear).`);
  };

  function planter(r: Rect, o?: { height_ft?: number; material?: MaterialSpec }): void {
    const rect = normRect(r);
    if (!rect) return warn("landscape.planter: invalid rect");
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.d / 2;
    const objs = capture(() => planterRaw(rect, o));
    settle(objs, cx, cy, groundAt(cx, cy), "a planter", { slim: "never", wider: true });
  }

  function planterRaw(rect: Rect, o?: { height_ft?: number; material?: MaterialSpec }): void {

    const H = clamp(num(o?.height_ft, 1.5), 0.3, 6);
    const base = groundAt(rect.x + rect.w / 2, rect.y + rect.d / 2);
    const mat = M.get(o?.material, "plaster_grey");
    const kit = new Kit();
    const t = Math.min(0.33, rect.w / 4, rect.d / 4);
    const x0 = rect.x, x1 = rect.x + rect.w, y0 = rect.y, y1 = rect.y + rect.d;
    const b = (ax: number, bx: number, ay: number, by: number) => kit.mb(mat).box(ax * FT, (base - 0.2) * FT, ay * FT, bx * FT, (base + H) * FT, by * FT);
    b(x0, x1, y0, y0 + t);
    b(x0, x1, y1 - t, y1);
    b(x0, x0 + t, y0 + t, y1 - t);
    b(x1 - t, x1, y0 + t, y1 - t);
    kit.mb(M.get("concrete")).box((x0 - 0.04) * FT, (base + H) * FT, (y0 - 0.04) * FT, (x1 + 0.04) * FT, (base + H + 0.08) * FT, (y0 + t + 0.02) * FT);
    kit.mb(M.get({ preset: "soil", color: "#3f3027" })).box((x0 + t) * FT, base * FT, (y0 + t) * FT, (x1 - t) * FT, (base + H - 0.18) * FT, (y1 - t) * FT);
    ctx.add(kit.build(), tag("planter", "Planter"));
    // shrubs inside
    const n = Math.max(1, Math.round(rect.w / 2.2));
    for (let i = 0; i < n; i++) {
      const px = x0 + (rect.w * (i + 0.5)) / n, py = (y0 + y1) / 2;
      plantTree(ctx, px, py, base + H - 0.18, i % 3 === 1 ? "ornamental" : "bush", i % 3 === 1 ? 3.2 : 2.2, `planter${i}`);
    }
  }

  function tree(at: Pt, o?: { kind?: TreeKind; height_ft?: number }): void {
    const p = Array.isArray(at) ? at : [0, 0];
    const x = num(p[0], 0), y = num(p[1], 0);
    const kinds: TreeKind[] = ["palm", "ashoka", "neem", "ornamental", "bush"];
    const kind: TreeKind = kinds.includes(o?.kind as TreeKind) ? (o!.kind as TreeKind) : "neem";
    const dflt: Record<TreeKind, number> = { palm: 14, ashoka: 18, neem: 20, ornamental: 12, bush: 3 };
    const H = clamp(num(o?.height_ft, dflt[kind]), kind === "bush" ? 0.8 : 2, 60);
    const base = groundAt(x, y);
    const objs = capture(() => plantTree(ctx, x, y, base, kind, H));
    // an ashoka grows as a column anyway (the boundary-wall tree): made slim before it is moved; a spreading tree or a
    // palm goes to a wider space first
    settle(objs, x, y, base, `the ${kind === "bush" ? "shrub" : `${kind} tree`}`, { slim: kind === "ashoka" ? "first" : "later", wider: true });
  }

  function hedge(from: Pt, to: Pt, o?: { height_ft?: number }): void {
    const a = Array.isArray(from) ? from : [0, 0], b = Array.isArray(to) ? to : [0, 0];
    const x0 = num(a[0], 0), y0 = num(a[1], 0), x1 = num(b[0], 0), y1 = num(b[1], 0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.5) return;
    const H = clamp(num(o?.height_ft, 3), 0.8, 10);
    const objs = capture(() => hedgeRaw(x0, y0, x1, y1, H));
    const base = groundAt((x0 + x1) / 2, (y0 + y1) / 2);
    const f0 = footprint(objs, base);
    if (!model() || !f0 || !why(f0, false, false)) {
      if (f0) placed.push(f0);
      return;
    }
    // EN-F1: keep the stretches of the hedge that break no rule (a gap at a door or a gate, none across a passage)
    removeAll(objs);
    const depth = Math.min(1.6, H * 0.6) / 2 + 0.25;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    // (its leaves reach past the ends of its line: keep that much more clear)
    const over = Math.max(0.3, Math.abs(ux) * Math.max(f0.x1 - Math.max(x0, x1), Math.min(x0, x1) - f0.x0) + Math.abs(uy) * Math.max(f0.y1 - Math.max(y0, y1), Math.min(y0, y1) - f0.y0));
    const n = Math.max(1, Math.round(len / 0.5));
    const good: boolean[] = [];
    for (let k = 0; k < n; k++) {
      const t0 = (k / n) * len, t1 = ((k + 1) / n) * len;
      const ax = x0 + ux * t0, ay = y0 + uy * t0, bx = x0 + ux * t1, by = y0 + uy * t1;
      const f: Box = { x0: Math.min(ax, bx) - Math.abs(uy) * depth - Math.abs(ux) * over, x1: Math.max(ax, bx) + Math.abs(uy) * depth + Math.abs(ux) * over, y0: Math.min(ay, by) - Math.abs(ux) * depth - Math.abs(uy) * over, y1: Math.max(ay, by) + Math.abs(ux) * depth + Math.abs(uy) * over };
      good.push(!why(f, false, false, false));
    }
    let kept = 0;
    for (let k = 0; k < n; ) {
      if (!good[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < n && good[e + 1]) e++;
      const t0 = (k / n) * len, t1 = ((e + 1) / n) * len;
      if (t1 - t0 >= 1.5) {
        const sx = x0 + ux * t0, sy = y0 + uy * t0, ex = x0 + ux * t1, ey = y0 + uy * t1;
        const part = capture(() => hedgeRaw(sx, sy, ex, ey, H));
        const f = footprint(part, base);
        if (f && why(f, false, false)) removeAll(part);
        else {
          if (f) placed.push(f);
          kept += t1 - t0;
        }
      }
      k = e + 1;
    }
    warn(`landscape: the hedge from (${at1(x0)}, ${at1(y0)}) to (${at1(x1)}, ${at1(y1)}) crossed a door, a gate or a passage's 3 ft clear way; ${kept > 0 ? `${at1(kept)} of its ${at1(len)} ft kept` : "left out"}.`);
  }

  function hedgeRaw(x0: number, y0: number, x1: number, y1: number, H: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);

    const base = groundAt((x0 + x1) / 2, (y0 + y1) / 2);
    const depth = Math.min(1.6, H * 0.6);
    const kit = new Kit();
    const core = M.basic("#2c4a22", { roughness: 0.95 });
    const ang = Math.atan2(y1 - y0, x1 - x0);
    kit.rbox(core, ((x0 + x1) / 2) * FT, (base + H / 2 - 0.05) * FT, ((y0 + y1) / 2) * FT, len * FT, (H - 0.1) * FT, depth * FT, 0.12, 2, 0, -ang, 0);
    ctx.add(kit.build(), tag("hedge", "Hedge"));
    // leafy skin of cards
    const cards = new MeshBuilder();
    const r = rng(hashStr(`hedge${x0},${y0}`));
    const n = Math.round(len * H * 3.2);
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len, nx = -uy, ny = ux;
    for (let i = 0; i < n; i++) {
      const t = r(), side = r() < 0.5 ? -1 : 1, top = r() < 0.3;
      const hh = top ? H - 0.05 : 0.2 + r() * (H - 0.4);
      const off = top ? (r() - 0.5) * depth : side * depth * 0.5;
      const px = x0 + ux * len * t + nx * off, py = y0 + uy * len * t + ny * off;
      const cn = new THREE.Vector3(top ? nx * off * 0.3 : nx * side, top ? 1 : 0.25 * (r() - 0.3), top ? ny * off * 0.3 : ny * side).normalize();
      card(cards, new THREE.Vector3(px * FT, (base + hh) * FT, py * FT), cn, 0.42 + r() * 0.25, r() * Math.PI * 2, r);
    }
    const g = cards.build();
    if (g) {
      const m = new THREE.Mesh(g, leafCardMat(ctx, "bush"));
      m.castShadow = m.receiveShadow = true;
      ctx.add(m, tag("hedge", "Hedge"));
    }
  }

  function street(o?: StreetOpts): void {
    const RW = clamp(num(o?.road_width_ft, plan.plan.site?.road_width_ft ?? 40), 12, 150);
    const W = plan.plotW, D = plan.plotD;
    const ext = 110;
    const fpY0 = -FOOTPATH, rY0 = -FOOTPATH - RW, rY1 = -FOOTPATH;
    // road
    const road = new MeshBuilder();
    road.faceY(0, (-ext) * FT, (W + ext) * FT, (rY0 - FOOTPATH - 0.5) * FT, rY1 * FT, 1);
    const roadMesh = new THREE.Mesh(road.build()!, M.get("asphalt"));
    roadMesh.receiveShadow = true;
    ctx.add(context(roadMesh), ctag("Road"));
    ctx.collider(roadMesh);
    // markings
    const paint = M.basic("#e9e6dc", { roughness: 0.6 });
    const mk = new Kit();
    const mid = (rY0 + rY1) / 2;
    for (let x = -ext + 4; x < W + ext - 8; x += 18) mk.box(paint, (x + 4) * FT, 0.004, mid * FT, 8 * FT, 0.006, 0.35 * FT);
    for (const yy of [rY0 + 1.2, rY1 - 1.2]) mk.box(paint, (W / 2) * FT, 0.004, yy * FT, (W + 2 * ext) * FT, 0.006, 0.3 * FT);
    ctx.add(context(mk.build(new THREE.Group(), false)), ctag("Road markings"));
    // footpaths + kerbs on both sides (skip parts already landscaped)
    const near: R[] = [{ x: -ext, y: fpY0, w: W + 2 * ext, d: FOOTPATH }];
    const far: R[] = [{ x: -ext, y: rY0 - FOOTPATH, w: W + 2 * ext, d: FOOTPATH }];
    const fpMat = M.get({ preset: "paving", color: "#a9a49b" });
    for (const [rects, kerbY, sign] of [[near, rY1, 1], [far, rY0, -1]] as const) {
      const g = CellGrid.fromRects<boolean>([
        ...rects.map((rect) => ({ rect, val: true })),
        ...ctx.ground.filter((s) => s.y < 0).map((s) => ({ rect: { x: s.x, y: s.y, w: s.w, d: s.d }, val: false })),
      ]);
      const mb = new MeshBuilder();
      for (const rr of g.rects((v) => v === true)) mb.faceY(plan.grade * FT, rr.x * FT, (rr.x + rr.w) * FT, rr.y * FT, (rr.y + rr.d) * FT, 1);
      const m = new THREE.Mesh(mb.build()!, fpMat);
      m.receiveShadow = true;
      ctx.add(context(m), ctag("Footpath"));
      ctx.collider(m);
      const kerb = new Kit();
      kerb.box(M.get({ preset: "concrete", color: "#cfcac1" }), (W / 2) * FT, (plan.grade / 2) * FT, (kerbY + sign * 0.35) * FT, (W + 2 * ext) * FT, plan.grade * FT + 0.01, 0.7 * FT);
      ctx.add(context(kerb.build()), ctag("Kerb"));
    }
    // street trees in the verge
    const r = rng(hashStr(`street${W}`));
    for (let x = -ext + 25; x < W + ext - 20; x += 38 + r() * 12) {
      if (x > -6 && x < W + 6) continue;
      plantTree(ctx, x, fpY0 + 1.8, plan.grade, r() < 0.5 ? "neem" : "ashoka", 18 + r() * 8, `st${x}`);
    }
    if (o?.streetlights !== false) {
      const kit = new Kit();
      const pole = M.get({ preset: "metal_brushed", color: "#7d8187" });
      const head = M.emissive("#fff0d8", 2.2);
      for (const x of [-34, W + 26, -110, W + 92]) {
        const y = fpY0 + 0.6;
        kit.cyl(pole, x * FT, ((plan.grade + 14) / 2) * FT, y * FT, 0.07, 14 * FT, 12);
        kit.cyl(pole, x * FT, (plan.grade + 14) * FT + 0.05, (y - 2.5) * FT, 0.04, 5 * FT, 8, Math.PI / 2 - 0.15);
        kit.rbox(pole, x * FT, (plan.grade + 14.2) * FT, (y - 5) * FT, 0.18, 0.08, 0.6, 0.02, 2);
        kit.box(head, x * FT, (plan.grade + 14.2) * FT - 0.045, (y - 5) * FT, 0.14, 0.01, 0.5);
      }
      ctx.add(context(kit.build()), ctag("Streetlights"));
      utilityPoles(ctx, W, fpY0 + 0.5, ext);
    }
    if (o?.neighbours !== false) neighbours(ctx, W, D, RW, FOOTPATH, streetFrom(ctx, o));
  }

  return { lawn, paving, planter, tree, hedge, street };
}

function overlapFrac(a: R, b: R): number {
  const i = rectIntersect(a, b);
  return i ? (i.w * i.d) / Math.max(1e-6, b.w * b.d) : 0;
}

// ── grass tufts (instanced) ─────────────────────────────────────────────────────────────────────────────
let tuftGeo: THREE.BufferGeometry | null = null;
function grassTufts(ctx: BuildCtx, rect: Rect, h: number): void {
  if (!tuftGeo) {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const r = rng(7);
    const blades = 9;
    for (let i = 0; i < blades; i++) {
      const a = r() * Math.PI * 2, rr = r() * 0.05;
      const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
      const lean = 0.25 + r() * 0.35, la = r() * Math.PI * 2;
      const hh = 0.06 + r() * 0.08, w = 0.007 + r() * 0.004;
      const tx = bx + Math.cos(la) * lean * hh, tz = bz + Math.sin(la) * lean * hh;
      const px = -Math.sin(la) * w, pz = Math.cos(la) * w;
      const k = pos.length / 3;
      pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, tx, hh, tz);
      const dark = [0.14, 0.24, 0.07], light = [0.42, 0.55, 0.2];
      col.push(...dark, ...dark, ...light);
      idx.push(k, k + 1, k + 2);
    }
    tuftGeo = new THREE.BufferGeometry();
    tuftGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    tuftGeo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    tuftGeo.setIndex(idx);
    tuftGeo.computeVertexNormals();
    const nor = tuftGeo.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
  }
  const area = rect.w * rect.d * FT * FT;
  const n = Math.min(ctx.quality === "high" ? 9000 : 3500, Math.round(area * (ctx.quality === "high" ? 140 : 60)));
  if (n < 10) return;
  const mat = ctx.mats.basic("#ffffff", { roughness: 0.9 });
  const tm = (ctx.mats as unknown as { _tuft?: THREE.MeshStandardMaterial });
  if (!tm._tuft) {
    tm._tuft = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    ctx.mats.created.push(tm._tuft);
  }
  void mat;
  const im = new THREE.InstancedMesh(tuftGeo, tm._tuft, n);
  const r = rng(hashStr(`tuft${rect.x},${rect.y}`));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const x = rect.x + r() * rect.w, y = rect.y + r() * rect.d;
    p.set(x * FT, h * FT, -y * FT);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
    const k = 0.7 + r() * 0.9;
    s.set(k, k * (0.8 + r() * 0.5), k);
    m.compose(p, q, s);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = false;
  im.receiveShadow = true;
  im.frustumCulled = true;
  im.computeBoundingSphere();
  ctx.add(im, { kind: "landscape:grass", label: "Grass", level: ctx.plan.levels[0].id });
  im.userData.collide = false;
}

// ── trees ──────────────────────────────────────────────────────────────────────────────────────────────
const leafTex = new Map<string, THREE.Texture>();
function leafTexture(kind: string): THREE.Texture {
  let t = leafTex.get(kind);
  if (t) return t;
  const N = 256;
  const cv = makeCanvas(N);
  const g = cv.getContext("2d") as CanvasRenderingContext2D;
  g.clearRect(0, 0, N, N);
  const r = rng(hashStr(kind));
  const greens = kind === "ashoka" ? ["#24401c", "#2e5124", "#3a6329", "#1d3517"] : kind === "ornamental" ? ["#3a5f2a", "#4d7533", "#2f4f22", "#5a8238"] : ["#2f5223", "#3d6a2b", "#4a7a33", "#284a1f", "#5b8a3c"];
  const leaf = (x: number, y: number, len: number, wid: number, ang: number, col: string) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid, len * 0.45, 0, len);
    g.quadraticCurveTo(-wid, len * 0.45, 0, 0);
    g.fill();
    g.strokeStyle = "rgba(20,35,15,0.35)";
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, len * 0.9);
    g.stroke();
    g.restore();
  };
  if (kind === "palm") {
    // frond strip: midrib along x, leaflets angled both sides
    g.strokeStyle = "#5d6b33";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, N / 2);
    g.lineTo(N, N / 2);
    g.stroke();
    for (let x = 6; x < N - 4; x += 4) {
      const L = (N / 2 - 6) * Math.sin((x / N) * Math.PI * 0.95 + 0.05);
      for (const s of [-1, 1]) {
        g.strokeStyle = greens[Math.floor(r() * greens.length)];
        g.lineWidth = 2.2;
        g.beginPath();
        g.moveTo(x, N / 2);
        g.quadraticCurveTo(x + 14, N / 2 + s * L * 0.5, x + 24, N / 2 + s * L);
        g.stroke();
      }
    }
  } else if (kind === "ashoka") {
    for (let i = 0; i < 42; i++) {
      const x = N * (0.15 + r() * 0.7), y = N * (0.05 + r() * 0.35);
      leaf(x, y, N * (0.35 + r() * 0.25), N * 0.03, (r() - 0.5) * 0.5, greens[Math.floor(r() * greens.length)]);
    }
  } else {
    const n = kind === "bush" ? 110 : 90;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * N * 0.42;
      const x = N / 2 + Math.cos(a) * rr, y = N / 2 + Math.sin(a) * rr;
      leaf(x, y, N * (kind === "bush" ? 0.09 : 0.13) * (0.7 + r() * 0.6), N * (kind === "bush" ? 0.035 : 0.045), a + Math.PI / 2 + (r() - 0.5), greens[Math.floor(r() * greens.length)]);
    }
    if (kind === "ornamental") {
      for (let i = 0; i < 26; i++) {
        const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * N * 0.4;
        g.fillStyle = r() < 0.5 ? "#c2347a" : "#e05a9a";
        g.beginPath();
        g.arc(N / 2 + Math.cos(a) * rr, N / 2 + Math.sin(a) * rr, 4 + r() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  t = new THREE.CanvasTexture(cv as HTMLCanvasElement);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  leafTex.set(kind, t);
  return t;
}

function leafCardMat(ctx: BuildCtx, kind: string): THREE.Material {
  const key = `leafcard|${kind === "neem" || kind === "bush" ? "broad" : kind}`;
  const cache = ctx.mats as unknown as { _cards?: Map<string, THREE.Material> };
  cache._cards ??= new Map();
  let m = cache._cards.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: leafTexture(kind === "neem" ? "broad" : kind), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.75, metalness: 0 });
    m.name = key;
    cache._cards.set(key, m);
    ctx.mats.created.push(m);
  }
  return m;
}

/** One leaf card: a quad centered at p, facing n (for shading normals point outward from the crown). */
function card(mb: MeshBuilder, p: THREE.Vector3, n: THREE.Vector3, size: number, spin: number, r: () => number, radial?: THREE.Vector3): void {
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(up, n).normalize();
  const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
  const c = Math.cos(spin), s = Math.sin(spin);
  const a = t1.clone().multiplyScalar(c).addScaledVector(t2, s).multiplyScalar(size / 2);
  const b = t2.clone().multiplyScalar(c).addScaledVector(t1, -s).multiplyScalar(size / 2);
  const nn = (radial ?? n).clone().normalize();
  const k = mb.pos.length / 3;
  const corners = [
    p.clone().sub(a).sub(b), p.clone().add(a).sub(b), p.clone().add(a).add(b), p.clone().sub(a).add(b),
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1];
  corners.forEach((v, i) => mb.vertex(v.x, v.y, v.z, nn.x, nn.y, nn.z, uv[i * 2], uv[i * 2 + 1]));
  mb.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  void r;
}

export function plantTree(ctx: BuildCtx, x: number, y: number, base: number, kind: TreeKind, H: number, seedKey = ""): void {
  const r = rng(hashStr(`${kind}|${x.toFixed(1)}|${y.toFixed(1)}|${seedKey}`));
  const M = ctx.mats;
  const bark = M.get({ preset: "wood_walnut", color: "#5c4b3d", roughness: 0.9 });
  const kit = new Kit();
  const cards = new MeshBuilder();
  const X = x * FT, Y = base * FT, Z = y * FT;
  const Hm = H * FT;
  const tagLv = ctx.plan.levels[0].id;
  // street trees outside the plot are context, like the road and the neighbours
  const outside = x < 0 || y < 0 || x > ctx.plan.plotW || y > ctx.plan.plotD;
  const treeKind = outside ? "context" : "landscape:tree";
  const ctxMark = (o: THREE.Object3D) => {
    if (outside) o.userData.mergeGroup = "context";
    return o;
  };
  if (kind === "palm") {
    // curved ringed trunk + arching fronds
    const trunkH = Hm * 0.78;
    const lean = new THREE.Vector3((r() - 0.5) * 0.3, 1, (r() - 0.5) * 0.3).normalize();
    const segs = 9;
    let prev = new THREE.Vector3(X, Y, Z);
    const r0 = Math.max(0.09, Hm * 0.028), r1 = r0 * 0.75;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const pt = new THREE.Vector3(X + lean.x * trunkH * t * t * 0.6, Y + trunkH * t, Z + lean.z * trunkH * t * t * 0.6);
      const d = pt.clone().sub(prev);
      const L = d.length();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      const rr = r0 + (r1 - r0) * t;
      kit.geo(bark, lathe("palmseg", [[0.92, 0], [1, 0.15], [1, 0.85], [0.92, 1]], 14), new THREE.Matrix4().compose(prev, q, new THREE.Vector3(rr, L, rr)));
      prev = pt;
    }
    const crown = prev;
    const fronds = 14 + Math.floor(r() * 5);
    const fl = Math.max(0.9, Hm * 0.32);
    const fm = new MeshBuilder();
    for (let i = 0; i < fronds; i++) {
      const az = (i / fronds) * Math.PI * 2 + r() * 0.3;
      const up = 0.9 - (i % 3) * 0.35 + r() * 0.2; // initial elevation
      const len = fl * (0.8 + r() * 0.35);
      frond(fm, crown, az, up, len, 0.28 * len);
    }
    const g1 = fm.build();
    if (g1) {
      const m = new THREE.Mesh(g1, leafCardMat(ctx, "palm"));
      m.castShadow = m.receiveShadow = true;
      ctx.add(ctxMark(m), { kind: treeKind, label: "Palm", level: tagLv });
    }
  } else {
    // trunk + crown of cards
    const spec = {
      neem: { trunk: 0.42, crownR: 0.36, crownH: 0.55, flat: 0.75, cards: 360 },
      ashoka: { trunk: 0.12, crownR: 0.14, crownH: 0.9, flat: 1, cards: 300 },
      ornamental: { trunk: 0.38, crownR: 0.3, crownH: 0.55, flat: 0.85, cards: 200 },
      bush: { trunk: 0, crownR: 0.55, crownH: 0.9, flat: 0.7, cards: 70 },
    }[kind];
    const trunkTop = Hm * spec.trunk;
    if (spec.trunk > 0) {
      const tr = Math.max(0.05, Hm * 0.022);
      kit.geo(bark, lathe("trunk", [[1.3, 0], [1, 0.08], [0.85, 0.6], [0.6, 1]], 12), mat4(X, Y, Z, 0, 0, 0, tr, trunkTop + Hm * 0.12, tr));
      if (kind !== "ashoka")
        for (let b = 0; b < 4; b++) {
          const a = (b / 4) * Math.PI * 2 + r();
          const from = new THREE.Vector3(X, Y + trunkTop * (0.75 + r() * 0.2), Z);
          const to = new THREE.Vector3(X + Math.cos(a) * Hm * spec.crownR * 0.6, Y + trunkTop + Hm * 0.12, Z + Math.sin(a) * Hm * spec.crownR * 0.6);
          const d = to.clone().sub(from);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
          kit.geo(bark, lathe("branch", [[1, 0], [0.55, 1]], 8), new THREE.Matrix4().compose(from, q, new THREE.Vector3(tr * 0.55, d.length(), tr * 0.55)));
        }
    }
    const cy = Y + (kind === "bush" ? Hm * 0.5 : trunkTop + Hm * spec.crownH * 0.5);
    const RX = Math.max(kind === "bush" ? 0.3 : 0.5, Hm * spec.crownR), RY = Math.max(0.3, Hm * spec.crownH * 0.5 * spec.flat);
    const n = Math.round(spec.cards * (ctx.quality === "high" ? 1 : 0.6) * clamp(Hm / 5, kind === "bush" ? 0.5 : 0.7, 1.6));
    const sz = kind === "ashoka" ? Math.max(0.45, Hm * 0.11) : kind === "bush" ? Math.max(0.28, RX * 0.55) : Math.max(0.5, RX * 0.42);
    for (let i = 0; i < n; i++) {
      // points biased to the surface of an ellipsoid (columnar for ashoka)
      const u = r() * 2 - 1, th = r() * Math.PI * 2;
      const rad = Math.pow(r(), 0.35);
      const sxz = Math.sqrt(1 - u * u);
      let px = Math.cos(th) * sxz * rad, py = u * rad, pz = Math.sin(th) * sxz * rad;
      if (kind === "ashoka") {
        const k = 1 - (py + 1) / 2; // wider at the bottom
        px *= 0.4 + 0.75 * k;
        pz *= 0.4 + 0.75 * k;
      }
      const p = new THREE.Vector3(X + px * RX, cy + py * RY, Z + pz * RX);
      const radial = new THREE.Vector3(px, py * 0.8 + 0.25, pz).normalize();
      const nrm = radial.clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(0.9)).normalize();
      card(cards, p, nrm, sz * (0.75 + r() * 0.5), r() * Math.PI * 2, r, radial);
    }
    const g2 = cards.build();
    if (g2) {
      const m = new THREE.Mesh(g2, leafCardMat(ctx, kind));
      m.castShadow = m.receiveShadow = true;
      ctx.add(ctxMark(m), { kind: treeKind, label: kind === "bush" ? "Shrub" : `${kind[0].toUpperCase()}${kind.slice(1)} tree`, level: tagLv });
    }
  }
  if (!kit.empty) ctx.add(ctxMark(kit.build()), { kind: treeKind, label: "Tree", level: tagLv });
}

/** An arching palm frond as a ribbon with the frond texture (u along, v across). */
function frond(mb: MeshBuilder, base: THREE.Vector3, az: number, elev: number, len: number, width: number): void {
  const n = 10;
  const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const k0 = mb.pos.length / 3;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // parabolic arch: rises then droops
    const hx = Math.cos(elev) * len * t;
    const hy = Math.sin(elev) * len * t - len * 0.55 * t * t;
    const c = base.clone().addScaledVector(dir, hx).add(new THREE.Vector3(0, hy, 0));
    const w = width * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)) * 0.5;
    const droop = -w * 0.35;
    const a = c.clone().addScaledVector(side, -w).add(new THREE.Vector3(0, droop, 0));
    const b = c.clone().addScaledVector(side, w).add(new THREE.Vector3(0, droop, 0));
    const nrm = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -0.2).normalize();
    mb.vertex(a.x, a.y, a.z, nrm.x, nrm.y, nrm.z, t, 0);
    mb.vertex(b.x, b.y, b.z, nrm.x, nrm.y, nrm.z, t, 1);
  }
  for (let i = 0; i < n; i++) {
    const a = k0 + i * 2;
    mb.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

// ── street furniture: utility poles + wires, neighbours ───────────────────────────────────────────────
function utilityPoles(ctx: BuildCtx, W: number, y: number, ext: number): void {
  const M = ctx.mats;
  const kit = new Kit();
  const conc = M.get({ preset: "concrete", color: "#a19d95" });
  const dark = M.basic("#1b1c1e", { roughness: 0.7 });
  const xs = [-ext + 20, -18, W + 40, W + ext - 10];
  const top = ctx.plan.grade + 26;
  for (const x of xs) {
    kit.geo(conc, lathe("upole", [[1, 0], [0.62, 1]], 10), mat4(x * FT, ctx.plan.grade * FT, (y + 0.4) * FT, 0, 0, 0, 0.13, (top - ctx.plan.grade) * FT, 0.13));
    kit.box(dark, x * FT, (top - 1.2) * FT, (y + 0.4) * FT, 0.06, 0.06, 1.6);
    kit.cyl(M.basic("#3a3b3c", { roughness: 0.6 }), x * FT, (top - 3.2) * FT, (y + 0.9) * FT, 0.22, 0.6, 12);
  }
  // sagging wires between poles
  const wires = new MeshBuilder();
  for (let i = 0; i < xs.length - 1; i++)
    for (const dz of [-0.6, 0, 0.6]) {
      const a = new THREE.Vector3(xs[i] * FT, (top - 1.15) * FT, (y + 0.4) * FT + dz);
      const b = new THREE.Vector3(xs[i + 1] * FT, (top - 1.15) * FT, (y + 0.4) * FT + dz);
      const segs = 16;
      let prev = a;
      for (let k = 1; k <= segs; k++) {
        const t = k / segs;
        const p = a.clone().lerp(b, t);
        p.y -= Math.sin(Math.PI * t) * 0.9;
        const d = p.clone().sub(prev);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
        wires.addGeometry(unitCyl(4), new THREE.Matrix4().compose(prev.clone().add(p).multiplyScalar(0.5), q, new THREE.Vector3(0.02, d.length(), 0.02)));
        prev = p;
      }
    }
  const poles = kit.build();
  poles.userData.mergeGroup = "context";
  ctx.add(poles, { kind: "context", label: "Utility poles", level: ctx.plan.levels[0].id });
  const wg = wires.build();
  if (wg) {
    const m = new THREE.Mesh(wg, dark);
    m.userData.mergeGroup = "context";
    ctx.add(m, { kind: "context", label: "Power lines", level: ctx.plan.levels[0].id });
  }
}

export interface StreetOpts {
  road_width_ft?: number;
  neighbours?: boolean;
  streetlights?: boolean;
  /** how the neighbours stand; each defaults to plan.site.street */
  form?: "row" | "detached" | "semi-detached";
  side_gap_ft?: number;
  storeys?: number;
  roof?: unknown;
}

interface StreetCfg {
  form: "row" | "detached" | "semi-detached";
  gap: number;
  setback: number | null;
  storeys: number | null;
  roof: PitchSpec | null;
  frontWall: boolean;
  tank: boolean;
  walls: string[];
}

/** How the street stands: the design's options over plan.site.street (stamped from the place's home profile). A plan
 *  without one is a row of flat-roofed houses, as every plan before profiles was. */
function streetFrom(ctx: BuildCtx, o?: StreetOpts): StreetCfg {
  const s = (ctx.plan.plan.site?.street ?? {}) as NonNullable<NonNullable<typeof ctx.plan.plan.site>["street"]>;
  const stamped = !!ctx.plan.plan.site?.street;
  const form = o?.form ?? s.form ?? "row";
  return {
    form: form === "detached" || form === "semi-detached" ? form : "row",
    gap: clamp(num(o?.side_gap_ft, s.side_gap_ft ?? 6), 2, 40),
    setback: s.setback_ft != null ? clamp(num(s.setback_ft, 10), 0, 60) : null,
    storeys: o?.storeys != null || s.storeys != null ? clamp(Math.round(num(o?.storeys, s.storeys ?? 2)), 1, 3) : null,
    roof: pitchSpec(o?.roof, s.roof),
    frontWall: stamped ? s.front_wall !== false : true,
    tank: stamped ? !!s.roof_tank : true,
    walls: (s.walls ?? []).filter((w): w is string => typeof w === "string"),
  };
}

function neighbours(ctx: BuildCtx, W: number, D: number, RW: number, FP: number, cfg: StreetCfg): void {
  const M = ctx.mats;
  const r = rng(hashStr(`nb${W}|${D}`));
  const walls = [
    M.get({ preset: "plaster_white", color: "#e8e3da" }),
    M.get({ preset: "plaster_warm", color: "#dccfbd" }),
    M.get({ preset: "plaster_grey", color: "#c3c0ba" }),
    M.get({ preset: "plaster_warm", color: "#e2d8c8" }),
  ];
  // the street's usual walls, where the place's profile names them
  for (const w of cfg.walls.slice(0, 2).reverse()) {
    const p = resolvePresetName(/brick/i.test(w) ? "brick_red" : w);
    if (p) walls.unshift(M.get(p.color ? { preset: p.preset, color: p.color } : p.preset));
  }
  const roofTone = M.get({ preset: "roof_shingle", color: "#5e5f63" });
  const trim = M.get({ preset: "plaster_white", color: "#f2efe9" });
  const stone = M.get({ preset: "stone_cladding", color: "#8f8a83" });
  const wood = M.get("wood_teak");
  const glass = nbGlass(ctx);
  const frame = M.get("metal_black");
  const kit = new Kit();
  const grade = ctx.plan.grade;
  const bx = (a: number, b: number, c: number, d: number, h0: number, h1: number, m: THREE.Material) =>
    kit.mb(m).box(Math.min(a, b) * FT, h0 * FT, Math.min(c, d) * FT, Math.max(a, b) * FT, h1 * FT, Math.max(c, d) * FT);
  const house = (x0: number, w: number, frontY: number, depth: number, facing: 1 | -1, storeysIn: number) => {
    const wm = walls[Math.floor(r() * Math.min(walls.length, cfg.walls.length ? 2 : walls.length))];
    const storeys = cfg.storeys ?? storeysIn;
    const setback = cfg.setback != null ? cfg.setback + r() * 2 : 9 + r() * 4;
    const fy = frontY + facing * setback;
    const H = storeys * 11 + 1.5;
    const back = fy + facing * depth;
    // main volume (slightly recessed) + projecting front volume on one side
    bx(x0 + 0.6, x0 + w - 0.6, fy + facing * 2.5, back, grade, grade + H, wm);
    const split = x0 + w * (0.42 + r() * 0.16);
    const projLeft = r() < 0.5;
    const pa = projLeft ? x0 + 0.6 : split, pb = projLeft ? split : x0 + w - 0.6;
    bx(pa, pb, fy, fy + facing * 2.6, grade, grade + H + 1.2, wm);
    if (cfg.roof) {
      // a pitched roof over the whole house, the projecting front volume included
      const y0 = Math.min(fy, back), y1 = Math.max(fy, back);
      massRoof(kit, roofTone, wm, { x0: x0 + 0.6, x1: x0 + w - 0.6, y0, y1 }, grade + H + 1.2, cfg.roof.pitch, cfg.roof.form, cfg.roof.ridge, cfg.form === "row" ? 0.2 : 1.2);
    } else {
      // parapet + coping
      bx(x0 + 0.6, x0 + w - 0.6, fy + facing * 2.5, back, grade + H, grade + H + 3, wm);
      bx(x0 + 0.4, x0 + w - 0.4, fy + facing * 2.3, back + facing * 0.2, grade + H + 3, grade + H + 3.25, trim);
    }
    // per storey: chajja band + windows with frames
    for (let s = 0; s < storeys; s++) {
      const fl = grade + 1.5 + s * 11;
      const band = fl + 11 - 0.5;
      bx(x0 + 0.3, x0 + w - 0.3, fy + facing * 2.5 - facing * 1.6, fy + facing * 2.5, band, band + 0.55, trim);
      for (const [a, b, plane] of [[pa, pb, fy], [projLeft ? split : x0 + 0.6, projLeft ? x0 + w - 0.6 : split, fy + facing * 2.5]] as const) {
        const span = Math.abs(b - a);
        const n = Math.max(1, Math.floor(span / 9));
        for (let k = 0; k < n; k++) {
          const wx = Math.min(a, b) + (span * (k + 0.5)) / n;
          const ww = Math.min(7, span / n - 2);
          if (ww < 2) continue;
          const tall = r() < 0.35;
          const h0 = fl + (tall ? 0.3 : 2.6), h1 = fl + 8.2;
          bx(wx - ww / 2, wx + ww / 2, plane - facing * 0.02, plane + facing * 0.2, h0, h1, glass);
          bx(wx - ww / 2 - 0.18, wx + ww / 2 + 0.18, plane - facing * 0.06, plane + facing * 0.12, h1, h1 + 0.18, frame);
          bx(wx - ww / 2 - 0.18, wx + ww / 2 + 0.18, plane - facing * 0.25, plane + facing * 0.12, h0 - 0.15, h0, frame);
          bx(wx - 0.05, wx + 0.05, plane - facing * 0.06, plane + facing * 0.12, h0, h1, frame);
          if (tall && s > 0) bx(wx - ww / 2 - 0.3, wx + ww / 2 + 0.3, plane - facing * 2.2, plane, fl - 0.1, fl + 0.35, trim);
        }
      }
    }
    // accents
    const acc = r();
    if (acc < 0.45) bx(projLeft ? pb - 3.5 : pa, projLeft ? pb : pa + 3.5, fy - facing * 0.25, fy + facing * 0.4, grade, grade + H + 1.2, stone);
    else if (acc < 0.75) bx(pa + 1, pb - 1, fy - facing * 0.2, fy, grade + 12.4, grade + 13.4, wood);
    // boundary wall + gate + water tank, where homes here have them
    const gx = x0 + w * (0.25 + r() * 0.3);
    if (cfg.frontWall) {
      bx(x0, x0 + w, frontY - 0.35, frontY + 0.35, grade - 0.2, grade + 4.5, walls[walls.length - 2]);
      bx(x0, x0 + w, frontY - 0.45, frontY + 0.45, grade + 4.5, grade + 4.7, trim);
      bx(gx, gx + 12, frontY - 0.25, frontY + 0.25, grade, grade + 5.4, frame);
    }
    if (cfg.tank && !cfg.roof) kit.cyl(M.get({ preset: "plastic", color: "#1f2022" }), (x0 + w * 0.3) * FT, (grade + H + 3) * FT + 0.7, ((fy + back) / 2) * FT, 0.65, 1.4, 20);
  };
  const yAcross = -FP - RW - FP;
  if (cfg.form === "row") {
    house(-36, 35, 0, D - 24, 1, 2);
    house(W, 35, 0, D - 24, 1, 2);
    house(-72, 36, 0, D - 24, 1, r() < 0.5 ? 2 : 3);
    house(W + 35, 36, 0, D - 24, 1, 2);
    for (let i = -1; i <= 2; i++) house(-30 + i * 36, 35, yAcross, 44, -1, r() < 0.6 ? 2 : 3);
  } else {
    // lots like this one along both sides of the street; a house stands clear of its lot lines, or of one when semi-detached
    const lot = Math.max(W, 24);
    const g = cfg.gap, depth = Math.min(D - (cfg.setback ?? 12) - 15, 55);
    if (cfg.form === "semi-detached") {
      // pairs sharing a wall: this house's other half on its left, the next pair on its right
      house(-lot + g, lot - g, 0, depth, 1, 2);
      house(W + g, lot - g, 0, depth, 1, 2);
      house(W + lot, lot - g, 0, depth, 1, 2);
      house(-2 * lot, lot - g, 0, depth, 1, 2);
      for (let i = -2; i <= 2; i++) house(i * 2 * lot, 2 * lot - g, yAcross, Math.min(depth, 44), -1, 2);
    } else {
      for (const i of [-2, -1, 1, 2]) house((i < 0 ? i * lot : W + (i - 1) * lot) + g, lot - 2 * g, 0, depth, 1, 2);
      for (let i = -2; i <= 2; i++) house((W - lot) / 2 + i * lot + g, lot - 2 * g, yAcross, Math.min(depth, 44), -1, 2);
    }
  }
  const g = kit.build();
  g.userData.mergeGroup = "context";
  ctx.add(g, { kind: "context", label: "Neighbouring houses", level: ctx.plan.levels[0].id });
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.castShadow = false;
  });
}

function nbGlass(ctx: BuildCtx): THREE.Material {
  const c = ctx.mats as unknown as { _nbg?: THREE.Material };
  if (!c._nbg) {
    c._nbg = new THREE.MeshStandardMaterial({ color: new THREE.Color("#4a5560"), roughness: 0.06, metalness: 0.65, envMapIntensity: 1.6 });
    c._nbg.name = "neighbour_glass";
    ctx.mats.created.push(c._nbg);
  }
  return c._nbg;
}
