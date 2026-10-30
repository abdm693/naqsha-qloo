/** Site: plot platform, ground surfaces (lawn/driveway ramp/paving), boundary walls with coping, gate pillars, gates. */
import * as THREE from "three";
import { CellGrid, type R } from "../core/grid";
import { MeshBuilder } from "../core/meshbuilder";
import { Kit, mat4, unitBox } from "../core/shapes";
import { FT, clamp, num } from "../core/util";
import type { BuildCtx } from "../core/ctx";
import type { RoomM } from "../plan/model";
import { resolveJunctions, type WallRun } from "./model";

export interface SiteMats {
  wall: THREE.Material;
  coping: THREE.Material;
  gate: THREE.Material;
  gateWood: THREE.Material;
  ground: (room: RoomM | null) => THREE.Material;
  platform: THREE.Material;
  base: THREE.Material;
  lamp: THREE.Material;
}

export function buildSite(ctx: BuildCtx, m: SiteMats): void {
  const plan = ctx.plan;
  const W = plan.plotW, D = plan.plotD, grade = plan.grade;
  const L0 = plan.levels[0];

  // ── ground surfaces inside the plot ──────────────────────────────────────────────────────────────
  type Cell = { kind: "room"; room: RoomM } | { kind: "building" } | { kind: "yard" };
  const items: { rect: R; val: Cell }[] = [{ rect: { x: 0, y: 0, w: W, d: D }, val: { kind: "yard" } }];
  for (const r of plan.roomsOn(L0.id)) if (r.cat === "outdoor") items.push({ rect: r.rect, val: { kind: "room", room: r } });
  // building footprint (plinth) blocks the ground
  const P = ctx.model.plinth;
  for (const r of P.rects((v) => v != null)) items.push({ rect: r, val: { kind: "building" } });
  const g = CellGrid.fromRects<Cell>(items, undefined, [0, W], [0, D]);
  const porch = plan.roomsOn(L0.id).find((r) => r.cat === "porch");
  const groups = new Map<string, { mb: MeshBuilder; room: RoomM | null; mat: THREE.Material }>();
  for (const rr of g.rects((v) => !!v && v.kind !== "building", (v) => (v && v.kind === "room" ? v.room.id : "yard"))) {
    const room = rr.key === "yard" ? null : plan.room(rr.key) ?? null;
    const mat = m.ground(room);
    const key = `${rr.key}`;
    let gr = groups.get(key);
    if (!gr) groups.set(key, (gr = { mb: new MeshBuilder(), room, mat }));
    const hFn = rampFn(room, porch, grade);
    const x0 = rr.x * FT, x1 = (rr.x + rr.w) * FT, z0 = rr.y * FT, z1 = (rr.y + rr.d) * FT;
    const h00 = hFn(rr.x, rr.y) * FT, h10 = hFn(rr.x + rr.w, rr.y) * FT, h01 = hFn(rr.x, rr.y + rr.d) * FT, h11 = hFn(rr.x + rr.w, rr.y + rr.d) * FT;
    const sloped = Math.abs(h00 - h11) > 1e-4 || Math.abs(h10 - h01) > 1e-4;
    if (!sloped) gr.mb.faceY(h00, x0, x1, z0, z1, 1);
    else {
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3(0, h01 - h00, z1 - z0), new THREE.Vector3(x1 - x0, h10 - h00, 0)).normalize();
      gr.mb.quad(x0, h01, z1, x1, h11, z1, x1, h10, z0, x0, h00, z0, n.x, n.y, n.z);
      // ramp side walls down to grade where exposed
      for (const [xa, za, xb, zb, ha, hb, nx, nz] of [
        [x0, z0, x0, z1, h00, h01, -1, 0],
        [x1, z1, x1, z0, h11, h10, 1, 0],
      ] as const) {
        if (Math.max(ha, hb) - grade * FT < 0.01) continue;
        gr.mb.quad(xa, grade * FT - 0.03, za, xb, grade * FT - 0.03, zb, xb, hb, zb, xa, ha, za, nx, 0, nz);
      }
    }
  }
  for (const [, gr] of groups) {
    const geo = gr.mb.build();
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, gr.mat);
    mesh.receiveShadow = true;
    const label = gr.room ? gr.room.name : "Yard";
    ctx.add(mesh, { kind: gr.room?.type === "lawn" ? "ground:lawn" : "ground", level: L0.id, room: gr.room?.id, id: gr.room ? `ground_${gr.room.id}` : "ground_yard", label });
    ctx.collider(mesh);
    if (gr.room) ctx.ground.push({ ...gr.room.rect, h: grade, obj: mesh, kind: "site" });
  }

  // ── plot platform edges (raised plot above the road) ─────────────────────────────────────────────
  const pf = new MeshBuilder();
  const hb = -0.25 * FT, ht = grade * FT;
  pf.faceZ(0, 0, W * FT, hb, ht, -1);
  pf.faceZ(D * FT, 0, W * FT, hb, ht, 1);
  pf.faceX(0, hb, ht, 0, D * FT, -1);
  pf.faceX(W * FT, hb, ht, 0, D * FT, 1);
  const pg = pf.build();
  if (pg) {
    const mesh = new THREE.Mesh(pg, m.platform);
    mesh.receiveShadow = true;
    ctx.add(mesh, { kind: "site:platform", level: L0.id, id: "plot_edge", label: "Plot edge" });
  }

  // ── site base: big ground so the plot sits on land even without a street ─────────────────────────
  const base = new MeshBuilder();
  const S = 120;
  const cx = (W / 2) * FT, cz = (D / 2) * FT;
  base.faceY(-0.06 * FT, cx - S, cx + S, cz - S, cz + S, 1);
  const bg = base.build();
  if (bg) {
    const mesh = new THREE.Mesh(bg, m.base);
    mesh.receiveShadow = true;
    ctx.add(mesh, { kind: "site:base", level: L0.id, id: "site_base", label: "Ground" });
    mesh.userData.collide = true;
    ctx.collider(mesh);
  }

  // ── boundary walls ───────────────────────────────────────────────────────────────────────────────
  const bw = plan.plan.site?.boundary_wall ?? { front_height_ft: 4, side_height_ft: 7, rear_height_ft: 7 };
  const hFront = num(bw.front_height_ft, 4, 0, 12), hSide = num(bw.side_height_ft, 7, 0, 14), hRear = num(bw.rear_height_ft, 7, 0, 14);
  const gates = (plan.plan.site?.gates ?? [])
    .filter((gt) => gt && Array.isArray(gt.at))
    .map((gt) => {
      const w = num(gt.width_ft, gt.kind === "pedestrian" ? 4 : 12, 2.5, 30);
      const x = clamp(num(gt.at[0], W / 2), w / 2 + 0.6, W - w / 2 - 0.6);
      return { id: gt.id ?? "gate", kind: gt.kind ?? "sliding", x0: x - w / 2, x1: x + w / 2 };
    })
    .sort((a, b) => a.x0 - b.x0);
  // remove overlaps between gates
  for (let k = 1; k < gates.length; k++) if (gates[k].x0 < gates[k - 1].x1 + 1.3) gates[k].x0 = gates[k - 1].x1 + 1.3;
  const foot = ctx.model.footprint;
  // an open front: no wall or gate on the road, and the side fences start level with the house
  const openFront = hFront < 0.5;
  const sideFrom = openFront && foot.length ? Math.min(...foot.map((f) => f.y)) : 0;
  const lines: { axis: "x" | "y"; c: number; a: number; b: number; h: number; out: -1 | 1; name: string }[] = [
    { axis: "x", c: 0, a: 0, b: W, h: hFront, out: -1, name: "front" },
    { axis: "x", c: D, a: 0, b: W, h: hRear, out: 1, name: "rear" },
    { axis: "y", c: 0, a: sideFrom, b: D, h: hSide, out: -1, name: "left" },
    { axis: "y", c: W, a: sideFrom, b: D, h: hSide, out: 1, name: "right" },
  ];
  const runs: WallRun[] = [];
  for (const ln of lines) {
    if (ln.h < 0.5) continue;
    let spans: [number, number][] = [[ln.a, ln.b]];
    const cut = (p: number, q: number) => {
      const next: [number, number][] = [];
      for (const [a, b] of spans) {
        if (q <= a || p >= b) next.push([a, b]);
        else {
          if (p > a) next.push([a, p]);
          if (q < b) next.push([q, b]);
        }
      }
      spans = next;
    };
    for (const f of foot) {
      const lo = ln.axis === "x" ? f.y : f.x, hi = ln.axis === "x" ? f.y + f.d : f.x + f.w;
      if (ln.c < lo - 0.01 || ln.c > hi + 0.01) continue;
      cut(ln.axis === "x" ? f.x : f.y, ln.axis === "x" ? f.x + f.w : f.y + f.d);
    }
    if (ln.name === "front") for (const gt of gates) cut(gt.x0, gt.x1);
    for (const [a, b] of spans) {
      if (b - a < 0.4) continue;
      runs.push({
        id: `boundary_${ln.name}_${runs.length}`, level: L0, axis: ln.axis, c: ln.c, a, b, t: 0.75, kind: "boundary", neg: null, pos: null, out: ln.out,
        ea: a, eb: b, capA: { kind: "none" }, capB: { kind: "none" }, h0: grade - 0.3, h1: grade + ln.h, openings: [], topExposed: true,
      });
    }
  }
  resolveJunctions(runs);
  const wallMB = new MeshBuilder();
  const copeMB = new MeshBuilder();
  for (const r of runs) {
    const t = r.t, ov = 0.08;
    const box = (mb: MeshBuilder, u0: number, u1: number, w0: number, w1: number, h0: number, h1: number) => {
      if (r.axis === "x") mb.box(u0 * FT, h0 * FT, w0 * FT, u1 * FT, h1 * FT, w1 * FT, { ny: false });
      else mb.box(w0 * FT, h0 * FT, u0 * FT, w1 * FT, h1 * FT, u1 * FT, { ny: false });
    };
    box(wallMB, r.ea, r.eb, r.c - t / 2, r.c + t / 2, r.h0, r.h1);
    box(copeMB, r.ea - (r.capA.kind !== "none" ? ov : 0), r.eb + (r.capB.kind !== "none" ? ov : 0), r.c - t / 2 - ov, r.c + t / 2 + ov, r.h1, r.h1 + 0.14);
  }
  // pillars at gates and plot front corners
  const pillarKit = new Kit();
  const pillarAt = (x: number, y: number, top: number) => {
    const s = 1.3;
    pillarKit.box(m.wall, x * FT, ((grade - 0.3 + top + 0.55) / 2) * FT, y * FT, s * FT, (top + 0.55 - grade + 0.3) * FT, s * FT);
    pillarKit.rbox(m.coping, x * FT, (top + 0.62) * FT, y * FT, (s + 0.22) * FT, 0.16 * FT, (s + 0.22) * FT, 0.01, 1);
    // lantern
    pillarKit.box(m.coping, x * FT, (top + 0.75) * FT, y * FT, 0.55 * FT, 0.1 * FT, 0.55 * FT);
    pillarKit.box(m.lamp, x * FT, (top + 1.12) * FT, y * FT, 0.42 * FT, 0.64 * FT, 0.42 * FT);
    pillarKit.box(m.gate, x * FT, (top + 1.48) * FT, y * FT, 0.55 * FT, 0.08 * FT, 0.55 * FT);
  };
  const frontTop = grade + hFront;
  if (!openFront) for (const gt of gates) {
    pillarAt(gt.x0 - 0.65, 0, frontTop);
    pillarAt(gt.x1 + 0.65, 0, frontTop);
  }
  const wg = wallMB.build(), cg = copeMB.build();
  if (wg) {
    const mesh = new THREE.Mesh(wg, m.wall);
    mesh.castShadow = mesh.receiveShadow = true;
    ctx.add(mesh, { kind: "boundary_wall", level: L0.id, id: "boundary_wall", label: "Boundary wall" });
    ctx.collider(mesh);
  }
  if (cg) {
    const mesh = new THREE.Mesh(cg, m.coping);
    mesh.castShadow = mesh.receiveShadow = true;
    ctx.add(mesh, { kind: "boundary_wall:coping", level: L0.id, id: "boundary_coping", label: "Boundary wall coping" });
  }
  if (!pillarKit.empty) {
    const pg2 = pillarKit.build();
    ctx.add(pg2, { kind: "boundary_wall:pillar", level: L0.id, id: "gate_pillars", label: "Gate pillars" });
    pg2.traverse((o) => (o as THREE.Mesh).isMesh && ctx.collider(o as THREE.Mesh));
  }

  // ── gates ────────────────────────────────────────────────────────────────────────────────────────
  if (!openFront) for (const gt of gates) {
    const kit = new Kit();
    const H = Math.max(5, hFront + 1.0);
    const span = gt.x1 - gt.x0;
    if (gt.kind === "pedestrian") {
      // single leaf, open ~70° into the plot
      const leafW = span - 0.15;
      const base = new THREE.Matrix4().makeTranslation(gt.x0 * FT + 0.04, (grade + 0.12) * FT, 0.12 * FT).multiply(new THREE.Matrix4().makeRotationY(-1.2));
      gateLeaf(kit, m, leafW, H - 0.15, base);
    } else if (gt.kind === "swing") {
      const leafW = span / 2 - 0.08;
      gateLeaf(kit, m, leafW, H, new THREE.Matrix4().makeTranslation(gt.x0 * FT + 0.03, (grade + 0.1) * FT, 0));
      gateLeaf(kit, m, leafW, H, new THREE.Matrix4().makeTranslation((gt.x1 - leafW) * FT - 0.03, (grade + 0.1) * FT, 0));
    } else {
      // sliding gate (closed) on a floor track
      gateLeaf(kit, m, span - 0.1, H, new THREE.Matrix4().makeTranslation((gt.x0 + 0.05) * FT, (grade + 0.18) * FT, 0.1 * FT));
      kit.box(m.gate, ((gt.x0 + gt.x1) / 2) * FT, (grade + 0.04) * FT, 0.1 * FT, (span + 2) * FT, 0.08 * FT, 0.12 * FT);
    }
    const gg = kit.build();
    ctx.add(gg, { kind: "gate", level: L0.id, id: gt.id, label: gt.kind === "pedestrian" ? "Pedestrian gate" : "Main gate" });
    if (gt.kind !== "pedestrian") gg.traverse((o) => (o as THREE.Mesh).isMesh && ctx.collider(o as THREE.Mesh));
  }
}

/** Gate leaf of width w ft and height h ft; origin at bottom-left corner on the gate plane (local +x along). */
function gateLeaf(kit: Kit, m: SiteMats, w: number, h: number, base: THREE.Matrix4): void {
  const f = 0.16;
  const B = (x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: THREE.Material) =>
    kit.mb(mat).addGeometry(unitBox(), base.clone().multiply(mat4(x * FT, y * FT, z * FT, 0, 0, 0, sx * FT, sy * FT, sz * FT)));
  B(f / 2, h / 2, 0, f, h, f, m.gate);
  B(w - f / 2, h / 2, 0, f, h, f, m.gate);
  B(w / 2, f / 2, 0, w, f, f, m.gate);
  B(w / 2, h - f / 2, 0, w, f, f, m.gate);
  // wood slat band in the middle, vertical bars above/below
  const bandLo = h * 0.3, bandHi = h * 0.78;
  B(w / 2, bandLo, 0, w - f, 0.12, f * 0.8, m.gate);
  B(w / 2, bandHi, 0, w - f, 0.12, f * 0.8, m.gate);
  const slats = Math.max(3, Math.round((bandHi - bandLo - 0.12) / 0.34));
  const sh = (bandHi - bandLo - 0.12) / slats;
  for (let k = 0; k < slats; k++) B(w / 2, bandLo + 0.06 + sh * (k + 0.5), 0.0, w - f * 2, sh - 0.06, 0.07, m.gateWood);
  const bars = Math.max(2, Math.round((w - f * 2) / 0.32));
  for (let k = 1; k < bars; k++) {
    const x = f + ((w - 2 * f) * k) / bars;
    B(x, (f + bandLo) / 2, 0, 0.07, bandLo - f, 0.07, m.gate);
    B(x, (bandHi + h - f) / 2, 0, 0.07, h - f - bandHi, 0.07, m.gate);
  }
}

/** Height function for ground surfaces: driveways ramp up to the porch floor. */
function rampFn(room: RoomM | null, porch: RoomM | undefined, grade: number): (x: number, y: number) => number {
  if (!room || room.type !== "driveway" || !porch) return () => grade;
  const r = room.rect, p = porch.rect;
  const top = porch.floorH - 0.02;
  if (top - grade < 0.05) return () => grade;
  const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
  if (Math.abs(r.y + r.d - p.y) < 0.3 && ov(r.x, r.x + r.w, p.x, p.x + p.w)) return (_x, y) => grade + (top - grade) * clamp((y - r.y) / r.d, 0, 1);
  if (Math.abs(p.y + p.d - r.y) < 0.3 && ov(r.x, r.x + r.w, p.x, p.x + p.w)) return (_x, y) => grade + (top - grade) * clamp((r.y + r.d - y) / r.d, 0, 1);
  if (Math.abs(r.x + r.w - p.x) < 0.3 && ov(r.y, r.y + r.d, p.y, p.y + p.d)) return (x) => grade + (top - grade) * clamp((x - r.x) / r.w, 0, 1);
  if (Math.abs(p.x + p.w - r.x) < 0.3 && ov(r.y, r.y + r.d, p.y, p.y + p.d)) return (x) => grade + (top - grade) * clamp((r.x + r.w - x) / r.w, 0, 1);
  return () => grade;
}
