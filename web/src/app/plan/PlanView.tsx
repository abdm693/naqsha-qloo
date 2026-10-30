/**
 * Plan (DESIGN.md "Plan (design, compliance, print)"): the floor plan on white with the floor stack, the
 * compliance chip and sheet ("LDA rules" / "Livable home"), the named stages of a design run, "Design again"
 * behind a confirmation, comment pins, changed rooms, and Print / Save as PDF.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Printer, RotateCcw, X } from "lucide-react";
import type { ComplianceCheck, Room } from "@contracts/plan";
import type { Project } from "@contracts/api-types";
import { cn, feetInches, num, relativeTime } from "@/app/lib/utils";
import { resolveVersion } from "@/app/lib/views";
import { useShell } from "@/app/shell/state";
import { useProject } from "@/app/store/project";
import { toast } from "@/app/store/toast";
import { plotLabel } from "@/api/domain";
import { useAskContext } from "@/app/shell/ask";
import { flow, fixLoopOf, useFlow } from "@/app/design/flow";
import { FloorStack, stackItems } from "@/app/design/FloorStack";
import { Button, Dialog, EASE_OUT, EASE_SHEET, IconButton, useHotkeys, useMediaQuery } from "@/app/design/kit";
import { useViewNav } from "@/app/design/nav";
import { RunCard, WorkingHairline } from "@/app/design/RunProgress";
import { failures } from "@/app/design/words";
import { PlotCanvas } from "@/app/setup/PlotCanvas";
import { ReviseStatus } from "@/app/revisions/ReviseStatus";
import { CompliancePanel, ComplianceChip } from "./CompliancePanel";
import { FloorPlan, type PlanPin } from "./FloorPlan";
import { anchorLevel, anchorPlanXY, areaDeltas, authorHue, changedRooms, coveredArea, hueColor, levelKey, levelName, levelsOf, sentenceCase } from "./model";
import { PrintDialog } from "./PrintDialog";
import { RoomKeyRow } from "./RoomKey";
import { usePinNumbers } from "@/app/comments/pins";

export function PlanView({ project, onProjectChange }: { project: Project; onProjectChange(p: Project): void }) {
  const goTo = useViewNav();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const phone = useMediaQuery("(max-width: 767px)");
  // Legend and zoom sit beside the dock only when a 720px dock leaves room for them.
  const wide = useMediaQuery("(min-width: 1600px)");

  const run = useFlow((s) => (s.design?.pid === project.id ? s.design : null));
  const revise = useFlow((s) => (s.revise?.pid === project.id ? s.revise : null));
  const running = run?.status === "running";
  // ?v= is a version id or its number (?v=2); one that doesn't exist falls back to the latest, and says so.
  const vParam = params.get("v");
  const resolved = resolveVersion(project, vParam);
  const vid = resolved.id;
  useEffect(() => {
    if (!vParam || resolved.known) return;
    toast.show(`There's no version ${vParam.replace(/^v/i, "")} of this home. Showing the latest.`);
    setParams((p) => { const n = new URLSearchParams(p); n.delete("v"); return n; }, { replace: true });
  }, [vParam, resolved.known, setParams]);
  const version = useFlow((s) => (vid ? s.versions[vid] : undefined));
  const asBuilt = useProject((s) => (vid ? s.asBuilt[vid] : undefined));
  const dockH = useShell((s) => s.dockH);
  const parent = useFlow((s) => (version?.parent_id ? s.versions[version.parent_id] : undefined));
  const comments = useFlow((s) => (vid ? s.comments[vid] : undefined));

  useEffect(() => {
    if (vid) void flow.loadVersion(project.id, vid);
  }, [project.id, vid]);
  useEffect(() => {
    if (version?.parent_id) void flow.loadVersion(project.id, version.parent_id);
  }, [project.id, version?.parent_id]);
  useEffect(() => {
    if (vid) void flow.loadComments(project.id, vid);
  }, [project.id, vid]);
  useEffect(() => {
    void flow.resume(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Arriving from "Plan this one": start straight away. From "Decide everything", carry on into the house when built.
  const [walkWhenBuilt] = useState(() => !!(location.state as { walk?: boolean } | null)?.walk);
  useEffect(() => {
    const st = location.state as { autostart?: boolean } | null;
    if (!st?.autostart) return;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    if (!running && !project.current_version_id && !["planning", "building"].includes(project.stage)) void flow.design(project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const builtVid = run?.status === "done" ? run.version?.id : undefined;
  useEffect(() => {
    if (walkWhenBuilt && builtVid) {
      const t = setTimeout(() => goTo("house"), 1200);
      return () => clearTimeout(t);
    }
  }, [walkWhenBuilt, builtVid, goTo]);

  // During a run show only the run's own drawing and checks: never the previous version's.
  const plan = running ? run?.plan : version?.plan;
  const report = running ? run?.compliance : version?.compliance;
  const draft = running && !!run?.plan;
  const loop = running ? run?.failures : fixLoopOf(version?.id);

  // Floors
  const levels = useMemo(() => (plan ? levelsOf(plan) : []), [plan]);
  const floorParam = params.get("floor");
  const [levelState, setLevelState] = useState<string | null>(null);
  const level = levels.find((l) => l.id === (levelState ?? floorParam))?.id ?? levels.find((l) => l.index === 0)?.id ?? levels[0]?.id ?? "ground";
  const setLevel = useCallback(
    (id: string) => {
      setLevelState(id);
      setParams((p) => { const n = new URLSearchParams(p); n.set("floor", id); return n; }, { replace: true });
    },
    [setParams],
  );

  // Compliance
  const [sheet, setSheet] = useState(false);
  const [check, setCheck] = useState<ComplianceCheck | null>(null);
  useEffect(() => setCheck(null), [vid, running]);
  // Closing the sheet clears its highlight; while it is open the dock moves clear of it.
  useEffect(() => {
    if (!sheet) setCheck(null);
    useShell.getState().setViewSheet(sheet ? 380 : 0);
  }, [sheet]);
  useEffect(() => () => useShell.getState().setViewSheet(0), []);
  // Opening the sheet moves focus to its heading; closing it gives focus back to the compliance chip.
  const chipRef = useRef<HTMLButtonElement>(null);
  const sheetHeading = useRef<HTMLHeadingElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheet) {
      sheetWasOpen.current = true;
      const t = requestAnimationFrame(() => sheetHeading.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(t);
    }
    if (!sheetWasOpen.current) return;
    sheetWasOpen.current = false;
    const a = document.activeElement;
    // Only when focus was in the sheet (leaving with it) or nowhere: never steal it from what the person moved to.
    if (!a || a === document.body || !document.contains(a) || sheetRef.current?.contains(a)) chipRef.current?.focus({ preventScroll: true });
  }, [sheet]);
  const selectCheck = (c: ComplianceCheck | null) => {
    setCheck(c);
    const id = c?.element_ids?.[0];
    if (!id || !plan) return;
    const lv = plan.rooms.find((r) => r.id === id)?.level ?? plan.openings.find((o) => o.id === id)?.level ?? plan.stairs.find((s) => s.id === id)?.from_level;
    if (lv && lv !== level) setLevel(lv);
    if (phone) setSheet(false);
  };
  const issues = useMemo(() => (running && report ? report.checks.filter((c) => c.status === "fail").flatMap((c) => c.element_ids ?? []) : undefined), [running, report]);

  // Changes vs the parent version
  // Targets may be rooms, openings (f_master_w) or stairs: each maps to the room(s) it touches.
  const changeNotes = useMemo(() => (version ? changedRooms(version.plan, version.changes) : new Map<string, string[]>()), [version]);
  const changedIds = useMemo(() => [...changeNotes.keys()], [changeNotes]);
  const [showChanges, setShowChanges] = useState(true);
  const deltas = useMemo(() => (version && changedIds.length ? areaDeltas(parent?.plan, version.plan, changedIds) : undefined), [version, parent, changedIds]);
  const changesOn = !running && showChanges && changedIds.length > 0;

  // Pins (numbered the same way in House)
  const [pinSel, setPinSel] = useState<string | null>(null);
  const [pinAt, setPinAt] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Numbered across the whole project (comments/pins.ts): a pin keeps its number from version to version.
  const pinNo = usePinNumbers(project.id, comments);
  const pins = useMemo<PlanPin[]>(() => {
    if (running || !plan || !comments?.length) return [];
    const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return ordered
      .map((c, i) => ({ c, n: pinNo.get(c.id) ?? i + 1 }))
      .filter(({ c }) => anchorLevel(plan, c) === level && c.anchor.kind !== "view")
      .map(({ c, n }) => {
        const [x, y] = anchorPlanXY(c);
        return { id: c.id, n, x, y, hue: authorHue(c), text: c.text, selected: pinSel === c.id };
      })
      .filter((p) => p.x > -2 && p.y > -2 && p.x < plan.site.plot.width_ft + 2 && p.y < plan.site.plot.depth_ft + 2);
  }, [running, plan, comments, level, pinSel, pinNo]);
  const selectedPin = comments?.find((c) => c.id === pinSel);

  // Keys for rooms too small to label
  const [keys, setKeys] = useState<{ n: number; letter: string; room: Room }[]>([]);
  const [keysOpen, setKeysOpen] = useState(false);
  // Phones: the legend is folded behind a "Key" button.
  const [legendOpen, setLegendOpen] = useState(false);

  // Dialogs
  const [confirmAgain, setConfirmAgain] = useState(false);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p" && version && !running) {
        e.preventDefault();
        setPrinting(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [version, running]);
  // Esc steps back one thing at a time: a selected check or pin first, then the compliance sheet.
  useHotkeys({
    Escape: () => {
      if (check || pinSel) {
        setCheck(null);
        setPinSel(null);
      } else if (sheet) setSheet(false);
    },
  });

  // The shell's commands: ?dialog=print ("Print plan…") and ?compare=1 ("Compare versions").
  const dialogParam = params.get("dialog");
  const compareParam = params.get("compare");
  useEffect(() => {
    if (dialogParam !== "print" || !version || running) return;
    setPrinting(true);
    setParams((p) => { const n = new URLSearchParams(p); n.delete("dialog"); return n; }, { replace: true });
  }, [dialogParam, version, running, setParams]);
  useEffect(() => {
    if (compareParam !== "1" || !version || running) return;
    setParams((p) => { const n = new URLSearchParams(p); n.delete("compare"); return n; }, { replace: true });
    if (changedIds.length && version.parent_id) setShowChanges(true);
    else goTo("revisions", version.id === project.current_version_id ? undefined : { search: `v=${version.id}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareParam, version, running]);

  const designAgain = () => {
    setConfirmAgain(false);
    if (params.get("v")) setParams((p) => { const n = new URLSearchParams(p); n.delete("v"); return n; }, { replace: true });
    void flow.design(project.id);
  };

  // Ask: a typed change becomes a revision of this version.
  const latestVid = project.current_version_id;
  useAskContext(
    !plan && !running && !latestVid
      ? // Empty: the big "Draw the plan" is the one accent; the dock doesn't repeat it.
        { next: null }
      : latestVid && !running
      ? {
          placeholder: "Tell Naqsha what to change…",
          suggestions: report && failures(report) ? ["Fix the rules that still fail"] : planSuggestions(plan),
          busy: revise?.status === "running",
          onSubmit: (text) => flow.revise(project.id, { version_id: latestVid, instruction: text }),
        }
      : null,
  );

  const lvl = levels.find((l) => l.id === level);
  const covered = plan && lvl ? coveredArea(plan, lvl.id) : 0;
  const notLatest = !!vid && vid !== project.current_version_id;
  const brief = project.brief;
  const sheetW = 380;
  const [headH, setHeadH] = useState(120);
  const [legend, setLegend] = useState({ w: 0, h: 0 });
  const legendObs = useRef<ResizeObserver | null>(null);
  const legendRef = useCallback((el: HTMLDivElement | null) => {
    legendObs.current?.disconnect();
    if (!el) return setLegend({ w: 0, h: 0 });
    legendObs.current = new ResizeObserver(() => setLegend({ w: el.offsetWidth, h: el.offsetHeight }));
    legendObs.current.observe(el);
  }, []);
  const headObs = useRef<ResizeObserver | null>(null);
  const headRef = useCallback((el: HTMLDivElement | null) => {
    headObs.current?.disconnect();
    if (!el) return;
    headObs.current = new ResizeObserver(() => setHeadH(el.offsetHeight));
    headObs.current.observe(el);
  }, []);
  // The drawing keeps clear of the floating pieces: the legend sits beside it on wider screens, below it on phones.
  const dockClear = wide ? 16 : (dockH || 96) + 12;
  const inset = {
    top: headH + 12,
    left: phone ? 12 : Math.max(76, wide ? 76 : legend.w + 32),
    right: (sheet && !phone ? sheetW + 24 : 16) + (phone ? 0 : 8),
    bottom: dockClear + (phone ? legend.h + 8 : 0),
  };
  const items = stackItems(levels, (l) => levelKey(l, levels), levelName).map((it) => ({
    ...it,
    dot: !!issues?.length && plan?.rooms.some((r) => r.level === it.id && issues.includes(r.id)),
  }));

  // ── Empty: nothing drawn yet and nothing running ──
  if (!plan && !running) {
    if (vid && !version) {
      return (
        <div className="grid h-full place-items-center bg-canvas text-[15px] text-ink-3">
          <span className="inline-flex items-center gap-2">Opening the plan…</span>
        </div>
      );
    }
    return (
      <div className="relative grid h-full place-items-center overflow-y-auto bg-canvas px-4 py-24">
        <div className="w-full max-w-[560px] text-center">
          {brief?.plot?.width_ft ? (
            <PlotCanvas width={brief.plot.width_ft} depth={brief.plot.depth_ft} envelope={project.envelope} corner={brief.plot.corner} facing={brief.facing} className="mx-auto h-auto w-full max-w-[360px]" />
          ) : null}
          <h1 className="mt-8 text-title text-ink">Ready to draw the plan</h1>
          <p className="mx-auto mt-2 max-w-[440px] text-body-lg text-ink-2">
            I'll lay out every floor inside what the rules allow, check it against every rule and fix what fails, then build it in 3D. It takes about five minutes.
          </p>
          <Button variant="primary" size="lg" className="mt-7" onClick={() => void flow.design(project.id)}>
            Draw the plan
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative h-full overflow-hidden bg-canvas">
      <WorkingHairline active={running || revise?.status === "running"} />

      {/* The sheet */}
      <div className="absolute inset-0">
        {plan ? (
          <FloorPlan
            plan={plan}
            level={level}
            highlight={check?.element_ids}
            highlightTone={check ? (check.status === "fail" ? "fail" : check.status === "warn" ? "warn" : "pass") : "accent"}
            issues={issues}
            changed={changesOn ? changedIds : undefined}
            deltas={changesOn ? deltas : undefined}
            pins={pins}
            onPin={(id, at) => {
              const r = rootRef.current?.getBoundingClientRect();
              setPinAt(at && r ? { x: at.x - r.left, y: at.y - r.top } : null);
              setPinSel((s) => (s === id ? null : id));
            }}
            notes={changesOn ? changeNotes : undefined}
            setbacks={report?.envelope.setbacks_ft}
            inset={inset}
            resetKey={`${plan.site.plot.width_ft}x${plan.site.plot.depth_ft}`}
            fit={phone ? "plot" : "sheet"}
            controlsClassName={cn("right-3 sm:right-4", wide ? "bottom-4" : "bottom-[calc(var(--dock-h,96px)+12px)]", sheet && !phone && "right-[404px] sm:right-[404px]")}
            onKeys={setKeys}
            className={cn(draft && "[&_svg]:opacity-[0.92]")}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center px-6" style={{ paddingTop: inset.top, paddingBottom: inset.bottom }}>
            {brief?.plot?.width_ft ? (
              <PlotCanvas width={brief.plot.width_ft} depth={brief.plot.depth_ft} envelope={project.envelope} corner={brief.plot.corner} facing={brief.facing} faint className="h-full max-h-[620px] w-auto max-w-full" />
            ) : null}
          </div>
        )}
      </div>

      {/* Top: floor title and actions, then (phones) the floor chips, then run progress */}
      <div ref={headRef} className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-3 px-3 pt-[var(--chrome-top)] sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="pointer-events-auto min-w-0 md:pl-[60px]">
            <div className="flex items-baseline gap-2">
              <h1 className="text-heading text-ink">{lvl ? levelName(lvl) : "Plan"}</h1>
              {draft && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent">Draft</span>}
            </div>
            <p className="mt-0.5 truncate text-[13px] text-ink-3">
              {[
                plan ? <span key="d" className="font-mono tabular-nums">{feetInches(plan.site.plot.width_ft)} × {feetInches(plan.site.plot.depth_ft)}</span> : null,
                brief?.plot?.area_marla ? <span key="m">{plotLabel(brief.plot.area_marla)}</span> : null,
                covered > 0 ? <span key="c"><span className="font-mono tabular-nums">{num(covered)}</span> sq ft covered</span> : null,
                !running && version ? <span key="v">Version {version.n}</span> : null,
                running ? <span key="r">Drawing a new version</span> : null,
              ]
                .filter(Boolean)
                .flatMap((el, i) => (i ? [<span key={`s${i}`}> · </span>, el] : [el]))}
            </p>
            {notLatest && (
              <button type="button" onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.delete("v"); return n; })} className="mt-1 text-[13px] font-medium text-accent hover:underline">
                Back to the latest version
              </button>
            )}
          </div>
          <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2 max-md:w-full max-md:justify-start">
            {phone && levels.length > 1 && <FloorStack items={items} value={level} onChange={setLevel} orientation="horizontal" className="mr-auto" />}
            {!running && changedIds.length > 0 && parent && !phone && (
              <button
                type="button"
                onClick={() => setShowChanges((s) => !s)}
                aria-pressed={showChanges}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium shadow-e1 outline-none transition-colors focus-visible:shadow-focus",
                  showChanges ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]" : "bg-surface text-ink-2 hover:bg-surface-2",
                )}
              >
                <span className={cn("h-0 w-4 border-t-[1.5px] border-dashed", showChanges ? "border-accent" : "border-ink-3")} />
                Changes since v{parent.n}
              </button>
            )}
            {report && plan && <ComplianceChip ref={chipRef} report={report} plan={plan} asBuilt={running ? null : asBuilt} onClick={() => setSheet((s) => !s)} active={sheet} />}
            {version && !running && (
              <>
                <Button variant="secondary" size="sm" icon={<Printer className="size-4" strokeWidth={1.75} />} onClick={() => setPrinting(true)} className="h-9" aria-label="Print or save as PDF">
                  <span className="hidden sm:inline">Print</span>
                </Button>
                <Button variant="secondary" size="sm" icon={<RotateCcw className="size-4" strokeWidth={1.75} />} onClick={() => setConfirmAgain(true)} className="h-9">
                  Design again
                </Button>
              </>
            )}
          </div>
        </div>
        <AnimatePresence>
          {run && (running || run.status === "error") && (
            <div key="run" className="pointer-events-auto mx-auto w-full max-w-[460px]">
              <RunCard run={run} onRetry={() => void flow.design(project.id)} />
            </div>
          )}
          {revise && !running && (
            <div key="revise" className="pointer-events-auto mx-auto">
              <ReviseStatus run={revise} onOpen={() => goTo("revisions")} onDismiss={() => flow.clear("revise")} />
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Floor stack */}
      {!phone && levels.length > 1 && (
        <div className="absolute left-4 top-1/2 z-20 -translate-y-1/2">
          <FloorStack items={items} value={level} onChange={setLevel} />
        </div>
      )}

      {/* Legend */}
      {plan && (
        <div ref={legendRef} className={cn("pointer-events-none absolute left-3 z-10 max-w-[300px] sm:left-4", wide ? "bottom-4" : "bottom-[calc(var(--dock-h,96px)+12px)]")}>
          {/* Phones: the key stays folded behind one button, so the lawn, the gates and the road stay in view. */}
          {phone && (
            <button
              type="button"
              onClick={() => setLegendOpen((o) => !o)}
              aria-expanded={legendOpen}
              className="hit-44 pointer-events-auto relative mb-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-surface/90 px-3.5 text-[13px] font-medium text-ink-2 shadow-e1 outline-none backdrop-blur focus-visible:shadow-focus"
            >
              {legendOpen ? "Hide key" : "Key"}
            </button>
          )}
          {(!phone || legendOpen) && (
          <div className="pointer-events-auto rounded-control bg-surface/90 px-3 py-2 text-[12px] text-ink-3 shadow-e1 backdrop-blur">
            <p className="flex items-center gap-2">
              <span className="h-0 w-5 border-t border-dashed border-accent" />
              Setback (building line)
            </p>
            {changesOn && (
              <div className="mt-1">
                <p className="flex items-center gap-2">
                  <span className="h-2.5 w-5 shrink-0 rounded-[3px] border-[1.5px] border-dashed border-accent" />
                  Changed since version {parent?.n}
                </p>
                {deltas && deltas.size > 0 && (
                  <p className="mt-0.5 pl-7 leading-snug text-ink-2">
                    {[...deltas.entries()]
                      .map(([id, d]) => {
                        const r = plan.rooms.find((x) => x.id === id);
                        return r ? { r, d } : null;
                      })
                      .filter((x): x is { r: Room; d: number | "new" } => !!x && x.r.level === level)
                      .map(({ r, d }, i) => (
                        <span key={r.id} className="whitespace-nowrap">
                          {i > 0 && " · "}
                          {sentenceCase(r.name)} <span className="font-mono font-semibold tabular-nums text-accent">{d === "new" ? "new" : `${d > 0 ? "+" : "−"}${num(Math.abs(d))}`}</span>
                        </span>
                      ))}
                  </p>
                )}
              </div>
            )}
            {keys.length > 0 && (
              <div className="relative mt-1.5 border-t border-line pt-1.5">
                {keys.length <= 3 || keysOpen ? (
                  <ul className={cn("space-y-0.5", keys.length > 3 && "absolute bottom-full left-0 mb-2 max-h-[50vh] w-max overflow-y-auto rounded-control bg-surface p-3 shadow-e2")}>
                    {keys.map((k) => (
                      <RoomKeyRow key={k.room.id} letter={k.letter} room={k.room} />
                    ))}
                  </ul>
                ) : null}
                {keys.length > 3 && (
                  <button type="button" onClick={() => setKeysOpen((o) => !o)} className="font-medium text-ink-2 hover:text-ink" aria-expanded={keysOpen}>
                    {keysOpen ? "Hide the room key" : `Room key · ${keys.length} rooms`}
                  </button>
                )}
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* Selected pin */}
      <AnimatePresence>
        {selectedPin && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="absolute z-30 w-[min(360px,calc(100vw-24px))] rounded-card bg-surface p-4 shadow-e2"
            style={pinPopoverStyle(pinAt, rootRef.current, dockClear)}
          >
            <div className="flex items-start gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white" style={{ background: hueColor(selectedPin) }}>
                {pins.find((p) => p.id === selectedPin.id)?.n}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink-3">
                  {selectedPin.author?.name ?? "You"} · {relativeTime(selectedPin.created_at)}
                </p>
                <p className="mt-0.5 text-body text-ink">{selectedPin.text}</p>
                {selectedPin.resolution && <p className="mt-2 text-[13px] text-ink-2">{selectedPin.resolution}</p>}
              </div>
              <IconButton label="Close" size={28} onClick={() => setPinSel(null)}>
                <X className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compliance sheet */}
      <AnimatePresence>
        {sheet && report && plan && (
          <motion.aside
            ref={sheetRef}
            initial={phone ? { y: "100%" } : { x: 24, opacity: 0 }}
            animate={phone ? { y: 0 } : { x: 0, opacity: 1 }}
            exit={phone ? { y: "100%" } : { x: 24, opacity: 0 }}
            transition={{ duration: 0.32, ease: EASE_SHEET }}
            className={cn(
              "absolute z-40 flex flex-col overflow-hidden bg-surface shadow-e3",
              phone ? "inset-x-0 bottom-0 max-h-[78dvh] rounded-t-panel" : "bottom-3 right-3 top-[124px] rounded-panel",
            )}
            style={phone ? undefined : { width: sheetW }}
            aria-label="Compliance"
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 ref={sheetHeading} tabIndex={-1} className="rounded-[6px] text-[15px] font-semibold text-ink outline-none focus-visible:shadow-focus">
                Compliance
              </h2>
              <IconButton label="Close compliance" size={32} onClick={() => setSheet(false)}>
                <X className="size-4" strokeWidth={1.75} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
              <CompliancePanel
                report={report}
                plan={plan}
                asBuilt={running ? null : asBuilt}
                stage={running ? run?.stage : null}
                failures={loop}
                selectedId={check?.id}
                onSelect={selectCheck}
                running={running}
                onFix={latestVid && !notLatest ? (c) => { setSheet(false); void flow.revise(project.id, { version_id: latestVid, instruction: `Fix the plan so it passes this rule: ${c.title}. ${c.message}` }); } : undefined}
              />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <Dialog
        open={confirmAgain}
        onClose={() => setConfirmAgain(false)}
        title="Start a fresh design?"
        description={`I'll draw a new plan from your brief and concept. Version ${version?.n ?? 1} stays in your history. It takes about five minutes.`}
        actions={
          <>
            <Button variant="quiet" onClick={() => setConfirmAgain(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={designAgain} data-autofocus>
              Design again
            </Button>
          </>
        }
      />
      {version && <PrintDialog open={printing} onClose={() => setPrinting(false)} project={project} version={version} />}
    </div>
  );
}

/** Beside its pin (right, else left), clamped clear of the top row and the dock. */
function pinPopoverStyle(at: { x: number; y: number } | null, root: HTMLElement | null, dockClear: number): React.CSSProperties {
  const W = root?.clientWidth ?? window.innerWidth;
  const H = root?.clientHeight ?? window.innerHeight;
  const w = Math.min(360, W - 24);
  const h = 170;
  if (!at) return { left: Math.max(12, (W - w) / 2), bottom: dockClear };
  const right = at.x + 22 + w <= W - 12;
  const left = right ? at.x + 22 : Math.max(12, at.x - 22 - w);
  const top = Math.min(Math.max(at.y - 28, 12), Math.max(12, H - dockClear - h));
  return { left, top };
}

/** Plan suggestions that make sense for this plan: never a room it already has. */
function planSuggestions(plan: { rooms: { type: string; level: string; name: string }[] } | undefined): string[] {
  const has = (t: string, level?: string) => !!plan?.rooms.some((r) => r.type === t && (!level || r.level === level));
  const out: string[] = [];
  out.push("Make the kitchen bigger");
  if (!has("prayer")) out.push("Add a prayer room upstairs");
  else if (!has("study")) out.push("Add a study");
  if (!has("store")) out.push("Add a store near the kitchen");
  else if (!has("balcony")) out.push("Add a balcony to the master bedroom");
  return out.slice(0, 2);
}
