/**
 * The landing's house-under-construction animation (DESIGN.md §6 "Landing"), an 8-second timeline that plays once
 * when it comes into view: the plot and its LDA envelope, the plinth, columns rising under a crane, walls floor by
 * floor (hatched, then solid), the stair, railings, solar frame and tank, windows and landscaping. Then the drawing
 * wipes into the rendered home, which turns to night and holds. Hover (or focus) offers Replay.
 *
 * The drawing is an elevation on the same 900 × 491 grid as the render, so the wipe lands line for line.
 * Reduced motion shows the final frame.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { usePhone, useReducedMotion } from "@/app/lib/hooks";

const W = 900;
const H = 491;
const GROUND = 412;

// Timeline (seconds)
const T = {
  ground: 0,
  envelope: 0.8,
  plinth: 1.4,
  columns: 2.0,
  walls: 2.4,
  roof: 4.4,
  glaze: 5.2,
  wipe: 5.8,
  night: 6.8,
  end: 8.0,
};

const CAPTIONS: [number, string][] = [
  [T.ground, "Plot 35′ × 65′ · mid‑row"],
  [T.plinth, "Structure, floor by floor"],
  [T.roof, "Stair to the roof · clear for solar"],
  [T.wipe, "The same home, rendered"],
  [T.night, "By night"],
];

type Anim = "draw" | "fade" | "rise" | "pop" | "fill";

/** Inline animation style: name, duration, delay (s). Paused until the frame is in view. */
function a(kind: Anim, delay: number, dur = 0.5, ease = "cubic-bezier(.22,1,.36,1)"): CSSProperties {
  return { animation: `nqc-${kind} ${dur}s ${ease} ${delay}s both` };
}

export function Construction({
  className,
  counts,
  onDone,
  hideReplay,
}: {
  className?: string;
  /** The 10 marla sample's own check counts. */
  counts?: { lda: number; livable: number } | null;
  /** Called once the timeline has finished (the night frame is showing). */
  onDone?: () => void;
  /** The hero hands over to the 3D film when the drawing ends, so it has no Replay button. */
  hideReplay?: boolean;
}) {
  const reduced = useReducedMotion();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const phone = usePhone();
  const root = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0); // 0 = waiting to be seen
  const [now, setNow] = useState(0);
  const [done, setDone] = useState(false);

  // Start when a quarter of the frame is visible (at 1440 × 900 its top sits in the first screen, so it plays
  // without a scroll).
  useEffect(() => {
    if (reduced) return;
    const el = root.current;
    if (!el) return;
    // Already on screen when the page opens: start now.
    const r = el.getBoundingClientRect();
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (r.height && visible / r.height >= 0.25) {
      setRun((x) => (x === 0 ? 1 : x));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRun((r) => (r === 0 ? 1 : r));
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  // A clock for the captions and the count-up.
  useEffect(() => {
    if (!run) return;
    setDone(false);
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const s = (t - start) / 1000;
      // rAF stamps can run a hair before the start: never a negative clock (no "Plot -2′ × -3′" on Replay).
      setNow(Math.max(0, s));
      if (s < T.end + 0.2) raf = requestAnimationFrame(tick);
      else setDone(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]);

  useEffect(() => {
    if (done) onDoneRef.current?.();
  }, [done]);

  const time = reduced ? T.end + 1 : now;
  const caption = [...CAPTIONS].reverse().find(([t]) => time >= t)?.[1] ?? CAPTIONS[0][1];
  const k = Math.min(1, Math.max(0, time / 0.8));
  const eased = 1 - Math.pow(1 - k, 3);
  const dims = `${Math.round(35 * eased)}′ × ${Math.round(65 * eased)}′`;

  // Phone: crop to the house, its level marks and the crane (x 96–886) so it stays big and nothing is cut at the
  // frame's edge; the photo is cropped identically.
  const vx = phone ? 96 : 0;
  const vw = phone ? 790 : W;
  const imgStyle: CSSProperties = { width: `${(W / vw) * 100}%`, left: `${(-vx / vw) * 100}%` };

  return (
    <div
      ref={root}
      className={cn("group/cons relative overflow-hidden rounded-media bg-surface shadow-e2", className)}
      style={{ aspectRatio: `${vw} / ${H}` }}
    >
      <style>{KEYFRAMES}</style>
      {reduced ? (
        <img src="/landing/home-night.jpg" alt="A two-storey modern home in Lahore at night, designed with Naqsha" className="absolute top-0 h-full max-w-none" style={imgStyle} />
      ) : (
        <div key={run} className={cn("absolute inset-0", run ? "nqc-play" : "nqc-wait")}>
          <svg viewBox={`${vx} 0 ${vw} ${H}`} className="absolute inset-0 size-full" role="img" aria-label="A house being drawn: plot, structure, walls, roof and garden">
            <Drawing phone={phone} />
          </svg>
          <img src="/landing/home-day.jpg" alt="" aria-hidden className="nqc-photo absolute top-0 h-full max-w-none" style={{ ...imgStyle, ...a("fill", T.wipe, 1.0, "cubic-bezier(.65,0,.35,1)") }} />
          <img
            src="/landing/home-night.jpg"
            alt="The finished home at night"
            className="absolute top-0 h-full max-w-none"
            style={{ ...imgStyle, ...a("fade", T.night, 1.2, "cubic-bezier(.22,1,.36,1)") }}
          />
        </div>
      )}
      {/* Before it plays: a pencil poster of the plot and the elevation, so the frame is never blank. It fades as the
          ink draws over it. */}
      {!reduced && (
        <svg
          viewBox={`${vx} 0 ${vw} ${H}`}
          className={cn("pointer-events-none absolute inset-0 size-full transition-opacity duration-[1400ms] ease-out", run ? "opacity-0" : "opacity-100")}
          aria-hidden
        >
          <Poster />
        </svg>
      )}

      {/* Captions */}
      {/* Phones: the caption rides at the top, clear of the ground line; wider frames keep it bottom-left. */}
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 sm:bottom-5 sm:left-5 sm:top-auto">
        <Chip dark={time >= T.wipe}>
          <span className="tabular">{time < T.plinth ? `Plot ${run || reduced ? dims : "35′ × 65′"} · mid‑row` : caption}</span>
        </Chip>
      </div>
      <div
        className={cn("pointer-events-none absolute right-3 top-3 hidden transition-opacity duration-500 sm:right-5 sm:top-5 sm:block", time >= T.roof ? "opacity-100" : "opacity-0")}
        aria-hidden={time < T.roof}
      >
        <Chip dark={time >= T.wipe}>
          <span className="size-1.5 rounded-full bg-pass" aria-hidden />
          <span className="tabular">{counts ? `${counts.lda} LDA checks · ${counts.livable} livable` : "Every LDA check · livable rules"}</span>
        </Chip>
      </div>

      {!reduced && !hideReplay && (
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className={cn(
            "glass-hud absolute bottom-3 right-3 inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium outline-none transition-opacity duration-300 focus-visible:opacity-100 focus-visible:shadow-focus sm:bottom-5 sm:right-5",
            done ? "opacity-100 sm:opacity-0 sm:group-hover/cons:opacity-100" : "pointer-events-none opacity-0",
          )}
          aria-label="Replay the animation"
          tabIndex={done ? 0 : -1}
        >
          <RotateCcw className="size-3.5" strokeWidth={2} />
          Replay
        </button>
      )}
    </div>
  );
}

function Chip({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full px-3 text-[12px] font-medium transition-colors duration-500 sm:text-[13px]",
        dark ? "glass-hud" : "bg-surface/90 text-ink-2 shadow-e1 backdrop-blur",
      )}
    >
      {children}
    </span>
  );
}

// ── The drawing ─────────────────────────────────────────────────────────────────────────────────────

const INK = "var(--color-ink)";
const FAINT = "rgb(60 44 30 / .14)";
const HIDDEN = "rgb(60 44 30 / .35)";
const ACCENT = "var(--color-accent)";
const TEAK = "#D8B48C";
const STONE = "#E6DFD4";
const GLASS = "#DCE5EE";
const PLASTER = "#FFFDF9";
const LAWN = "#DDEBDD";

type Rect = [number, number, number, number]; // x0, y0, x1, y1

/** A wall panel that fills hatched, then solid, at `t`. */
function Panel({ r, fill, t, battens, stone }: { r: Rect; fill: string; t: number; battens?: boolean; stone?: boolean }) {
  const [x0, y0, x1, y1] = r;
  const w = x1 - x0;
  const h = y1 - y0;
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} fill="url(#nqc-hatch)" style={a("fade", t, 0.18)} />
      <rect x={x0} y={y0} width={w} height={h} fill={fill} style={a("fade", t + 0.26, 0.34)} />
      {battens && (
        <g stroke="rgb(120 78 40 / .35)" strokeWidth={0.6} style={a("fade", t + 0.4, 0.3)}>
          {Array.from({ length: Math.floor(w / 5) }, (_, i) => (
            <line key={i} x1={x0 + 3 + i * 5} y1={y0 + 1} x2={x0 + 3 + i * 5} y2={y1 - 1} />
          ))}
        </g>
      )}
      {stone && (
        <g stroke="rgb(30 25 21 / .10)" strokeWidth={0.6} style={a("fade", t + 0.4, 0.3)}>
          {Array.from({ length: Math.floor(h / 9) }, (_, i) => (
            <line key={i} x1={x0} y1={y0 + 8 + i * 9} x2={x1} y2={y0 + 8 + i * 9} />
          ))}
        </g>
      )}
      <rect x={x0} y={y0} width={w} height={h} fill="none" stroke={INK} strokeWidth={0.8} pathLength={1} strokeDasharray={1} style={a("draw", t, 0.4)} />
    </g>
  );
}

function Window({ r, mullions, t }: { r: Rect; mullions: number[]; t: number }) {
  const [x0, y0, x1, y1] = r;
  return (
    <g>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={PLASTER} stroke={INK} strokeWidth={0.9} style={a("fade", t - 1.0, 0.3)} />
      <rect x={x0 + 1} y={y0 + 1} width={x1 - x0 - 2} height={y1 - y0 - 2} fill="url(#nqc-glass)" style={a("fade", t, 0.45)} />
      <line x1={x0 + 6} y1={y1 - 6} x2={Math.min(x1 - 6, x0 + (y1 - y0) * 0.7)} y2={y0 + 6} stroke="white" strokeOpacity={0.8} strokeWidth={2} style={a("fade", t + 0.2, 0.4)} />
      {mullions.map((m) => (
        <line key={m} x1={m} y1={y0} x2={m} y2={y1} stroke={INK} strokeWidth={1.4} style={a("fade", t - 0.9, 0.3)} />
      ))}
    </g>
  );
}

/** The poster: the ground, the plot and its envelope, and the elevation in outline. Fades as the ink takes over. */
const POSTER_RECTS: Rect[] = [
  [174, 404, 827, 412], // plinth
  [174, 104, 182, 404], [364, 104, 372, 404], [521, 104, 529, 404], [723, 104, 731, 404], [786, 263, 796, 404], // columns
  [174, 242, 731, 260], [520, 262, 827, 280], // slabs
  [182, 262, 521, 330], [529, 288, 576, 330], // ground floor
  [174, 104, 731, 129], [200, 129, 705, 242], // roof frame, first floor
  [198, 77, 371, 104], [371, 96, 703, 104], [547, 50, 670, 96], [532, 37, 686, 50], // parapet, mumty
  [260, 150, 326, 237], [398, 150, 502, 237], [580, 150, 666, 237], [261, 283, 325, 330], [398, 283, 501, 330], // windows
  [70, 330, 517, 410], [517, 326, 541, 410], [822, 326, 850, 410], [541, 334, 822, 404], // boundary, piers, gate
];
function Poster() {
  return (
    <g fill="none">
      <line x1="0" y1={GROUND} x2={W} y2={GROUND} stroke="rgb(30 25 21 / .55)" strokeWidth={1.2} />
      <g stroke="rgb(30 25 21 / .4)" strokeWidth={0.8}>
        <line x1="172" y1="404" x2="172" y2="428" />
        <line x1="852" y1="404" x2="852" y2="428" />
        <line x1="172" y1="424" x2="852" y2="424" strokeWidth={0.6} />
      </g>
      <path d="M172 412V24H852V412" stroke={ACCENT} strokeOpacity={0.45} strokeWidth={1.2} strokeDasharray="6 5" />
      <g stroke="rgb(30 25 21 / .32)" strokeWidth={0.8}>
        {POSTER_RECTS.map(([x0, y0, x1, y1], i) => (
          <rect key={i} x={x0} y={y0} width={x1 - x0} height={y1 - y0} />
        ))}
        <path d="M560 404L660 333L560 262L660 183L560 104" strokeDasharray="4 3" />
      </g>
    </g>
  );
}

/** Level marks and the envelope label: twice the size on phones (the frame is ~half scale there) and inside the frame. */
function Drawing({ phone }: { phone?: boolean }) {
  const plants = useMemo(() => [32, 98, 150, 212, 378, 440, 488], []);
  const levelFont = phone ? 25 : 10;
  const levelX = phone ? 100 : 138;
  return (
    <>
      <defs>
        <pattern id="nqc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(30 25 21 / .28)" strokeWidth="0.8" />
        </pattern>
        <linearGradient id="nqc-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#EEF3F8" />
          <stop offset="1" stopColor={GLASS} />
        </linearGradient>
        <linearGradient id="nqc-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFDF9" />
          <stop offset="1" stopColor="#F8F4ED" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill="url(#nqc-sky)" />

      {/* Street and ground */}
      <rect x="0" y="442" width={W} height={H - 442} fill="#F2ECE3" style={a("fade", 0.1, 0.6)} />
      <line x1="0" y1="458" x2={W} y2="458" stroke={FAINT} strokeWidth={0.8} style={a("fade", 0.2, 0.6)} />
      <line x1="0" y1={GROUND} x2={W} y2={GROUND} stroke={INK} strokeWidth={1.2} pathLength={1} strokeDasharray={1} style={a("draw", T.ground, 0.6)} />
      {/* Plot lines and the 35′ dimension */}
      <g stroke={INK} strokeWidth={0.8} style={a("fade", 0.25, 0.4)}>
        <line x1="172" y1="404" x2="172" y2="428" />
        <line x1="852" y1="404" x2="852" y2="428" />
        <line x1="172" y1="424" x2="852" y2="424" strokeWidth={0.6} />
        <line x1="168" y1="428" x2="176" y2="420" />
        <line x1="848" y1="428" x2="856" y2="420" />
      </g>

      {/* Neighbours on both sides (mid-row), ghosted */}
      <g fill="none" stroke={FAINT} strokeWidth={1} style={a("fade", 0.35, 0.6)}>
        <path d="M0 112H160V412M0 180H120V250H0M160 260H0M60 320H160" />
        <path d="M900 106H738V412M738 255H900M760 200H790V250H760M840 238H900" />
      </g>

      {/* LDA envelope */}
      <g style={a("fade", T.envelope, 0.2)}>
        <path d="M172 412V24H852V412" fill="none" stroke={ACCENT} strokeWidth={1.2} strokeDasharray="6 5" pathLength={1} style={a("draw", T.envelope, 0.6)} />
        <text x="182" y={phone ? 50 : 40} fill={ACCENT} fontSize={phone ? 25 : 11} fontWeight="500" fontFamily="Geist Mono, ui-monospace, monospace" style={a("fade", T.envelope + 0.3, 0.3)}>
          LDA envelope · 45′ max
        </text>
      </g>

      {/* Plinth */}
      <rect x="174" y="404" width="653" height="8" fill={STONE} stroke={INK} strokeWidth={0.9} className="nqc-origin-b" style={a("rise", T.plinth, 0.5)} />

      {/* Columns rising */}
      <g fill={PLASTER} stroke={INK} strokeWidth={0.9}>
        {[174, 364, 521, 723].map((x, i) => (
          <rect key={x} x={x} y="104" width="8" height="300" className="nqc-origin-b" style={a("rise", T.columns + i * 0.08, 0.9)} />
        ))}
        <rect x="786" y="263" width="10" height="141" className="nqc-origin-b" style={a("rise", T.columns + 0.4, 0.7)} />
      </g>
      <g fill="rgb(30 25 21 / .62)" fontSize={levelFont} fontFamily="Geist Mono, ui-monospace, monospace" fontWeight="500">
        {[
          [404, "+0′", 2.1],
          [260, "+11′", 2.5],
          [104, "+21′", 2.9],
        ].map(([y, label, t]) => (
          <g key={label as string} style={a("fade", t as number, 0.3)}>
            <line x1={levelX} y1={y as number} x2="166" y2={y as number} stroke="rgb(30 25 21 / .45)" strokeWidth={phone ? 1 : 0.6} />
            <text x={levelX} y={(y as number) - (phone ? 6 : 4)}>{label}</text>
          </g>
        ))}
      </g>

      {/* Crane: the tower draws, the jib swings to 35°, then it leaves */}
      <g className="nqc-crane" style={a("fade", T.columns, 0.3)}>
        <g style={{ animation: `nqc-leave 0.6s cubic-bezier(.4,0,1,1) ${T.glaze}s both` }}>
          <g stroke="rgb(30 25 21 / .55)" strokeWidth={0.7} fill="none">
            <path d="M862 412V30M874 412V30" pathLength={1} strokeDasharray={1} style={a("draw", T.columns, 0.5)} />
            <path d="M862 400L874 380L862 360L874 340L862 320L874 300L862 280L874 260L862 240L874 220L862 200L874 180L862 160L874 140L862 120L874 100L862 80L874 60L862 40" strokeWidth={0.5} style={a("fade", T.columns + 0.3, 0.4)} />
          </g>
          {/* The jib slews 35° out of the elevation plane, so it foreshortens (cos 35° ≈ .82) about the mast. */}
          <g className="nqc-jib" style={{ animation: `nqc-swing 0.8s cubic-bezier(.65,0,.35,1) ${T.columns + 0.4}s both` }}>
            <line x1="560" y1="30" x2="874" y2="30" stroke="rgb(30 25 21 / .6)" strokeWidth={0.9} />
            <path d="M560 30L600 22H874" fill="none" stroke="rgb(30 25 21 / .35)" strokeWidth={0.5} />
            <line x1="640" y1="30" x2="640" y2="70" stroke="rgb(30 25 21 / .4)" strokeWidth={0.5} />
            <rect x="630" y="70" width="20" height="5" fill="rgb(30 25 21 / .5)" />
          </g>
          <line x1="874" y1="30" x2="900" y2="30" stroke="rgb(30 25 21 / .6)" strokeWidth={0.9} style={a("fade", T.columns + 0.3, 0.3)} />
        </g>
      </g>

      {/* Slabs: first floor and porch canopy, then the roof frame */}
      <Panel r={[174, 242, 731, 260]} fill={PLASTER} t={2.2} />
      <Panel r={[520, 262, 827, 280]} fill={PLASTER} t={2.35} />

      {/* Ground floor walls, hatched then solid */}
      <Panel r={[182, 262, 259, 330]} fill={TEAK} t={2.4} battens />
      <Panel r={[259, 262, 327, 330]} fill={STONE} t={2.52} stone />
      <Panel r={[327, 262, 372, 330]} fill={TEAK} t={2.64} battens />
      <Panel r={[372, 262, 521, 330]} fill={STONE} t={2.76} stone />
      <Panel r={[529, 288, 576, 330]} fill="#3A3A3F" t={2.88} />

      {/* Roof frame and jambs */}
      <Panel r={[174, 104, 731, 129]} fill={PLASTER} t={3.0} />
      <Panel r={[174, 129, 200, 242]} fill={PLASTER} t={3.1} />
      <Panel r={[705, 129, 731, 242]} fill={PLASTER} t={3.15} />

      {/* First floor walls */}
      <Panel r={[200, 129, 259, 242]} fill={TEAK} t={3.3} battens />
      <Panel r={[259, 129, 326, 242]} fill={STONE} t={3.42} stone />
      <Panel r={[326, 129, 372, 242]} fill={TEAK} t={3.54} battens />
      <Panel r={[372, 129, 525, 242]} fill={STONE} t={3.66} stone />
      <Panel r={[525, 129, 578, 242]} fill={TEAK} t={3.78} battens />
      <Panel r={[578, 129, 667, 242]} fill={STONE} t={3.9} stone />
      <Panel r={[667, 129, 705, 242]} fill={TEAK} t={4.02} battens />

      {/* Parapet */}
      <Panel r={[198, 77, 371, 104]} fill={STONE} t={4.1} stone />
      <Panel r={[371, 96, 703, 104]} fill={PLASTER} t={4.2} />

      {/* Stair (hidden lines) to the roof, and the mumty over it */}
      <path
        d="M560 404L660 333L560 262L660 183L560 104"
        fill="none"
        stroke={HIDDEN}
        strokeWidth={0.9}
        strokeDasharray="4 3"
        style={a("fade", T.roof, 0.6)}
      />
      <Panel r={[547, 50, 670, 96]} fill={PLASTER} t={T.roof} />
      <Panel r={[532, 37, 686, 50]} fill={PLASTER} t={T.roof + 0.12} />

      {/* Railing rises */}
      <g stroke={INK} strokeWidth={0.9}>
        <line x1="371" y1="84" x2="703" y2="84" pathLength={1} strokeDasharray={1} style={a("draw", T.roof + 0.25, 0.5)} />
        {[372, 430, 490, 702].map((x, i) => (
          <line key={x} x1={x} y1="84" x2={x} y2="96" className="nqc-origin-b" style={a("rise", T.roof + 0.2 + i * 0.05, 0.35)} />
        ))}
      </g>

      {/* Solar frame and tank spring in */}
      <g className="nqc-origin-b" style={a("pop", T.roof + 0.4, 0.55)}>
        {[386, 432, 478].map((x) => (
          <g key={x}>
            <rect x={x} y="64" width="40" height="13" fill="#2F3A52" stroke={INK} strokeWidth={0.7} />
            <line x1={x + 13} y1="64" x2={x + 13} y2="77" stroke="rgb(255 255 255 / .35)" strokeWidth={0.5} />
            <line x1={x + 27} y1="64" x2={x + 27} y2="77" stroke="rgb(255 255 255 / .35)" strokeWidth={0.5} />
            <line x1={x + 4} y1="77" x2={x + 4} y2="96" stroke={INK} strokeWidth={0.6} />
            <line x1={x + 36} y1="77" x2={x + 36} y2="96" stroke={INK} strokeWidth={0.6} />
          </g>
        ))}
      </g>
      <g className="nqc-origin-b" style={a("pop", T.roof + 0.55, 0.55)}>
        <rect x="598" y="22" width="50" height="15" rx="2" fill={STONE} stroke={INK} strokeWidth={0.8} />
        <line x1="602" y1="27" x2="644" y2="27" stroke="rgb(30 25 21 / .25)" strokeWidth={0.5} />
      </g>

      {/* Windows glaze */}
      <Window r={[260, 150, 326, 237]} mullions={[293]} t={T.glaze} />
      <Window r={[398, 150, 502, 237]} mullions={[426, 472]} t={T.glaze + 0.08} />
      <Window r={[580, 150, 666, 237]} mullions={[623]} t={T.glaze + 0.16} />
      <Window r={[261, 283, 325, 330]} mullions={[293]} t={T.glaze + 0.12} />
      <Window r={[398, 283, 501, 330]} mullions={[426, 450, 476]} t={T.glaze + 0.2} />
      <Window r={[632, 62, 657, 94]} mullions={[]} t={T.glaze + 0.24} />

      {/* Boundary wall, piers and gate */}
      <g style={a("fade", 4.8, 0.4)}>
        <rect x="70" y="330" width="447" height="80" fill={PLASTER} stroke={INK} strokeWidth={0.9} />
        <rect x="70" y="330" width="197" height="80" fill="url(#nqc-hatch)" opacity={0.5} />
        <line x1="267" y1="352" x2="517" y2="352" stroke="rgb(30 25 21 / .25)" strokeWidth={0.6} />
        <rect x="517" y="326" width="24" height="84" fill={STONE} stroke={INK} strokeWidth={0.9} />
        <rect x="822" y="326" width="28" height="84" fill={STONE} stroke={INK} strokeWidth={0.9} />
        <rect x="524" y="318" width="10" height="8" fill={PLASTER} stroke={INK} strokeWidth={0.7} />
        <rect x="831" y="318" width="10" height="8" fill={PLASTER} stroke={INK} strokeWidth={0.7} />
      </g>
      <g stroke="#2B2B30" strokeWidth={1.3} style={a("fade", 5.0, 0.4)}>
        <rect x="541" y="334" width="281" height="70" fill="rgb(30 25 21 / .06)" strokeWidth={1} />
        {Array.from({ length: 34 }, (_, i) => (
          <line key={i} x1={546 + i * 8.2} y1="336" x2={546 + i * 8.2} y2="402" strokeWidth={0.9} />
        ))}
      </g>

      {/* Landscaping */}
      <rect x="0" y={GROUND} width="530" height="30" fill={LAWN} style={a("fade", 5.0, 0.5)} />
      <g stroke="#3E7A4E" strokeWidth={1} fill="none" strokeLinecap="round">
        {plants.map((x, i) => (
          <g key={x} className="nqc-origin-b" style={a("pop", 5.05 + i * 0.06, 0.5)}>
            <path d={`M${x} 412C${x - 4} 400 ${x - 14} 394 ${x - 20} 396M${x} 412C${x + 3} 398 ${x + 12} 392 ${x + 20} 394M${x} 412C${x - 1} 398 ${x - 2} 390 ${x} 382M${x} 412C${x - 8} 404 ${x - 16} 404 ${x - 22} 408M${x} 412C${x + 8} 404 ${x + 16} 404 ${x + 22} 408`} />
          </g>
        ))}
      </g>
      <g stroke="#5A4A3A" strokeWidth={1.2} fill="none" strokeLinecap="round" pathLength={1}>
        <path d="M295 405V372L280 352M295 372L312 350M295 382L272 368M280 352L268 340M312 350L326 338" pathLength={1} strokeDasharray={1} style={a("draw", 5.1, 0.6)} />
      </g>
      <g fill="#7FA86F" fillOpacity={0.75}>
        {[
          [268, 336, 9],
          [282, 346, 7],
          [313, 345, 8],
          [327, 333, 9],
          [272, 362, 6],
        ].map(([cx, cy, rr], i) => (
          <circle key={i} cx={cx} cy={cy} r={rr} className="nqc-origin-c" style={a("pop", 5.4 + i * 0.05, 0.4)} />
        ))}
      </g>
    </>
  );
}

const KEYFRAMES = `
.nqc-wait * { animation-play-state: paused !important; }
.nqc-origin-b { transform-box: fill-box; transform-origin: 50% 100%; }
.nqc-origin-c { transform-box: fill-box; transform-origin: 50% 50%; }
.nqc-jib { transform-box: fill-box; transform-origin: 100% 50%; }
@keyframes nqc-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes nqc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes nqc-rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes nqc-pop { 0% { opacity: 0; transform: scale(.6); } 70% { opacity: 1; transform: scale(1.06); } 100% { opacity: 1; transform: scale(1); } }
@keyframes nqc-swing { from { transform: scaleX(.42); } to { transform: scaleX(.82); } }
@keyframes nqc-leave { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(60px); } }
.nqc-photo { -webkit-mask-image: linear-gradient(90deg, #000 46%, transparent 54%); mask-image: linear-gradient(90deg, #000 46%, transparent 54%);
  -webkit-mask-size: 250% 100%; mask-size: 250% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
@keyframes nqc-fill { from { -webkit-mask-position: 100% 0; mask-position: 100% 0; } to { -webkit-mask-position: 0% 0; mask-position: 0% 0; } }
`;
