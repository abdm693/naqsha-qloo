import { forwardRef, useCallback, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { spring } from "./motion";

/**
 * The message field (DESIGN.md §4 "Composer"): 52px, growing to 160px, radius 26. A 36px accent send button
 * scales in from 0.6 once there is text. Enter sends, Shift+Enter adds a line.
 */
export const Composer = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    onSubmit: (text: string) => void;
    placeholder?: string;
    disabled?: boolean;
    /** Naqsha is busy: sending is held, typing is not. */
    busy?: boolean;
    /** Left of the text (e.g. a "+" button). */
    leading?: ReactNode;
    /** Right of the text, before send (e.g. a ⌘K hint). Hidden once there is text. */
    trailing?: ReactNode;
    tone?: "light" | "hud";
    label?: string;
    className?: string;
    onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    maxHeight?: number;
  }
>(function Composer(
  { value, onChange, onSubmit, placeholder, disabled, busy, leading, trailing, tone = "light", label, className, onKeyDown, onFocus, onBlur, maxHeight = 160 },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(maxHeight - 16, Math.max(36, el.scrollHeight))}px`;
  }, [value, maxHeight]);

  const has = value.trim().length > 0;
  const send = () => {
    if (!has || disabled || busy) return;
    onSubmit(value.trim());
  };
  const hud = tone === "hud";

  return (
    <div
      className={cn(
        "nq-field flex min-h-[52px] items-end gap-1.5 rounded-[26px] p-2 transition-[box-shadow,border-color] duration-200",
        hud
          ? "glass-hud focus-within:shadow-[inset_0_0_0_1px_rgb(242_184_219/.6)]"
          : "border border-line-strong bg-surface shadow-e1 hover:border-ink-4/60 focus-within:border-accent focus-within:shadow-focus",
        disabled && "opacity-60",
        className,
      )}
    >
      {leading && <div className="flex h-9 shrink-0 items-center self-end">{leading}</div>}
      <textarea
        ref={setRef}
        rows={1}
        value={value}
        disabled={disabled}
        aria-label={label ?? placeholder}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className={cn(
          "min-w-0 flex-1 resize-none self-center bg-transparent px-2.5 py-[7px] text-[15px] leading-[22px] outline-none scrollbar-thin",
          hud ? "text-hud-ink placeholder:text-hud-ink-2" : "text-ink placeholder:text-ink-4",
        )}
      />
      {!has && trailing && <div className="flex h-9 shrink-0 items-center self-end pr-1">{trailing}</div>}
      <AnimatePresence initial={false}>
        {has && (
          <motion.button
            type="button"
            aria-label="Send"
            onClick={send}
            disabled={disabled || busy}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0, transition: { duration: 0.12 } }}
            transition={spring}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-white outline-none transition-colors hover:bg-accent-press focus-visible:shadow-focus disabled:opacity-50"
          >
            {busy ? <span className="size-1.5 rounded-full bg-white animate-breathe" /> : <ArrowUp className="size-[18px]" strokeWidth={2} />}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
});
