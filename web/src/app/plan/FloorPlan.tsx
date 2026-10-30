/**
 * The floor plan: a vector drawing of one level on white (DESIGN.md "Plan"). Ink walls, plan fills by room
 * category, door swings, mono dimensions, the setback as a 1px accent dash, the road (and the side road on a
 * corner plot), north arrow and scale bar. Zoom and pan (wheel, drag, pinch, double-click, +/−/fit), labels that
 * never collide or go blank, "Opens to…" on hover, numbered comment pins, and changed rooms outlined with
 * their area delta.
 *
 * `PlanSheet` is the pure drawing (also used for print at true scale); `FloorPlan` is the interactive canvas.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import type { BuildingPlan, Opening, Room } from "@contracts/plan";
import { cn, feetInches, num, sizeLabel } from "@/app/lib/utils";
import { EXT_WALL, deriveWalls, placeOpenings, stairDrawing, wallPieces, type PlacedOpening, type StairDrawing } from "./geometry";
import { layoutLabels, measure, type Box, type Label } from "./labels";
import { CATEGORY, FILL, OPEN_TYPES, SITE_TYPES, area, isRoofLevel, levelsOf, opensTo, sentenceCase } from "./model";
import { planSolarLabel, planTankLabel } from "@/app/lib/roof";

export type HighlightTone = "accent" | "fail" | "warn" | "pass";

export interface PlanPin { id: string; n: number; x: number; y: number; hue: number; text: string; selected?: boolean }

const INK = "#111113";
const INK2 = "#46464B";
const INK3 = "#6E6E73";
const LINE = "#CFCFC8";
const ACCENT = "#6B2A5E";
const PAPER = "#FFFFFF";
const TONE: Record<HighlightTone, string> = { accent: ACCENT, fail: "#C8281E", warn: "#A35A00", pass: "#0E7A55" };
const HUE = ["#0D7C72", "#6A4FD6", "#C23F78", "#A8641A", "#4F6378", "#2F7A3A"];
const SANS = "Geist, ui-sans-serif, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, monospace";

/** "+20 sq ft", "−30 sq ft", "New". */
export function deltaStrings(deltas: Map<string, number | "new"> | undefined): Map<string, string> | undefined {
  if (!deltas?.size) return undefined;
  const out = new Map<string, string>();
  for (const [id, d] of deltas) out.set(id, d === "new" ? "New" : `${d > 0 ? "+" : "−"}${num(Math.abs(d))} sq ft`);
  return out;
}

/** Margins around the plot in plan feet: room for dimensions, the road and the north arrow. */
export const MARGIN = { l: 9, r: 10, t: 9, b: 13 };

export function sheetBounds(plan: BuildingPlan, corner = plan.site.plot.corner) {
  const W = plan.site.plot.width_ft;
  const D = plan.site.plot.depth_ft;
  const side = corner ? 7 : 0;
  return { x: -MARGIN.l - (corner && cornerSide(plan) === "left" ? side : 0), y: -MARGIN.t, w: W + MARGIN.l + MARGIN.r + side, h: D + MARGIN.t + MARGIN.b };
}

/** Which side the second road is on for a corner plot (the side with the larger setback, right by default). */
export function cornerSide(plan: BuildingPlan): "left" | "right" {
  const sb = plan.site.setbacks_ft;
  return sb.left > sb.right ? "left" : "right";
}

/**
 * What room labels must keep clear of on a level: each stair's drawing, and its "Up" / "Down" mark (which sits just
 * outside the flights).
 */
export function stairAvoid(plan: BuildingPlan, levelId: string, ppf: number): Box[] {
  const up = plan.stairs.filter((s) => s.from_level === levelId).map((s) => ({ d: stairDrawing(s, plan.levels), dir: "up" as const }));
  const down = up.length ? [] : plan.stairs.filter((s) => s.to_level === levelId).map((s) => ({ d: stairDrawing(s, plan.levels), dir: "down" as const }));
  const out: Box[] = [];
  for (const { d, dir } of [...up, ...down]) {
    out.push({ x0: d.outline.x, y0: d.outline.y, x1: d.outline.x + d.outline.w, y1: d.outline.y + d.outline.d });
    const [sx, sy] = dir === "up" ? d.path[0] : d.path[d.path.length - 1];
    const hw = 16 / ppf;
    out.push({ x0: sx - hw, y0: sy - 22 / ppf, x1: sx + hw, y1: sy + 14 / ppf });
  }
  return [...out, ...swingAvoid(plan, levelId), ...gateAvoid(plan, levelId, ppf)];
}

/**
 * Every door's swing on a level, as boxes in plan feet (y up): the quarter circle a leaf sweeps, so no room name or
 * size is ever printed across an arc.
 */
export function swingAvoid(plan: BuildingPlan, levelId: string): Box[] {
  const building = plan.rooms.filter((r) => r.level === levelId && !SITE_TYPES.has(r.type));
  if (!building.length) return [];
  const { walls, boundaries } = deriveWalls(building);
  const placed = placeOpenings(plan.openings.filter((o) => o.level === levelId), building, walls, boundaries);
  const out: Box[] = [];
  for (const p of placed) {
    const t = p.opening.type;
    if (t !== "door" && t !== "main_door" && t !== "double_door") continue;
    const L = p.b - p.a;
    const leaves: [number, number][] = t === "double_door" ? [[p.a, p.a + L / 2], [p.b - L / 2, p.b]] : [p.hingeAtA ? [p.a, p.a + L] : [p.b - L, p.b]];
    for (const [u0, u1] of leaves) {
      const len = u1 - u0;
      const n0 = p.swingDir > 0 ? p.c + p.thick / 2 : p.c - p.thick / 2 - len;
      const n1 = n0 + len;
      out.push(p.orient === "h" ? { x0: u0, y0: n0, x1: u1, y1: n1 } : { x0: n0, y0: u0, x1: n1, y1: u1 });
    }
  }
  return out;
}

/** The "Gate" and "Car gate" captions on the front boundary (ground floor), so site labels (Lawn, Driveway) miss them. */
function gateAvoid(plan: BuildingPlan, levelId: string, ppf: number): Box[] {
  const lv = plan.levels.find((l) => l.id === levelId);
  if (!lv || lv.index !== 0) return [];
  return plan.site.gates.flatMap((g) => {
    const w = measure(g.kind === "pedestrian" ? "Gate" : "Car gate", 10) / ppf;
    const cx = g.at[0];
    const caption = { x0: cx - w / 2 - 3 / ppf, y0: 0, x1: cx + w / 2 + 3 / ppf, y1: 19 / ppf };
    // A hinged gate's leaf sweeps into the plot (drawn as an arc): keep labels off it too.
    const swing = g.kind === "sliding" ? [] : [{ x0: cx - g.width_ft / 2, y0: 0, x1: cx + g.width_ft / 2, y1: g.width_ft }];
    return [caption, ...swing];
  });
}

// ── The drawing ─────────────────────────────────────────────────────────────────────────────────────

export interface PlanSheetProps {
  plan: BuildingPlan;
  levelId: string;
  /** Screen px per plan foot, for label fitting and stroke/text sizing. */
  ppf: number;
  setbacks?: { front: number; rear: number; left: number; right: number };
  highlight?: string[];
  tone?: HighlightTone;
  issues?: string[];
  changed?: string[];
  deltas?: Map<string, number | "new">;
  pins?: PlanPin[];
  hovered?: string | null;
  onHover?: (room: Room | null, e: React.PointerEvent) => void;
  /** Keyboard: Tab moves between rooms; focusing one (or Enter) shows its card. */
  onFocusRoom?: (room: Room | null) => void;
  /** A pin was tapped; `at` is its centre in client (viewport) px, for anchoring a popover beside it. */
  onPin?: (id: string, at?: { x: number; y: number }) => void;
  /** Print: no hover affordances, heavier hairlines. */
  print?: boolean;
  /** Labels computed by the parent (keeps the legend in sync). */
  labels?: Label[];
}

export const PlanSheet = memo(function PlanSheet({
  plan,
  levelId,
  ppf,
  setbacks,
  highlight,
  tone = "accent",
  issues,
  changed,
  deltas,
  pins,
  hovered,
  onHover,
  onFocusRoom,
  onPin,
  print,
  labels: labelsProp,
}: PlanSheetProps) {
  const px = (n: number) => n / ppf;
  const W = plan.site.plot.width_ft;
  const D = plan.site.plot.depth_ft;
  const Y = (y: number) => D - y;
  const levels = useMemo(() => levelsOf(plan), [plan]);
  const level = levels.find((l) => l.id === levelId) ?? levels[0];
  const isGround = level ? level.index === 0 : true;
  const roof = level ? isRoofLevel(plan, level) : false;
  const sb = setbacks ?? plan.site.setbacks_ft;

  const geo = useMemo(() => {
    const rooms = plan.rooms.filter((r) => r.level === level?.id);
    const site = isGround ? rooms.filter((r) => SITE_TYPES.has(r.type)) : [];
    const building = rooms.filter((r) => !SITE_TYPES.has(r.type));
    const { walls, boundaries } = deriveWalls(building);
    const openings = placeOpenings(plan.openings.filter((o) => o.level === level?.id), building, walls, boundaries);
    let roofRooms: Room[] = [];
    let parapet: ReturnType<typeof deriveWalls>["walls"] = [];
    if (roof && level) {
      const below = levels.filter((l) => l.index < level.index).pop();
      roofRooms = below ? plan.rooms.filter((r) => r.level === below.id && !OPEN_TYPES.has(r.type)) : [];
      parapet = deriveWalls(roofRooms).walls.filter((w) => w.exterior);
    }
    const up = plan.stairs.filter((s) => s.from_level === level?.id).map((s) => ({ d: stairDrawing(s, plan.levels), dir: "up" as const }));
    const down = up.length ? [] : plan.stairs.filter((s) => s.to_level === level?.id).map((s) => ({ d: stairDrawing(s, plan.levels), dir: "down" as const }));
    const stairs = [...up, ...down];
    // Every room gets a label or a numbered marker, the stair hall included (its marker sits clear of the flights).
    const labelled = [...site, ...building];
    return { rooms, site, building, walls, boundaries, openings, roofRooms, parapet, stairs, labelled };
  }, [plan, level, levels, isGround, roof]);

  const labels = useMemo(() => {
    if (labelsProp) return labelsProp;
    const avoid: Box[] = level ? stairAvoid(plan, level.id, ppf) : [];
    return layoutLabels(geo.labelled, ppf, { avoid, site: new Set(geo.site.map((r) => r.id)), deltas: deltaStrings(deltas) });
  }, [labelsProp, geo, ppf, deltas]);

  const hl = new Set(highlight ?? []);
  const bad = new Set(issues ?? []);
  const chg = new Set(changed ?? []);
  const rect = (r: { x: number; y: number; w: number; d: number }) => ({ x: r.x, y: Y(r.y + r.d), width: r.w, height: r.d });
  const hair = print ? 0.9 : 1;
  const gapsFor = (w: (typeof geo.walls)[number]) =>
    geo.openings.filter((o) => o.orient === w.orient && Math.abs(o.c - w.c) < 0.01 && o.b > w.a - 0.01 && o.a < w.b + 0.01).map((o) => ({ a: o.a, b: o.b }));

  return (
    <g>
      <Roads plan={plan} px={px} isGround={isGround} />

      {/* Plot */}
      <rect x={0} y={0} width={W} height={D} fill={PAPER} />
      {/* Setback zone: the open space LDA keeps free, a whisper of tone */}
      <SetbackZone W={W} D={D} sb={sb} />

      {/* Site areas */}
      {geo.site.map((r) => (
        <rect key={r.id} {...rect(r.rect)} fill={FILL[CATEGORY[r.type]]} onPointerMove={onHover && ((e) => onHover(r, e))} onPointerLeave={onHover && ((e) => onHover(null, e))} />
      ))}

      {/* Roof slab */}
      {roof && geo.roofRooms.map((r) => <rect key={r.id} {...rect(r.rect)} fill="#F4F4F1" />)}
      {roof && geo.roofRooms.map((r) => <rect key={`${r.id}-h`} {...rect(r.rect)} fill="url(#fp-roof)" pointerEvents="none" />)}

      {/* Rooms */}
      {geo.building.map((r) => (
        <rect
          key={r.id}
          {...rect(r.rect)}
          fill={FILL[CATEGORY[r.type]] ?? FILL.living}
          onPointerMove={onHover && ((e) => onHover(r, e))}
          onPointerLeave={onHover && ((e) => onHover(null, e))}
          tabIndex={onFocusRoom ? 0 : undefined}
          role={onFocusRoom ? "button" : undefined}
          aria-label={onFocusRoom ? `${sentenceCase(r.name)}, ${sizeLabel(r.rect.w, r.rect.d).replace("×", " by ")}` : undefined}
          onFocus={onFocusRoom && (() => onFocusRoom(r))}
          onBlur={onFocusRoom && (() => onFocusRoom(null))}
          onKeyDown={onFocusRoom && ((e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocusRoom(r); } })}
          style={onFocusRoom ? { outline: "none" } : undefined}
        />
      ))}
      {hovered && (() => {
        const r = geo.rooms.find((x) => x.id === hovered);
        return r ? <rect {...rect(r.rect)} fill="rgb(107 42 94 / 0.06)" stroke={ACCENT} strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null;
      })()}

      {/* Issues and highlights */}
      <g pointerEvents="none">
        {geo.rooms.filter((r) => bad.has(r.id)).map((r) => <rect key={`bad-${r.id}`} {...rect(r.rect)} fill="url(#fp-issue)" />)}
        {geo.rooms.filter((r) => hl.has(r.id)).map((r) => (
          <rect key={`hl-${r.id}`} {...rect(r.rect)} fill={TONE[tone]} opacity={0.12} className="fp-pulse" />
        ))}
        {geo.rooms.filter((r) => chg.has(r.id)).map((r) => <rect key={`chg-${r.id}`} {...rect(r.rect)} fill="rgb(107 42 94 / 0.07)" />)}
      </g>

      {/* Stairs (on the roof they are drawn again after the stair tower, see below) */}
      <g pointerEvents="none">
        {!roof && geo.stairs.map(({ d, dir }) => (
          <StairSymbol key={d.stair.id} d={d} dir={dir} Y={Y} px={px} highlighted={hl.has(d.stair.id)} tone={TONE[tone]} />
        ))}
      </g>

      {/* Open boundaries and railings */}
      <g pointerEvents="none">
        {geo.boundaries.map((b, i) => {
          const [x1, y1, x2, y2] = b.orient === "h" ? [b.a, Y(b.c), b.b, Y(b.c)] : [b.c, Y(b.a), b.c, Y(b.b)];
          if (b.kind === "open") return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={INK3} strokeWidth={0.8} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />;
          const off = 0.16;
          const [dx, dy] = b.orient === "h" ? [0, off] : [off, 0];
          return (
            <g key={i} stroke={INK2} strokeWidth={0.9} vectorEffect="non-scaling-stroke">
              <line x1={x1 - dx} y1={y1 - dy} x2={x2 - dx} y2={y2 - dy} vectorEffect="non-scaling-stroke" />
              <line x1={x1 + dx} y1={y1 + dy} x2={x2 + dx} y2={y2 + dy} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </g>

      {/* Roof: parapet, mumty, tank, solar */}
      {roof && (
        <g pointerEvents="none">
          {geo.parapet.map((w, i) => {
            const th = 0.5;
            const r = w.orient === "h" ? { x: w.a - th / 2, y: Y(w.c) - th / 2, width: w.b - w.a + th, height: th } : { x: w.c - th / 2, y: Y(w.b) - th / 2, width: th, height: w.b - w.a + th };
            return <rect key={i} {...r} fill={PAPER} stroke={INK} strokeWidth={hair} vectorEffect="non-scaling-stroke" />;
          })}
          <RoofExtras plan={plan} Y={Y} px={px} W={W} />
          {/* The stair arriving at the roof, inside the stair tower: never painted over. */}
          {geo.stairs.map(({ d, dir }) => (
            <StairSymbol key={d.stair.id} d={d} dir={dir} Y={Y} px={px} highlighted={hl.has(d.stair.id)} tone={TONE[tone]} />
          ))}
          <RoofLabels plan={plan} Y={Y} px={px} W={W} D={D} />
        </g>
      )}

      {/* Walls */}
      <g pointerEvents="none" fill={INK}>
        {geo.walls.flatMap((w, i) =>
          wallPieces(w, gapsFor(w)).map((p, j) =>
            w.orient === "h" ? (
              <rect key={`${i}-${j}`} x={p.a} y={Y(w.c) - w.thick / 2} width={p.b - p.a} height={w.thick} />
            ) : (
              <rect key={`${i}-${j}`} x={w.c - w.thick / 2} y={Y(p.b)} width={w.thick} height={p.b - p.a} />
            ),
          ),
        )}
      </g>

      {/* Openings */}
      <g pointerEvents="none">
        {geo.openings.map((o) => (
          <OpeningSymbol key={o.opening.id} p={o} Y={Y} highlighted={hl.has(o.opening.id)} bad={bad.has(o.opening.id)} tone={TONE[tone]} px={px} />
        ))}
      </g>

      {/* Porch columns */}
      <g pointerEvents="none" fill={INK}>
        {geo.building
          .filter((r) => r.type === "porch")
          .flatMap((r) => {
            const { x, y, w, d } = r.rect;
            const touches = (cx: number, cy: number) =>
              geo.building.some((o) => o.id !== r.id && !OPEN_TYPES.has(o.type) && cx >= o.rect.x - 0.01 && cx <= o.rect.x + o.rect.w + 0.01 && cy >= o.rect.y - 0.01 && cy <= o.rect.y + o.rect.d + 0.01);
            return ([[x, y], [x + w, y], [x, y + d], [x + w, y + d]] as [number, number][])
              .filter(([cx, cy]) => !touches(cx, cy))
              .map(([cx, cy], i) => <rect key={`${r.id}-c${i}`} x={cx === x ? x : x + w - 1} y={cy === y ? Y(y + 1) : Y(y + d)} width={1} height={1} />);
          })}
      </g>

      {/* Changed rooms: dashed accent outline and the area delta */}
      <g pointerEvents="none" fill="none">
        {geo.rooms.filter((r) => chg.has(r.id)).map((r) => {
          const ins = Math.min(0.55, r.rect.w / 5, r.rect.d / 5);
          return (
            <g key={`co-${r.id}`}>
              <rect x={r.rect.x + ins} y={Y(r.rect.y + r.rect.d) + ins} width={r.rect.w - 2 * ins} height={r.rect.d - 2 * ins} stroke={ACCENT} strokeWidth={1.6} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </g>

      {/* Highlight outlines (compliance) */}
      <g pointerEvents="none" fill="none">
        {geo.rooms.filter((r) => hl.has(r.id)).map((r) => (
          <rect key={`ho-${r.id}`} x={r.rect.x + 0.4} y={Y(r.rect.y + r.rect.d) + 0.4} width={r.rect.w - 0.8} height={r.rect.d - 0.8} stroke={TONE[tone]} strokeWidth={2} vectorEffect="non-scaling-stroke" className="fp-pulse" />
        ))}
        {geo.rooms.filter((r) => bad.has(r.id)).map((r) => (
          <rect key={`bo-${r.id}`} x={r.rect.x + 0.5} y={Y(r.rect.y + r.rect.d) + 0.5} width={r.rect.w - 1} height={r.rect.d - 1} stroke={TONE.fail} strokeWidth={1.4} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
        ))}
      </g>

      {/* Labels */}
      <g pointerEvents="none">
        {labels.map((l) => (
          <RoomLabel key={l.room.id} l={l} Y={Y} px={px} />
        ))}
      </g>

      {/* Setback lines */}
      <Setbacks W={W} D={D} sb={sb} />

      {/* Boundary wall and gates */}
      <Boundary plan={plan} Y={Y} px={px} isGround={isGround} />

      {/* Dimensions, north arrow, scale */}
      <Dimensions W={W} D={D} sb={sb} px={px} />
      <NorthArrow x={W + 5.5} y={-4.8} facing={plan.site.facing} px={px} />
      {!print && <ScaleBar x={-MARGIN.l + 1.2} y={D + 10.4} px={px} />}

      {/* Comment pins */}
      {pins?.map((p) => (
        <g
          key={p.id}
          transform={`translate(${p.x} ${Y(p.y)})`}
          style={{ cursor: onPin ? "pointer" : undefined }}
          onClick={onPin && ((e) => {
            e.stopPropagation();
            const r = (e.currentTarget as SVGGElement).getBoundingClientRect();
            onPin(p.id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
          })}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <title>{p.text}</title>
          {p.selected && <circle r={px(15)} fill="none" stroke={ACCENT} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          <circle r={px(12)} fill={HUE[(p.hue - 1) % 6]} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <text y={px(4)} textAnchor="middle" fontSize={px(11)} fontWeight={600} fill="#fff" style={{ fontFamily: SANS }}>
            {p.n}
          </text>
        </g>
      ))}
    </g>
  );
});

function SetbackZone({ W, D, sb }: { W: number; D: number; sb: { front: number; rear: number; left: number; right: number } }) {
  // Hatch only the open space between the plot line and the building line.
  const parts: { x: number; y: number; w: number; h: number }[] = [];
  if (sb.front > 0) parts.push({ x: 0, y: D - sb.front, w: W, h: sb.front });
  if (sb.rear > 0) parts.push({ x: 0, y: 0, w: W, h: sb.rear });
  if (sb.left > 0) parts.push({ x: 0, y: sb.rear, w: sb.left, h: D - sb.rear - sb.front });
  if (sb.right > 0) parts.push({ x: W - sb.right, y: sb.rear, w: sb.right, h: D - sb.rear - sb.front });
  return (
    <g pointerEvents="none">
      {parts.map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill="url(#fp-setback)" />
      ))}
    </g>
  );
}

export function PlanDefs({ ppf }: { ppf: number }) {
  return (
    <defs>
      <pattern id="fp-roof" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M0 0V1.4" stroke="rgb(17 17 19 / 0.07)" strokeWidth={0.8 / ppf} />
      </pattern>
      <pattern id="fp-setback" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M0 0V1.6" stroke="rgb(107 42 94 / 0.07)" strokeWidth={0.8 / ppf} />
      </pattern>
      <pattern id="fp-issue" width="1.1" height="1.1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M0 0V1.1" stroke="rgb(200 40 30 / 0.3)" strokeWidth={1 / ppf} />
      </pattern>
      <pattern id="fp-solar" width="3.4" height="5.6" patternUnits="userSpaceOnUse">
        <rect x="0.15" y="0.15" width="3.1" height="5.3" fill="rgb(107 42 94 / 0.10)" stroke="rgb(107 42 94 / 0.55)" strokeWidth={0.8 / ppf} />
      </pattern>
      <marker id="fp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 1L9 5L0 9Z" fill={INK} />
      </marker>
    </defs>
  );
}

function RoomLabel({ l, Y, px }: { l: Label; Y: (y: number) => number; px: (n: number) => number }) {
  const cx = l.cx;
  const cy = Y(l.cy);
  if (l.kind === "key") {
    // A lettered square, so a room key never reads as a numbered comment pin (round).
    return (
      <g transform={`translate(${cx} ${cy})`}>
        <rect x={-px(7.5)} y={-px(7.5)} width={px(15)} height={px(15)} rx={px(3.5)} fill="#fff" stroke={INK2} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <text y={px(3.6)} textAnchor="middle" fontSize={px(10)} fontWeight={600} fill={INK} style={{ fontFamily: SANS }}>
          {l.letter}
        </text>
      </g>
    );
  }
  // The block is centred on (cx, cy): the name's line(s), then the size line.
  const nameH = l.fs * 1.2 * l.lines.length;
  const top = -(nameH + (l.dims ? l.dimFs * 1.3 : 0)) / 2;
  return (
    <g transform={`translate(${cx} ${cy})${l.vertical ? " rotate(-90)" : ""}`} textAnchor="middle">
      {l.lines.map((line, i) => (
        <text key={i} y={px(top + l.fs * 1.2 * i + l.fs * 0.93)} fontSize={px(l.fs)} fontWeight={500} fill={INK} style={{ fontFamily: SANS }}>
          {line}
        </text>
      ))}
      {l.dims && (
        <text y={px(top + nameH + l.dimFs * 1.02)} fontSize={px(l.dimFs)} fontWeight={500} fill={INK3} style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
          {l.dims}
          {l.delta && <tspan fill={ACCENT} fontWeight={600}>{` · ${l.delta}`}</tspan>}
        </text>
      )}
    </g>
  );
}

function OpeningSymbol({ p, Y, highlighted, bad, tone, px }: { p: PlacedOpening; Y: (y: number) => number; highlighted: boolean; bad: boolean; tone: string; px: (n: number) => number }) {
  const o: Opening = p.opening;
  const along = (u: number, n: number): [number, number] => (p.orient === "h" ? [u, Y(p.c) - n] : [p.c + n, Y(u)]);
  const L = p.b - p.a;
  const th = p.thick;
  const sw = p.swingDir;
  const stroke = { stroke: INK, vectorEffect: "non-scaling-stroke" as const, fill: "none" };
  const parts: ReactNode[] = [];
  const line = (u1: number, n1: number, u2: number, n2: number, k: string, w = 0.8, extra: object = {}) => {
    const [x1, y1] = along(u1, n1);
    const [x2, y2] = along(u2, n2);
    parts.push(<line key={k} x1={x1} y1={y1} x2={x2} y2={y2} {...stroke} strokeWidth={w} {...extra} />);
  };
  const jambs = () => {
    line(p.a, -th / 2, p.a, th / 2, "ja", 0.8);
    line(p.b, -th / 2, p.b, th / 2, "jb", 0.8);
  };
  const leaf = (hinge: number, toward: number, len: number, k: string, heavy = false) => {
    const [hx, hy] = along(hinge, sw * (th / 2));
    const [tx, ty] = along(hinge, sw * (th / 2 + len));
    const [cx, cy] = along(hinge + toward * len, sw * (th / 2));
    parts.push(<line key={`${k}-l`} x1={hx} y1={hy} x2={tx} y2={ty} {...stroke} strokeWidth={heavy ? 1.5 : 1.1} />);
    const sweep = (tx - hx) * (cy - hy) - (ty - hy) * (cx - hx) > 0 ? 1 : 0;
    parts.push(<path key={`${k}-a`} d={`M${tx} ${ty}A${len} ${len} 0 0 ${sweep} ${cx} ${cy}`} {...stroke} strokeWidth={0.6} stroke={INK3} />);
  };
  switch (o.type) {
    case "door":
    case "main_door": {
      jambs();
      if (p.hingeAtA) leaf(p.a, 1, L, "d", o.type === "main_door");
      else leaf(p.b, -1, L, "d", o.type === "main_door");
      if (o.type === "main_door") {
        const mid = (p.a + p.b) / 2;
        const tip = along(mid, -sw * (th / 2 + 0.35));
        const b1 = along(mid - 0.55, -sw * (th / 2 + 1.3));
        const b2 = along(mid + 0.55, -sw * (th / 2 + 1.3));
        parts.push(<path key="entry" d={`M${tip[0]} ${tip[1]}L${b1[0]} ${b1[1]}L${b2[0]} ${b2[1]}Z`} fill={ACCENT} />);
      }
      break;
    }
    case "double_door":
      jambs();
      leaf(p.a, 1, L / 2, "d1");
      leaf(p.b, -1, L / 2, "d2");
      break;
    case "sliding_door": {
      jambs();
      const mid = (p.a + p.b) / 2;
      const pw = 0.13;
      for (const [u1, u2, n, k] of [[p.a, mid + 0.25, -th / 6, "s1"], [mid - 0.25, p.b, th / 6, "s2"]] as [number, number, number, string][]) {
        const [x1, y1] = along(u1, n - pw / 2);
        const [x2, y2] = along(u2, n + pw / 2);
        parts.push(<rect key={k} x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} fill="#fff" stroke={INK} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />);
      }
      break;
    }
    case "arch":
      jambs();
      line(p.a, 0, p.b, 0, "arch", 0.6, { strokeDasharray: "3 3", stroke: INK3 });
      break;
    case "garage_door":
      jambs();
      line(p.a, 0, p.b, 0, "g", 0.9, { strokeDasharray: "6 3" });
      break;
    case "ventilator":
      jambs();
      line(p.a, -th / 2, p.b, -th / 2, "f1", 0.6);
      line(p.a, th / 2, p.b, th / 2, "f2", 0.6);
      line(p.a, 0, p.b, 0, "g1", 0.9);
      break;
    default:
      jambs();
      line(p.a, -th / 2, p.b, -th / 2, "f1", 0.6);
      line(p.a, th / 2, p.b, th / 2, "f2", 0.6);
      line(p.a, -th * 0.12, p.b, -th * 0.12, "g1", 0.8);
      line(p.a, th * 0.12, p.b, th * 0.12, "g2", 0.8);
  }
  const [cx, cy] = along((p.a + p.b) / 2, 0);
  const [gx1, gy1] = along(p.a, -th / 2);
  const [gx2, gy2] = along(p.b, th / 2);
  return (
    <g>
      {o.type !== "arch" && <rect x={Math.min(gx1, gx2)} y={Math.min(gy1, gy2)} width={Math.abs(gx2 - gx1)} height={Math.abs(gy2 - gy1)} fill="#fff" />}
      {parts}
      {(highlighted || bad) && (
        <circle cx={cx} cy={cy} r={Math.max(L / 2 + 0.8, px(14))} fill="none" stroke={bad ? TONE.fail : tone} strokeWidth={2} vectorEffect="non-scaling-stroke" className="fp-pulse" />
      )}
    </g>
  );
}

function StairSymbol({ d, dir, Y, px, highlighted, tone }: { d: StairDrawing; dir: "up" | "down"; Y: (y: number) => number; px: (n: number) => number; highlighted: boolean; tone: string }) {
  const o = d.outline;
  const pts = (dir === "up" ? d.path : [...d.path].reverse()).map(([x, y]) => `${x},${Y(y)}`).join(" ");
  const [sx, sy] = dir === "up" ? d.path[0] : d.path[d.path.length - 1];
  const f = d.flights[0];
  let cut = "";
  if (f) {
    const [a, b, c, e] = f.outline;
    const p1 = [a[0] + (b[0] - a[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.55];
    const p2 = [e[0] + (c[0] - e[0]) * 0.72, e[1] + (c[1] - e[1]) * 0.72];
    cut = `M${p1[0]} ${Y(p1[1])}L${p2[0]} ${Y(p2[1])}`;
  }
  return (
    <g>
      <rect x={o.x} y={Y(o.y + o.d)} width={o.w} height={o.d} fill="#F7F7F5" stroke={highlighted ? tone : INK} strokeWidth={highlighted ? 2 : 0.8} vectorEffect="non-scaling-stroke" />
      {d.flights.map((fl, i) => (
        <g key={i}>
          <polygon points={fl.outline.map(([x, y]) => `${x},${Y(y)}`).join(" ")} fill="none" stroke={INK} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
          {fl.treads.map(([x1, y1, x2, y2], k) => (
            <line key={k} x1={x1} y1={Y(y1)} x2={x2} y2={Y(y2)} stroke={INK2} strokeWidth={0.55} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
      {dir === "up" && cut && <path d={cut} stroke={INK} strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" />}
      <polyline points={pts} fill="none" stroke={INK} strokeWidth={0.9} markerEnd="url(#fp-arrow)" vectorEffect="non-scaling-stroke" />
      <circle cx={sx} cy={Y(sy)} r={px(2.2)} fill={INK} />
      <text x={sx} y={Y(sy) + (dir === "up" ? px(13) : -px(7))} textAnchor="middle" fontSize={px(9.5)} fontWeight={600} fill={INK} style={{ fontFamily: SANS }}>
        {dir === "up" ? "Up" : "Down"}
      </text>
    </g>
  );
}

function RoofExtras({ plan, Y }: { plan: BuildingPlan; Y: (y: number) => number; px: (n: number) => number; W: number }) {
  const m = plan.roof.mumty;
  const tank = plan.roof.water_tank;
  const solar = plan.roof.solar;
  // A tank sitting on the stair tower's roof is above this level: dashed, like anything overhead.
  const overhead = !!(m && tank && inside(tank.rect, m.rect));
  return (
    <g>
      {solar?.rect && (
        <rect {...{ x: solar.rect.x, y: Y(solar.rect.y + solar.rect.d), width: solar.rect.w, height: solar.rect.d }} fill={solar.mode === "panels" ? "url(#fp-solar)" : "rgb(107 42 94 / 0.04)"} stroke={ACCENT} strokeWidth={1} strokeDasharray={solar.mode === "panels" ? undefined : "5 4"} vectorEffect="non-scaling-stroke" />
      )}
      {m && (
        <g>
          {/* Walls only (no fill), so the stair that arrives inside stays visible. */}
          <rect x={m.rect.x + EXT_WALL / 2} y={Y(m.rect.y + m.rect.d) + EXT_WALL / 2} width={Math.max(0.1, m.rect.w - EXT_WALL)} height={Math.max(0.1, m.rect.d - EXT_WALL)} fill="none" stroke={INK} strokeWidth={EXT_WALL} />
          {(() => {
            const { x, y, w, d } = m.rect;
            const dw = 3;
            const g =
              m.door_side === "right" ? { x: x + w - EXT_WALL - 0.05, y: Y(y + d / 2 + dw / 2), width: EXT_WALL + 0.1, height: dw }
              : m.door_side === "left" ? { x: x - 0.05, y: Y(y + d / 2 + dw / 2), width: EXT_WALL + 0.1, height: dw }
              : m.door_side === "front" ? { x: x + w / 2 - dw / 2, y: Y(y) - EXT_WALL - 0.05, width: dw, height: EXT_WALL + 0.1 }
              : { x: x + w / 2 - dw / 2, y: Y(y + d) - 0.05, width: dw, height: EXT_WALL + 0.1 };
            return <rect {...g} fill={PAPER} />;
          })()}
        </g>
      )}
      {tank && (
        <g>
          {tank.material === "plastic" ? (
            <ellipse cx={tank.rect.x + tank.rect.w / 2} cy={Y(tank.rect.y + tank.rect.d / 2)} rx={tank.rect.w / 2} ry={tank.rect.d / 2} fill={overhead ? "none" : "#E6F1F5"} stroke={INK} strokeWidth={1} strokeDasharray={overhead ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />
          ) : (
            <>
              <rect x={tank.rect.x} y={Y(tank.rect.y + tank.rect.d)} width={tank.rect.w} height={tank.rect.d} fill={overhead ? "none" : "#E6F1F5"} stroke={INK} strokeWidth={1} strokeDasharray={overhead ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />
              {!overhead && <path d={`M${tank.rect.x} ${Y(tank.rect.y)}L${tank.rect.x + tank.rect.w} ${Y(tank.rect.y + tank.rect.d)}M${tank.rect.x} ${Y(tank.rect.y + tank.rect.d)}L${tank.rect.x + tank.rect.w} ${Y(tank.rect.y)}`} stroke={INK3} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
            </>
          )}
        </g>
      )}
    </g>
  );
}

function inside(a: { x: number; y: number; w: number; d: number }, b: { x: number; y: number; w: number; d: number }) {
  return a.x >= b.x - 0.01 && a.y >= b.y - 0.01 && a.x + a.w <= b.x + b.w + 0.01 && a.y + a.d <= b.y + b.d + 0.01;
}

/**
 * Roof captions: inside their shape when they fit, otherwise beside it with a short leader, on the side with room
 * (never on the stair tower's walls or over the flights).
 */
function RoofLabels({ plan, Y, px, W, D }: { plan: BuildingPlan; Y: (y: number) => number; px: (n: number) => number; W: number; D: number }) {
  const m = plan.roof.mumty;
  const tank = plan.roof.water_tank;
  const solar = plan.roof.solar;
  const FS = 11;
  const SUB = 10;
  const pad = px(4);
  type R = { x: number; y: number; w: number; d: number };
  const taken: R[] = [];
  const out: ReactNode[] = [];
  const hit = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
  /** `around`: the box the caption goes beside (the stair tower, for a tank standing on it); the leader starts at `shape`. */
  const place = (key: string, shape: R, title: string, sub: string | undefined, allowInside: boolean, avoid: R[], around: R = shape) => {
    const tw = px(Math.max(measure(title, FS), sub ? measure(sub, SUB, true) : 0));
    const th = px(FS * 1.2 + (sub ? SUB * 1.3 : 0));
    const text = (x: number, top: number, anchor: "start" | "middle" | "end") => (
      <g textAnchor={anchor} style={{ fontFamily: SANS }}>
        <text x={x} y={Y(top) + px(FS * 0.95)} fontSize={px(FS)} fontWeight={500} fill={INK}>
          {title}
        </text>
        {sub && (
          <text x={x} y={Y(top) + px(FS * 1.2 + SUB * 1.05)} fontSize={px(SUB)} fill={INK3} style={{ fontFamily: MONO }}>
            {sub}
          </text>
        )}
      </g>
    );
    // Inside, centred, when the caption fits with a 4px margin and touches nothing else.
    if (allowInside && tw + 2 * pad <= shape.w && th + 2 * pad <= shape.d) {
      const box = { x: shape.x + shape.w / 2 - tw / 2, y: shape.y + shape.d / 2 - th / 2, w: tw, d: th };
      if (!avoid.some((a) => hit(a, box)) && !taken.some((t) => hit(t, box))) {
        taken.push(box);
        out.push(<g key={key}>{text(shape.x + shape.w / 2, box.y + box.d, "middle")}</g>);
        return;
      }
    }
    // Beside it with a leader: right, left, behind (up the page), in front.
    const gap = px(10);
    const A = around;
    const cy = A.y + A.d / 2;
    const sx = shape.x + shape.w / 2;
    const sy = shape.y + shape.d / 2;
    // Above or below, centred on the shape but kept inside the plot.
    const midX = Math.max(0.5, Math.min(W - 0.5 - tw, A.x + A.w / 2 - tw / 2));
    const cands: { box: R; anchor: "start" | "end" | "middle"; tx: number; lead: [number, number, number, number] }[] = [
      { box: { x: A.x + A.w + gap, y: cy - th / 2, w: tw, d: th }, anchor: "start", tx: A.x + A.w + gap, lead: [A === shape ? A.x + A.w : sx, A === shape ? cy : sy, A.x + A.w + gap - px(2), cy] },
      { box: { x: A.x - gap - tw, y: cy - th / 2, w: tw, d: th }, anchor: "end", tx: A.x - gap, lead: [A === shape ? A.x : sx, A === shape ? cy : sy, A.x - gap + px(2), cy] },
      { box: { x: midX, y: A.y + A.d + gap, w: tw, d: th }, anchor: "middle", tx: midX + tw / 2, lead: [A === shape ? A.x + A.w / 2 : sx, A === shape ? A.y + A.d : sy, A.x + A.w / 2, A.y + A.d + gap - px(2)] },
      { box: { x: midX, y: A.y - gap - th, w: tw, d: th }, anchor: "middle", tx: midX + tw / 2, lead: [A === shape ? A.x + A.w / 2 : sx, A === shape ? A.y : sy, A.x + A.w / 2, A.y - gap + px(2)] },
    ];
    const inPlot = (b: R) => b.x >= 0.5 && b.x + b.w <= W - 0.5 && b.y >= 0.5 && b.y + b.d <= D - 0.5;
    const clearOfLabels = (b: R) => !taken.some((t) => hit(t, b));
    const c =
      cands.find((k) => inPlot(k.box) && clearOfLabels(k.box) && !avoid.some((a) => hit(a, k.box))) ??
      cands.find((k) => inPlot(k.box) && clearOfLabels(k.box)) ??
      cands.find((k) => clearOfLabels(k.box)) ??
      cands[0];
    taken.push(c.box);
    out.push(
      <g key={key}>
        <line x1={c.lead[0]} y1={Y(c.lead[1])} x2={c.lead[2]} y2={Y(c.lead[3])} stroke={INK3} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        <circle cx={c.lead[0]} cy={Y(c.lead[1])} r={px(1.6)} fill={INK3} />
        {text(c.tx, c.box.y + c.box.d, c.anchor)}
      </g>,
    );
  };
  const stairsUp = plan.stairs.filter((st) => m && inside(st.rect, m.rect)).map((st) => st.rect);
  const solids: R[] = [...(m ? [m.rect] : []), ...(tank ? [tank.rect] : [])];
  if (m) place("mumty", m.rect, "Stair tower", `${feetInches(m.height_ft)} high`, false, solids.filter((r) => r !== m.rect));
  if (tank) {
    const name = planTankLabel(tank.material);
    const onTower = !!(m && inside(tank.rect, m.rect));
    // A tank on the stair tower's roof is labelled beside the tower (its own box sits over the flights).
    place("tank", tank.rect, onTower ? `${name} above` : name, undefined, !onTower, [...(m ? [m.rect] : []), ...stairsUp].filter((r) => r !== tank.rect), onTower && m ? m.rect : tank.rect);
  }
  if (solar?.rect) place("solar", solar.rect, planSolarLabel(solar.mode), `${num(solar.rect.w * solar.rect.d)} sq ft`, true, solids);
  return <g>{out}</g>;
}

function Roads({ plan, px, isGround }: { plan: BuildingPlan; px: (n: number) => number; isGround: boolean }) {
  const W = plan.site.plot.width_ft;
  const D = plan.site.plot.depth_ft;
  const corner = plan.site.plot.corner;
  const side = cornerSide(plan);
  const road = plan.site.road_width_ft ? `${plan.site.road_width_ft}′ road` : "Road";
  const op = isGround ? 1 : 0.6;
  return (
    <g pointerEvents="none" opacity={op}>
      <rect x={-MARGIN.l + 1} y={D + 2.2} width={W + MARGIN.l + MARGIN.r - 2} height={5.6} fill="#EEEEEA" />
      <line x1={-MARGIN.l + 1.5} y1={D + 5} x2={W + MARGIN.r - 1.5} y2={D + 5} stroke="#CFCFC8" strokeWidth={0.8} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
      <text x={W / 2} y={D + 5 + px(4)} textAnchor="middle" fontSize={px(10.5)} fill={INK3} fontWeight={500} style={{ fontFamily: SANS }}>
        {road}
      </text>
      {corner && (() => {
        const x = side === "right" ? W + 2.2 : -2.2 - 5.6;
        return (
          <g>
            <rect x={x} y={-MARGIN.t + 1} width={5.6} height={D + MARGIN.t + 6.8} fill="#EEEEEA" />
            <line x1={x + 2.8} y1={-MARGIN.t + 1.5} x2={x + 2.8} y2={D + 7} stroke="#CFCFC8" strokeWidth={0.8} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
            <text transform={`translate(${x + 2.8 + px(4)} ${D / 2}) rotate(-90)`} textAnchor="middle" fontSize={px(10.5)} fill={INK3} fontWeight={500} style={{ fontFamily: SANS }}>
              Side road
            </text>
          </g>
        );
      })()}
    </g>
  );
}

function Setbacks({ W, D, sb }: { W: number; D: number; sb: { front: number; rear: number; left: number; right: number } }) {
  const common = { stroke: ACCENT, strokeWidth: 1, strokeDasharray: "6 4", vectorEffect: "non-scaling-stroke" as const };
  return (
    <g pointerEvents="none">
      {sb.front > 0 && <line x1={0} y1={D - sb.front} x2={W} y2={D - sb.front} {...common} />}
      {sb.rear > 0 && <line x1={0} y1={sb.rear} x2={W} y2={sb.rear} {...common} />}
      {sb.left > 0 && <line x1={sb.left} y1={0} x2={sb.left} y2={D} {...common} />}
      {sb.right > 0 && <line x1={W - sb.right} y1={0} x2={W - sb.right} y2={D} {...common} />}
    </g>
  );
}

function Boundary({ plan, Y, px, isGround }: { plan: BuildingPlan; Y: (y: number) => number; px: (n: number) => number; isGround: boolean }) {
  const W = plan.site.plot.width_ft;
  const D = plan.site.plot.depth_ft;
  const t = 0.42;
  const gates = isGround ? [...plan.site.gates].sort((a, b) => a.at[0] - b.at[0]) : [];
  const pieces: [number, number][] = [];
  let x = -t / 2;
  for (const g of gates) {
    const a = g.at[0] - g.width_ft / 2;
    if (a > x) pieces.push([x, a]);
    x = g.at[0] + g.width_ft / 2;
  }
  if (x < W + t / 2) pieces.push([x, W + t / 2]);
  const fill = isGround ? "#8E8E93" : "#C7C7CC";
  return (
    <g pointerEvents="none">
      <rect x={-t / 2} y={-t / 2} width={W + t} height={t} fill={fill} />
      <rect x={-t / 2} y={-t / 2} width={t} height={D + t} fill={fill} />
      <rect x={W - t / 2} y={-t / 2} width={t} height={D + t} fill={fill} />
      {pieces.map(([a, b], i) => (
        <rect key={i} x={a} y={Y(0) - t / 2} width={b - a} height={t} fill={fill} />
      ))}
      {gates.map((g) => {
        const a = g.at[0] - g.width_ft / 2;
        const b = g.at[0] + g.width_ft / 2;
        const y = Y(0);
        return (
          <g key={g.id}>
            {g.kind === "sliding" ? (
              <line x1={a} y1={y + 0.4} x2={b} y2={y + 0.4} stroke={INK} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
            ) : (
              <path d={`M${a} ${y}L${a} ${y - (b - a)}A${b - a} ${b - a} 0 0 1 ${b} ${y}`} fill="none" stroke={INK3} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
            )}
            <text x={(a + b) / 2} y={y - px(6)} textAnchor="middle" fontSize={px(10)} fill={INK3} style={{ fontFamily: SANS }}>
              {g.kind === "pedestrian" ? "Gate" : "Car gate"}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Dim({ x1, y1, x2, y2, label, px, side = -1 }: { x1: number; y1: number; x2: number; y2: number; label: string; px: (n: number) => number; side?: 1 | -1 }) {
  const vertical = Math.abs(x1 - x2) < 1e-6;
  const tick = 0.5;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const fs = px(10.5);
  const fits = label.length * 10.5 * 0.62 < len / px(1) - 6;
  return (
    <g pointerEvents="none">
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={INK3} strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
      {[[x1, y1], [x2, y2]].map(([x, y], i) => (
        <line key={i} x1={x - tick} y1={y + tick} x2={x + tick} y2={y - tick} stroke={INK2} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {fits &&
        (vertical ? (
          <text transform={`translate(${mx + side * px(5)} ${my}) rotate(-90)`} textAnchor="middle" fontSize={fs} fill={INK2} fontWeight={500} style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
            {label}
          </text>
        ) : (
          <text x={mx} y={my + side * px(4.5)} textAnchor="middle" fontSize={fs} fill={INK2} fontWeight={500} style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
            {label}
          </text>
        ))}
    </g>
  );
}

function Dimensions({ W, D, sb, px }: { W: number; D: number; sb: { front: number; rear: number; left: number; right: number }; px: (n: number) => number }) {
  const ext = { stroke: LINE, strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" as const };
  const topRow = -2.6;
  const topOuter = -5.6;
  const rightRow = W + 2.8;
  const leftRow = -2.8;
  const chainX: [number, number][] = [];
  let x0 = 0;
  if (sb.left > 0) { chainX.push([0, sb.left]); x0 = sb.left; }
  chainX.push([x0, W - sb.right]);
  if (sb.right > 0) chainX.push([W - sb.right, W]);
  const chainY: [number, number][] = [];
  if (sb.rear > 0) chainY.push([0, sb.rear]);
  chainY.push([sb.rear, D - sb.front]);
  if (sb.front > 0) chainY.push([D - sb.front, D]);
  // svg y: rear edge at 0, front (road) at D. Chain values are in svg space already.
  return (
    <g>
      <line x1={0} y1={-0.6} x2={0} y2={topOuter - 0.6} {...ext} />
      <line x1={W} y1={-0.6} x2={W} y2={topOuter - 0.6} {...ext} />
      {sb.right > 0 && <line x1={W - sb.right} y1={-0.6} x2={W - sb.right} y2={topRow - 0.6} {...ext} />}
      {sb.left > 0 && <line x1={sb.left} y1={-0.6} x2={sb.left} y2={topRow - 0.6} {...ext} />}
      <line x1={-0.6} y1={0} x2={leftRow - 0.6} y2={0} {...ext} />
      <line x1={-0.6} y1={D} x2={leftRow - 0.6} y2={D} {...ext} />
      {chainY.map(([a]) => a > 0 && <line key={a} x1={W + 0.6} y1={a} x2={rightRow + 0.6} y2={a} {...ext} />)}
      <line x1={W + 0.6} y1={0} x2={rightRow + 0.6} y2={0} {...ext} />
      <line x1={W + 0.6} y1={D} x2={rightRow + 0.6} y2={D} {...ext} />
      {/* At a small scale (the A4 cover's site plan) the inner row would overprint the plot width: drop it. */}
      {chainX.length > 1 && (topRow - topOuter) / px(1) >= 15 && chainX.map(([a, b]) => <Dim key={`x${a}`} x1={a} y1={topRow} x2={b} y2={topRow} label={feetInches(b - a)} px={px} />)}
      <Dim x1={0} y1={topOuter} x2={W} y2={topOuter} label={feetInches(W)} px={px} />
      <Dim x1={leftRow} y1={0} x2={leftRow} y2={D} label={feetInches(D)} px={px} />
      {chainY.map(([a, b]) => <Dim key={`y${a}`} x1={rightRow} y1={a} x2={rightRow} y2={b} label={feetInches(b - a)} px={px} side={1} />)}
    </g>
  );
}

const BEARING: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** Rotation (deg, clockwise from screen-up) of a north arrow when the road is drawn at the bottom. */
export function northRotation(facing?: string): number {
  return (180 - (BEARING[facing ?? "N"] ?? 0) + 360) % 360;
}

export function NorthArrow({ x, y, facing, px, r = 2.1 }: { x: number; y: number; facing: string; px: (n: number) => number; r?: number }) {
  const rot = northRotation(facing);
  const rad = (rot * Math.PI) / 180;
  const dist = r + px(9);
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      <circle r={r} fill="#fff" stroke={INK} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      <g transform={`rotate(${rot})`}>
        <path d={`M0 ${-r * 0.82}L${r * 0.42} ${r * 0.55}L0 ${r * 0.28}Z`} fill={INK} />
        <path d={`M0 ${-r * 0.82}L${-r * 0.42} ${r * 0.55}L0 ${r * 0.28}Z`} fill="#fff" stroke={INK} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
      </g>
      <text x={Math.sin(rad) * dist} y={-Math.cos(rad) * dist + px(3.5)} textAnchor="middle" fontSize={px(10)} fontWeight={600} fill={INK} style={{ fontFamily: SANS }}>
        N
      </text>
    </g>
  );
}

function ScaleBar({ x, y, px }: { x: number; y: number; px: (n: number) => number }) {
  const h = 0.5;
  const segs = [0, 5, 10, 20];
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      {segs.slice(0, -1).map((s, i) => (
        <rect key={s} x={s} y={0} width={segs[i + 1] - s} height={h} fill={i % 2 ? "#fff" : INK} stroke={INK} strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
      ))}
      {segs.map((s) => (
        <text key={s} x={s} y={h + px(11)} textAnchor="middle" fontSize={px(9.5)} fill={INK3} style={{ fontFamily: MONO }}>
          {s}
        </text>
      ))}
      <text x={20 + px(9)} y={h + px(11)} fontSize={px(9.5)} fill={INK3} style={{ fontFamily: MONO }}>
        ft
      </text>
    </g>
  );
}

// ── The interactive canvas ──────────────────────────────────────────────────────────────────────────

export interface FloorPlanProps {
  plan: BuildingPlan;
  level: string;
  highlight?: string[];
  highlightTone?: HighlightTone;
  issues?: string[];
  changed?: string[];
  deltas?: Map<string, number | "new">;
  pins?: PlanPin[];
  onPin?: (id: string, at?: { x: number; y: number }) => void;
  setbacks?: { front: number; rear: number; left: number; right: number };
  /** Space (px) kept clear around the drawing at "fit" (floating chrome sits there). */
  inset?: { top: number; right: number; bottom: number; left: number };
  className?: string;
  /** Show the +/−/fit controls (bottom-right). */
  controls?: boolean;
  /** Where the zoom controls sit (default bottom-right). */
  controlsClassName?: string;
  /** Reset the view when this changes (e.g. the version). */
  resetKey?: string;
  /** "sheet" fits the drawing with its dimensions and road; "plot" fits the plot itself (small screens). */
  fit?: "sheet" | "plot";
  /** Called with the label layout so the parent can show the numbered-key legend. */
  onKeys?: (keys: { n: number; letter: string; room: Room }[]) => void;
  /** What changed in a room since the last version, shown in its card ("Widened the window"). */
  notes?: Map<string, string[]>;
  children?: ReactNode;
}

interface View { cx: number; cy: number; z: number }

export function FloorPlan({
  plan,
  level,
  highlight,
  highlightTone = "accent",
  issues,
  changed,
  deltas,
  pins,
  onPin,
  setbacks,
  inset = { top: 16, right: 16, bottom: 16, left: 16 },
  className,
  controls = true,
  controlsClassName = "bottom-3 right-3",
  resetKey,
  fit = "sheet",
  onKeys,
  notes,
  children,
}: FloorPlanProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sheet = useMemo(() => sheetBounds(plan), [plan]);
  const B = useMemo(
    () => (fit === "plot" ? { x: -1.5, y: -1.5, w: plan.site.plot.width_ft + 3, h: plan.site.plot.depth_ft + 3 } : sheet),
    [fit, plan, sheet],
  );
  const availW = Math.max(40, size.w - inset.left - inset.right);
  const availH = Math.max(40, size.h - inset.top - inset.bottom);
  const ppf0 = Math.min(availW / B.w, availH / B.h);
  /** The smallest zoom shows the whole sheet (below 1 only when fitting the plot). */
  const minZ = fit === "plot" ? Math.min(1, Math.min(availW / sheet.w, availH / sheet.h) / Math.max(ppf0, 0.001)) : 1;
  // Fit centre: the sheet's centre placed in the middle of the available (inset) area.
  const fitCx = B.x + B.w / 2 - (inset.left - inset.right) / 2 / Math.max(ppf0, 0.001);
  const fitCy = B.y + B.h / 2 - (inset.top - inset.bottom) / 2 / Math.max(ppf0, 0.001);

  const [view, setView] = useState<View | null>(null);
  const v: View = view ?? { cx: fitCx, cy: fitCy, z: 1 };
  const ppf = ppf0 * v.z;
  const vw = size.w / Math.max(ppf, 0.001);
  const vh = size.h / Math.max(ppf, 0.001);
  const viewBox = `${v.cx - vw / 2} ${v.cy - vh / 2} ${vw} ${vh}`;

  // Labels re-fit once a zoom settles (text scales with the drawing while the gesture runs).
  const [zoomPpf, setZoomPpf] = useState(ppf);
  useEffect(() => {
    const t = setTimeout(() => setZoomPpf(ppf), 140);
    return () => clearTimeout(t);
  }, [ppf]);
  // At fit, labels follow the size straight away; while zooming they re-fit once the gesture settles.
  const labelPpf = view ? zoomPpf : ppf;
  // Fonts arriving late change measurements.
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => alive && setFontTick((n) => n + 1));
    return () => { alive = false; };
  }, []);

  useEffect(() => setView(null), [resetKey, plan.site.plot.width_ft, plan.site.plot.depth_ft]);

  const clampView = useCallback(
    (nv: View): View => {
      const z = Math.min(8, Math.max(minZ, nv.z));
      if (z === 1 && fit === "sheet") return { cx: fitCx, cy: fitCy, z: 1 };
      return { z, cx: Math.min(sheet.x + sheet.w, Math.max(sheet.x, nv.cx)), cy: Math.min(sheet.y + sheet.h, Math.max(sheet.y, nv.cy)) };
    },
    [sheet, fitCx, fitCy, minZ, fit],
  );

  const anim = useRef<number | null>(null);
  const animateTo = useCallback(
    (target: View) => {
      if (anim.current) cancelAnimationFrame(anim.current);
      const from = view ?? { cx: fitCx, cy: fitCy, z: 1 };
      const to = clampView(target);
      const t0 = performance.now();
      const dur = 260;
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        setView({ cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, z: from.z + (to.z - from.z) * e });
        if (k < 1) anim.current = requestAnimationFrame(step);
        else { anim.current = null; if (to.z === 1) setView(null); }
      };
      anim.current = requestAnimationFrame(step);
    },
    [view, fitCx, fitCy, clampView],
  );

  /** Zoom by `factor` keeping the plan point under (sx, sy) (container px) fixed. */
  const zoomAt = useCallback(
    (factor: number, sx: number, sy: number) => {
      setView((prev) => {
        const cur = prev ?? { cx: fitCx, cy: fitCy, z: 1 };
        const p0 = ppf0 * cur.z;
        const z = Math.min(8, Math.max(minZ, cur.z * factor));
        const p1 = ppf0 * z;
        const px0 = cur.cx - size.w / 2 / p0 + sx / p0;
        const py0 = cur.cy - size.h / 2 / p0 + sy / p0;
        const cx = px0 + size.w / 2 / p1 - sx / p1;
        const cy = py0 + size.h / 2 / p1 - sy / p1;
        const next = clampView({ cx, cy, z });
        return next.z === 1 && fit === "sheet" ? null : next;
      });
    },
    [fitCx, fitCy, ppf0, size, clampView],
  );

  // Wheel: zoom at the cursor (non-passive so the page doesn't scroll).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = e.ctrlKey ? 0.012 : 0.0022;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      // One wheel notch (or one pinch event) zooms 1.25x at most.
      const f = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * unit * k)));
      zoomAt(f, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Drag to pan, two fingers to pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(0);
  const tapStart = useRef<number | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = 0;
    tapStart.current = pointers.current.size === 1 ? e.pointerId : null;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    // A mouse with no button held is never dragging: forget a press whose release we never saw (released outside
    // the window, or lost capture), so hover cards keep working.
    if (e.pointerType === "mouse" && e.buttons === 0 && pointers.current.has(e.pointerId)) {
      pointers.current.delete(e.pointerId);
      gesture.current = null;
      if (!pointers.current.size) setDragging(false);
      return;
    }
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    const r = box.current!.getBoundingClientRect();
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAt(dist / gesture.current.dist, mid.x - r.left, mid.y - r.top);
      const dx = mid.x - gesture.current.mid.x;
      const dy = mid.y - gesture.current.mid.y;
      setView((p) => (p ? clampView({ ...p, cx: p.cx - dx / (ppf0 * p.z), cy: p.cy - dy / (ppf0 * p.z) }) : p));
      gesture.current = { dist, mid };
      setDragging(true);
      return;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    moved.current += Math.abs(dx) + Math.abs(dy);
    if (moved.current < 3) return;
    setDragging(true);
    setHover(null);
    setView((p) => {
      const base = p ?? { cx: fitCx, cy: fitCy, z: 1 };
      if (base.z <= minZ + 0.001) return p; // nothing to pan at the smallest zoom
      return clampView({ ...base, cx: base.cx - dx / (ppf0 * base.z), cy: base.cy - dy / (ppf0 * base.z) });
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    // A tap (no drag) on a room shows its card; on empty paper it clears the card.
    if (e.type === "pointerup" && tapStart.current === e.pointerId && moved.current < 3 && pointers.current.size === 1) {
      const r = box.current!.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const room = roomAt(sx, sy);
      setTapped(room ? { room, x: sx, y: sy } : null);
    }
    tapStart.current = null;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (!pointers.current.size) setDragging(false);
  };

  // Hover: the room under the pointer with "Opens to…". A tap or keyboard focus pins the same card (phones, keyboards).
  const [hover, setHover] = useState<{ room: Room; x: number; y: number } | null>(null);
  const [tapped, setTapped] = useState<{ room: Room; x: number; y: number } | null>(null);
  /** Container px → the room on this level under that point (smallest first, so a bath inside a suite wins). */
  const roomAt = (sx: number, sy: number): Room | null => {
    const p = ppf0 * v.z;
    const x = v.cx - size.w / 2 / p + sx / p;
    const y = plan.site.plot.depth_ft - (v.cy - size.h / 2 / p + sy / p);
    const hits = plan.rooms
      .filter((rm) => rm.level === level && x >= rm.rect.x && x <= rm.rect.x + rm.rect.w && y >= rm.rect.y && y <= rm.rect.y + rm.rect.d)
      .sort((a, b) => area(a) - area(b));
    return hits[0] ?? null;
  };
  /** A room's centre in container px. */
  const roomCentre = (rm: Room) => {
    const p = ppf0 * v.z;
    return {
      x: (rm.rect.x + rm.rect.w / 2 - (v.cx - size.w / 2 / p)) * p,
      y: (plan.site.plot.depth_ft - (rm.rect.y + rm.rect.d / 2) - (v.cy - size.h / 2 / p)) * p,
    };
  };
  const onFocusRoom = useCallback(
    (rm: Room | null) => {
      setHover(null);
      setTapped(rm ? { room: rm, ...roomCentre(rm) } : null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v.cx, v.cy, v.z, ppf0, size.w, size.h, plan],
  );
  useEffect(() => setTapped(null), [level, plan]);
  const card = hover ?? tapped;
  const onHover = useCallback((room: Room | null, e: React.PointerEvent) => {
    // Touch shows the card on a tap instead; a mouse shows it on hover unless a button is held (a pan).
    if (e.pointerType === "touch" || (e.pointerType === "mouse" ? e.buttons !== 0 : pointers.current.size > 0)) return;
    const r = box.current?.getBoundingClientRect();
    if (!room || !r) return setHover(null);
    setHover({ room, x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);
  useEffect(() => setHover(null), [level, plan]);

  // Keys for the legend.
  const rooms = useMemo(() => plan.rooms.filter((r) => r.level === level), [plan, level]);
  const keysRef = useRef<string>("");
  const measured = size.w > 0 && size.h > 0;
  const labels = useMemo(() => {
    void fontTick;
    if (!measured) return [] as Label[];
    const lv = levelsOf(plan).find((l) => l.id === level);
    const isGround = lv ? lv.index === 0 : true;
    const site = isGround ? rooms.filter((r) => SITE_TYPES.has(r.type)) : [];
    const building = rooms.filter((r) => !SITE_TYPES.has(r.type));
    const stairs = [
      ...plan.stairs.filter((s) => s.from_level === level),
      ...(plan.stairs.some((s) => s.from_level === level) ? [] : plan.stairs.filter((s) => s.to_level === level)),
    ].map((s) => stairDrawing(s, plan.levels));
    const labelled = [...site, ...building];
    void stairs;
    const avoid: Box[] = stairAvoid(plan, level, labelPpf || 1);
    return layoutLabels(labelled, labelPpf || 1, { avoid, site: new Set(site.map((r) => r.id)), deltas: deltaStrings(deltas) });
  }, [plan, level, rooms, labelPpf, fontTick, deltas, measured]);
  useEffect(() => {
    const keys = labels.filter((l): l is Extract<Label, { kind: "key" }> => l.kind === "key").map((l) => ({ n: l.n, letter: l.letter, room: l.room })).sort((a, b) => a.n - b.n);
    const k = keys.map((x) => `${x.letter}:${x.room.id}`).join("|");
    if (k !== keysRef.current) {
      keysRef.current = k;
      onKeys?.(keys);
    }
  }, [labels, onKeys]);

  const zoomBy = (f: number) => animateTo(clampView({ ...v, z: v.z * f }));

  const opens = card ? opensTo(plan, card.room) : [];

  return (
    <div
      ref={box}
      className={cn("relative h-full w-full touch-none select-none overflow-hidden", dragging ? "cursor-grabbing" : v.z > 1 ? "cursor-grab" : "", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={(e) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) gesture.current = null;
        if (!pointers.current.size) setDragging(false);
      }}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={(e) => {
        const r = box.current!.getBoundingClientRect();
        if (v.z >= 7.9) animateTo({ cx: fitCx, cy: fitCy, z: 1 });
        else {
          const sx = e.clientX - r.left;
          const sy = e.clientY - r.top;
          const p0 = ppf0 * v.z;
          const px0 = v.cx - size.w / 2 / p0 + sx / p0;
          const py0 = v.cy - size.h / 2 / p0 + sy / p0;
          animateTo({ cx: px0, cy: py0, z: v.z * 2 });
        }
      }}
    >
      {size.w > 0 && (
        <svg viewBox={viewBox} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${levelsOf(plan).find((l) => l.id === level)?.name ?? "Floor"} plan`}>
          <PlanDefs ppf={labelPpf || 1} />
          <PlanSheet
            plan={plan}
            levelId={level}
            ppf={labelPpf || 1}
            setbacks={setbacks}
            highlight={highlight}
            tone={highlightTone}
            issues={issues}
            changed={changed}
            deltas={deltas}
            pins={pins}
            hovered={card?.room.id ?? null}
            onHover={onHover}
            onFocusRoom={onFocusRoom}
            onPin={onPin}
            labels={labels}
          />
        </svg>
      )}
      <style>{`.fp-pulse{animation:fp-pulse 1.6s ease-in-out infinite}@keyframes fp-pulse{50%{opacity:.35}}@media (prefers-reduced-motion: reduce){.fp-pulse{animation:none}}`}</style>

      {card && !dragging && (
        <div
          className="pointer-events-none absolute z-10 max-w-[260px] rounded-control bg-ink px-3 py-2 text-white shadow-e2"
          style={{ left: Math.max(8, Math.min(card.x + 16, size.w - 270)), top: Math.max(8, card.y - 72) }}
          role="status"
          aria-live="polite"
        >
          <p className="text-[13px] font-medium leading-tight">{sentenceCase(card.room.name)}</p>
          <p className="mt-0.5 font-mono text-[11.5px] tabular-nums text-white/70">
            {sizeLabel(card.room.rect.w, card.room.rect.d).replace("×", " × ")} · {num(area(card.room))} sq ft
          </p>
          {opens.length > 0 && <p className="mt-1 text-[12px] leading-snug text-white/85">Opens to: {opens.join(", ")}</p>}
          {(() => {
            const d = deltas?.get(card.room.id);
            const said = notes?.get(card.room.id);
            if (d === undefined && !said?.length) return null;
            return (
              <p className="mt-1.5 border-t border-white/15 pt-1.5 text-[12px] leading-snug text-white/85">
                {d !== undefined && <span className="font-mono font-semibold tabular-nums text-[#9DB0FF]">{d === "new" ? "New room" : `${d > 0 ? "+" : "−"}${num(Math.abs(d))} sq ft`}</span>}
                {d !== undefined && said?.length ? " · " : ""}
                {said?.join("; ")}
              </p>
            );
          })()}
        </div>
      )}

      {controls && (
        <div className={cn("absolute flex items-center gap-0.5 rounded-full bg-surface/90 p-1 shadow-e1 backdrop-blur", controlsClassName)} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <ZoomBtn label="Zoom out" onClick={() => zoomBy(1 / 1.6)} disabled={v.z <= minZ + 0.001}>
            <Minus className="size-4" strokeWidth={1.75} />
          </ZoomBtn>
          <button
            type="button"
            onClick={() => animateTo({ cx: fitCx, cy: fitCy, z: 1 })}
            className="h-8 min-w-12 rounded-full px-2 font-mono text-[12px] tabular-nums text-ink-2 transition-colors hover:bg-surface-2"
            aria-label="Fit the plan"
            title="Fit (0)"
          >
            {Math.abs(v.z - 1) < 0.001 && !view ? <Scan className="mx-auto size-4" strokeWidth={1.75} /> : `${Math.round(v.z * 100)}%`}
          </button>
          <ZoomBtn label="Zoom in" onClick={() => zoomBy(1.6)} disabled={v.z >= 7.99}>
            <Plus className="size-4" strokeWidth={1.75} />
          </ZoomBtn>
        </div>
      )}
      {children}
    </div>
  );
}

function ZoomBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-35"
    >
      {children}
    </button>
  );
}
