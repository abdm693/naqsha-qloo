/**
 * The house at dusk. Each person is a window, dark until they answer. The room at the centre is the heart: it lights last,
 * and only when there is something real to light it with. Lamp light is the only warm colour in this world, so a lit window
 * always means a person.
 */
import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/app/lib/utils";

export interface SceneWindow { id: string; name: string; lit: boolean }

// The window slots, first filled first: upper floor from the middle out, then the ground floor, then the eaves.
const SLOTS: [number, number, number, number][] = [
  [508, 338, 74, 92], [618, 338, 74, 92], [388, 338, 74, 92], [738, 338, 74, 92],
  [368, 470, 92, 102], [740, 470, 92, 102], [522, 218, 56, 66], [622, 218, 56, 66],
];
const LAMP = "#FFC46B";

function Glass({ x, y, w, h, lit, delay, id }: { x: number; y: number; w: number; h: number; lit: boolean; delay: number; id: string }) {
  const still = useReducedMotion();
  // A lamp coming on: it catches, dips, then holds.
  const on = still ? { opacity: 1 } : { opacity: [0, 0.75, 0.4, 1] };
  const timing = still ? { duration: 0 } : { duration: 1.1, delay, times: [0, 0.3, 0.45, 1], ease: "easeOut" as const };
  return (
    <g>
      {/* the light falling out of the window onto the wall */}
      <motion.rect x={x - 26} y={y - 26} width={w + 52} height={h + 74} rx={18} fill={LAMP} filter={`url(#${id}-spill)`}
        initial={false} animate={lit ? { opacity: 0.34 } : { opacity: 0 }} transition={still ? { duration: 0 } : { duration: 1.4, delay }} />
      <rect x={x - 5} y={y - 5} width={w + 10} height={h + 10} rx={3} fill="#070B1F" />
      <rect x={x} y={y} width={w} height={h} fill="#141B3F" />
      <motion.rect x={x} y={y} width={w} height={h} fill={`url(#${id}-lamp)`} initial={false} animate={lit ? on : { opacity: 0 }} transition={timing} />
      <path d={`M${x + w / 2} ${y}V${y + h}M${x} ${y + h * 0.42}H${x + w}`} stroke="#070B1F" strokeWidth={3.5} />
    </g>
  );
}

export function HouseScene({ windows = [], heart = false, roof = "gable", labels = false, delays, className, title }: {
  windows?: SceneWindow[];
  heart?: boolean;
  roof?: "gable" | "flat";
  labels?: boolean;
  /** Seconds before each window comes on (the reveal plays them one by one). */
  delays?: Record<string, number>;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  const still = useReducedMotion();
  const shown = windows.slice(0, SLOTS.length);
  return (
    <svg viewBox="-420 0 2040 720" preserveAspectRatio="xMidYMax slice" className={cn("block", className)} role="img" aria-label={title ?? "A house at dusk"}>
      <defs>
        <linearGradient id={`${id}-lamp`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE7BD" /><stop offset="0.55" stopColor={LAMP} /><stop offset="1" stopColor="#F2A24E" />
        </linearGradient>
        <filter id={`${id}-spill`} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="20" /></filter>
        <filter id={`${id}-heart`} x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="46" /></filter>
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2A3470" /><stop offset="1" stopColor="#1C2455" /></linearGradient>
      </defs>

      {/* the street: other homes, a few of them lit */}
      <g fill="#111840">
        <path d="M-480 720V470l120-88 120 88v250z" /><path d="M-210 720V430l130-96 130 96v290z" />
        <path d="M980 720V450h60v-40h120v40h80v270z" /><path d="M1290 720V462l126-92 126 92v258z" /><path d="M1560 720V480h120v240z" />
      </g>
      <g fill="#E9B26B" opacity="0.5"><rect x="-136" y="480" width="34" height="44" /><rect x="-398" y="520" width="30" height="40" /><rect x="1062" y="492" width="34" height="42" /><rect x="1440" y="510" width="30" height="42" /></g>
      <g fill="#0B1030">
        <path d="M212 640c-34-6-58-34-58-72 0-44 30-92 66-92s66 48 66 92c0 38-24 66-58 72v80h-16z" />
        <path d="M968 640c-30-6-50-30-50-62 0-40 26-82 58-82s58 42 58 82c0 32-20 56-50 62v80h-16z" />
      </g>

      {/* the house */}
      {roof === "gable"
        ? <path d="M268 310 600 128 932 310z" fill="#1A2152" />
        : <path d="M292 268h616v42H292z" fill="#1A2152" />}
      <rect x="304" y="304" width="592" height="336" fill={`url(#${id}-wall)`} />
      <path d="M304 450h592" stroke="#141A42" strokeWidth="3" />

      {/* the heart: the room everything opens onto */}
      <motion.rect x="430" y="400" width="340" height="300" rx="60" fill={LAMP} filter={`url(#${id}-heart)`} initial={false}
        animate={heart ? { opacity: 0.62 } : { opacity: 0 }} transition={still ? { duration: 0 } : { duration: 2.4, ease: [0.22, 1, 0.36, 1] }} />
      <Glass id={id} x={512} y={468} w={176} h={172} lit={heart} delay={0} />

      {/* windows nobody has claimed stay dark */}
      {SLOTS.slice(shown.length, 6).map(([x, y, ww, h]) => <Glass key={`${x}-${y}`} id={id} x={x} y={y} w={ww} h={h} lit={false} delay={0} />)}

      {shown.map((w, i) => {
        const [x, y, ww, h] = SLOTS[i];
        return (
          <g key={w.id}>
            <Glass id={id} x={x} y={y} w={ww} h={h} lit={w.lit} delay={delays?.[w.id] ?? 0} />
            {labels && (
              <text x={x + ww / 2} y={y + h + 27} textAnchor="middle" fontSize="15" fontWeight="500" fill={w.lit ? "#FFE3B0" : "#AEB4D2"} className="font-sans">
                {w.name.length > 14 ? `${w.name.slice(0, 13)}…` : w.name}
              </text>
            )}
          </g>
        );
      })}

      <rect x="-500" y="640" width="2200" height="90" fill="#0A0E28" />
    </svg>
  );
}
