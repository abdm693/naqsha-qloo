/**
 * The compliance sheet: "LDA rules" and "Livable home", with units and 2px meters. Clicking a rule highlights
 * its rooms on the plan (and moves to their floor).
 */
import { useMemo, useState, type Ref } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, X as XIcon, TriangleAlert } from "lucide-react";
import type { BuildingPlan, ComplianceCheck, ComplianceReport } from "@contracts/plan";
import { cn, feetInches, num } from "@/app/lib/utils";
import { EASE_OUT, Meter } from "@/app/design/kit";
import { firstSentence, LDA_SECTIONS, ldaSection, notesLine, reviewLine, statusLine, summarize, tallyLine, valueLine, type Tally } from "./compliance";
import { sentenceCase } from "./model";
import { rulesLabel, rulesTitle } from "@/app/lib/locale";

export function ComplianceChip({ ref, report, plan, asBuilt, onClick, active }: { ref?: Ref<HTMLButtonElement>; report: ComplianceReport; plan?: BuildingPlan; asBuilt?: ComplianceReport | null; onClick: () => void; active?: boolean }) {
  const s = useMemo(() => summarize(report, plan, asBuilt), [report, plan, asBuilt]);
  const tone = s.fails.length ? "bg-fail" : s.warns.length ? "bg-warn" : "bg-pass";
  const check = s.warns.length;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Checks: ${statusLine(s)}`}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium shadow-e1 outline-none transition-colors focus-visible:shadow-focus",
        active ? "bg-ink text-white" : "bg-surface text-ink hover:bg-surface-2",
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone)} />
      <span className="font-mono tabular-nums">
        {s.ldaPass}/{s.lda.length}
      </span>
      <span className={active ? "text-white/70" : "text-ink-3"}>{rulesLabel()}</span>
      {s.livable.length > 0 && (
        <>
          <span className={active ? "text-white/40" : "text-ink-4"}>·</span>
          <span className="font-mono tabular-nums">
            {s.livablePass}/{s.livable.length}
          </span>
          <span className={active ? "text-white/70" : "text-ink-3"}>livable</span>
        </>
      )}
      {s.fails.length > 0 && <span className={cn("max-sm:hidden", active ? "text-white/70" : "text-fail")}>· {s.fails.length} to fix</span>}
      {check > 0 && <span className={cn("max-sm:hidden", active ? "text-white/70" : "text-warn")}>· {check} to check</span>}
    </button>
  );
}

export function CompliancePanel({
  report,
  plan,
  asBuilt,
  failures,
  selectedId,
  onSelect,
  onFix,
  running,
  stage,
}: {
  report: ComplianceReport;
  /** What the 3D build found (House), shown as "As built" rows and counted. */
  asBuilt?: ComplianceReport | null;
  /** The design run's stage while it runs ("fix", "review", "build"…), so the copy says what is happening. */
  stage?: string | null;
  /** Ask Naqsha to fix a failing rule (a revision). */
  onFix?: (c: ComplianceCheck) => void;
  running?: boolean;
  plan?: BuildingPlan;
  /** Failures per check in the run that produced this plan, e.g. [5, 1, 0]. */
  failures?: number[];
  selectedId?: string | null;
  onSelect: (c: ComplianceCheck | null) => void;
}) {
  const s = useMemo(() => summarize(report, plan, asBuilt), [report, plan, asBuilt]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const m = report.metrics;
  const env = report.envelope;
  const sections = useMemo(() => {
    const map = new Map<string, ComplianceCheck[]>();
    for (const c of s.lda) map.set(ldaSection(c), [...(map.get(ldaSection(c)) ?? []), c]);
    return LDA_SECTIONS.filter((x) => map.get(x.key)?.length).map((x) => ({ ...x, list: map.get(x.key)! }));
  }, [s.lda]);
  const fails = s.fails.length;
  const checks = s.warns.length;
  // The one phrasing every count uses (capsule, chip, dock, Revisions, print): "36/36 LDA · 10/12 livable · 2 to check".
  const verdict = `${!fails && s.approvalReady ? "Approval-ready · " : ""}${statusLine(s)}`;
  const headline = fails
    ? running
      ? stage === "fix" || stage === "plan" || stage === "compliance"
        ? "I'm fixing these now."
        : stage === "review"
          ? "I'm reviewing the plan now; these may still change."
          : "I'm building this version in 3D. Ask me to fix these once it's ready."
      : "Ask me to fix it, or change the plan yourself."
    : s.approvalReady
      ? `Passes all ${s.ldaTally.total} ${rulesLabel()} checks${s.livableTally.total ? (s.livableIssues ? `. ${s.livableIssues} livable ${s.livableIssues === 1 ? "point" : "points"} to check.` : ` and ${s.livableTally.total} livable rules.`) : "."}`
      : `${s.ldaTally.pass} of ${s.ldaTally.total} ${rulesLabel()} checks pass. Look at the ${checks === 1 ? "one" : checks} marked below before you submit.`;
  const setbackChecks = s.lda.filter((c) => c.id.startsWith("setback.") && c.id !== "setback.envelope" && c.id !== "setback.side");

  return (
    <div className="pb-4">
      {/* Verdict */}
      <div className="px-5 pt-5">
        <p className={cn("text-[13px] font-medium", fails ? "text-fail" : s.approvalReady ? "text-pass" : "text-warn")}>{verdict}</p>
        <p className="mt-1 text-heading text-ink">{headline}</p>
        <p className="mt-1 text-[13px] text-ink-3">{report.authority} Building and Zoning Regulations</p>
        <p className="text-[13px] text-ink-3">Plot band: {report.band.charAt(0).toLowerCase() + report.band.slice(1)}</p>
        {failures && failures.length > 1 && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-[12.5px] text-ink-2">
            <span>Fixed while drawing</span>
            <span className="font-mono tabular-nums text-ink">{failures.join(" → ")}</span>
          </p>
        )}
      </div>

      {/* LDA rules */}
      <section className="mt-6">
        <GroupHeading title={rulesTitle()} t={s.ldaTally} />
        <div className="grid grid-cols-2 gap-x-5 gap-y-4 px-5 pt-3">
          <Metric label="Ground coverage" value={`${num(m.coverage_pct, 1)}%`} limit={`max ${num(env.max_coverage_pct)}%`} ratio={m.coverage_pct / env.max_coverage_pct} />
          <Metric label="Height" value={feetInches(m.height_ft)} limit={`max ${feetInches(env.max_height_ft)}`} ratio={m.height_ft / env.max_height_ft} />
          <Metric label="Floor area ratio" value={`1:${num(m.far, 2)}`} limit={(() => { const c = s.lda.find((x) => x.id === "far"); return c?.limit != null ? `max 1:${num(Number(c.limit), 1)}` : `${num(m.total_floor_area_sqft)} sq ft`; })()} ratio={(() => { const c = s.lda.find((x) => x.id === "far"); return c?.limit ? m.far / Number(c.limit) : 0; })()} />
          <Metric label="Storeys" value={String(m.storeys)} limit={`max ${env.max_storeys}`} ratio={m.storeys / env.max_storeys} />
        </div>
        {setbackChecks.length > 0 && (
          <div className="mx-5 mt-4 flex flex-wrap gap-x-4 gap-y-1 rounded-control bg-surface-2/70 px-3 py-2 text-[12.5px] text-ink-2">
            {setbackChecks.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", c.status === "fail" ? "bg-fail" : c.status === "warn" ? "bg-warn" : "bg-pass")} />
                {c.id.replace("setback.", "").replace(/^\w/, (x) => x.toUpperCase())}
                <span className="font-mono tabular-nums text-ink">{c.value != null ? feetInches(Number(c.value)) : "–"}</span>
              </span>
            ))}
          </div>
        )}
        <div className="mt-3">
          {sections.map((sec) => {
            const bad = sec.list.filter((c) => c.status !== "pass");
            const isOpen = open[sec.key] ?? bad.length > 0;
            return (
              <div key={sec.key} className="border-t border-line first:border-t-0">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [sec.key]: !isOpen }))}
                  className="flex w-full items-center justify-between px-5 py-2.5 text-left outline-none hover:bg-surface-2/50 focus-visible:bg-surface-2"
                  aria-expanded={isOpen}
                >
                  <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                    <StatusMark status={bad.some((c) => c.status === "fail") ? "fail" : bad.length ? "warn" : "pass"} />
                    {sec.title}
                  </span>
                  <span className="flex items-center gap-2 text-[12px] text-ink-3">
                    <span className="font-mono tabular-nums">
                      {sec.list.length - bad.length}/{sec.list.length}
                    </span>
                    <ChevronDown className={cn("size-3.5 transition-transform duration-(--dur-fast)", isOpen && "rotate-180")} strokeWidth={1.75} />
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.ul
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.24, ease: EASE_OUT }}
                      className="overflow-hidden px-3 pb-2"
                    >
                      {sec.list.map((c) => (
                        <Row key={c.id} c={c} selected={selectedId === c.id} onSelect={onSelect} onFix={!running ? onFix : undefined} />
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </section>

      {/* Livable home */}
      {s.livable.length > 0 && (
        <section className="mt-6">
          <GroupHeading title="Livable home" t={s.livableTally} />
          <ul className="px-3 pt-1">
            {s.livable.map((c) => (
              <Row key={c.id} c={c} selected={selectedId === c.id} onSelect={onSelect} onFix={!running ? onFix : undefined} always />
            ))}
          </ul>
        </section>
      )}

      {/* Architect's notes: the self-review's advice, collapsed, never counted */}
      {s.review.length > 0 && (
        <section className="mt-6 border-t border-line pt-1">
          <button
            type="button"
            onClick={() => setOpen((o) => ({ ...o, review: !o.review }))}
            aria-expanded={!!open.review}
            className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left outline-none hover:bg-surface-2/50 focus-visible:bg-surface-2"
          >
            <span className="text-[15px] font-semibold text-ink">{reviewLine(s.review.length)}</span>
            <ChevronDown className={cn("size-3.5 text-ink-3 transition-transform duration-(--dur-fast)", open.review && "rotate-180")} strokeWidth={1.75} />
          </button>
          <AnimatePresence initial={false}>
            {open.review && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <p className="px-5 pt-0.5 text-[12.5px] text-ink-3">A second read of the plan, as an architect would give it. Advice, not rules: these aren't counted above.</p>
                <ul className="px-3 pt-1">
                  {s.review.map((c) => (
                    <NoteRow key={c.id} c={c} selected={selectedId === c.id} onSelect={onSelect} />
                  ))}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

      {/* As built: what the 3D build found (only notes that aren't a pass) */}
      {s.asBuilt.length > 0 && (
        <section className="mt-6">
          <GroupHeading title="As built" t={s.asBuiltTally} line={notesLine(s.notes)} />
          <p className="px-5 pt-0.5 text-[12.5px] text-ink-3">What I found while building the house in 3D. These aren't counted in the rules or livable checks above.</p>
          <ul className="px-3 pt-1">
            {s.asBuilt.map((c) => (
              <Row key={c.id} c={c} selected={selectedId === c.id} onSelect={onSelect} onFix={!running ? onFix : undefined} always />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GroupHeading({ title, t, line }: { title: string; t: Tally; line?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-5">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <span className={cn("text-[12.5px] tabular-nums", t.fail ? "text-fail" : t.warn ? "text-warn" : "text-pass")}>{line ?? tallyLine(t)}</span>
    </div>
  );
}

function Metric({ label, value, limit, ratio }: { label: string; value: string; limit: string; ratio: number }) {
  return (
    <div>
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1.5">
        <span className="font-mono text-[15px] font-medium tabular-nums text-ink">{value}</span>
        <span className="text-[11.5px] text-ink-3">{limit}</span>
      </p>
      {ratio > 0 && <Meter value={ratio} max={1} className="mt-1.5" tone={ratio > 1 ? "fail" : ratio > 0.92 ? "warn" : "pass"} />}
    </div>
  );
}

function StatusMark({ status, className }: { status: "pass" | "warn" | "fail"; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full",
        status === "pass" ? "bg-pass-soft text-pass" : status === "warn" ? "bg-warn-soft text-warn" : "bg-fail-soft text-fail",
        className,
      )}
    >
      {status === "pass" ? <Check className="size-2.5" strokeWidth={3} /> : status === "warn" ? <TriangleAlert className="size-2.5" strokeWidth={2.5} /> : <XIcon className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

/** An architect's note: its first sentence; open it for the rest and "Suggested: …". */
function NoteRow({ c, selected, onSelect }: { c: ComplianceCheck; selected: boolean; onSelect: (c: ComplianceCheck | null) => void }) {
  const head = firstSentence(c.message) || sentenceCase(c.title);
  const rest = (c.message ?? "").trim().slice(head.length).trim();
  const fix = (c.fix ?? "").trim();
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(selected ? null : c)}
        aria-expanded={selected}
        className={cn(
          "flex w-full gap-2.5 rounded-control px-2 py-2 text-left outline-none transition-colors focus-visible:shadow-focus",
          selected ? "bg-accent-soft" : "hover:bg-surface-2/70",
        )}
      >
        <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink-4" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] leading-snug text-ink">{head}</span>
          {selected && rest && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{rest}</span>}
          {selected && fix && (
            <span className="mt-1 block text-[12.5px] leading-snug text-ink-2">
              <span className="font-medium text-ink">Suggested: </span>
              {fix}
            </span>
          )}        </span>
        <ChevronDown className={cn("mt-1 size-3.5 shrink-0 text-ink-3 transition-transform duration-(--dur-fast)", selected && "rotate-180")} strokeWidth={1.75} />
      </button>
    </li>
  );
}

function Row({ c, selected, onSelect, onFix, always }: { c: ComplianceCheck; selected: boolean; onSelect: (c: ComplianceCheck | null) => void; onFix?: (c: ComplianceCheck) => void; always?: boolean }) {
  const v = valueLine(c);
  const expanded = always || selected || c.status !== "pass";
  const target = !!c.element_ids?.length;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(selected ? null : c)}
        className={cn(
          "flex w-full gap-2.5 rounded-control px-2 py-2 text-left outline-none transition-colors focus-visible:shadow-focus",
          selected ? "bg-accent-soft" : "hover:bg-surface-2/70",
        )}
      >
        <StatusMark status={c.status} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] leading-snug text-ink">{sentenceCase(c.title)}</span>
          {v && <span className="mt-0.5 block font-mono text-[12px] tabular-nums text-ink-2">{v}</span>}
          {(expanded || !v) && c.message && (!v || c.status !== "pass" || always) && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{c.message}</span>}
          {selected && target && <span className="mt-1 block text-[12px] font-medium text-accent">Shown on the plan</span>}
        </span>
      </button>
      {c.status === "fail" && onFix && (
        <div className="pb-1.5 pl-[34px]">
          <button type="button" onClick={() => onFix(c)} className="rounded-full px-2.5 py-1 text-[13px] font-medium text-accent outline-none hover:bg-accent-soft focus-visible:shadow-focus">
            Ask Naqsha to fix this
          </button>
        </div>
      )}
    </li>
  );
}
