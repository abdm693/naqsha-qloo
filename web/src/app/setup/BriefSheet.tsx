/**
 * The live brief: every captured requirement, visible and directly editable (tap a row to change it; the brief is
 * saved straight away and the LDA envelope recomputed). Assumed values read in ink-3 with a dotted underline.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, ChevronRight, Plus, X } from "lucide-react";
import type { Brief, Envelope, RulesPack } from "@contracts/api-types";
import { BUDGET_LABEL, FACING_LABEL, plotLabel, toMarla } from "@/api/domain";
import { cn, feetInches, num } from "@/app/lib/utils";
import { Button, Dialog, EASE_OUT, Segmented } from "@/app/design/kit";
import { LEVEL_LABEL, defaultProgram, levelsFor, roomsLine, toFloors, bedroomsIn, bathsIn, type Program } from "./catalogue";
import { rulesKnown } from "./Understood";
import { FacingPicker, FloorsEditor, PlotEditor, RoofEditor, StyleEditor, solarEstimate, useCurrentReport } from "./widgets";
import { solarLabel, tankLabel } from "@/app/lib/roof";
import { sentenceCase, untitle } from "@/app/plan/model";

export type SaveBrief = (patch: Partial<Brief>, decided: string[]) => void;

type Editing = "plot" | "location" | "facing" | "floors" | "roof" | "style" | "budget" | null;

export function BriefSheet({ brief, envelope, save, className }: { brief: Brief | null; envelope: Envelope | null; save: SaveBrief; className?: string }) {
  const [editing, setEditing] = useState<Editing>(null);
  const auto = new Set(brief?.auto_filled ?? []);
  const b = brief;
  const plot = b?.plot;
  const hasPlot = !!plot?.width_ft;
  const program: Program | null = b ? (b.floors?.length ? defaultProgram(b, envelope) : null) : null;
  const levels = levelsFor(b?.storeys || 2);
  const porch = b?.spaces?.find((s) => s.startsWith("car_porch"));
  // Only what is known shows as a row; the rest is one line ("Naqsha will ask about the rest"), each still settable.
  const missing = (
    [
      ["plot", "Plot", !hasPlot],
      ["location", "Location", !b?.scheme && !b?.city],
      ["facing", "Facing", !b?.facing],
      ["floors", "Floors", !b?.storeys],
      ["roof", "Roof", !b?.water_tank && !b?.solar],
      ["style", "Style", !b?.style],
      ["budget", "Finishes", !b?.budget],
    ] as [Exclude<Editing, null>, string, boolean][]
  )
    .filter(([key, , gone]) => gone && ((key !== "floors" && key !== "roof") || !!b))
    .map(([key, label]) => ({ key, label }));

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-heading text-ink">Your brief</h2>
        <span className="text-[12.5px] text-ink-3">Tap anything to change it</span>
      </div>
      <dl className="mt-3 divide-y divide-line border-y border-line">
        {hasPlot && <Row label="Plot" empty={!hasPlot} assumed={auto.has("plot")} onEdit={() => setEditing("plot")}>
          {hasPlot && (
            <>
              <span>{plotLabel(plot!.area_marla || toMarla(plot!.width_ft, plot!.depth_ft))}</span>
              <span className="font-mono text-[13px] tabular-nums text-ink-2">
                {feetInches(plot!.width_ft)} × {feetInches(plot!.depth_ft)}
              </span>
              <span className={cn(auto.has("corner") && "text-ink-3 underline decoration-dotted decoration-ink-4 underline-offset-4")}>{plot!.corner ? "Corner" : "Mid-row"}</span>
            </>
          )}
        </Row>}
        {(b?.scheme || b?.city) && <Row label="Location" empty={!b?.scheme && !b?.city} assumed={auto.has("scheme")} onEdit={() => setEditing("location")}>
          <span>{[b?.scheme, b?.city].filter(Boolean).join(", ")}</span>
          {b?.authority && <span className="text-[12.5px] text-ink-3">{b.authority === "LDA" ? "LDA rules" : b.rules_pack ? `${b.rules_pack.name || b.rules_pack.authority} rules` : `${b.city ?? b.authority} rules`}</span>}
        </Row>}
        {b?.facing && <Row label="Facing" empty={!b?.facing} assumed={auto.has("facing")} onEdit={() => setEditing("facing")}>
          {b?.facing && <span>The front faces {FACING_LABEL[b.facing]?.toLowerCase()}</span>}
        </Row>}
        {!!b?.storeys && <Row label="Floors" empty={!b?.storeys} assumed={auto.has("floors") || auto.has("storeys")} onEdit={() => setEditing("floors")} block>
          {!!b?.storeys && (
            <div className="space-y-0.5">
              <p>
                {b.storeys} {b.storeys === 1 ? "storey" : "storeys"}
                {b.bedrooms ? `, ${b.bedrooms} bedrooms` : ""}
                {b.basement ? ", basement" : ""}
                {porch ? `, ${porch.split(":")[1] ?? 1}-car porch` : ""}
              </p>
              {program &&
                levels
                  .filter((l) => roomsLine(program[l]))
                  .map((l) => (
                    <p key={l} className="text-[13px] leading-snug text-ink-2">
                      <span className="text-ink-3">{LEVEL_LABEL[l]}</span> {roomsLine(program[l])}
                    </p>
                  ))}
            </div>
          )}
        </Row>}
        {(b?.water_tank || b?.solar) && <Row label="Roof" empty={!b?.water_tank && !b?.solar} assumed={auto.has("water_tank") || auto.has("solar")} onEdit={() => setEditing("roof")}>
          {b?.water_tank && <span>{tankLabel(b.water_tank)}</span>}
          {b?.solar && <span className="text-ink-2">{solarLabel(b.solar)}</span>}
        </Row>}
        {b?.style && <Row label="Style" empty={!b?.style} assumed={auto.has("style")} onEdit={() => setEditing("style")}>
          {b?.style && <span>{sentenceCase(b.style)}</span>}
        </Row>}
        {b?.budget && <Row label="Finishes" empty={!b?.budget} assumed={auto.has("budget")} onEdit={() => setEditing("budget")}>
          {b?.budget && <span>{BUDGET_LABEL[b.budget]}</span>}
        </Row>}
        {missing.length > 0 && (
          <div className="py-2.5 text-[13.5px] leading-snug text-ink-3">
            Naqsha will ask about the rest
            <span className="sr-only">: {missing.map((m) => m.label.toLowerCase()).join(", ")}</span>
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {missing.map((m) => (
                <button key={m.key} type="button" onClick={() => setEditing(m.key)} className="inline-flex h-7 items-center rounded-chip bg-surface-2 px-2.5 text-[12.5px] font-medium text-ink-2 outline-none transition-colors hover:bg-surface-3 hover:text-ink focus-visible:shadow-focus">
                  {m.label}
                </button>
              ))}
            </span>
          </div>
        )}
        <Wishes prefs={b?.preferences ?? []} onChange={(preferences) => save({ preferences }, [])} />
        {b?.notes && (
          <div className="grid grid-cols-[88px_1fr] gap-3 py-2.5">
            <dt className="text-[13px] text-ink-3">Notes</dt>
            <dd className="whitespace-pre-line text-[13.5px] leading-snug text-ink-2">{b.notes}</dd>
          </div>
        )}
      </dl>

      {rulesKnown(b)
        ? <EnvelopeFacts envelope={envelope} corner={!!plot?.corner} authority={b?.rules_pack?.name || b?.rules_pack?.authority || b?.authority} pack={b?.rules_pack} />
        : b?.city ? <p className="mt-4 text-[13.5px] text-ink-3">Looking up {b.city}'s building rules.</p> : null}
      {b?.rules_pack && <RulesSources pack={b.rules_pack} />}

      {/* Editors */}
      <Dialog open={editing === "plot"} onClose={() => setEditing(null)} title="Plot" description="Pick a standard size or enter the exact width and depth." width={560}>
        <PlotEditor
          brief={b}
          doneLabel={() => "Save"}
          onDone={(w, d, corner) => {
            save({ plot: { width_ft: w, depth_ft: d, area_marla: Math.round(toMarla(w, d) * 10) / 10, corner } }, ["plot", "corner"]);
            setEditing(null);
          }}
        />
      </Dialog>
      <LocationDialog open={editing === "location"} brief={b} onClose={() => setEditing(null)} save={save} />
      <Dialog open={editing === "facing"} onClose={() => setEditing(null)} title="Which way does the front face?" description="The road side of the plot. It sets where the sun falls.">
        <FacingPicker
          value={b?.facing}
          onChange={(facing) => {
            save({ facing }, ["facing"]);
            setEditing(null);
          }}
        />
      </Dialog>
      {b && <FloorsDialog open={editing === "floors"} brief={b} envelope={envelope} onClose={() => setEditing(null)} save={save} />}
      {b && <RoofDialog open={editing === "roof"} brief={b} envelope={envelope} onClose={() => setEditing(null)} save={save} />}
      <Dialog open={editing === "style"} onClose={() => setEditing(null)} title="Style" width={620}>
        <StyleEditor
          current={b?.style}
          onPick={(style) => {
            save({ style }, ["style"]);
            setEditing(null);
          }}
        />
      </Dialog>
      <Dialog open={editing === "budget"} onClose={() => setEditing(null)} title="Finishes" description="It changes materials, not the layout.">
        <div className="grid gap-2">
          {(["economy", "standard", "premium", "luxury"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                save({ budget: k }, ["budget"]);
                setEditing(null);
              }}
              className={cn(
                "flex items-center justify-between rounded-control px-4 py-3 text-left outline-none transition-colors focus-visible:shadow-focus",
                b?.budget === k ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]" : "bg-surface-2 text-ink hover:bg-surface-3",
              )}
            >
              <span className="text-[15px] font-medium">{BUDGET_LABEL[k]}</span>
              <span className="text-[13px] text-ink-3">
                {k === "economy" ? "Simple, durable finishes" : k === "standard" ? "Porcelain floors, local fittings" : k === "premium" ? "Marble, wood, imported fittings" : "Bespoke throughout"}
              </span>
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

function Row({ label, children, empty, assumed, onEdit, block }: { label: string; children?: ReactNode; empty?: boolean; assumed?: boolean; onEdit: () => void; block?: boolean }) {
  // A valid dl row (dt, then dd holding the button); the button's hit area covers the whole row.
  return (
    <div className="group relative grid w-full grid-cols-[88px_1fr] items-start gap-3 py-2.5 has-[:focus-visible]:bg-surface-2">
      <dt className="pt-px text-[13px] text-ink-3">{label}</dt>
      <dd className="min-w-0">
        <button type="button" onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`} className="grid w-full grid-cols-[1fr_16px] items-start gap-3 text-left outline-none after:absolute after:inset-0 after:content-['']">
          <span className={cn("block min-w-0 text-[14px] leading-snug", assumed ? "text-ink-3" : "text-ink")}>
            {empty ? (
              <span className="text-ink-3">Not yet</span>
            ) : (
              <motion.span initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_OUT }} className={cn(block ? "block" : "flex flex-wrap items-baseline gap-x-2 gap-y-0.5", assumed && !block && "[&>span:first-child]:underline [&>span:first-child]:decoration-dotted [&>span:first-child]:decoration-ink-4 [&>span:first-child]:underline-offset-4")}>
                {children}
              </motion.span>
            )}
          </span>
          <ChevronRight className="mt-0.5 size-4 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 max-md:opacity-100" strokeWidth={1.75} aria-hidden />
        </button>
      </dd>
    </div>
  );
}

function Wishes({ prefs, onChange }: { prefs: string[]; onChange: (p: string[]) => void }) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const commit = () => {
    const t = text.trim();
    if (t) onChange([...prefs, t]);
    setText("");
    setAdding(false);
  };
  return (
    <div className="grid grid-cols-[88px_1fr_16px] items-start gap-3 py-2.5">
      <dt className="pt-1.5 text-[13px] text-ink-3">Wishes</dt>
      <dd className="flex min-w-0 flex-wrap gap-1.5">
        <AnimatePresence initial={false}>
          {prefs.map((p) => (
            <motion.span key={p} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="inline-flex min-h-8 max-w-full items-center gap-0.5 rounded-chip bg-surface-2 py-1 pl-2.5 text-[13px] leading-snug text-ink">
              {untitle(p)}
              <button type="button" aria-label={`Remove ${p}`} onClick={() => onChange(prefs.filter((x) => x !== p))} className="grid size-6 shrink-0 place-items-center rounded-full text-ink-4 hover:bg-surface-3 hover:text-ink">
                <X className="size-3" strokeWidth={2} />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        {adding ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setText(""); setAdding(false); }
              e.stopPropagation();
            }}
            placeholder="e.g. open kitchen"
            className="h-8 w-44 rounded-chip bg-surface px-2.5 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--color-accent)] outline-none placeholder:text-ink-4"
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="inline-flex h-8 items-center gap-1 rounded-chip px-2 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            <Plus className="size-3.5" strokeWidth={2} /> {prefs.length ? "Add" : "Add a wish"}
          </button>
        )}
      </dd>
    </div>
  );
}

function EnvelopeFacts({ envelope, corner, authority, pack }: { envelope: Envelope | null; corner: boolean; authority?: string | null; pack?: RulesPack }) {
  if (!envelope) return null;
  const r = envelope.buildable_rect;
  const perFloor = Math.min(r.w * r.d, envelope.max_ground_coverage_sqft);
  // Only the notes the line and the facts grid don't already say: the corner splay and the authority's own notes. The
  // envelope's generic lines (plot size, setbacks, coverage with a second per-floor figure, height) repeat them in
  // jargon (lda.py envelope()).
  const notes = envelope.notes
    .filter((n) => !/^(Plot |Setbacks:|Ground coverage|Height up to)/.test(n.trim()))
    // The corner-plot note matters most on a corner plot; never drop it.
    .sort((a, b) => Number(/corner|splay/i.test(b) && corner) - Number(/corner|splay/i.test(a) && corner));
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT }} className="mt-6">
      <h3 className="text-[15px] font-semibold text-ink">What {authority || envelope.authority || "LDA"} lets you build</h3>
      <p className="mt-1 text-body text-ink-2">
        Up to <span className="font-mono tabular-nums text-ink">{num(perFloor)}</span> sq ft a floor, {envelope.max_storeys} storeys, {feetInches(envelope.max_height_ft)} to the parapet.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <Fact label="Ground coverage" value={`${num(envelope.max_coverage_pct)}% max`} />
        <Fact label="Floor area ratio" value={`1:${envelope.max_far}`} />
        <Fact label="Front · rear" value={`${feetInches(envelope.setbacks_ft.front)} · ${feetInches(envelope.setbacks_ft.rear)}`} />
        <Fact label="Sides" value={envelope.setbacks_ft.left || envelope.setbacks_ft.right ? `${feetInches(envelope.setbacks_ft.left)} · ${feetInches(envelope.setbacks_ft.right)}` : "None needed"} />
      </div>
      {notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {notes.map((n) => (
            <li key={n} className="flex gap-2 text-[13px] leading-snug text-ink-2">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />
              {n}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[12px] text-ink-3">
        {[pack ? pack.instrument : `${envelope.authority} Building and Zoning Regulations`, envelope.band].filter(Boolean).join(" · ")}
      </p>
    </motion.div>
  );
}

/**
 * Rules for an authority Naqsha ships no pack for, researched on the web: where they came from (official sources
 * marked) and that they are a draft until the authority confirms them.
 */
function RulesSources({ pack }: { pack: RulesPack }) {
  const who = pack.name || pack.authority;
  const sources = pack.sources.filter((s) => s.url);
  const caveats = (pack.caveats ?? []).filter(Boolean).slice(0, 3);
  return (
    <motion.section aria-label="Where these rules come from" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT }} className="mt-4 rounded-card bg-surface-2 px-4 py-3">
      <p className="text-[13.5px] font-medium leading-snug text-ink">Rules for {who} researched on the web</p>
      {sources.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {sources.map((s) => (
            <li key={s.url} className="flex min-w-0 items-baseline gap-2 text-[13px] leading-snug">
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="group inline-flex min-w-0 items-baseline gap-1 rounded-[4px] text-accent outline-none underline-offset-4 hover:underline focus-visible:shadow-focus">
                <span className="line-clamp-2 break-words">{s.title?.trim() || hostOf(s.url)}</span>
                <ArrowUpRight className="size-3 shrink-0 translate-y-px opacity-70" strokeWidth={2} aria-hidden />
              </a>
              {s.official && <span className="shrink-0 rounded-chip bg-surface px-1.5 py-px text-[11.5px] font-medium text-ink-2">Official</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2.5 text-[12.5px] leading-snug text-ink-3">
        A draft from public sources. Confirm the figures with {pack.authority} before you apply for approval.
      </p>
      {caveats.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {caveats.map((c) => (
            <li key={c} className="flex gap-2 text-[12.5px] leading-snug text-ink-3">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
              {c}
            </li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-ink-3">{label}</p>
      <p className="font-mono tabular-nums text-ink">{value}</p>
    </div>
  );
}

function LocationDialog({ open, brief, onClose, save }: { open: boolean; brief: Brief | null; onClose: () => void; save: SaveBrief }) {
  const [scheme, setScheme] = useState(brief?.scheme ?? "");
  const [authority, setAuthority] = useState<Brief["authority"]>(brief?.authority ?? "LDA");
  useEffect(() => {
    if (!open) return;
    setScheme(brief?.scheme ?? "");
    setAuthority(brief?.authority ?? "LDA");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Where is the plot?"
      description="The scheme decides whose rules apply. DHA and Bahria have their own bylaws; I design to LDA rules and flag where they differ."
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              save({ scheme: scheme.trim() || undefined, authority, city: brief?.city || "Lahore" }, ["scheme"]);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <input
          value={scheme}
          onChange={(e) => setScheme(e.target.value)}
          placeholder="Scheme, e.g. Johar Town"
          aria-label="Scheme"
          className="h-11 w-full rounded-control bg-surface px-3.5 text-body text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)] outline-none placeholder:text-ink-4 focus:shadow-[inset_0_0_0_1px_var(--color-accent),var(--shadow-focus)]"
        />
        <Segmented
          label="Authority"
          value={authority}
          onChange={setAuthority}
          options={[
            { value: "LDA", label: "LDA" },
            { value: "DHA", label: "DHA" },
            { value: "BAHRIA", label: "Bahria" },
            { value: "OTHER", label: "Other" },
          ]}
        />
      </div>
    </Dialog>
  );
}

function FloorsDialog({ open, brief, envelope, onClose, save }: { open: boolean; brief: Brief; envelope: Envelope | null; onClose: () => void; save: SaveBrief }) {
  const [program, setProgram] = useState<Program>(() => defaultProgram(brief, envelope));
  const [storeys, setStoreys] = useState(Math.max(1, Math.min(3, brief.storeys || 2)));
  useEffect(() => {
    if (!open) return;
    setProgram(defaultProgram(brief, envelope));
    setStoreys(Math.max(1, Math.min(3, brief.storeys || 2)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rooms on each floor"
      width={640}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const levels = levelsFor(storeys);
              const beds = bedroomsIn(program);
              save({ floors: toFloors(program, levels), storeys, bedrooms: beds || brief.bedrooms, bathrooms: bathsIn(program) || brief.bathrooms }, ["floors", "storeys", "bedrooms"]);
              onClose();
            }}
          >
            Save floors
          </Button>
        </>
      }
    >
      <FloorsEditor brief={brief} envelope={envelope} program={program} storeys={storeys} onChange={(p, s) => { setProgram(p); setStoreys(s); }} />
    </Dialog>
  );
}

function RoofDialog({ open, brief, envelope, onClose, save }: { open: boolean; brief: Brief; envelope: Envelope | null; onClose: () => void; save: SaveBrief }) {
  const report = useCurrentReport();
  const [tank, setTank] = useState<"plastic" | "concrete">(brief.water_tank ?? "concrete");
  const [solar, setSolar] = useState<"none" | "ready" | "panels">(brief.solar ?? "ready");
  useEffect(() => {
    if (!open) return;
    setTank(brief.water_tank ?? "concrete");
    setSolar(brief.solar ?? "ready");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="The roof"
      width={600}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              save({ water_tank: tank, solar }, ["water_tank", "solar"]);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <RoofEditor tank={tank} solar={solar} panels={solarEstimate(envelope, brief, report)} onChange={(t, s) => { setTank(t); setSolar(s); }} />
    </Dialog>
  );
}
