import { isIntl } from "@/app/lib/locale";
/** Shared domain vocabulary: plot presets, styles and spaces (used by the UI and the mock). */

export const MARLA_SQFT = 225; // Lahore District (LDA definition)

export interface PlotPreset { id: string; label: string; marla: number; width_ft: number; depth_ft: number; note?: string }

/** Typical Lahore dimensions (docs/research/lda-regulations.md §1.2; they vary by scheme). */
export const PLOT_PRESETS: PlotPreset[] = [
  { id: "3m", label: "3 marla", marla: 3, width_ft: 15, depth_ft: 45 },
  { id: "5m", label: "5 marla", marla: 5, width_ft: 25, depth_ft: 45 },
  { id: "7m", label: "7 marla", marla: 7, width_ft: 30, depth_ft: 52.5 },
  { id: "10m", label: "10 marla", marla: 10, width_ft: 35, depth_ft: 65, note: "Most popular" },
  { id: "1k", label: "1 kanal", marla: 20, width_ft: 50, depth_ft: 90 },
  { id: "2k", label: "2 kanal", marla: 40, width_ft: 75, depth_ft: 120 },
];

export function toMarla(width_ft: number, depth_ft: number): number {
  return (width_ft * depth_ft) / MARLA_SQFT;
}

/**
 * How people say plot sizes: "10 marla" (a 35×65 plot is 10.1 marla, but it is sold as 10), "7.5 marla",
 * "1 kanal", "1 kanal 4 marla". Sizes within 0.15 marla of a whole number snap to it.
 */
export function plotLabel(marla: number, intl: boolean = isIntl()): string {
  if (!marla || !Number.isFinite(marla)) return "—";
  if (intl) return `${Math.round((marla * 272.25) / 10) * 10 >= 1000 ? (Math.round((marla * 272.25) / 10) * 10).toLocaleString("en") : Math.round(marla * 272.25)} sq ft`;
  const snapped = Math.abs(marla - Math.round(marla)) <= 0.15 ? Math.round(marla) : Math.round(marla * 10) / 10;
  if (snapped >= 20) {
    const kanal = Math.floor(snapped / 20);
    const rest = Math.round((snapped - kanal * 20) * 10) / 10;
    return rest >= 0.5 ? `${kanal} kanal ${rest} marla` : `${kanal} kanal`;
  }
  return `${snapped} marla`;
}

export interface StyleOption {
  name: string;
  blurb: string;
  palette: [string, string, string, string];
  motif: "fins" | "arch" | "columns" | "box" | "dome" | "grid" | "tile";
}

export const STYLE_OPTIONS: StyleOption[] = [
  { name: "Modern Contemporary", blurb: "White volumes, stone pier, teak fins", palette: ["#f4f1ec", "#8b877f", "#a26a3c", "#1f1f22"], motif: "fins" },
  { name: "Spanish", blurb: "Clay tile roofs, arches, warm plaster", palette: ["#efe2cf", "#b5562f", "#6f4a2e", "#2e2a26"], motif: "tile" },
  { name: "Classic", blurb: "Columns, cornices, symmetry", palette: ["#f1ebe0", "#cbbfa8", "#8a7b62", "#3a352d"], motif: "columns" },
  { name: "Minimalist", blurb: "Quiet planes, deep reveals, no ornament", palette: ["#f6f5f2", "#d9d6cf", "#9b968c", "#2a2a2a"], motif: "box" },
  { name: "Mediterranean", blurb: "Whitewash, blue accents, pergolas", palette: ["#f7f4ee", "#d9c6a5", "#3f6e8c", "#2b2b2b"], motif: "arch" },
  { name: "Mughal Revival", blurb: "Red sandstone, jharokas, jaali screens", palette: ["#efe0cf", "#a4482c", "#d8b88a", "#3b2a22"], motif: "dome" },
  { name: "Industrial", blurb: "Exposed brick, steel, big glass", palette: ["#e9e4dc", "#9c4b32", "#4b4a48", "#1d1d1d"], motif: "grid" },
];

export interface SpaceOption { id: string; label: string; hint?: string }

export const SPACE_OPTIONS: SpaceOption[] = [
  { id: "drawing", label: "Drawing room", hint: "Formal guest room" },
  { id: "tv_lounge", label: "TV lounge" },
  { id: "dining", label: "Dining" },
  { id: "dirty_kitchen", label: "Dirty kitchen", hint: "For heavy cooking" },
  { id: "servant_quarter", label: "Servant quarter" },
  { id: "lawn", label: "Lawn" },
  { id: "prayer", label: "Prayer room" },
  { id: "roof_terrace", label: "Roof terrace" },
  { id: "study", label: "Study" },
  { id: "store", label: "Store" },
  { id: "laundry", label: "Laundry" },
  { id: "gym", label: "Gym" },
];

export function spaceLabel(id: string): string {
  if (id.startsWith("car_porch")) {
    const n = Number(id.split(":")[1] ?? 1);
    return `Car porch (${n} car${n === 1 ? "" : "s"})`;
  }
  if (id === "kitchen") return "Kitchen";
  return SPACE_OPTIONS.find((s) => s.id === id)?.label ?? id.replace(/_/g, " ");
}

export const FACING_LABEL: Record<string, string> = {
  N: "North", NE: "North-east", E: "East", SE: "South-east", S: "South", SW: "South-west", W: "West", NW: "North-west",
};

export const BUDGET_LABEL: Record<string, string> = {
  economy: "Economy", standard: "Standard", premium: "Premium", luxury: "Luxury",
};

/** Parse "31.5204, 74.3587" or a Google Maps URL (…/@lat,lng,… or ?q=lat,lng or !3dlat!4dlng). */
export function parseCoordinates(input: string): { lat: number; lng: number } | null {
  const s = decodeURIComponent(input.trim());
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll|center|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}
