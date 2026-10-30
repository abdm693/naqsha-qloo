/**
 * The plot, to scale (DESIGN.md "Brief"): the road in front, ghosted neighbours, the accent LDA envelope and
 * its setbacks, the north arrow, and on a corner plot the second road and the splayed corner. The envelope
 * springs to size as the plot changes.
 */
import { useId } from "react";
import { motion } from "motion/react";
import type { Envelope } from "@contracts/api-types";
import { feetInches, num } from "@/app/lib/utils";
import { northRotation } from "@/app/plan/FloorPlan";

const SPRING = { type: "spring" as const, stiffness: 380, damping: 34 };
const INK = "#111113";
const INK3 = "#6E6E73";
const ACCENT = "#2747F5";
const SANS = "Geist, ui-sans-serif, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, monospace";

/** Corner splay (ft) LDA asks for: 5 ft up to 10 marla, 10 ft above. */
export function splayFt(width: number, depth: number) {
  return (width * depth) / 225 <= 10.15 ? 5 : 10;
}

export function PlotCanvas({
  width,
  depth,
  envelope,
  corner,
  facing,
  className,
  faint,
  compact,
}: {
  width: number;
  depth: number;
  envelope: Envelope | null;
  corner?: boolean;
  facing?: string;
  className?: string;
  /** Drawn behind something else (e.g. while the plan is being laid out). */
  faint?: boolean;
  /** Smaller type for small canvases. */
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const W = Math.max(10, width || 35);
  const D = Math.max(20, depth || 65);
  // World frame in feet: plot at (0,0)-(W,D), road at y > D (bottom of the drawing), neighbours left/right/behind.
  const road = 30;
  const gap = 0;
  const nb = Math.min(W * 0.9, 40);
  const vx0 = -nb * 0.55;
  const vx1 = W + (corner ? road + 6 : nb * 0.55);
  const vy0 = -D * 0.28;
  const vy1 = D + road + 4;
  const vw = vx1 - vx0;
  const vh = vy1 - vy0;
  const s = 1; // feet are the user unit
  const k = vw / 340; // px-ish per ft for text sizing (viewBox is ~340 wide at 1x)
  const fs = (n: number) => n * k * (compact ? 1.1 : 1);

  const sb = envelope?.setbacks_ft ?? { front: 0, rear: 0, left: 0, right: 0 };
  const r = envelope?.buildable_rect ?? { x: 0, y: 0, w: W, d: D };
  // Plan y runs from the road (0) to the back (D). Drawing y runs down, with the road at the bottom.
  const Y = (y: number) => D - y;
  const sp = corner ? splayFt(W, D) : 0;
  const perFloor = envelope ? Math.min(r.w * r.d, envelope.max_ground_coverage_sqft) : 0;
  const plotPath = sp
    ? `M0 0H${W}V${D - sp}L${W - sp} ${D}H0Z`
    : `M0 0H${W}V${D}H0Z`;

  return (
    <svg viewBox={`${vx0} ${vy0} ${vw} ${vh}`} className={className} role="img" aria-label={`Plot ${num(W, 1)} by ${num(D, 1)} feet${corner ? ", corner" : ""}, with the area you can build on`} style={{ opacity: faint ? 0.55 : 1 }}>
      <defs>
        <pattern id={`n-${id}`} width={3 * s} height={3 * s} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d={`M0 0V${3 * s}`} stroke="rgb(17 17 19 / 0.06)" strokeWidth={0.5 * k} />
        </pattern>
        <pattern id={`sb-${id}`} width={2} height={2} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0V2" stroke="rgb(39 71 245 / 0.14)" strokeWidth={0.45 * k} />
        </pattern>
      </defs>

      {/* Road(s) */}
      <rect x={vx0} y={D + gap} width={vw} height={road} fill="#EEEEEA" />
      <line x1={vx0} y1={D + road / 2} x2={vx1} y2={D + road / 2} stroke="#CFCFC8" strokeWidth={0.6 * k} strokeDasharray={`${6 * k} ${5 * k}`} />
      <text x={W / 2} y={D + road / 2 + fs(4)} textAnchor="middle" fontSize={fs(11)} fill={INK3} fontWeight={500} style={{ fontFamily: SANS }}>
        Road
      </text>
      {corner && (
        <>
          <rect x={W + gap} y={vy0} width={road} height={vh} fill="#EEEEEA" />
          <line x1={W + road / 2} y1={vy0} x2={W + road / 2} y2={D} stroke="#CFCFC8" strokeWidth={0.6 * k} strokeDasharray={`${6 * k} ${5 * k}`} />
          <text transform={`translate(${W + road / 2 + fs(4)} ${D / 2}) rotate(-90)`} textAnchor="middle" fontSize={fs(11)} fill={INK3} fontWeight={500} style={{ fontFamily: SANS }}>
            Side road
          </text>
        </>
      )}

      {/* Ghosted neighbours */}
      <g fill={`url(#n-${id})`} stroke="rgb(17 17 19 / 0.12)" strokeWidth={0.6 * k}>
        <rect x={vx0 - 1} y={0} width={-vx0 - 0.6} height={D} />
        {!corner && <rect x={W + 0.6} y={0} width={vx1 - W} height={D} />}
        <rect x={0} y={vy0 - 1} width={W} height={-vy0 + 0.4} />
      </g>

      {/* Plot */}
      <motion.path initial={false} animate={{ d: plotPath }} transition={SPRING} fill="#fff" stroke="none" />
      {envelope && (
        <motion.path initial={false} animate={{ d: plotPath }} transition={SPRING} fill={`url(#sb-${id})`} stroke="none" />
      )}

      {/* Buildable envelope */}
      {envelope && (
        <motion.rect
          initial={false}
          animate={{ x: r.x, y: Y(r.y + r.d), width: r.w, height: r.d }}
          transition={SPRING}
          fill="#fff"
          stroke={ACCENT}
          strokeWidth={1.1 * k}
          strokeDasharray={`${5 * k} ${3 * k}`}
        />
      )}
      <motion.path initial={false} animate={{ d: plotPath }} transition={SPRING} fill="none" stroke={INK} strokeWidth={1.3 * k} strokeLinejoin="round" />

      {/* Setback labels */}
      {envelope && (
        <g fontSize={fs(9.5)} fill={ACCENT} fontWeight={500} textAnchor="middle" style={{ fontFamily: MONO }}>
          {sb.front > 0 && <text x={W / 2} y={Y(sb.front / 2) + fs(3.3)}>{feetInches(sb.front)}</text>}
          {sb.rear > 0 && <text x={W / 2} y={Y(D - sb.rear / 2) + fs(3.3)}>{feetInches(sb.rear)}</text>}
          {sb.left > 0 && sb.left * 1 > fs(8) && <text transform={`translate(${sb.left / 2 + fs(3.3)} ${D / 2}) rotate(-90)`}>{feetInches(sb.left)}</text>}
          {sb.right > 0 && sb.right * 1 > fs(8) && <text transform={`translate(${W - sb.right / 2 + fs(3.3)} ${D / 2}) rotate(-90)`}>{feetInches(sb.right)}</text>}
        </g>
      )}

      {/* Envelope caption, sized to sit inside the buildable rectangle */}
      {envelope && (() => {
        const line = `${num(perFloor)} sq ft a floor`;
        const t = Math.min(1, (r.w * 0.86) / (line.length * 0.62 * fs(10.5)), (r.d * 0.7) / fs(40));
        if (t < 0.55) return null;
        const f = (n: number) => fs(n) * t;
        return (
          <g textAnchor="middle" style={{ fontFamily: SANS }}>
            <text x={r.x + r.w / 2} y={Y(r.y + r.d / 2) - f(4)} fontSize={f(12)} fontWeight={500} fill={INK}>
              Buildable
            </text>
            <text x={r.x + r.w / 2} y={Y(r.y + r.d / 2) + f(10)} fontSize={f(10.5)} fill={INK3} style={{ fontFamily: MONO }}>
              {feetInches(r.w)} × {feetInches(r.d)}
            </text>
            <text x={r.x + r.w / 2} y={Y(r.y + r.d / 2) + f(23)} fontSize={f(10.5)} fill={INK3} style={{ fontFamily: MONO }}>
              {line}
            </text>
          </g>
        );
      })()}

      {/* Splay */}
      {sp > 0 && (
        <text x={W - sp / 2 + fs(2)} y={D - sp / 2 + fs(12)} fontSize={fs(9)} fill={INK3} textAnchor="start" style={{ fontFamily: SANS }}>
          {`${sp}′ splay`}
        </text>
      )}

      {/* Overall dimensions */}
      <g style={{ fontFamily: MONO }} fontSize={fs(10.5)} fill={INK} fontWeight={500} textAnchor="middle">
        <line x1={0} y1={-fs(7)} x2={W} y2={-fs(7)} stroke={INK3} strokeWidth={0.5 * k} />
        <line x1={0} y1={-fs(10)} x2={0} y2={-fs(4)} stroke={INK3} strokeWidth={0.5 * k} />
        <line x1={W} y1={-fs(10)} x2={W} y2={-fs(4)} stroke={INK3} strokeWidth={0.5 * k} />
        <rect x={W / 2 - fs(18)} y={-fs(13)} width={fs(36)} height={fs(12)} fill="#F6F6F3" />
        <text x={W / 2} y={-fs(4)}>{feetInches(W)}</text>
        <line x1={-fs(12)} y1={0} x2={-fs(12)} y2={D} stroke={INK3} strokeWidth={0.5 * k} />
        <line x1={-fs(15)} y1={0} x2={-fs(4)} y2={0} stroke={INK3} strokeWidth={0.5 * k} />
        <line x1={-fs(15)} y1={D} x2={-fs(4)} y2={D} stroke={INK3} strokeWidth={0.5 * k} />
        <g transform={`translate(${-fs(12)} ${D / 2}) rotate(-90)`}>
          <rect x={-fs(18)} y={-fs(6.5)} width={fs(36)} height={fs(12)} fill="#F6F6F3" />
          <text y={fs(3.5)}>{feetInches(D)}</text>
        </g>
      </g>

      {/* North */}
      <g transform={`translate(${vx1 - fs(16)} ${vy0 + fs(18)})`}>
        <circle r={fs(9)} fill="#fff" stroke={INK} strokeWidth={0.6 * k} />
        <g transform={`rotate(${northRotation(facing)})`}>
          <path d={`M0 ${-fs(7)}L${fs(3.6)} ${fs(4.6)}L0 ${fs(2.4)}Z`} fill={INK} />
          <path d={`M0 ${-fs(7)}L${-fs(3.6)} ${fs(4.6)}L0 ${fs(2.4)}Z`} fill="#fff" stroke={INK} strokeWidth={0.4 * k} />
        </g>
        <text y={fs(21)} textAnchor="middle" fontSize={fs(10)} fontWeight={600} fill={INK} style={{ fontFamily: SANS }}>
          N
        </text>
      </g>
    </svg>
  );
}
