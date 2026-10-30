import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/app/lib/utils";

/*
 * Text fields (DESIGN.md §4): 44px, radius 12, surface with a strong line.
 * Focus: accent border plus the focus halo. Error: a fail border and a caption, never a red fill.
 */

const field =
  "w-full rounded-control border bg-surface text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-200 ease-out " +
  "shadow-[0_1px_2px_rgb(74_52_30/.04)] placeholder:text-ink-4 hover:border-ink-4/70 focus:border-accent focus:shadow-focus disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3";

interface FieldProps {
  /** A visible label above the field. */
  label?: ReactNode;
  /** A quiet line under the field. */
  hint?: ReactNode;
  /** Replaces the hint with a fail caption and a fail border. `true`: the border only (the message is elsewhere). */
  error?: ReactNode | boolean;
  /** Icon inside, on the left. */
  leading?: ReactNode;
  /** Element inside, on the right (a button, a unit). */
  trailing?: ReactNode;
  /** Class for the outer wrapper. */
  wrapperClassName?: string;
}

function Frame({ id, label, hint, error, children, className }: { id: string; label?: ReactNode; hint?: ReactNode; error?: ReactNode | boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
          {label}
        </label>
      )}
      {children}
      {error && error !== true ? (
        <p id={`${id}-msg`} className="text-[12px] font-medium leading-4 text-fail" role="alert">
          {error}
        </p>
      ) : hint && !error ? (
        <p id={`${id}-msg`} className="text-[12px] leading-4 text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldProps;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leading, trailing, wrapperClassName, className, id: idProp, ...rest },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Frame id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className="relative flex items-center">
        {leading && <span className="pointer-events-none absolute left-3.5 flex text-ink-3">{leading}</span>}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={(error && error !== true) || (hint && !error) ? `${id}-msg` : undefined}
          className={cn(
            field,
            "h-11 px-3.5",
            leading && "pl-10",
            trailing && "pr-11",
            error ? "border-fail hover:border-fail focus:border-fail focus:shadow-[0_0_0_4px_rgb(180_42_31/.14)]" : "border-line-strong",
            className,
          )}
          {...rest}
        />
        {trailing && <span className="absolute right-1.5 flex items-center">{trailing}</span>}
      </div>
    </Frame>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  Omit<FieldProps, "leading" | "trailing"> & {
    /** Grow with the text up to maxHeight (px). */
    autoGrow?: boolean;
    maxHeight?: number;
  };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, wrapperClassName, className, id: idProp, autoGrow, maxHeight = 240, value, onChange, ...rest },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
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
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(maxHeight, el.scrollHeight + 2)}px`;
  }, [autoGrow, maxHeight, value]);
  return (
    <Frame id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <textarea
        ref={setRef}
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={(error && error !== true) || (hint && !error) ? `${id}-msg` : undefined}
        className={cn(
          field,
          "min-h-11 resize-none px-3.5 py-2.5 leading-[22px]",
          autoGrow && "overflow-y-auto scrollbar-thin",
          error ? "border-fail hover:border-fail focus:border-fail" : "border-line-strong",
          className,
        )}
        {...rest}
      />
    </Frame>
  );
});
