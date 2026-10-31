/**
 * userData tags ({layer, level, room, kind, id, label}) and human-readable labels.
 */
import type * as THREE from "three";
import type { BuildingPlan } from "@contracts/plan";

export interface ResolvedTags {
  /** Nearest ancestor (or self) that carries an id or kind: the "element" a comment/hover refers to. */
  element: THREE.Object3D;
  id?: string;
  kind?: string;
  label?: string;
  level?: string;
  room?: string;
  layer?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);

/** Engine containers that carry tags but are never "the element" (a design.js section, the merged-mesh group). */
const CONTAINER_KINDS = new Set(["section", "merged"]);
export const isContainer = (o: THREE.Object3D) => CONTAINER_KINDS.has(o.userData?.kind);

/** Triangle range of a consolidated mesh → the tags of the original element (engine core/consolidate.ts). */
export interface PartRange {
  start: number;
  count: number;
  tags: Record<string, unknown>;
}

export function partsOf(o: THREE.Object3D): PartRange[] | null {
  const p = o.userData?.parts;
  return Array.isArray(p) && p.length ? (p as PartRange[]) : null;
}

/** The part containing triangle `faceIndex` (binary search; parts are in triangle order). */
export function partAt(o: THREE.Object3D, faceIndex: number | null | undefined): PartRange | null {
  const parts = partsOf(o);
  if (!parts || faceIndex == null || faceIndex < 0) return null;
  let lo = 0, hi = parts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = parts[mid];
    if (faceIndex < p.start) hi = mid - 1;
    else if (faceIndex >= p.start + p.count) lo = mid + 1;
    else return p;
  }
  return null;
}

/** Tags for a raycast hit: the element's own tags, refined by its consolidated part when the mesh was merged. */
export function resolveHitTags(hit: THREE.Intersection, stopAt?: THREE.Object3D | null): ResolvedTags & { part: PartRange | null } {
  const base = resolveTags(hit.object, stopAt);
  const part = partAt(hit.object, hit.faceIndex);
  if (!part) return { ...base, part: null };
  const t = part.tags;
  return {
    element: hit.object,
    part,
    id: str(t.id) ?? base.id,
    kind: str(t.kind) ?? base.kind,
    label: str(t.label) ?? (str(t.id) ? undefined : base.label),
    level: str(t.level) ?? base.level,
    room: str(t.room) ?? base.room,
    layer: str(t.layer) ?? base.layer,
  };
}

/**
 * Walk up from a hit object: the first ancestor with id/kind is the element; missing fields inherit from further up.
 * `stopAt` (exclusive) is the build root, so a tag on the whole house never becomes "the element".
 */
export function resolveTags(obj: THREE.Object3D, stopAt?: THREE.Object3D | null): ResolvedTags {
  let element: THREE.Object3D | null = null;
  const out: Omit<ResolvedTags, "element"> = {};
  let o: THREE.Object3D | null = obj;
  while (o && o !== stopAt) {
    const u = o.userData ?? {};
    if (!element && !isContainer(o) && (str(u.id) || str(u.kind))) element = o;
    if (element) {
      out.id ??= str(u.id);
      out.kind ??= str(u.kind);
      out.label ??= str(u.label);
    }
    out.level ??= str(u.level);
    out.room ??= str(u.room);
    out.layer ??= str(u.layer);
    o = o.parent;
  }
  return { element: element ?? obj, ...out };
}

const KIND_WORDS: Record<string, string> = {
  wc: "WC",
  tv: "TV",
  tv_unit: "TV unit",
  ac_split: "AC",
  ac_outdoor: "AC outdoor unit",
  sofa_3: "3-seat sofa",
  sofa_2: "2-seat sofa",
  sofa_l: "L-shaped sofa",
  bed_king: "King bed",
  bed_queen: "Queen bed",
  bed_single: "Single bed",
  dining_table_4: "Dining table",
  dining_table_6: "Dining table",
  dining_table_8: "Dining table",
  plant_floor: "Floor plant",
  mirror_wall: "Wall mirror",
  sink_kitchen: "Kitchen sink",
  sink: "Sink",
  car_sedan: "Car",
  car_suv: "SUV",
  vehicle: "Car",
  water_tank: "Water tank",
  false_ceiling: "False ceiling",
  accent_wall: "Accent wall",
  led_strip: "LED strip",
  downlights: "Downlights",
};

/** Words that keep their capitals inside a sentence. */
const KEEP_CAPS = /^(TV|WC|AC|LED|LDA|UPS|W|kW|[A-Z]{2,}\d*)$/;

/** "furniture:sofa_3" → "3-seat sofa", "facade:fins" → "Fins", "stair_ramp" → "Stair ramp". */
export function humanizeKind(kind?: string): string {
  if (!kind) return "Element";
  const last = kind.split(":").pop() || kind;
  if (KIND_WORDS[last]) return KIND_WORDS[last];
  // "railing:glass" reads "Glass railing", "window:glass" → "Window glass"
  const segs = kind.split(":");
  if (segs.length >= 2 && /^(glass|stair|exterior|interior|coping|pillar|panel|light)$/.test(last)) {
    const head = segs[segs.length - 2].replace(/[_-]+/g, " ");
    const adjective = /^(stair|exterior|interior)$/.test(last) || (last === "glass" && head !== "window" && head !== "door");
    const s = adjective ? `${last} ${head}` : `${head} ${last}`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const s = last.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A name inside a sentence: "Upper Family Lounge" → "upper family lounge" (TV, WC and the like keep their capitals). */
export function inSentence(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (KEEP_CAPS.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

/** "the kitchen", "bedroom 2" (numbered rooms read without "the"). */
export function theRoom(name: string): string {
  if (/^[A-Z][\p{L}-]*['’]s\b/u.test(name)) return name;  // "Mateo's bath": a person's own room keeps their name
  const s = inSentence(name);
  return /\d/.test(s) || /^(the|a|an)\s/.test(s) ? s : `the ${s}`;
}

/** First letter up, the rest as written. */
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** A floor named in brackets: "(Ground Floor)", "(roof)", "(first)", "(level 2)", "(mumty)". */
const LEVEL_WORDS = /\b(floor|storey|story|level|roof|ground|first|second|third|fourth|basement|mumty|upper|lower)\b/i;

/**
 * Engine labels carry their floor in brackets ("Exterior walls (Ground Floor)", "Roof (Roof)", "Ceiling (First
 * Floor)"); the floor is already the label's subtitle, so it goes. Other brackets ("Solar panels (12 × ~550 W)") stay.
 */
export function stripLevel(label: string, levelNames: string[] = []): string {
  const m = /\s*\(([^()]*)\)\s*$/.exec(label);
  if (!m) return label;
  const inner = m[1].trim().toLowerCase();
  const isLevel = LEVEL_WORDS.test(inner) || levelNames.some((n) => n.trim().toLowerCase() === inner);
  return isLevel ? label.slice(0, m.index).trim() : label;
}

/**
 * The one human label for a thing in the house: "TV in the upper family lounge", "Floor plant in the drawing room",
 * "Wall in bedroom 2", "Water tank". Engine labels that only repeat "<Room name> <type>" are rebuilt from the kind;
 * hand-written labels ("AC outdoor unit", "Palm") are kept, sentence-cased.
 */
export function humanLabel(kind?: string, label?: string, room?: string, levelNames: string[] = []): string {
  label = label === undefined ? undefined : stripLevel(label, levelNames) || undefined;
  const last = (kind ?? "").split(":").pop() ?? "";
  const typeWords = last.replace(/[_-]+/g, " ").trim().toLowerCase();
  let auto = !label;
  if (label && room) {
    const l = label.trim().toLowerCase(), r = room.trim().toLowerCase();
    // "Upper Family Lounge tv", "Drawing Room plant floor", or just the room name again
    if (l === r || (typeWords && (l === `${r} ${typeWords}` || l.startsWith(`${r} `) && l.endsWith(typeWords)))) auto = true;
  }
  if (label && !room && typeWords && label.trim().toLowerCase() === typeWords) auto = true;
  let name = auto ? humanizeKind(kind) : cap(label!.trim());
  if (!auto && room && name.toLowerCase().startsWith(`${room.toLowerCase()} `)) {
    // "Car Porch roof": a label that names its room already reads fine, just in sentence case
    return cap(inSentence(name));
  }
  name = cap(inSentence(name));
  if (!room || name.toLowerCase().includes(room.trim().toLowerCase())) return name;
  // "on the roof terrace", "on the lawn"; "in the kitchen", "in bedroom 2"
  const on = /\b(terrace|balcony|roof|lawn|porch|patio|deck|driveway)\b/i.test(room);
  return `${name} ${on ? "on" : "in"} ${theRoom(room)}`;
}

/** Build-card words for a design section: "Building the roof", "Furnishing the kitchen". */
export function sectionStage(name: string | undefined, plan?: BuildingPlan): string {
  if (!name) return "";
  const n = name.toLowerCase().replace(/_auto$/, "");
  let m = n.match(/^furnish(?:ing)?_(.+)$/);
  if (m) {
    const id = m[1];
    const rm = plan?.rooms.find((r) => r.id === id || r.id.toLowerCase() === id);
    if (rm) return `Furnishing ${theRoom(rm.name)}`;
    return `Furnishing ${theRoom(id.replace(/^[bgfstr]_/, "").replace(/_/g, " "))}`;
  }
  if (/^structure/.test(n)) return "Raising the walls and slabs";
  if (/roof/.test(n)) return "Building the roof";
  if (/^facade_boundary|boundary/.test(n)) return "Building the boundary wall";
  if (/^facade/.test(n)) return "Dressing the facade";
  m = n.match(/^interior(?:s)?(?:_(.+))?$/);
  if (m) {
    const lvl = m[1] && plan?.levels.find((l) => l.id === m![1]);
    return lvl ? `Finishing the ${inSentence(lvl.name)}` : "Finishing the interiors";
  }
  if (/^(landscape|site|garden)/.test(n)) return "Planting the garden";
  if (/^(light|lights|lighting)/.test(n)) return "Lighting the house";
  if (/^stair/.test(n)) return "Building the stairs";
  return `Building the ${n.replace(/[_-]+/g, " ")}`;
}

export function roomName(plan: BuildingPlan | undefined, roomId?: string): string | undefined {
  if (!roomId || !plan) return undefined;
  return plan.rooms.find((r) => r.id === roomId)?.name;
}

export function levelName(plan: BuildingPlan | undefined, levelId?: string): string | undefined {
  if (!levelId || !plan) return undefined;
  return plan.levels.find((l) => l.id === levelId)?.name;
}

/** Hover / anchor label: "TV in the upper family lounge", with the floor underneath. */
export function displayLabel(t: Omit<ResolvedTags, "element">, plan?: BuildingPlan): { title: string; subtitle?: string } {
  const rn = roomName(plan, t.room);
  return { title: humanLabel(t.kind, t.label, rn, plan?.levels.map((l) => l.name) ?? []), subtitle: levelName(plan, t.level) };
}
