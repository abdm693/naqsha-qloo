import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/app/lib/utils";

/**
 * A media card (DESIGN.md §4): a 4:3 image with no text on it, then a heading and an ink-3 caption.
 * Hover: the image scales 1.02 over 600ms and the frame lifts to e2. Wrap it in a link or pass onClick;
 * `actions` sit to the right of the heading (e.g. a menu button) and never trigger the card.
 */
export function Card({
  media,
  title,
  caption,
  actions,
  onClick,
  href,
  aspect = "4 / 3",
  label,
  className,
  badge,
}: {
  /** An <img> (object-cover) or any drawing. */
  media: ReactNode;
  title: ReactNode;
  caption?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  /** Plain href (for router links, wrap the card instead). */
  href?: string;
  aspect?: string;
  /** Accessible name for the clickable area (defaults to the title text). */
  label?: string;
  className?: string;
  /** A small element over the image's top-left corner (a status dot). Keep it tiny. */
  badge?: ReactNode;
}) {
  const interactive = !!(onClick || href);
  const Media = (
    <div
      className="relative overflow-hidden rounded-card bg-surface-2 shadow-e1 transition-[box-shadow,transform] duration-[600ms] ease-out group-hover/card:-translate-y-1 group-hover/card:shadow-e2"
      style={{ aspectRatio: aspect }}
    >
      <div className="absolute inset-0 transition-transform duration-[600ms] ease-out group-hover/card:scale-[1.02] [&>img]:size-full [&>img]:object-cover">
        {media}
      </div>
      {/* A hairline inside the frame keeps light images from bleeding into the canvas. */}
      <div className="pointer-events-none absolute inset-0 rounded-card ring-1 ring-inset ring-[rgb(74_52_30/.06)]" aria-hidden />
      {badge && <div className="absolute left-3 top-3">{badge}</div>}
    </div>
  );
  const Text = (
    <div className="min-w-0 flex-1">
      <h3 className="truncate text-[16px] font-semibold leading-[22px] tracking-[-.01em] text-ink">{title}</h3>
      {caption && <p className="mt-1 truncate text-[13px] leading-[18px] text-ink-3">{caption}</p>}
    </div>
  );
  return (
    <article className={cn("group/card relative flex min-w-0 flex-col gap-3", className)}>
      {Media}
      <div className="flex items-start gap-2 px-0.5">
        {Text}
        {actions && <div className="relative z-[2] -mr-1.5 -mt-1 flex shrink-0 items-center">{actions}</div>}
      </div>
      {interactive &&
        (href ? (
          <a href={href} aria-label={label} className="absolute inset-0 z-[1] rounded-card outline-none focus-visible:shadow-focus" />
        ) : (
          <button
            type="button"
            onClick={onClick}
            aria-label={label ?? (typeof title === "string" ? title : undefined)}
            className="absolute inset-0 z-[1] rounded-card outline-none focus-visible:shadow-focus"
          />
        ))}
    </article>
  );
}

/** A plain surface: warm white, radius 20, e1. For grouped content on the canvas. */
export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-card bg-surface shadow-e1", className)} {...rest}>
      {children}
    </div>
  );
}
