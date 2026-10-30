/**
 * Before and after, on the plan (DESIGN.md "Revisions → Compare"): both versions drawn in one sheet with a wipe
 * that snaps to 0, 50 and 100%, changed rooms outlined with their area change, one floor at a time.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildingPlan } from "@contracts/plan";
import { cn } from "@/app/lib/utils";
import { FloorStack, stackItems } from "@/app/design/FloorStack";
import { Segmented } from "@/app/design/kit";
import { PlanDefs, PlanSheet, deltaStrings, sheetBounds, stairAvoid } from "@/app/plan/FloorPlan";
import { stairDrawing } from "@/app/plan/geometry";
import { layoutLabels, type Box, type Label } from "@/app/plan/labels";
import { SITE_TYPES, areaDeltas, levelKey, levelName, levelsOf } from "@/app/plan/model";
import { RoomKeyRow } from "@/app/plan/RoomKey";

export function PlanCompare({
  before,
  after,
  changed,
  caption,
  className,
  compact,
}: {
  before?: BuildingPlan;
  after: BuildingPlan;
  changed: string[];
  caption?: string;
  className?: string;
  /** Phone and tablet: a fixed ~280px sheet inside the page that still lets the page scroll vertically. */
  compact?: boolean;
}) {
  const levels = useMemo(() => levelsOf(after), [after]);
  // Open on the floor of the first change (in the order the changes were made), not always the ground floor.
  const firstChanged = changed.map((id) => after.rooms.find((r) => r.id === id)?.level).find(Boolean);
  const [level, setLevel] = useState(firstChanged ?? levels[0]?.id ?? "ground");
  useEffect(() => {
    if (firstChanged) setLevel(firstChanged);
  }, [firstChanged]);
  const [wipeState, setWipe] = useState(50);
  const wipe = before ? wipeState : 0;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 500 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const B = sheetBounds(after);
  const ppf = Math.min(size.w / B.w, size.h / B.h);
  const deltas = useMemo(() => areaDeltas(before, after, changed), [before, after, changed]);
  const dragging = useRef(false);
  const toPct = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return wipe;
    // The sheet is centred; map the pointer to the drawing's own width.
    const drawW = B.w * ppf;
    const left = r.left + (r.width - drawW) / 2;
    return Math.max(0, Math.min(100, ((clientX - left) / drawW) * 100));
  };
  const snap = (p: number) => ([0, 50, 100].find((s) => Math.abs(s - p) < 6) ?? p);
  const cutX = B.x + (B.w * wipe) / 100;
  const id = useMemo(() => `cmp-${Math.random().toString(36).slice(2, 8)}`, []);
  const items = stackItems(levels, (l) => levelKey(l, levels), levelName);
  // The same labels as the drawing, so its numbered markers get a key beside it.
  const labels = useMemo<Label[]>(() => {
    if (!ppf) return [];
    const lv = levels.find((l) => l.id === level);
    const rooms = after.rooms.filter((r) => r.level === level);
    const site = lv?.index === 0 ? rooms.filter((r) => SITE_TYPES.has(r.type)) : [];
    const building = rooms.filter((r) => !SITE_TYPES.has(r.type));
    const stairs = [
      ...after.stairs.filter((s) => s.from_level === level),
      ...(after.stairs.some((s) => s.from_level === level) ? [] : after.stairs.filter((s) => s.to_level === level)),
    ].map((s) => stairDrawing(s, after.levels));
    void stairs;
    const avoid: Box[] = stairAvoid(after, level, ppf);
    return layoutLabels([...site, ...building], ppf, { avoid, site: new Set(site.map((r) => r.id)), deltas: deltaStrings(deltas) });
  }, [after, level, levels, ppf, deltas]);
  const keys = labels.filter((l): l is Extract<Label, { kind: "key" }> => l.kind === "key");
  // Before / After pills ride either side of the wipe line (the north arrow sits top-right).
  const drawLeft = (size.w - B.w * ppf) / 2;
  const cutPx = drawLeft + (cutX - B.x) * ppf;

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {levels.length > 1 && <FloorStack items={items} value={level} onChange={setLevel} orientation="horizontal" hotkeys={false} />}
        {before && (
          <Segmented
            label="Compare"
            size="sm"
            value={wipe === 100 ? "before" : wipe === 0 ? "after" : "both"}
            onChange={(v) => setWipe(v === "before" ? 100 : v === "after" ? 0 : 50)}
            options={[
              { value: "before", label: "Before" },
              { value: "both", label: "Wipe" },
              { value: "after", label: "After" },
            ]}
          />
        )}
      </div>
      {/* Before / After ride either side of the wipe line, in a strip above the drawing: never over its dimensions. */}
      {before && (
        <div className="relative mt-2 h-6" aria-hidden>
          {wipe > 0 && wipe < 100 && (
            <>
              <span className="pointer-events-none absolute top-0 -translate-x-full rounded-full bg-surface px-2.5 py-0.5 text-[12px] font-medium text-ink-2 shadow-e1" style={{ left: Math.max(64, cutPx - 6) }}>Before</span>
              <span className="pointer-events-none absolute top-0 rounded-full bg-surface px-2.5 py-0.5 text-[12px] font-medium text-ink-2 shadow-e1" style={{ left: Math.min(size.w - 60, cutPx + 6) }}>After</span>
            </>
          )}
        </div>
      )}
      <div
        ref={box}
        className={cn("relative select-none overflow-hidden rounded-card bg-surface shadow-e1", before ? "mt-1" : "mt-3", compact ? "h-[280px] shrink-0 touch-pan-y" : "min-h-[360px] flex-1 touch-none")}
        onPointerDown={(e) => {
          if (!before) return;
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setWipe(toPct(e.clientX));
        }}
        onPointerMove={(e) => dragging.current && setWipe(toPct(e.clientX))}
        onPointerUp={() => {
          dragging.current = false;
          setWipe((w) => snap(w));
        }}
        onPointerCancel={() => {
          // A vertical page scroll (compact) takes the pointer: settle the wipe where it was.
          dragging.current = false;
          setWipe((w) => snap(w));
        }}
      >
        <svg viewBox={`${B.x} ${B.y} ${B.w} ${B.h}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Plan before and after">
          <PlanDefs ppf={ppf || 1} />
          <defs>
            <clipPath id={`${id}-b`}>
              <rect x={B.x - 1} y={B.y - 1} width={cutX - B.x + 1} height={B.h + 2} />
            </clipPath>
            <clipPath id={`${id}-a`}>
              <rect x={cutX} y={B.y - 1} width={B.x + B.w - cutX + 1} height={B.h + 2} />
            </clipPath>
          </defs>
          {before && wipe > 0 && (
            <g clipPath={`url(#${id}-b)`}>
              <PlanSheet plan={before} levelId={level} ppf={ppf || 1} highlight={changed.filter((x) => before.rooms.some((r) => r.id === x))} tone="warn" />
            </g>
          )}
          {wipe < 100 && (
            <g clipPath={`url(#${id}-a)`}>
              <PlanSheet plan={after} levelId={level} ppf={ppf || 1} changed={changed} deltas={deltas} labels={labels} />
            </g>
          )}
          {before && wipe > 0 && wipe < 100 && <line x1={cutX} y1={B.y} x2={cutX} y2={B.y + B.h} stroke="#6B2A5E" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      {keys.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3" aria-label="Room key">
          {[...keys].sort((a, b) => a.n - b.n).map((k) => (
            <RoomKeyRow key={k.room.id} letter={k.letter} room={k.room} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-[12.5px] text-ink-3">{caption ?? (before ? "Drag across the plan to compare. Changed rooms are outlined." : "Nothing to compare yet.")}</p>
    </div>
  );
}
