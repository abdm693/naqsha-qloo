/**
 * Pitched roofs, gable and hip, sitting on the walls the plan already has: rooms, stairs and every rule check are untouched.
 * The roof covers the bounding rectangle of the top storey's enclosed rooms. Its eaves start at the top of the parapet, so
 * the parapet reads as a knee wall under them; the gap up to the roof plane is filled with the wall material, the gable ends
 * too. The roof level stays as a floored attic (PlanModel.enterAttic): the stair arrives there behind a guard rail, and no
 * stair tower, tank or solar frame stands up through the roof. Heights are feet above the road crown.
 */
import * as THREE from "three";
import type { MaterialPreset, MaterialSpec } from "@contracts/house-sdk";
import type { BuildCtx } from "../core/ctx";
import { MeshBuilder } from "../core/meshbuilder";
import { Kit } from "../core/shapes";
import { DEG, FT, clamp, num } from "../core/util";
import { PRESETS } from "../materials/library";
import { EXT_T } from "./model";
import { southVector } from "./roof-geo";

export type RoofForm = "gable" | "hip";
export type RidgeAxis = "x" | "y";

export interface PitchSpec {
  form: RoofForm;
  pitch: number; // degrees
  ridge: RidgeAxis | "auto";
  overhang: number; // ft
  material?: MaterialSpec | string;
  fascia?: MaterialSpec;
  soffit?: MaterialSpec;
}

export interface Box2 { x0: number; x1: number; y0: number; y1: number }
export type P3 = [number, number, number]; // plan x, plan y, height

export interface RoofGeom {
  outer: Box2;
  eave: number;
  top: number;
  axis: RidgeAxis;
  tan: number;
  /** the slopes, each a convex polygon starting with its eave edge */
  planes: P3[][];
  /** height of the roof surface over a plan point */
  surf(x: number, y: number): number;
}

const RIDGE: Record<string, RidgeAxis> = { x: "x", y: "y", along_road: "x", parallel: "x", across_road: "y", perpendicular: "y" };
const SHELL_T = 0.35; // roof build-up, top surface to soffit
const FASCIA = 0.6;
const MAX_SPAN = 38; // no ordinary ridge spans more: the roof turns
const MAX_RISE = 15;

/** The roof asked for, from s.structure({ roof }) over plan.roof.pitched; null for a flat roof. Forgiving, like the SDK. */
export function pitchSpec(asked: unknown, planned: unknown): PitchSpec | null {
  const a = (asked && typeof asked === "object" ? asked : {}) as Record<string, unknown>;
  const p = (planned && typeof planned === "object" ? planned : {}) as Record<string, unknown>;
  const form = String(a.form ?? p.form ?? "flat").toLowerCase();
  if (form !== "gable" && form !== "hip") return null;
  return {
    form,
    pitch: clamp(num(a.pitch_deg ?? a.pitch ?? p.pitch_deg ?? p.pitch, 30), 10, 55),
    ridge: RIDGE[String(a.ridge ?? p.ridge ?? "").toLowerCase()] ?? "auto",
    overhang: clamp(num(a.overhang_ft ?? a.overhang ?? p.overhang_ft ?? p.overhang, 1.5), 0, 3),
    material: (a.material ?? p.material) as PitchSpec["material"],
    fascia: a.fascia as MaterialSpec | undefined,
    soffit: a.soffit as MaterialSpec | undefined,
  };
}

/** Pick the ridge: as asked unless it would span too far; along the long side when free. A hip's always runs the long way. */
export function ridgeAxis(b: Box2, form: RoofForm, want: RidgeAxis | "auto"): RidgeAxis {
  const w = b.x1 - b.x0, d = b.y1 - b.y0;
  const long: RidgeAxis = w >= d ? "x" : "y";
  if (form === "hip" || want === "auto") return long;
  const span = want === "x" ? d : w;
  return span > MAX_SPAN && (want === "x" ? w : d) < span ? long : want;
}

/** The slopes over a rectangle, eaves at height `eave`. */
export function roofGeom(o: Box2, eave: number, pitch: number, form: RoofForm, axis: RidgeAxis): RoofGeom {
  const w = o.x1 - o.x0, d = o.y1 - o.y0;
  const half = (axis === "x" ? d : w) / 2;
  const tan = Math.min(Math.tan(pitch * DEG), MAX_RISE / Math.max(half, 1));
  const top = eave + half * tan;
  const xm = (o.x0 + o.x1) / 2, ym = (o.y0 + o.y1) / 2;
  const e = eave;
  const planes: P3[][] = [];
  if (form === "gable") {
    if (axis === "x") {
      planes.push([[o.x0, o.y0, e], [o.x1, o.y0, e], [o.x1, ym, top], [o.x0, ym, top]]);
      planes.push([[o.x1, o.y1, e], [o.x0, o.y1, e], [o.x0, ym, top], [o.x1, ym, top]]);
    } else {
      planes.push([[o.x0, o.y1, e], [o.x0, o.y0, e], [xm, o.y0, top], [xm, o.y1, top]]);
      planes.push([[o.x1, o.y0, e], [o.x1, o.y1, e], [xm, o.y1, top], [xm, o.y0, top]]);
    }
  } else if (axis === "x") {
    const r0 = Math.min(o.x0 + half, xm), r1 = Math.max(o.x1 - half, xm);
    planes.push(uniq([[o.x0, o.y0, e], [o.x1, o.y0, e], [r1, ym, top], [r0, ym, top]]));
    planes.push(uniq([[o.x1, o.y1, e], [o.x0, o.y1, e], [r0, ym, top], [r1, ym, top]]));
    planes.push([[o.x0, o.y1, e], [o.x0, o.y0, e], [r0, ym, top]]);
    planes.push([[o.x1, o.y0, e], [o.x1, o.y1, e], [r1, ym, top]]);
  } else {
    const r0 = Math.min(o.y0 + half, ym), r1 = Math.max(o.y1 - half, ym);
    planes.push(uniq([[o.x0, o.y1, e], [o.x0, o.y0, e], [xm, r0, top], [xm, r1, top]]));
    planes.push(uniq([[o.x1, o.y0, e], [o.x1, o.y1, e], [xm, r1, top], [xm, r0, top]]));
    planes.push([[o.x0, o.y0, e], [o.x1, o.y0, e], [xm, r0, top]]);
    planes.push([[o.x1, o.y1, e], [o.x0, o.y1, e], [xm, r1, top]]);
  }
  const surf = (x: number, y: number): number => {
    const across = axis === "x" ? Math.min(y - o.y0, o.y1 - y) : Math.min(x - o.x0, o.x1 - x);
    const along = form === "hip" ? (axis === "x" ? Math.min(x - o.x0, o.x1 - x) : Math.min(y - o.y0, o.y1 - y)) : Infinity;
    return e + Math.min(across, along, half) * tan;
  };
  return { outer: o, eave: e, top, axis, tan, planes, surf };
}

function uniq(p: P3[]): P3[] {
  return p.filter((q, i) => !p.slice(0, i).some((s) => Math.abs(s[0] - q[0]) < 1e-6 && Math.abs(s[1] - q[1]) < 1e-6 && Math.abs(s[2] - q[2]) < 1e-6));
}

/** Append a convex polygon. `want`: the side its normal must face. uvEave: u runs along the first edge, v up the slope (m). */
export function poly(mb: MeshBuilder, pts: P3[], want: [number, number, number], lift = 0, uvEave = false): void {
  const v = pts.map(([x, y, h]) => new THREE.Vector3(x * FT, (h + lift) * FT, y * FT));
  if (v.length < 3) return;
  const n = new THREE.Vector3().crossVectors(v[1].clone().sub(v[0]), v[2].clone().sub(v[0])).normalize();
  const face = n.dot(new THREE.Vector3(want[0], want[1], want[2])) < 0;
  const order = face ? [...v].reverse() : v;
  if (face) n.negate();
  const a = v[1].clone().sub(v[0]).normalize();
  const b = new THREE.Vector3().crossVectors(n, a).normalize();
  if (b.y < 0) b.negate();
  const base = mb.vertexCount;
  for (const p of order) {
    if (uvEave) mb.vertex(p.x, p.y, p.z, n.x, n.y, n.z, p.dot(a), p.dot(b));
    else mb.vertex(p.x, p.y, p.z, n.x, n.y, n.z);
  }
  for (let i = 1; i + 1 < order.length; i++) mb.idx.push(base, base + i, base + i + 1);
}

/** The rectangle the roof covers (outer wall faces), or null when the top storey has no enclosed room. */
export function roofRect(ctx: BuildCtx): Box2 | null {
  const plan = ctx.plan;
  const top = plan.levelBelow(plan.roof);
  if (!top) return null;
  const rooms = plan.roomsOn(top.id).filter((r) => r.cat === "enclosed");
  if (!rooms.length) return null;
  const t = EXT_T / 2;
  return {
    x0: Math.min(...rooms.map((r) => r.rect.x)) - t, x1: Math.max(...rooms.map((r) => r.rect.x + r.rect.w)) + t,
    y0: Math.min(...rooms.map((r) => r.rect.y)) - t, y1: Math.max(...rooms.map((r) => r.rect.y + r.rect.d)) + t,
  };
}

function roofMaterial(ctx: BuildCtx, m: PitchSpec["material"]): THREE.Material {
  if (m && typeof m === "object") return ctx.mats.get(m as MaterialSpec, "roof_shingle");
  const t = String(m ?? "").toLowerCase();
  if ((PRESETS as Record<string, unknown>)[t]) return ctx.mats.get(t as MaterialPreset);
  const words: [RegExp, MaterialPreset][] = [[/metal|steel|seam|zinc|\btin\b|copper|alumin/, "roof_metal"], [/clay|terracotta|tile|pantile|mangalore/, "roof_tile"], [/slate/, "roof_slate"], [/shingle|asphalt|bitumen/, "roof_shingle"]];
  const preset = words.map(([re, p]) => ({ i: t.search(re), p })).filter((w) => w.i >= 0).sort((a, b) => a.i - b.i)[0]?.p ?? "roof_shingle";
  const tones: [RegExp, string][] = [[/charcoal|black|dark/, "#3d3e42"], [/grey|gray|silver|pewter/, "#6f7276"], [/brown|bronze/, "#5c4638"], [/green/, "#4b5a4a"], [/white|light/, "#c9c7c1"]];
  const color = tones.find(([re]) => re.test(t))?.[1];
  return ctx.mats.get(color && preset !== "roof_tile" ? { preset, color } : preset);
}

/** Build the roof. `wall` is the exterior wall material, for the gable ends and the band under the eaves. */
export function buildPitchedRoof(ctx: BuildCtx, spec: PitchSpec, wall: THREE.Material): void {
  const rect = roofRect(ctx);
  if (!rect) return;
  const plan = ctx.plan;
  const env = ctx.model.envelope;
  const clip = (want: number, room: number) => clamp(Math.min(want, room), 0, want);
  // never past a party wall or the plot edge
  const ov = {
    l: clip(spec.overhang, rect.x0 - Math.max(env.x0, 0)),
    r: clip(spec.overhang, Math.min(env.x1, plan.plotW) - rect.x1),
    f: clip(spec.overhang, rect.y0 - Math.max(env.y0, 0)),
    b: clip(spec.overhang, Math.min(env.y1, plan.plotD) - rect.y1),
  };
  const axis = ridgeAxis(rect, spec.form, spec.ridge);
  const gable = spec.form === "gable";
  // rakes (the sloped ends of a gable) stay tight; the eaves take the full overhang
  const outer: Box2 = axis === "x"
    ? { x0: rect.x0 - (gable ? Math.min(ov.l, 1) : ov.l), x1: rect.x1 + (gable ? Math.min(ov.r, 1) : ov.r), y0: rect.y0 - ov.f, y1: rect.y1 + ov.b }
    : { x0: rect.x0 - ov.l, x1: rect.x1 + ov.r, y0: rect.y0 - (gable ? Math.min(ov.f, 1) : ov.f), y1: rect.y1 + (gable ? Math.min(ov.b, 1) : ov.b) };
  const knee = plan.roof.elev + plan.parapet;
  const eaveSides = gable ? (axis === "x" ? [ov.f, ov.b] : [ov.l, ov.r]) : [ov.l, ov.r, ov.f, ov.b];
  const tan0 = Math.min(Math.tan(spec.pitch * DEG), MAX_RISE / Math.max((axis === "x" ? outer.y1 - outer.y0 : outer.x1 - outer.x0) / 2, 1));
  // the soffit meets the top of the knee wall at the side with the least overhang
  const eave = knee + SHELL_T - Math.min(...eaveSides) * tan0;
  const G = roofGeom(outer, eave, spec.pitch, spec.form, axis);

  const roofM = roofMaterial(ctx, spec.material);
  const soffit = ctx.mats.get(spec.soffit, { preset: "paint", color: "#e6e1d7" });
  const fascia = ctx.mats.get(spec.fascia, { preset: "paint", color: "#efeae1" });
  const kit = new Kit();
  const top = kit.mb(roofM), under = kit.mb(soffit), trim = kit.mb(fascia), band = kit.mb(wall);
  for (const p of G.planes) {
    poly(top, p, [0, 1, 0], 0, true);
    poly(under, p, [0, -1, 0], -SHELL_T);
  }
  // fascia along the eaves
  for (const p of G.planes) {
    const [a, b] = p;
    const horiz = Math.abs(a[1] - b[1]) < 1e-6;
    const out: [number, number, number] = horiz ? [0, 0, a[1] <= outer.y0 + 1e-6 ? -1 : 1] : [a[0] <= outer.x0 + 1e-6 ? -1 : 1, 0, 0];
    const lo = a[2] - FASCIA, hi = a[2] + 0.02;
    poly(trim, [[a[0], a[1], lo], [b[0], b[1], lo], [b[0], b[1], hi], [a[0], a[1], hi]], out);
    poly(trim, [[a[0], a[1], lo], [b[0], b[1], lo], [b[0] + out[0] * -0.3, b[1] + out[2] * -0.3, lo], [a[0] + out[0] * -0.3, a[1] + out[2] * -0.3, lo]], [0, -1, 0]);
  }
  const wallTop = (x: number, y: number) => G.surf(x, y) - SHELL_T + 0.03;
  // from the slab, not the knee wall: where the top storey steps in (a balcony, a terrace) the roof's own wall closes the attic
  const sill = plan.roof.elev - 0.02;
  if (gable) {
    // barge boards up the rakes, and the gable walls on the true wall planes
    const ends = axis === "x" ? [outer.x0, outer.x1] : [outer.y0, outer.y1];
    const mid = axis === "x" ? (outer.y0 + outer.y1) / 2 : (outer.x0 + outer.x1) / 2;
    const [s0, s1] = axis === "x" ? [outer.y0, outer.y1] : [outer.x0, outer.x1];
    for (const c of ends) {
      const P = (u: number, h: number): P3 => (axis === "x" ? [c, u, h] : [u, c, h]);
      const out: [number, number, number] = axis === "x" ? [c === outer.x0 ? -1 : 1, 0, 0] : [0, 0, c === outer.y0 ? -1 : 1];
      for (const u of [s0, s1]) poly(trim, [P(u, G.eave), P(mid, G.top), P(mid, G.top - FASCIA), P(u, G.eave - FASCIA)], out);
    }
    const planes = axis === "x" ? [[rect.x0, rect.x0 + EXT_T, -1], [rect.x1, rect.x1 - EXT_T, 1]] : [[rect.y0, rect.y0 + EXT_T, -1], [rect.y1, rect.y1 - EXT_T, 1]];
    for (const [outerC, innerC, sign] of planes) {
      for (const [c, dir] of [[outerC, sign], [innerC, -sign]] as const) {
        const a = axis === "x" ? rect.y0 : rect.x0, b = axis === "x" ? rect.y1 : rect.x1;
        const P = (u: number, h: number): P3 => (axis === "x" ? [c, u, h] : [u, c, h]);
        const S = (u: number) => (axis === "x" ? wallTop(c, u) : wallTop(u, c));
        const pts: P3[] = [P(a, sill), P(b, sill), P(b, S(b)), P(mid, S(mid)), P(a, S(a))];
        poly(band, pts, axis === "x" ? [dir, 0, 0] : [0, 0, dir]);
      }
      // a slatted vent high in the gable, on the outer face
      const apex = wallTop(axis === "x" ? outerC : mid, axis === "x" ? mid : outerC);
      const H = Math.min(2.6, (apex - knee) * 0.3), W = H * 0.8, h0 = apex - H * 2.1;
      if (apex - knee > 5) {
        const off = sign * 0.06;
        for (let k = 0; k <= 6; k++) {
          const h = h0 + (H * k) / 6;
          const tall = k === 0 || k === 6 ? 0.16 : 0.1;
          if (axis === "x") trim.box(Math.min(outerC, outerC + off) * FT, h * FT, (mid - W / 2) * FT, Math.max(outerC, outerC + off) * FT, (h + tall) * FT, (mid + W / 2) * FT);
          else trim.box((mid - W / 2) * FT, h * FT, Math.min(outerC, outerC + off) * FT, (mid + W / 2) * FT, (h + tall) * FT, Math.max(outerC, outerC + off) * FT);
        }
        for (const e of [-1, 1]) {
          const u = mid + (e * W) / 2;
          if (axis === "x") trim.box(Math.min(outerC, outerC + off) * FT, h0 * FT, (u - 0.07) * FT, Math.max(outerC, outerC + off) * FT, (h0 + H + 0.16) * FT, (u + 0.07) * FT);
          else trim.box((u - 0.07) * FT, h0 * FT, Math.min(outerC, outerC + off) * FT, (u + 0.07) * FT, (h0 + H + 0.16) * FT, Math.max(outerC, outerC + off) * FT);
        }
      }
    }
  }
  // the band of wall between the knee wall and the soffit, on the eave sides
  const strips: { u0: number; u1: number; c: number; alongX: boolean; h: number }[] = [];
  if (!gable || axis === "x") {
    strips.push({ u0: rect.x0, u1: rect.x1, c: rect.y0 + EXT_T / 2, alongX: true, h: wallTop((rect.x0 + rect.x1) / 2, rect.y0) });
    strips.push({ u0: rect.x0, u1: rect.x1, c: rect.y1 - EXT_T / 2, alongX: true, h: wallTop((rect.x0 + rect.x1) / 2, rect.y1) });
  }
  if (!gable || axis === "y") {
    strips.push({ u0: rect.y0, u1: rect.y1, c: rect.x0 + EXT_T / 2, alongX: false, h: wallTop(rect.x0, (rect.y0 + rect.y1) / 2) });
    strips.push({ u0: rect.y0, u1: rect.y1, c: rect.x1 - EXT_T / 2, alongX: false, h: wallTop(rect.x1, (rect.y0 + rect.y1) / 2) });
  }
  for (const s of strips) {
    const t = EXT_T / 2;
    if (s.alongX) band.box(s.u0 * FT, sill * FT, (s.c - t) * FT, s.u1 * FT, s.h * FT, (s.c + t) * FT);
    else band.box((s.c - t) * FT, sill * FT, s.u0 * FT, (s.c + t) * FT, s.h * FT, s.u1 * FT);
  }
  // ridge cap
  if (gable || Math.abs((axis === "x" ? outer.x1 - outer.x0 : outer.y1 - outer.y0) - (axis === "x" ? outer.y1 - outer.y0 : outer.x1 - outer.x0)) > 0.5) {
    const xs = G.planes.flat().filter((p) => p[2] > G.top - 1e-6);
    const x0 = Math.min(...xs.map((p) => p[0])), x1 = Math.max(...xs.map((p) => p[0])), y0 = Math.min(...xs.map((p) => p[1])), y1 = Math.max(...xs.map((p) => p[1]));
    const w = 0.42;
    if (axis === "x") top.box(x0 * FT, (G.top - 0.12) * FT, (y0 - w) * FT, x1 * FT, (G.top + 0.1) * FT, (y0 + w) * FT);
    else top.box((x0 - w) * FT, (G.top - 0.12) * FT, y0 * FT, (x0 + w) * FT, (G.top + 0.1) * FT, y1 * FT);
  }
  flushPanels(ctx, G, kit);
  const g = kit.build();
  ctx.add(g, { kind: "roof", level: plan.roof.id, id: "pitched_roof", label: spec.form === "hip" ? "Hip roof" : "Gable roof" });
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) ctx.collider(o as THREE.Mesh);
  });
}

/** Solar panels lying flush on the sunniest slope, when the brief asks for panels (there are no raised rows on a pitched roof). */
function flushPanels(ctx: BuildCtx, G: RoofGeom, kit: Kit): void {
  if (ctx.plan.plan.roof?.solar?.mode !== "panels") return;
  const [sx, sy] = southVector(ctx);
  // the slope whose fall faces south the most
  const facing = (p: P3[]) => {
    const [a, b, c] = p;
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
    const nx = ey / L, ny = -ex / L; // horizontal, across the eave
    const out = nx * (a[0] - c[0]) + ny * (a[1] - c[1]) > 0 ? 1 : -1;
    return (nx * sx + ny * sy) * out;
  };
  const best = [...G.planes].filter((p) => p.length === 4).sort((p, q) => facing(q) - facing(p))[0];
  if (!best) return;
  const [a, b, c] = best;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const inX = c[0] - b[0], inY = c[1] - b[1];
  const across = Math.abs(a[1] - b[1]) < 1e-6 ? [0, Math.sign(inY)] : [Math.sign(inX), 0];
  const run = Math.abs(a[1] - b[1]) < 1e-6 ? Math.abs(inY) : Math.abs(inX);
  const pw = 3.6, pl = 5.8, gap = 0.12, margin = 2.5;
  const nU = Math.floor((L - 2 * margin) / (pw + gap)), nV = Math.min(3, Math.floor((run - 2 * margin) / (pl * Math.cos(Math.atan(G.tan)) + gap)));
  if (nU < 1 || nV < 1) return;
  const glass = ctx.mats.basic("#17202e", { roughness: 0.18, metalness: 0.35 });
  const mb = kit.mb(glass, false);
  const ex = (b[0] - a[0]) / L, ey = (b[1] - a[1]) / L;
  const u0 = (L - nU * (pw + gap)) / 2;
  const stepV = pl * Math.cos(Math.atan(G.tan)) + gap;
  const at = (u: number, v: number): P3 => {
    const x = a[0] + ex * u + across[0] * v, y = a[1] + ey * u + across[1] * v;
    return [x, y, a[2] + v * G.tan];
  };
  for (let i = 0; i < nU; i++)
    for (let j = 0; j < nV; j++) {
      const u = u0 + i * (pw + gap), v = margin + j * stepV;
      poly(mb, [at(u, v), at(u + pw, v), at(u + pw, v + stepV - gap), at(u, v + stepV - gap)], [0, 1, 0], 0.14);
    }
}

/** A neighbour's plain pitched roof: slopes in `roof`, gable ends in `wall`, over a wall top at `h`. */
export function massRoof(kit: Kit, roof: THREE.Material, wall: THREE.Material, b: Box2, h: number, pitch: number, form: RoofForm, want: RidgeAxis | "auto", overhang: number): number {
  const axis = ridgeAxis(b, form, want);
  const gable = form === "gable";
  const outer: Box2 = { x0: b.x0 - overhang, x1: b.x1 + overhang, y0: b.y0 - overhang, y1: b.y1 + overhang };
  const tan = Math.tan(pitch * DEG);
  const G = roofGeom(outer, h - overhang * tan + 0.1, pitch, form, axis);
  const top = kit.mb(roof), side = kit.mb(wall);
  for (const p of G.planes) {
    poly(top, p, [0, 1, 0], 0, true);
    poly(top, p, [0, -1, 0], -0.3);
  }
  if (gable) {
    const mid = axis === "x" ? (b.y0 + b.y1) / 2 : (b.x0 + b.x1) / 2;
    const [a, c] = axis === "x" ? [b.y0, b.y1] : [b.x0, b.x1];
    const ends = axis === "x" ? [b.x0, b.x1] : [b.y0, b.y1];
    for (const e of ends) {
      const P = (u: number, hh: number): P3 => (axis === "x" ? [e, u, hh] : [u, e, hh]);
      const S = (u: number) => (axis === "x" ? G.surf(e, u) : G.surf(u, e)) - 0.3;
      const out: [number, number, number] = axis === "x" ? [e === b.x0 ? -1 : 1, 0, 0] : [0, 0, e === b.y0 ? -1 : 1];
      poly(side, [P(a, h), P(c, h), P(c, S(c)), P(mid, S(mid)), P(a, S(a))], out);
    }
  }
  return G.top;
}
