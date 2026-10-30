/**
 * The dock (DESIGN.md §5.4): bottom-centre, max 720px. Naqsha's latest line and 2–3 suggestion chips, then Ask with
 * the attached Next pill. While Naqsha works, narration replaces the line and the pill.
 * Ask doubles as the command bar: ⌘K or "/" focuses it; typing opens Ask Naqsha · Go to · Do.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CornerDownLeft, Sparkles } from "lucide-react";
import type { Project } from "@contracts/api-types";
import { cn } from "@/app/lib/utils";
import { usePhone } from "@/app/lib/hooks";
import type { ViewId } from "@/app/lib/views";
import { useProject } from "@/app/store/project";
import { toast } from "@/app/store/toast";
import { Composer } from "@/app/ui/Composer";
import { SuggestionChip } from "@/app/ui/Chip";
import { Kbd } from "@/app/ui/Kbd";
import { NaqshaAvatar } from "@/app/ui/Avatar";
import { Tooltip } from "@/app/ui/Tooltip";
import { ease, spring } from "@/app/ui/motion";
import { activeAskContext, useActiveAskContext, useAskStore, type Command, type NextMove } from "./ask";
import { matchCommands } from "./commands";
import { useNaqshaActivity } from "@/app/design/flow";
import type { Narration } from "./narration";
import { useShell } from "./state";

export interface DockProps {
  view: ViewId;
  project: Project;
  tone: "light" | "hud";
  /** Default Next for the view (the view's context can override it). */
  defaultNext: NextMove | null;
  /** Default line ("Naqsha's latest words") when the view gives none. */
  defaultLine: string | null;
  defaultPlaceholder: string;
  defaultSuggestions: string[];
  /** What Ask does when the view registers nothing. */
  defaultSubmit: (text: string) => void | boolean | Promise<void | boolean>;
  commands: Command[];
  /** Whether Naqsha's line opens the conversation sheet (false where there is none, e.g. the client view). */
  conversation?: boolean;
  /** What Enter does with the typed text, in the command popover ("Ask Naqsha", or "Send to the owner"). */
  askLabel?: string;
}

export function Dock(props: DockProps) {
  const { tone, defaultNext, defaultLine, defaultPlaceholder, defaultSuggestions, defaultSubmit, commands, conversation = true, askLabel = "Ask Naqsha" } = props;
  const ctx = useActiveAskContext();
  // What Naqsha is doing right now (setup, concepts, night, design, revise), from the one project store.
  const activity = useNaqshaActivity();
  const phone = usePhone();
  const draft = useAskStore((s) => s.draft);
  const focusTick = useAskStore((s) => s.focusTick);
  const queued = useAskStore((s) => s.queued);
  const toggleChat = useShell((s) => s.toggleChat);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hud = tone === "hud";

  const next = ctx.next !== undefined ? ctx.next : defaultNext;
  const line = ctx.line !== undefined ? ctx.line : defaultLine;
  const suggestions = (ctx.suggestions ?? defaultSuggestions).slice(0, 3);
  const placeholder = ctx.placeholder ?? defaultPlaceholder;
  const working: Narration | null =
    activity.busy && activity.line
      ? { kind: activity.kind ?? "design", text: activity.line, progress: activity.progress }
      : ctx.busy
        ? { kind: "design", text: "Working…" }
        : null;

  const setDraft = (v: string) => useAskStore.setState({ draft: v });

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    if (working && working.kind !== "intake") {
      toast.show("Naqsha is still working on the last request. Ask again in a moment.");
      return;
    }
    setDraft("");
    setPaletteOpen(false);
    const fn = activeAskContext().onSubmit ?? defaultSubmit;
    // A send that fails keeps what was typed: the text comes back unless something new was typed meanwhile.
    const restore = () => {
      if (!useAskStore.getState().draft) setDraft(text);
    };
    try {
      void Promise.resolve(fn(t)).then((ok) => ok === false && restore(), restore);
    } catch {
      restore();
    }
  };

  // useAsk().submit from views
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const lastQueued = useRef(0);
  useEffect(() => {
    if (queued && queued.tick !== lastQueued.current) {
      lastQueued.current = queued.tick;
      submitRef.current(queued.text);
    }
  }, [queued]);

  // useAsk().focus(), ⌘K and "/"
  useEffect(() => {
    if (!focusTick) return;
    field.current?.focus();
    setPaletteOpen(true);
    setActive(0);
  }, [focusTick]);

  const allCommands = useMemo(() => [...(ctx.commands ?? []), ...commands], [ctx.commands, commands]);
  // Nothing typed yet: the places and the actions. Typing searches everything (floors, rooms, versions too).
  const matches = useMemo(
    () => (draft.trim() ? matchCommands(allCommands, draft, 6) : allCommands.filter((c) => c.group === "do" || c.id.startsWith("view-")).slice(0, 9)),
    [allCommands, draft],
  );
  const askItem = draft.trim().length > 0;
  const items: ({ kind: "ask" } | { kind: "cmd"; cmd: Command })[] = [
    ...(askItem ? [{ kind: "ask" as const }] : []),
    ...matches.map((cmd) => ({ kind: "cmd" as const, cmd })),
  ];
  const showPalette = paletteOpen && focused && items.length > 0;
  useEffect(() => setActive(0), [draft]);

  const runItem = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === "ask") submit(draft);
    else {
      setDraft("");
      setPaletteOpen(false);
      field.current?.blur();
      it.cmd.run();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showPalette) {
      if (e.key === "ArrowUp" && !draft) setPaletteOpen(true);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === "Enter" && !e.shiftKey) {
      const it = items[active];
      if (it && it.kind === "cmd") { e.preventDefault(); runItem(active); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(false);
    }
  };

  // Publish how much of the bottom edge the dock takes (its height, its inset and the safe area), so views keep
  // their controls above it and toasts sit 12px over it.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const set = () => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      const h = r.height ? Math.max(0, Math.round(window.innerHeight - r.top)) : 0;
      document.documentElement.style.setProperty("--dock-h", `${h}px`);
      if (useShell.getState().dockH !== h) useShell.setState({ dockH: h });
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    window.addEventListener("resize", set);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", set);
      document.documentElement.style.setProperty("--dock-h", "0px");
      useShell.setState({ dockH: 0 });
    };
  }, [phone, ctx.hidden]);

  // Close the palette on a click outside the dock.
  useEffect(() => {
    if (!paletteOpen) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setPaletteOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [paletteOpen]);

  if (ctx.hidden) return null;

  const pill = !working && next && (
    <motion.div layout transition={spring} className="shrink-0">
      <Tooltip content={next.hint ?? next.label} disabled={!next.hint}>
        <button
          type="button"
          onClick={next.run}
          disabled={next.disabled}
          aria-label={next.label}
          className={cn(
            "group inline-flex h-[52px] items-center gap-2 rounded-[26px] bg-accent pl-5 pr-4 text-[15px] font-medium text-white shadow-e2 outline-none",
            "transition-[background-color,transform,box-shadow] duration-[160ms] ease-out hover:bg-accent-press active:scale-[.97] focus-visible:shadow-[0_0_0_4px_rgb(107_42_94/.28)] disabled:opacity-50",
            phone && "h-11 rounded-full pl-4 pr-3 text-[14px]",
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={next.label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.24, ease: ease.out }}
              className="max-w-[46vw] truncate sm:max-w-none"
            >
              {next.label}
            </motion.span>
          </AnimatePresence>
          <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" strokeWidth={2} />
        </button>
      </Tooltip>
    </motion.div>
  );

  return (
    <div ref={root} className="pointer-events-auto relative w-full">
      {/* Command popover */}
      <AnimatePresence>
        {showPalette && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease: ease.out } }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.12, ease: ease.exit } }}
            role="listbox"
            aria-label="Ask Naqsha, go to or do"
            className={cn(
              "absolute inset-x-0 bottom-full mb-2 max-h-[min(420px,60dvh)] origin-bottom overflow-y-auto rounded-[20px] p-1.5 scrollbar-thin",
              hud ? "bg-hud/92 text-hud-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/.1),0_24px_60px_-20px_rgb(0_0_0/.6)] backdrop-blur-xl" : "bg-surface shadow-e3",
            )}
          >
            <PaletteList items={items} active={active} setActive={setActive} run={runItem} draft={draft} hud={hud} askLabel={askLabel} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Naqsha's line, suggestions, or narration */}
      <AnimatePresence initial={false} mode="wait">
        {working ? (
          <motion.div
            key="working"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: ease.out }}
            className="mb-2 flex justify-center"
          >
            <button
              type="button"
              onClick={() => conversation && toggleChat(true)}
              disabled={!conversation}
              className={cn(
                "relative flex max-w-full items-center gap-2.5 overflow-hidden rounded-full py-2 pl-3 pr-4 text-left text-[14px] outline-none focus-visible:shadow-focus",
                hud ? "glass-hud text-hud-ink" : "glass-light text-ink-2",
              )}
              aria-live="polite"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-accent animate-breathe" aria-hidden />
              <span className="truncate">{working.text}</span>
              {working.progress !== undefined && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent/15" aria-hidden>
                  <motion.span className="block h-full bg-accent" animate={{ width: `${Math.round(working.progress * 100)}%` }} transition={{ duration: 0.4, ease: ease.out }} />
                </span>
              )}
            </button>
          </motion.div>
        ) : line || suggestions.length || (phone && pill) ? (
          <motion.div
            key={`line-${line ?? ""}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: ease.out }}
            className="mb-2 flex flex-col items-center gap-2"
          >
            {/* On phones the Next pill sits here, beside Naqsha's line, so Ask keeps the full width. */}
            {(line || (phone && pill)) && (
              <div className={cn("flex max-w-full items-center gap-2", phone && "w-full justify-end")}>
                {line && (
                  <button
                    type="button"
                    onClick={() => conversation && toggleChat()}
                    disabled={!conversation}
                    title={conversation ? "Open the conversation (⌘J)" : undefined}
                    className={cn(
                      "flex max-w-full items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 text-left text-[14px] leading-5 outline-none transition-colors focus-visible:shadow-focus",
                      hud ? "glass-hud text-hud-ink hover:bg-hud/86" : "glass-light text-ink-2 hover:text-ink",
                      phone && "min-w-0 flex-1 rounded-[20px] text-[13px] leading-[18px]",
                    )}
                  >
                    <NaqshaAvatar size={24} />
                    <span className="line-clamp-2 sm:line-clamp-1">{line}</span>
                  </button>
                )}
                {phone && pill}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className={cn("flex max-w-full gap-2", phone ? "no-scrollbar -mx-3 w-[calc(100%+24px)] max-w-none self-stretch overflow-x-auto py-1 pl-3" : "flex-wrap justify-center")}>
                {suggestions.map((s) => (
                  <SuggestionChip key={s} tone={hud ? "hud" : "light"} onClick={() => submit(s)} className={cn("shrink-0", hud ? "" : "shadow-e1")}>
                    {s}
                  </SuggestionChip>
                ))}
                {/* Scrolled to the end, the last chip stops 16px from the edge (end padding is not reliable in a scroller). */}
                {phone && <span aria-hidden className="w-2 shrink-0" />}
              </div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Ask + Next */}
      <div className="flex items-end gap-2">
        <Composer
          ref={field}
          className="min-w-0 flex-1"
          tone={hud ? "hud" : "light"}
          value={draft}
          onChange={(v) => { setDraft(v); setPaletteOpen(true); }}
          onSubmit={submit}
          placeholder={phone ? phonePlaceholder(placeholder, askLabel) : placeholder}
          label={askLabel === "Ask Naqsha" ? "Ask Naqsha" : "Note for the owner"}
          busy={!!working && working.kind !== "intake"}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          leading={<Sparkles className={cn("ml-2 size-4", hud ? "text-hud-accent" : "text-accent")} strokeWidth={1.75} aria-hidden />}
          trailing={phone ? undefined : <Kbd keys={["mod", "K"]} tone={hud ? "hud" : "light"} />}
        />
        {!phone && pill}
      </div>
    </div>
  );
}

function PaletteList({
  items,
  active,
  setActive,
  run,
  draft,
  hud,
  askLabel,
}: {
  items: ({ kind: "ask" } | { kind: "cmd"; cmd: Command })[];
  active: number;
  setActive: (i: number) => void;
  run: (i: number) => void;
  draft: string;
  hud: boolean;
  askLabel: string;
}) {
  const headingClass = cn("px-3 pb-1 pt-2.5 text-[12px] font-medium", hud ? "text-hud-ink-2" : "text-ink-3");
  let lastGroup: string | null = null;
  return (
    <>
      {items.map((it, i) => {
        const group = it.kind === "ask" ? "ask" : it.cmd.group;
        const heading = group !== lastGroup && group !== "ask" ? (group === "go" ? "Go to" : "Do") : null;
        lastGroup = group;
        const selected = i === active;
        return (
          <div key={it.kind === "ask" ? "ask" : it.cmd.id}>
            {heading && <div className={headingClass}>{heading}</div>}
            <button
              type="button"
              role="option"
              aria-selected={selected}
              onPointerMove={() => setActive(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => run(i)}
              className={cn(
                "flex min-h-10 w-full items-center gap-3 rounded-[12px] px-3 text-left text-[14px] outline-none",
                hud ? "text-hud-ink" : "text-ink",
                selected && (hud ? "bg-white/10" : "bg-surface-2"),
              )}
            >
              {it.kind === "ask" ? (
                <>
                  <NaqshaAvatar size={20} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{askLabel}</span>
                    <span className={hud ? "text-hud-ink-2" : "text-ink-3"}> · {draft.trim()}</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{it.cmd.label}</span>
                  {it.cmd.hint && <span className={cn("shrink-0 text-[12px]", hud ? "text-hud-ink-2" : "text-ink-3")}>{it.cmd.hint}</span>}
                </>
              )}
              {selected && <CornerDownLeft className={cn("size-3.5 shrink-0", hud ? "text-hud-ink-2" : "text-ink-3")} aria-hidden />}
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Phones get a short placeholder that fits a 375px dock: the first clause, or a plain "Ask Naqsha". */
function phonePlaceholder(p: string, askLabel: string): string {
  const first = p.split(/, e\.g\.|\?|, like | e\.g\. /)[0].replace(/[…,.\s]+$/, "").trim();
  if (first.length <= 26) return first;
  return askLabel === "Ask Naqsha" ? "Ask Naqsha" : "Leave a note";
}
