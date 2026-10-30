/**
 * Brief (DESIGN.md "Brief (conversational setup)"): the conversation docked on the left; on the right the plot to
 * scale with the LDA envelope and the live, editable brief. One message can fill the whole brief; Naqsha answers
 * "Here's what I understood", then asks at most three things (floors, roof, style), each with "Decide for me".
 * "Decide everything for me" goes all the way to a plan and a walkable house.
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, FileImage, X } from "lucide-react";
import type { Brief, ChatMessage, Project } from "@contracts/api-types";
import { api } from "@/api/client";
import { plotLabel } from "@/api/domain";
import { cn } from "@/app/lib/utils";
import { canEdit } from "@/app/lib/views";
import { useAskContext } from "@/app/shell/ask";
import { Button, EASE_SHEET, IconButton, notify, useMediaQuery } from "@/app/design/kit";
import { useViewNav } from "@/app/design/nav";
import { useProject } from "@/app/store/project";
import { BriefSheet } from "./BriefSheet";
import { chat, useChat } from "./chat";
import { Conversation } from "./Conversation";
import { DrawingCard, useDrawingPicker } from "./DrawingCard";
import { importDrawing, useDrawing } from "./drawing";
import { PlotCanvas } from "./PlotCanvas";
import { Neighbourhood } from "@/app/taste/Neighbourhood";

const NO_MESSAGES: ChatMessage[] = [];

export function BriefView({ project, onProjectChange }: { project: Project; onProjectChange(p: Project): void }) {
  const goTo = useViewNav();
  const phone = useMediaQuery("(max-width: 1023px)");
  const messages = useChat((s) => (s.pid === project.id ? s.messages : NO_MESSAGES));
  const draft = useChat((s) => (s.pid === project.id ? s.draft : null));
  const busy = useChat((s) => s.pid === project.id && s.busy);
  const autopilot = useChat((s) => s.pid === project.id && s.autopilot);
  const failed = useChat((s) => s.pid === project.id && !!s.failed);
  // A turn that never got a reply (it failed, or the page was reloaded mid-turn).
  const unanswered = !busy && messages[messages.length - 1]?.role === "user" ? messages[messages.length - 1].text : undefined;
  const preview = useChat((s) => (s.pid === project.id ? s.preview : null));
  const [sheet, setSheet] = useState(false);
  // The family's own floor plan, being read (from here or from the workspace) or already read.
  const reading = useDrawing((s) => (s.pid === project.id ? s.previews : null));
  const editor = canEdit(project);
  const drawing = useDrawingPicker((files) => void importDrawing(project.id, files));

  useEffect(() => {
    void chat.open(project.id);
  }, [project.id]);

  const complete = project.stage !== "setup";
  const brief = project.brief;
  // The Ask example only offers another storey where the rules allow one.
  const storeys = brief?.storeys ?? 0;
  const maxStoreys = project.envelope?.max_storeys ?? 0;
  const moreExample = storeys && maxStoreys > storeys && storeys < 3 ? `a ${["", "second", "third"][storeys]} storey` : "a bigger kitchen";
  const send = useCallback((body: Parameters<typeof chat.send>[1], display?: string) => void chat.send(project.id, body, display), [project.id]);

  // "Decide everything for me": once the brief is complete, carry on to concepts (which choose and plan).
  useEffect(() => {
    if (!autopilot || !complete || busy) return;
    chat.stopAutopilot();
    goTo("concepts", { state: { autopilot: true } });
  }, [autopilot, complete, busy, goTo]);

  const save = useCallback(
    async (patch: Partial<Brief>, decided: string[]) => {
      if (!project.brief) return;
      const next: Brief = { ...project.brief, ...patch, auto_filled: (project.brief.auto_filled ?? []).filter((f) => !decided.includes(f)) };
      onProjectChange({ ...project, brief: next });
      try {
        const p = await api.updateProject(project.id, { brief: next });
        onProjectChange(p);
      } catch (e) {
        onProjectChange(project);
        notify.error("Couldn't save the brief", e);
      }
    },
    [project, onProjectChange],
  );

  const onSuggestion = (s: string) => {
    if (/^show me (the )?concepts?$/i.test(s.trim())) goTo("concepts");
    else send({ message: s }, s);
  };

  useAskContext({
    // The conversation is on screen here: the dock doesn't repeat Naqsha's line (it would cover the question).
    line: null,
    placeholder: complete ? `Anything to add or change? A prayer room, ${moreExample}…` : "Tell me about the plot and who will live there",
    // The conversation already shows Naqsha's suggestions under its last turn; the dock keeps to the one shortcut.
    suggestions: complete ? [] : ["Decide everything for me"],
    // A turn sent while the drawing is read would save the brief from before it.
    busy: busy || !!reading,
    onSubmit: (text) => {
      const t = text.trim();
      if (/^decide everything for me$/i.test(t)) send({ action: "skip_all" });
      else if (/^show me (the )?concepts?$/i.test(t)) goTo("concepts");
      else send({ message: text }, text);
    },
  });

  const w = preview?.width ?? brief?.plot?.width_ft ?? 0;
  const d = preview?.depth ?? brief?.plot?.depth_ft ?? 0;
  const env = preview?.envelope ?? project.envelope;
  const corner = preview?.corner ?? brief?.plot?.corner ?? false;

  const canvas = (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1">
        <div className="relative overflow-hidden rounded-media bg-surface shadow-e1">
          {w && d ? (
            <PlotCanvas width={w} depth={d} envelope={env} corner={corner} facing={brief?.facing} className="mx-auto block h-auto max-h-[64vh] w-full" />
          ) : (
            <EmptyPlot authority={brief?.authority} />
          )}
          <AnimatePresence>
            {preview && (
              <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute left-4 top-4 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">
                Preview
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {brief?.plot?.width_ft ? (
          <p className="mt-3 px-1 text-[13px] text-ink-3">
            {plotLabel(brief.plot.area_marla)} {brief.plot.corner ? "corner" : "mid-row"} plot{brief.scheme ? ` in ${brief.scheme}` : ""}. The blue line is how far {brief.rules_pack?.authority || brief.authority || project.envelope?.authority || "LDA"} lets you build.
          </p>
        ) : null}
        <div className="mt-6">
          <Neighbourhood
            project={project}
            compact
            title="Your neighbourhood"
            action={{ label: project.taste ? "See your family's taste" : "Make it yours: add what you love", onClick: () => goTo("taste") }}
          />
        </div>
        <DrawingCard
          imported={project.imported}
          reading={reading}
          onReplace={editor && !busy ? drawing.pick : undefined}
          className="mt-6 rounded-card bg-surface px-4 pb-4 pt-3 shadow-e1"
        />
      </div>
      <BriefSheet brief={brief} envelope={project.envelope} save={save} className="w-full shrink-0 xl:w-[360px]" />
    </div>
  );

  // The dock's Next pill says "Show me concepts" whenever the brief is filled (shell/next.ts): the conversation only
  // says what comes next, and offers the button itself only when the pill isn't there.
  const conceptsRunning = useProject((s) => !!s.conceptRun?.running);
  const pillSaysIt = project.stage !== "setup" && !conceptsRunning;
  const nextCard = complete && !busy && !project.current_version_id && (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, delay: 0.1 }} className="mt-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-card bg-surface-2 px-4 py-3">
      <p className="text-[14px] text-ink-2">Next: four exteriors, by day and by night.</p>
      {!pillSaysIt && (
        <Button variant="secondary" size="sm" iconRight={<ArrowRight className="size-4" strokeWidth={1.75} />} onClick={() => goTo("concepts")}>
          Show me concepts
        </Button>
      )}
    </motion.div>
  );

  return (
    <div className="relative h-full overflow-hidden bg-canvas">
      {/* Conversation, docked on the left (full width on phones) */}
      <section
        aria-label="Conversation"
        className={cn(
          "absolute z-10 flex flex-col overflow-hidden bg-surface",
          phone ? "inset-x-0 top-[var(--chrome-top)]" : "left-3 top-[72px] w-[420px] rounded-panel shadow-e2",
        )}
        style={{ bottom: "calc(var(--dock-h, 132px) + 8px)" }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-ink">Brief</p>
            <p className="truncate text-[12.5px] text-ink-3" aria-live="polite">
              {reading ? "Reading your drawing…" : complete ? "Ready. Change anything, any time." : "One message is enough."}
            </p>
          </div>
          {/* "Decide everything for me" is the dock's chip: one of it, not two. */}
          <div className="flex shrink-0 items-center gap-1">
            {/* Start from a drawing: quiet, beside the brief's title, until one has been read (then the card offers another). */}
            {editor && (!project.imported || reading) && (phone ? (
              <IconButton label={reading ? "Reading your drawing" : "Start from a drawing"} size={36} onClick={drawing.pick} disabled={busy || !!reading}>
                <FileImage className="size-[18px]" strokeWidth={1.75} />
              </IconButton>
            ) : (
              <Button variant="quiet" size="sm" icon={<FileImage className="size-4" strokeWidth={1.75} />} loading={!!reading} disabled={busy} onClick={drawing.pick}>
                From a drawing
              </Button>
            ))}
            {phone && (
              <Button variant="secondary" size="sm" onClick={() => setSheet(true)} className="hit-44 relative">
                Plot and brief
              </Button>
            )}
          </div>
        </div>
        <Conversation
          className="flex-1"
          messages={messages}
          draft={draft}
          busy={busy}
          complete={complete}
          brief={brief}
          envelope={project.envelope}
          send={send}
          onSuggestion={onSuggestion}
          onPreferences={(preferences) => void save({ preferences }, [])}
          failed={failed || !!unanswered}
          onRetry={() => void chat.retry(project.id, unanswered)}
          footer={nextCard}
          designed={!!project.current_version_id}
        />
      </section>

      {/* Plot and live brief */}
      {/* The column scrolls above the dock (never under the Next pill), with 16px of air at its end. */}
      {!phone && (
        <div className="scroll-clear-chrome left-[444px]" style={{ bottom: "calc(var(--dock-h, 132px) + 8px)" }}>
          <div className="scroll-clear-body mx-auto max-w-[1040px] px-6" style={{ paddingBottom: 16 }}>{canvas}</div>
        </div>
      )}

      {drawing.input}
      <AnimatePresence>
        {phone && sheet && (
          <motion.div className="fixed inset-0 z-[60]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-(--scrim)" onClick={() => setSheet(false)} />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ duration: 0.32, ease: EASE_SHEET }}
              className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-panel bg-canvas px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-3 [scrollbar-width:thin]"
              role="dialog"
              aria-label="Plot and brief"
            >
              <div className="sticky top-0 z-10 -mx-4 mb-3 flex items-center justify-between bg-canvas/95 px-4 pb-2 backdrop-blur">
                <span className="h-1 w-9 rounded-full bg-line-strong" />
                <IconButton label="Close" size={32} onClick={() => setSheet(false)}>
                  <X className="size-4" strokeWidth={1.75} />
                </IconButton>
              </div>
              {canvas}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyPlot({ authority }: { authority?: string | null }) {
  return (
    <div className="grid aspect-[4/3] place-items-center px-8 text-center">
      <div>
        <svg viewBox="0 0 120 150" className="mx-auto h-28 w-auto" aria-hidden>
          <rect x="22" y="12" width="76" height="112" fill="none" stroke="#CFCFC8" strokeDasharray="4 4" />
          <path d="M6 140H114" stroke="#E4E4DF" strokeWidth="6" />
        </svg>
        <p className="mt-3 text-body text-ink-3">Your plot appears here, to scale, with what {authority || "LDA"} lets you build.</p>
      </div>
    </div>
  );
}
