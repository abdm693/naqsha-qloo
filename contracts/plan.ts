/**
 * BuildingPlan: the Stage-1 artifact. Argon emits it (JSON, schema-constrained), the LDA engine
 * checks it, the 2D plan view draws it, and the House SDK builds the structure from it.
 *
 * Conventions (READ FIRST)
 * - Units: FEET everywhere in the plan. The 3D engine converts with 1 ft = 0.3048 m.
 * - Plan coordinates are plot-local: origin = FRONT-LEFT corner of the plot as seen from the road.
 *   +x runs along the road to the right (plot width); +y runs away from the road into the plot (plot depth).
 *   The road is at y < 0. 3D mapping: x_m = x_ft*0.3048, z_m = -y_ft*0.3048, up = +Y (height).
 *   (z is NEGATED so that, seen from the road at +z looking toward -z, plan +x appears on the viewer's RIGHT.)
 * - Room sides: "front" = min-y edge (towards the road), "back" = max-y, "left" = min-x, "right" = max-x.
 * - Rect = {x, y, w, d}: (x, y) is the min corner; w extends along +x and d along +y.
 * - Wall centerlines lie ON room edges. Exterior walls are 0.75 ft (9") thick and interior walls 0.375 ft (4.5").
 *   Walls are derived automatically from room edges; do not list walls.
 * - Two rooms on the same level must not overlap (touching edges is expected).
 * - Room edges that border no other room on that level are exterior.
 * - Rooms of type porch, balcony, terrace, lawn, driveway, courtyard and open_space get no walls on
 *   exterior edges: balconies and terraces get a railing or parapet, porches get columns.
 */

export type Pt = [number, number]; // [x_ft, y_ft]

export interface Rect {
  x: number; // ft, min x
  y: number; // ft, min y
  w: number; // ft, along +x
  d: number; // ft, along +y
}

export type Authority = "LDA" | "DHA" | "BAHRIA" | "RDA" | "FDA" | "MDA" | "GDA" | "OTHER";

export type RoomType =
  | "drawing" // formal guest room (Pakistani "drawing room")
  | "lounge" // TV lounge / family lounge
  | "dining"
  | "kitchen"
  | "dirty_kitchen"
  | "bedroom"
  | "master_bedroom"
  | "guest_bedroom"
  | "bath" // attached bathroom
  | "powder" // guest toilet
  | "dressing"
  | "study"
  | "prayer"
  | "store"
  | "laundry"
  | "servant" // servant quarter
  | "stair" // stair hall: the stair is placed inside via `stairs`
  | "lobby"
  | "corridor"
  | "porch" // car porch: covered, open sides
  | "garage"
  | "balcony"
  | "terrace" // open roof terrace
  | "courtyard"
  | "lawn"
  | "driveway"
  | "open_space";

export interface Level {
  id: string; // "basement" | "ground" | "first" | "second" | "roof"
  name: string; // "Ground Floor"
  index: number; // -1 basement, 0 ground, 1 first, ... (roof = top storey index + 1)
  elevation_ft: number; // finished floor level above the road crown (ground ≈ plinth, e.g. 1.5)
  height_ft: number; // floor-to-floor height (e.g. 11); roof level: parapet height
  slab_ft: number; // slab thickness (e.g. 0.5)
}

export interface Room {
  id: string; // unique, e.g. "g_drawing", "f_master", "f_master_bath"
  level: string; // Level.id
  name: string; // display name, e.g. "Drawing Room"
  type: RoomType;
  rect: Rect; // rooms are axis-aligned rectangles; build L-shapes from 2 rects with open_to
  open_to?: string[]; // ids of same-level rooms with NO wall between them (open plan)
  floor_finish?: "marble" | "porcelain_tile" | "terrazzo" | "wood" | "ceramic_tile" | "concrete" | "grass" | "paving";
  ceiling_height_ft?: number; // clear height; defaults to level.height_ft - level.slab_ft
}

export type OpeningType =
  | "main_door" // entrance door, ~4 ft
  | "door" // ~3 ft hinged
  | "double_door"
  | "sliding_door" // glazed sliding door to a lawn, terrace or balcony
  | "window"
  | "corner_window"
  | "ventilator" // small high window (baths)
  | "arch" // opening without a door leaf
  | "garage_door";

export interface Opening {
  id: string; // e.g. "g_drawing_w1"
  level: string;
  type: OpeningType;
  /** Center point of the opening ON a room edge (wall centerline). The engine snaps it to the nearest wall ≤1.5 ft away. */
  at: Pt;
  width_ft: number;
  height_ft: number; // doors ~7, windows ~4.5-5
  sill_ft?: number; // windows: ~3 (0 for doors/sliding)
  /** Rooms on each side; use "exterior" for outside. */
  between: [string, string];
  swing?: "in" | "out"; // doors; defaults to "in" toward between[0]
}

export interface Stair {
  id: string;
  from_level: string;
  to_level: string;
  rect: Rect; // footprint, must lie inside a room of type "stair" (or lobby) on from_level
  kind: "dogleg" | "straight" | "l_shape";
  width_ft: number; // flight width, LDA ≥ 3.5
  riser_in: number; // LDA ≤ 7.5
  tread_in: number; // LDA ≥ 10
  /** Direction the FIRST flight climbs: +y means it starts at the front edge and goes back. */
  start: "+x" | "-x" | "+y" | "-y";
}

export interface Roof {
  parapet_ft: number; // ~3.5
  mumty?: { rect: Rect; height_ft: number; door_side: "front" | "back" | "left" | "right" }; // stair tower ≤ 9.5 ft
  water_tank?: { rect: Rect; height_ft: number; material?: "plastic" | "concrete" };
  /** Rooftop solar: "ready" keeps a clear, unshaded area; "panels" also places panel rows. Rect = reserved array area. */
  solar?: { mode: "ready" | "panels"; rect?: Rect };
  /** Set by Naqsha from the place's home profile; leave it out. A pitched roof over the top storey: the parapet becomes the
   *  knee wall and the roof level an attic, so no room, tank or solar goes on it. */
  pitched?: { form: "gable" | "hip"; pitch_deg: number; ridge?: string; material?: string; overhang_ft?: number };
}

export interface Gate {
  id: string;
  at: Pt; // center point on the front boundary line (y = 0)
  width_ft: number; // car gate ~12-14, pedestrian ~4
  kind: "sliding" | "swing" | "pedestrian";
}

export interface Site {
  plot: { width_ft: number; depth_ft: number; area_marla: number; corner: boolean };
  /** Compass direction the FRONT of the plot faces (towards the road). Drives sun position. */
  facing: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  road_width_ft?: number;
  authority: Authority;
  scheme?: string; // e.g. "Johar Town", "DHA Phase 6"
  city: string; // "Lahore", "Austin"
  coordinates?: { lat: number; lng: number };
  /** Setbacks the design applies (≥ the LDA minimums); side setbacks are named left/right. */
  setbacks_ft: { front: number; rear: number; left: number; right: number };
  boundary_wall: { front_height_ft: number; side_height_ft: number; rear_height_ft: number };
  gates: Gate[];
  /** Set by Naqsha from the place's home profile; leave it out. How the neighbouring houses stand, for the 3D street. */
  street?: {
    form?: "row" | "detached" | "semi-detached";
    side_gap_ft?: number;
    setback_ft?: number;
    storeys?: number;
    front_wall?: boolean;
    roof_tank?: boolean;
    walls?: string[];
    roof?: { form?: string; pitch_deg?: number; ridge?: string };
  };
}

export interface Style {
  name: string; // "Modern Contemporary", "Spanish", "Classic", ...
  summary: string; // one paragraph used for the image and code prompts
  palette: string[]; // hex colors, e.g. ["#f2efe9", "#8a8780", "#a0673a", "#1d1d1f"]
  materials: string[]; // free text: "white plaster", "grey stone cladding", "teak fins"...
}

export interface BuildingPlan {
  schema: "naqsha.plan/1";
  units: "ft";
  site: Site;
  levels: Level[]; // bottom → top, including a final "roof" level
  rooms: Room[]; // includes outdoor site areas (lawn, driveway) on the ground level
  openings: Opening[];
  stairs: Stair[];
  roof: Roof;
  style: Style;
  notes?: string[]; // design rationale, shown to the user
}

/** Output of the LDA compliance engine (Python), returned with every plan/version. */
export interface ComplianceReport {
  authority: Authority;
  band: string; // e.g. "10 marla to under 1 kanal"
  ok: boolean; // no "fail" checks
  checks: ComplianceCheck[];
  envelope: {
    setbacks_ft: { front: number; rear: number; left: number; right: number };
    max_coverage_pct: number;
    max_height_ft: number;
    max_storeys: number;
    buildable_rect: Rect;
  };
  metrics: { plot_area_sqft: number; covered_area_sqft: number; coverage_pct: number; total_floor_area_sqft: number; far: number; height_ft: number; storeys: number };
}

export interface ComplianceCheck {
  id: string; // "setback.front", "room.min_area:f_bed2", ...
  title: string;
  status: "pass" | "warn" | "fail";
  message: string; // plain-English explanation
  value?: number | string;
  limit?: number | string;
  rule_ref?: string; // e.g. "LDA B&ZR 2019 (v2026) §2.7.1(a)"
  category?: "lda" | "livable"; // regulation vs Naqsha livability rules (room independence, stairs, guards, doors)
  unit?: string; // unit of value/limit: "ft", "sq ft", "%", "sides", "storeys", "bedrooms", ... (show "10 ft (min 10 ft)")
  fix?: string; // how to fix a failing check (fed to the planner; the UI may show it as a hint)
  element_ids?: string[]; // room/opening ids, used to highlight in 2D/3D
}
