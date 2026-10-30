import { useId } from "react";
import type { Envelope } from "@contracts/api-types";
import { cn } from "@/app/lib/utils";

/** "Naqsha" in the display serif, then نقشہ in Nastaliq at 70% opacity (DESIGN.md §3). */
export function Wordmark({ className, compact, tone = "ink" }: { className?: string; compact?: boolean; tone?: "ink" | "white" }) {
  return (
    <span className={cn("inline-flex items-baseline gap-2 leading-none", tone === "white" ? "text-white" : "text-ink", className)}>
      <span className="font-display text-[26px] leading-none tracking-[-.01em]">Naqsha</span>
      {!compact && (
        <span lang="ur" dir="rtl" className="font-urdu text-[15px] opacity-70" aria-hidden>
          نقشہ
        </span>
      )}
    </span>
  );
}

/** Thumbnail for a home without imagery yet: the plot to scale with its buildable envelope, or an empty sheet. */
export function PlotSketch({ envelope, width, depth, className }: { envelope?: Envelope | null; width?: number; depth?: number; className?: string }) {
  const W = width || 0;
  const D = depth || 0;
  const pid = useId().replace(/:/g, "");
  if (!W || !D) {
    return (
      <svg viewBox="0 0 160 120" className={cn("h-full w-full", className)} aria-hidden>
        {/* An empty plot, not yet sized: a neutral house mark (no accent "+", which reads as "New home"). */}
        <rect x="56" y="30" width="48" height="60" rx="2" fill="none" stroke="var(--color-line-strong)" strokeWidth="1" strokeDasharray="3 3" />
        <path d="M70 70V59l10-8 10 8v11z" fill="none" stroke="var(--color-ink-4)" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M77 70v-6h6v6" fill="none" stroke="var(--color-ink-4)" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  const scale = Math.min(110 / W, 84 / D);
  const w = W * scale;
  const h = D * scale;
  const x0 = (160 - w) / 2;
  const y0 = (120 - h) / 2 - 4;
  const r = envelope?.buildable_rect;
  return (
    <svg viewBox="0 0 160 120" className={cn("h-full w-full", className)} aria-hidden>
      <defs>
        <pattern id={`h${pid}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0V4" stroke="var(--color-line-strong)" strokeWidth="0.8" />
        </pattern>
      </defs>
      <rect x={x0} y={y0} width={w} height={h} fill={`url(#h${pid})`} stroke="var(--color-ink-2)" strokeWidth="0.9" />
      {r && (
        <rect
          x={x0 + r.x * scale}
          y={y0 + (D - r.y - r.d) * scale}
          width={r.w * scale}
          height={r.d * scale}
          fill="var(--color-surface)"
          stroke="var(--color-accent)"
          strokeWidth="0.9"
          strokeDasharray="2.5 1.5"
        />
      )}
      <path d={`M${x0 - 8} ${y0 + h + 6}H${x0 + w + 8}`} stroke="var(--color-ink-4)" strokeWidth="0.75" />
      <text x={80} y={y0 + h + 14} textAnchor="middle" fontSize="7" fill="var(--color-ink-3)" fontFamily="Geist Mono, monospace">
        {W}′ × {D}′
      </text>
    </svg>
  );
}
