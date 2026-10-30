/** The two pieces every dusk screen is made of: the sky, and the one warm thing you can press. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export function Dusk({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cn("dusk-sky relative min-h-[100dvh] overflow-x-hidden text-dusk-ink", className)}>{children}</div>;
}

export function LampButton({ children, loading, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || loading} aria-disabled={rest.disabled || undefined} aria-busy={loading || undefined}
      className={cn(
        "inline-flex min-h-13 items-center justify-center gap-2 rounded-full bg-lamp px-7 text-[1.0625rem] font-semibold text-dusk-1 shadow-[0_10px_34px_-8px_rgb(255_196_107/.55)] outline-none transition duration-200",
        "hover:bg-lamp-soft focus-visible:ring-4 focus-visible:ring-lamp/40 aria-disabled:bg-dusk-3 aria-disabled:text-dusk-ink-2 aria-disabled:shadow-none",
        className,
      )}>
      {loading ? <span className="size-2 animate-breathe rounded-full bg-dusk-1" aria-hidden /> : null}
      {children}
    </button>
  );
}
