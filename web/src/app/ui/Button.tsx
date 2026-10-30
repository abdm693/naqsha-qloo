import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/app/lib/utils";
import { Tooltip } from "./Tooltip";

/*
 * Pill buttons (DESIGN.md §4). primary: accent, at most one on screen. secondary: surface with a strong line.
 * quiet: transparent ink-2. ink: the landing's Portal only. hud: glass over 3D. danger: confirm a delete.
 * Legacy names still work: outline → secondary, ghost → quiet, glass → hud.
 */
const base =
  "group hit-44 relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full border font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-200 ease-out " +
  "active:scale-[.97] active:duration-[120ms] outline-none focus-visible:border-accent focus-visible:shadow-focus " +
  "disabled:pointer-events-none disabled:opacity-45 aria-busy:pointer-events-none";

const variants = {
  // Filled buttons carry a faint top highlight and a warm contact shadow, so they sit on the page like a pressed tile.
  primary:
    "border-transparent bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/.14),0_1px_2px_rgb(60_20_50/.20),0_8px_20px_-10px_rgb(107_42_94/.55)] " +
    "hover:bg-accent-press hover:shadow-[inset_0_1px_0_rgb(255_255_255/.12),0_1px_2px_rgb(60_20_50/.24),0_12px_26px_-12px_rgb(107_42_94/.65)] focus-visible:border-accent-press",
  secondary: "border-line-strong bg-surface text-ink shadow-[0_1px_2px_rgb(74_52_30/.06)] hover:border-ink-4/70 hover:bg-[#FBF7F1]",
  quiet: "border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink",
  ink: "border-transparent bg-ink text-white shadow-[inset_0_1px_0_rgb(255_255_255/.10),0_1px_2px_rgb(30_22_16/.25)] hover:bg-[#2E2621]",
  hud: "glass-hud border-transparent hover:bg-hud/86 focus-visible:border-hud-accent",
  danger: "border-transparent bg-fail text-white hover:bg-[#981F16]",
} as const;

const button = cva(base, {
  variants: {
    variant: { ...variants, outline: variants.secondary, ghost: variants.quiet, glass: variants.hud },
    size: {
      xs: "h-7 px-3 text-[12px]",
      sm: "h-8 px-3.5 text-[13px]",
      md: "h-10 px-[18px] text-[15px]",
      lg: "h-12 px-[22px] text-[16px]",
      xl: "h-14 px-7 text-[17px]",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export type ButtonVariant = NonNullable<VariantProps<typeof button>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof button>["size"]>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  /** Shows a breathing dot in place of the icon and blocks clicks. */
  loading?: boolean;
  icon?: ReactNode;
  /** Trailing icon (an arrow, a chevron). It nudges right on hover. */
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, icon, trailing, children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="size-1.5 rounded-full bg-current animate-breathe" aria-hidden /> : icon}
      {children}
      {trailing && <span className="-mr-1 inline-flex transition-transform duration-300 ease-out group-hover:translate-x-0.5">{trailing}</span>}
    </button>
  );
});

/** Class names for a link styled as a button (e.g. a react-router <Link>). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return cn(button({ variant, size }), className);
}

// ── Icon button ───────────────────────────────────────────────────────────────────────────────────────

const iconButton = cva(
  "hit-44 relative inline-grid shrink-0 place-items-center rounded-full border outline-none " +
    "transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-[160ms] ease-out active:scale-[.94] " +
    "focus-visible:border-accent focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        quiet: "border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink",
        secondary: "border-line-strong bg-surface text-ink hover:bg-[#FBF7F1]",
        primary: "border-transparent bg-accent text-white hover:bg-accent-press",
        hud: "glass-hud border-transparent hover:bg-hud/86 focus-visible:border-hud-accent",
        "hud-quiet": "border-transparent text-hud-ink-2 hover:bg-white/10 hover:text-hud-ink",
      },
      size: { xs: "size-7", sm: "size-8", md: "size-10", lg: "size-11" },
    },
    defaultVariants: { variant: "quiet", size: "md" },
  },
);

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof iconButton> {
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  /** Keys for the tooltip, e.g. ["mod", "K"]. */
  shortcut?: string[];
  /** Show the label as a tooltip on hover (default true). */
  tooltip?: boolean;
  /** Legacy: "dark" = quiet on a dark surface. */
  tone?: "light" | "dark";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, shortcut, tooltip = true, tone, variant, size, children, type = "button", ...rest },
  ref,
) {
  const v = variant ?? (tone === "dark" ? "hud-quiet" : "quiet");
  const s = size ?? (tone ? "sm" : "md");
  const btn = (
    <button ref={ref} type={type} aria-label={label} className={cn(iconButton({ variant: v, size: s }), className)} {...rest}>
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} shortcut={shortcut}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
});
