/**
 * The setup conversation: Naqsha's turns (with the understood card and the question's widget), the person's turns,
 * a streaming draft and a calm "thinking" line, and suggestion chips under the latest turn.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Brief, ChatMessage, Envelope } from "@contracts/api-types";
import { cn } from "@/app/lib/utils";
import { Chip, EASE_OUT } from "@/app/design/kit";
import { defaultProgram } from "./catalogue";
import { UnderstoodCard } from "./Understood";
import { ChipsWidget, FloorsWidget, MapWidget, PlotWidget, RoofWidget, StyleWidget, roofChips, type Send } from "./widgets";

const THINKING = ["Reading what you said", "Checking it against the rules", "Updating your brief"];
const THINKING_FIRST = ["Opening a fresh brief"];

export function NaqshaMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-ink text-white", className)} aria-hidden>
      <span className="font-urdu text-[13px] leading-none" style={{ marginTop: 3 }} lang="ur">
        ن
      </span>
    </span>
  );
}

/**
 * Once the home has a version, the setup turns no longer point at "Show me concepts" (that step is done): the
 * clause that says so is dropped from what Naqsha said.
 */
export function afterDesign(text: string): string {
  return text
    .replace(/[;,]?\s*(?:I will|I'll) sketch four exterior[^.;]*?when you tap Show me concepts\./gi, ".")
    .replace(/[;,]?\s*when you tap Show me concepts,[^.]*\./gi, ".")
    .replace(/\s*When you're ready, tap Show me concepts\./gi, "")
    .replace(/\.\./g, ".")
    .trim();
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className={cn("text-body-lg text-ink", i > 0 && "mt-2")}>
          {p}
        </p>
      ))}
    </>
  );
}

export function Conversation({
  messages,
  draft,
  busy,
  complete,
  brief,
  envelope,
  send,
  onSuggestion,
  onPreferences,
  failed,
  onRetry,
  className,
  footer,
  designed,
}: {
  messages: ChatMessage[];
  draft: string | null;
  busy: boolean;
  complete: boolean;
  brief: Brief | null;
  envelope: Envelope | null;
  send: Send;
  onSuggestion: (s: string) => void;
  /** Save the brief's preferences directly. */
  onPreferences: (prefs: string[]) => void;
  /** The last turn didn't get a reply. */
  failed?: boolean;
  onRetry?: () => void;
  className?: string;
  footer?: ReactNode;
  /** The home already has a version: no pointers to "Show me concepts". */
  designed?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = messages[messages.length - 1];
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant"), [messages]);
  const active = !busy && last?.role === "assistant" ? last : undefined;
  const latestUnderstood = useMemo(() => [...messages].reverse().find((m) => m.understood)?.id, [messages]);
  const skip = () => send({ action: "skip_question" });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, draft, busy]);

  return (
    <div
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      }}
      className={cn("min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:thin]", className)}
    >
      <div className="px-5 pb-6 pt-5">
        {messages.map((m) =>
          m.role === "user" ? (
            <motion.div key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE_OUT }} className="mt-5 flex justify-end">
              <p className="max-w-[85%] rounded-[18px] rounded-br-md bg-ink px-3.5 py-2 text-body text-white">{m.text}</p>
            </motion.div>
          ) : (
            <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT }} className="mt-5 first:mt-0">
              <div className="flex gap-3">
                <NaqshaMark className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <Paragraphs text={designed ? afterDesign(m.text) : m.text} />
                </div>
              </div>
              {m.understood && (
                <UnderstoodCard
                  m={m}
                  brief={brief}
                  envelope={envelope}
                  interactive={m.id === latestUnderstood}
                  onCorrect={(before, after) => send({ message: `Correction: ${after}, not ${before.toLowerCase()}.` }, `${after}, not ${before.toLowerCase()}`)}
                  onRemoveAssumption={(a) => send({ message: `Don't assume: ${a.toLowerCase()}.` }, `Don't assume ${a.toLowerCase()}`)}
                  onPreferences={onPreferences}
                />
              )}
              {active?.id === m.id && !complete && <Widget m={m} brief={brief} envelope={envelope} send={send} skip={skip} />}
            </motion.div>
          ),
        )}

        {busy && (draft ? <Draft text={draft} /> : <Thinking hints={messages.length ? THINKING : THINKING_FIRST} />)}

        {!busy && failed && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-5 flex items-center gap-3" role="status">
            <NaqshaMark />
            <span className="text-[14px] text-ink-2">That didn't go through.</span>
            {onRetry && (
              <Chip tone="suggestion" onClick={onRetry}>
                Try again
              </Chip>
            )}
          </motion.div>
        )}

        {!busy && lastAssistant?.suggestions?.length && last?.id === lastAssistant.id ? (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, delay: 0.1 }} className="mt-4 flex flex-wrap gap-2 pl-10">
            {lastAssistant.suggestions.filter((s) => !(complete && /^show me (the )?concepts?$/i.test(s.trim()))).slice(0, 3).map((s) => (
              <Chip key={s} tone="suggestion" onClick={() => onSuggestion(s)}>
                {s}
              </Chip>
            ))}
          </motion.div>
        ) : null}
        {footer}
      </div>
    </div>
  );
}

function Widget({ m, brief, envelope, send, skip }: { m: ChatMessage; brief: Brief | null; envelope: Envelope | null; send: Send; skip: () => void }) {
  const initial = useMemo(() => defaultProgram(brief, envelope), [m.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const wrap = (node: ReactNode) => (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: EASE_OUT, delay: 0.08 }} className="mt-3">
      {node}
    </motion.div>
  );
  if (m.input === "floors" || m.input === "rooms") return wrap(<FloorsWidget brief={brief} envelope={envelope} initial={initial} onSend={send} onSkip={skip} />);
  if (m.input === "plot") return wrap(<PlotWidget brief={brief} onSend={send} onSkip={skip} />);
  if (m.input === "style") return wrap(<StyleWidget chips={m.chips} current={brief?.style} onSend={send} onSkip={skip} />);
  if (m.input === "map") return wrap(<MapWidget chips={m.chips} onSend={send} onSkip={skip} />);
  if (m.field === "roof" || roofChips(m.chips)) return wrap(<RoofWidget brief={brief} envelope={envelope} onSend={send} onSkip={skip} />);
  if (m.chips?.length) return wrap(<ChipsWidget chips={m.chips} multi={m.multi} onSend={send} onSkip={m.allow_skip ? skip : undefined} />);
  return null;
}

function Thinking({ hints }: { hints: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(x + 1, hints.length - 1)), 2200);
    return () => clearInterval(t);
  }, [hints.length]);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-5 flex items-center gap-3" aria-live="polite">
      <NaqshaMark />
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((k) => (
          <motion.span key={k} className="size-1.5 rounded-full bg-ink-3" animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1.2, repeat: Infinity, delay: k * 0.16 }} />
        ))}
      </span>
      <AnimatePresence mode="wait">
        <motion.span key={i} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.2 }} className="text-[14px] text-ink-3">
          {hints[i]}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

function Draft({ text }: { text: string }) {
  return (
    <div className="mt-5 flex gap-3">
      <NaqshaMark className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <Paragraphs text={text} />
      </div>
    </div>
  );
}
