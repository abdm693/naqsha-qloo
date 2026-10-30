/**
 * The print dialog (⌘P in Plan): paper, floors, cover and compliance. "Print or save as PDF" mounts the sheets
 * in a print-only layer and opens the browser's print dialog; the layer is removed after printing.
 * `PrintView` is the same document as a page (for a `/p/:id/print?v=&size=&sheets=` route).
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, Printer } from "lucide-react";
import type { Project, Version } from "@contracts/api-types";
import { cn } from "@/app/lib/utils";
import { Button, Dialog, Segmented } from "@/app/design/kit";
import { flow, useFlow } from "@/app/design/flow";
import { levelKey, levelName, levelsOf } from "./model";
import { PAPER, PrintDocument, pickScale, type Paper, type PrintOptions } from "./PrintDocument";

const STYLE_ID = "nq-print-style";

function printCss(paper: Paper) {
  const p = PAPER[paper];
  return `
@page { size: ${p.w}mm ${p.h}mm; margin: 0; }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(#nq-print-root) { display: none !important; }
  #nq-print-root { display: block !important; position: static !important; }
}
@media screen { #nq-print-root { position: fixed; left: -200vw; top: 0; pointer-events: none; } }`;
}

/** Mount the document off-screen, wait for fonts and images, print, then clean up. */
function usePrintJob() {
  const [job, setJob] = useState<{ options: PrintOptions; project: Project; version: Version; conceptUrl?: string } | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!job) return;
    const el = document.createElement("div");
    el.id = "nq-print-root";
    document.body.appendChild(el);
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = printCss(job.options.paper);
    document.head.appendChild(style);
    setRoot(el);
    const prevTitle = document.title;
    document.title = `${job.project.name} — version ${job.version.n}`;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      window.removeEventListener("afterprint", cleanup);
      document.title = prevTitle;
      style.remove();
      el.remove();
      setRoot(null);
      setJob(null);
    };
    window.addEventListener("afterprint", cleanup);
    const go = async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try { await document.fonts?.ready; } catch { /* ignore */ }
      const imgs = [...el.querySelectorAll("img")];
      await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = () => r(null); }))));
      window.print();
      // Some browsers don't fire afterprint for "Save as PDF"; tidy up shortly after the dialog returns.
      setTimeout(cleanup, 1500);
    };
    void go();
    return () => cleanup();
  }, [job]);

  const portal = job && root ? createPortal(<PrintDocument project={job.project} version={job.version} options={job.options} conceptUrl={job.conceptUrl} />, root) : null;
  return { start: setJob, busy: !!job, portal };
}

export function PrintDialog({ open, onClose, project, version }: { open: boolean; onClose: () => void; project: Project; version: Version }) {
  const levels = useMemo(() => levelsOf(version.plan).filter((l) => l.index >= 0), [version.plan]);
  const [paper, setPaper] = useState<Paper>("a3");
  const [picked, setPicked] = useState<string[]>(() => levels.map((l) => l.id));
  const [cover, setCover] = useState(true);
  const [compliance, setCompliance] = useState(true);
  const { start, busy, portal } = usePrintJob();
  const concept = project.concepts.find((c) => c.id === project.selected_concept_id);
  const [preview, setPreview] = useState<PrintOptions | null>(null);
  useEffect(() => setPicked(levels.map((l) => l.id)), [levels]);

  const scale = pickScale(version.plan, paper);
  // The compliance report's sheets are measured off-screen (the same layout that prints), so the count is exact.
  const [reportSheets, setReportSheets] = useState<Record<Paper, number | null>>({ a3: null, a4: null });
  const measured = reportSheets[paper];
  const sheets = (cover ? 1 : 0) + picked.length + (compliance ? measured ?? 1 : 0);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const options: PrintOptions = { paper, levels: picked, cover, compliance };
  const go = (o: PrintOptions = options) => {
    onClose();
    setPreview(null);
    start({ project, version, conceptUrl: concept?.url, options: o });
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Print or save as PDF"
        description={`Landscape sheets for your contractor and the permit file. Floors print at 1:${scale}.`}
        actions={
          <>
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => { onClose(); setPreview(options); }} disabled={!sheets}>
              Preview
            </Button>
            <Button variant="primary" icon={<Printer className="size-4" strokeWidth={1.75} />} onClick={() => go()} disabled={!sheets} loading={busy}>
              {compliance && measured == null ? "Print" : `Print ${sheets} ${sheets === 1 ? "sheet" : "sheets"}`}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Field label="Paper">
            <Segmented
              label="Paper"
              value={paper}
              onChange={setPaper}
              options={[
                { value: "a3", label: "A3" },
                { value: "a4", label: "A4" },
              ]}
            />
          </Field>
          <Field label="Floors">
            <div className="flex flex-wrap gap-2">
              {levels.map((l) => (
                <Toggle key={l.id} on={picked.includes(l.id)} onClick={() => toggle(l.id)}>
                  <span className="font-mono text-[12px] text-ink-3">{levelKey(l, levels)}</span>
                  {levelName(l)}
                </Toggle>
              ))}
            </div>
          </Field>
          <Field label="Also include">
            <div className="flex flex-wrap gap-2">
              <Toggle on={cover} onClick={() => setCover((c) => !c)}>
                Cover with concept and areas
              </Toggle>
              <Toggle on={compliance} onClick={() => setCompliance((c) => !c)}>
                Compliance report
              </Toggle>
            </div>
          </Field>
        </div>
      </Dialog>
      {portal}
      {open && (
        <div aria-hidden style={{ position: "fixed", left: "-30000px", top: 0, visibility: "hidden", pointerEvents: "none" }}>
          {(["a3", "a4"] as Paper[]).map((p) => (
            <PrintDocument
              key={p}
              project={project}
              version={version}
              options={{ paper: p, levels: [], cover: false, compliance: true }}
              onPages={(n) => setReportSheets((s) => (s[p] === n ? s : { ...s, [p]: n }))}
            />
          ))}
        </div>
      )}
      <AnimatePresence>{preview && <PrintPreview project={project} version={version} options={preview} conceptUrl={concept?.url} onClose={() => setPreview(null)} onPrint={() => go(preview)} />}</AnimatePresence>
    </>
  );
}

/** The sheets on screen, scaled to the window, before printing. */
function PrintPreview({ project, version, options, conceptUrl, onClose, onPrint }: { project: Project; version: Version; options: PrintOptions; conceptUrl?: string; onClose: () => void; onPrint: () => void }) {
  const [w, setW] = useState(() => window.innerWidth);
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => {
      setW(window.innerWidth);
      setH(window.innerHeight);
    };
    window.addEventListener("resize", on);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  // One whole sheet in view at a time.
  const pageW = (PAPER[options.paper].w / 25.4) * 96;
  const pageH = (PAPER[options.paper].h / 25.4) * 96;
  const zoom = Math.min(1, (w - 48) / pageW, (h - 120) / pageH);
  return createPortal(
    <motion.div className="fixed inset-0 z-[85] flex flex-col bg-surface-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="dialog" aria-modal="true" aria-label="Print preview">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-ink">Print preview</p>
          <p className="truncate text-[12.5px] text-ink-3">
            {PAPER[options.paper].label} landscape · floors at 1:{pickScale(version.plan, options.paper)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={<Printer className="size-4" strokeWidth={1.75} />} onClick={onPrint} aria-label="Print or save as PDF">
            <span className="sm:hidden">Print</span>
            <span className="max-sm:hidden">Print or save as PDF</span>
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-6 [scrollbar-width:thin]">
        <div style={{ zoom }} className="[&_.page]:mx-auto [&_.page]:mb-6 [&_.page]:shadow-e2">
          <PrintDocument project={project} version={version} options={options} conceptUrl={conceptUrl} />
        </div>
      </div>
    </motion.div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-label text-ink-2">{label}</p>
      {children}
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-chip px-3 text-[13px] font-medium outline-none transition-colors focus-visible:shadow-focus",
        on ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]" : "bg-surface-2 text-ink-2 hover:bg-surface-3",
      )}
    >
      <span className={cn("grid size-4 place-items-center rounded-[5px]", on ? "bg-accent text-white" : "shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]")}>{on && <Check className="size-3" strokeWidth={3} />}</span>
      {children}
    </button>
  );
}

/** The print document as its own page: `?v=<version>&size=a3|a4&sheets=cover,ground,first,roof,compliance`. */
export function PrintView({ project }: { project: Project }) {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const vid = params.get("v") ?? project.current_version_id ?? "";
  const version = useFlow((s) => s.versions[vid]);
  useEffect(() => {
    if (vid) void flow.loadVersion(project.id, vid);
  }, [project.id, vid]);
  if (!version) return <div className="grid h-full place-items-center text-ink-3">Preparing the drawings…</div>;
  const size = (params.get("size") === "a4" ? "a4" : "a3") as Paper;
  const sheets = (params.get("sheets") ?? "").split(",").filter(Boolean);
  const levels = levelsOf(version.plan).filter((l) => l.index >= 0);
  const pick = (k: string, l: (typeof levels)[number]) => k === l.id || k === levelKey(l, levels).toLowerCase();
  const options: PrintOptions = {
    paper: size,
    levels: sheets.length ? levels.filter((l) => sheets.some((k) => pick(k, l))).map((l) => l.id) : levels.map((l) => l.id),
    cover: !sheets.length || sheets.includes("cover"),
    compliance: !sheets.length || sheets.includes("compliance"),
  };
  const concept = project.concepts.find((c) => c.id === project.selected_concept_id);
  return (
    <div className="min-h-full bg-surface-2 py-8 print:bg-white print:py-0">
      <style>{`@page { size: ${PAPER[size].w}mm ${PAPER[size].h}mm; margin: 0; } @media screen { .nq-print .page { margin: 0 auto 8mm; box-shadow: 0 12px 32px -12px rgb(17 17 19 / .18); } }`}</style>
      <div className="fixed right-4 top-4 z-10 print:hidden">
        <Button variant="primary" icon={<Printer className="size-4" strokeWidth={1.75} />} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <PrintDocument project={project} version={version} options={options} conceptUrl={concept?.url} />
    </div>
  );
}
