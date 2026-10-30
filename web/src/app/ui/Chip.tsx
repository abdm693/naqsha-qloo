import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/app/lib/utils";

/*
 * Chips (DESIGN.md §4): 32px, radius 10, 13px/500.
 * - Chip: a choice. surface-2, or accent-soft with accent text and an accent line when selected.
 * - SuggestionChip: a prompt; a tap sends it. Secondary look.
 * - FactToken: what Naqsha understood. Ink for "you said", ink-3 with a dotted underline for "assumed".
 * - StatusChip: a 6px dot plus text.
 */

const chipBase =
  "hit-44 relative inline-flex shrink-0 select-none items-center gap-1.5 rounded-chip border text-left text-[13px] font-medium leading-none outline-none " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out active:scale-[.97] " +
  "focus-visible:border-accent focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-45";

export function Chip({
  selected,
  onClick,
  children,
  hint,
  icon,
  disabled,
  size = "md",
  multi,
  className,
  title,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** A quiet second part, e.g. "Most popular". */
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Shows a checkbox (multi-select groups). */
  multi?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={title}
      className={cn(
        chipBase,
        size === "md" ? "min-h-8 px-3 py-1.5" : "min-h-7 px-2.5 py-1 text-[12px]",
        selected
          ? "border-accent-line bg-accent-soft text-accent"
          : "border-transparent bg-surface-2 text-ink hover:border-line-strong hover:bg-surface-3",
        className,
      )}
    >
      {multi && (
        <span
          className={cn(
            "grid size-3.5 place-items-center rounded-[4px] transition-colors",
            selected ? "bg-accent text-white" : "bg-surface shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
          )}
        >
          {selected && <Check className="size-2.5" strokeWidth={3} />}
        </span>
      )}
      {icon}
      <span>{children}</span>
      {hint && <span className={cn("font-normal", selected ? "text-accent/75" : "text-ink-3")}>{hint}</span>}
    </button>
  );
}

export function SuggestionChip({
  children,
  onClick,
  disabled,
  tone = "light",
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "light" | "hud";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        chipBase,
        "min-h-8 px-3 py-1.5",
        tone === "light"
          ? "border-line-strong bg-surface text-ink hover:border-ink-4/70 hover:bg-[#FBF7F1]"
          : "border-white/12 bg-white/8 text-hud-ink hover:bg-white/14",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function FactToken({
  children,
  assumed,
  onClick,
  onRemove,
  className,
}: {
  children: ReactNode;
  /** Naqsha decided this itself: ink-3 with a dotted underline. */
  assumed?: boolean;
  /** Tap to edit. */
  onClick?: () => void;
  /** Shows a × that removes the fact. */
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center rounded-chip bg-surface-2 text-[13px] font-medium",
        assumed ? "text-ink-3" : "text-ink",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        title={assumed ? "Assumed. Tap to change." : onClick ? "Tap to change" : undefined}
        className={cn(
          "rounded-chip px-3 py-1.5 outline-none focus-visible:shadow-focus disabled:cursor-default",
          onRemove && "pr-1.5",
          assumed && "underline decoration-dotted decoration-1 underline-offset-[5px] decoration-ink-4",
        )}
      >
        {children}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="mr-1 grid size-6 place-items-center rounded-full text-ink-3 outline-none transition-colors hover:bg-surface-3 hover:text-ink focus-visible:shadow-focus"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      )}
    </span>
  );
}

export type StatusTone = "neutral" | "accent" | "pass" | "warn" | "fail" | "progress" | "dark";

const dot: Record<StatusTone, string> = {
  neutral: "bg-ink-4",
  accent: "bg-accent",
  pass: "bg-pass",
  warn: "bg-warn",
  fail: "bg-fail",
  progress: "bg-accent animate-breathe",
  dark: "bg-hud-ink",
};
const text: Record<StatusTone, string> = {
  neutral: "text-ink-2",
  accent: "text-accent",
  pass: "text-pass",
  warn: "text-warn",
  fail: "text-fail",
  progress: "text-ink-2",
  dark: "text-hud-ink",
};
const fill: Record<StatusTone, string> = {
  neutral: "bg-surface-2",
  accent: "bg-accent-soft",
  pass: "bg-pass-soft",
  warn: "bg-warn-soft",
  fail: "bg-fail-soft",
  progress: "bg-surface-2",
  dark: "bg-white/10",
};

/** A status: a 6px dot plus text. `filled` puts it on a soft tinted chip; otherwise it is bare text. */
export function StatusChip({
  tone = "neutral",
  children,
  filled = true,
  dot: showDot = true,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  filled?: boolean;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium leading-none",
        filled && cn("h-6 rounded-full px-2.5", fill[tone]),
        text[tone],
        className,
      )}
    >
      {showDot && <span className={cn("size-1.5 shrink-0 rounded-full", dot[tone])} />}
      {children}
    </span>
  );
}
