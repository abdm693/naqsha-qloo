/**
 * House SDK: the API that Gemini Argon writes Stage-2 `design.js` against.
 * The web engine implements it in web/src/engine/. These comments are ALSO pasted into
 * Argon's prompt as its API reference, so keep them short, precise and example-driven.
 *
 * Coordinates: plan feet (see contracts/plan.ts). x = along the road (left→right), y = into the plot
 * (front→back), h = height in ft above the road crown (ground floor level ≈ plinth, e.g. 1.5).
 * World space is meters with +Y up; x_m = x_ft·0.3048, z_m = −y_ft·0.3048, Y_m = h_ft·0.3048
 * (z is negated: the road is at +z, so from the street plan +x is on the viewer's right).
 * The SDK is forgiving: it clamps items inside rooms, snaps to walls and fills defaults, but never throws on bad
 * numbers. Every object it creates is tagged (layer, level, room, kind, id) for layers, comments and checks.
 *
 * ── design.js format (Argon output) ─────────────────────────────────────────────────────────────────
 * A plain-text file of SECTIONS. Each section is a function body executed as `(s, THREE) => { ... }`
 * where `s` is the HouseSDK below. The delimiters are JS line comments:
 *
 *   // @section structure [structure]
 *   s.structure({ exterior_wall: "plaster_white", floors: { lounge: "marble_white" } });
 *   // @end
 *   // @section facade_front [facade]
 *   s.facade.cladding({ side: "front", from_x_ft: 22, to_x_ft: 30, from_h_ft: 1.5, to_h_ft: 24, material: "stone_cladding" });
 *   // @end
 *
 * Section names and order: structure (exactly one, first), facade_*, interior_*, furnish_<room_id> (one per room),
 * landscape, lighting, custom_*. The layer in [brackets] is one of: structure | facade | interior | furniture |
 * landscape | lighting | custom. Revisions replace whole sections by name, so keep each one self-contained.
 * Forbidden in section code: fetch, XMLHttpRequest, WebSocket, import(), eval, Function, document, window,
 * localStorage, setTimeout loops. Pure geometry and SDK calls only.
 */

import type * as THREE_NS from "three";
import type { BuildingPlan, Pt, Rect, RoomType } from "./plan";

export type Side = "front" | "back" | "left" | "right";
export type Layer = "structure" | "facade" | "interior" | "furniture" | "landscape" | "lighting" | "custom";

export type MaterialPreset =
  // plaster/paint (pass color for paint)
  | "plaster_white" | "plaster_warm" | "plaster_grey" | "paint"
  // facade cladding
  | "stone_cladding" | "slate_cladding" | "travertine" | "brick_red" | "brick_exposed" | "concrete" | "wood_cladding"
  // floors
  | "marble_white" | "marble_beige" | "marble_black" | "terrazzo" | "porcelain_tile" | "ceramic_tile" | "wood_floor_oak" | "wood_floor_walnut"
  // joinery
  | "wood_teak" | "wood_walnut" | "wood_oak" | "wood_white_oak" | "lacquer"
  // metal and glass
  | "metal_black" | "metal_brushed" | "metal_gold" | "metal_bronze" | "glass_clear" | "glass_tinted" | "glass_frosted" | "mirror"
  // soft
  | "fabric" | "velvet" | "leather" | "linen"
  // misc
  | "ceramic_white" | "plastic"
  // pitched roofs
  | "roof_shingle" | "roof_tile" | "roof_slate" | "roof_metal"
  // outdoor
  | "grass" | "paving" | "gravel" | "soil" | "water" | "asphalt";

/** A preset name, a preset with overrides, or a ready THREE material. */
export type MaterialSpec =
  | MaterialPreset
  | { preset: MaterialPreset; color?: string; scale_ft?: number; roughness?: number; metalness?: number; emissive?: string; emissive_intensity?: number }
  | THREE_NS.Material;

export interface Tags {
  layer: Layer;
  level?: string;
  room?: string;
  /** "wall" | "slab" | "window" | "door" | "stair" | "railing:stair" | "furniture:<type>" | "facade:<what>" | "solar" |
   *  "vehicle" (cars, motorbikes: viewers hide or ghost them) | "context" (road, footpaths, poles, neighbours: ghosted) */
  kind?: string;
  label?: string; // human label shown on hover/comment, e.g. "Front stone cladding"
  id?: string; // stable id; auto-generated if omitted
}

export type FurnitureType =
  // bedroom
  | "bed_king" | "bed_queen" | "bed_single" | "side_table" | "wardrobe" | "dresser" | "dressing_table" | "study_desk" | "desk_chair" | "bookshelf"
  // living / drawing
  | "sofa_3" | "sofa_2" | "sofa_l" | "armchair" | "ottoman" | "coffee_table" | "console_table" | "tv_unit" | "tv" | "rug"
  | "floor_lamp" | "table_lamp" | "pendant" | "chandelier" | "curtains" | "plant_floor" | "plant_small" | "painting" | "mirror_wall"
  // dining / kitchen
  | "dining_table_4" | "dining_table_6" | "dining_table_8" | "dining_chair" | "sideboard"
  | "kitchen_counter" // straight run of base + wall cabinets; size.w_ft = run length
  | "kitchen_island" | "fridge" | "hob" | "oven" | "sink_kitchen" | "microwave"
  // bath
  | "wc" | "vanity" | "shower" | "bathtub" | "towel_rail"
  // Pakistani home details
  | "ceiling_fan" | "ac_split" | "water_dispenser" | "prayer_mat" | "washing_machine"
  // outdoor / porch
  | "car_sedan" | "car_suv" | "motorbike" | "outdoor_chair" | "outdoor_table" | "swing";

export interface FurnishOptions {
  room: string; // room id
  /**
   * Back of the item against this wall of the room. along_ft = distance of the item's CENTER from the wall's left end
   * seen from inside the room, facing that wall: front wall → measured from its high-x end (x = room.x + room.w −
   * along); back wall → from its low-x end; left wall → from its low-y end; right wall → from its high-y end.
   */
  against?: Side;
  along_ft?: number;
  /** OR free placement: item center in room-local ft (origin = room's min corner). rot_deg 0 = item faces +y (toward the back of the plot). */
  at?: Pt;
  rot_deg?: number;
  size?: { w_ft?: number; d_ft?: number; h_ft?: number };
  material?: MaterialSpec; // primary (frame/body)
  color?: string; // upholstery / accent color
  variant?: string; // free text hint: "upholstered headboard", "marble top", "rattan"...
}

export interface RoomHandle {
  id: string;
  type: RoomType;
  level: string;
  rect: Rect; // ft, plan coordinates
  floor_h_ft: number; // finished floor height above road crown
  ceiling_h_ft: number;
  /** Room-local ft (origin = room min corner) + height above this room's floor → world meters. */
  toWorld(x_ft: number, y_ft: number, h_ft?: number): THREE_NS.Vector3;
}

export interface FacadeFace {
  side: Side;
  /** Extent along the face in plan ft: plan x for front/back faces, plan y for left/right faces. */
  from_ft: number;
  to_ft: number;
  /** Plane position: plan y for front/back faces, plan x for left/right faces (outer surface). */
  plane_ft: number;
  bottom_h_ft: number;
  top_h_ft: number; // top of parapet
}

export interface FacadeRegion {
  side: Side;
  /** Along the face (plan x for front/back, plan y for left/right). */
  from_x_ft: number;
  to_x_ft: number;
  from_h_ft: number; // heights above the road crown
  to_h_ft: number;
  material: MaterialSpec;
}

export interface HouseSDK {
  THREE: typeof THREE_NS;
  plan: Readonly<BuildingPlan>;
  ft(n: number): number; // feet → meters
  toWorld(x_ft: number, y_ft: number, h_ft?: number): THREE_NS.Vector3; // plan ft → world meters
  mat(spec: MaterialSpec): THREE_NS.Material;

  /**
   * Build everything structural from the plan: walls (with real door and window openings, frames, glass, sills and
   * lintels), floor slabs and finishes, ceilings, skirting, stairs with railings, porch columns, balcony and terrace
   * railings, roof parapet, mumty, water tank, solar panels, plinth, boundary wall and gates. Call exactly once, in
   * `structure`. The engine guarantees, whatever the plan says: code stairs (treads ≥ 10 in, landings, a 3 ft clear
   * strip at the foot) with a flight up to the roof; a 3.5 ft guard at every stairwell edge and every drop; a mumty
   * that covers the top flight with its door AT the top landing, at roof level; openings only in the wall between the
   * two rooms they name, on their own level. plan.roof.water_tank.material "plastic" = blue ribbed tank, "concrete" =
   * rendered RCC box; plan.roof.solar keeps a roof area clear ("panels" also builds tilted rows on a steel frame).
   * A pitched roof comes from plan.roof.pitched (the place's usual roof); pass `roof` only to change it: gable or hip,
   * over the top storey's walls, eaves at the top of the parapet (it reads as a knee wall), gable ends in the exterior
   * wall material. The roof level is then an attic: no stair tower, tank or solar frame. `roof: { form: "flat" }` keeps
   * the flat roof with its parapet.
   * Example: s.structure({ exterior_wall: "plaster_white", interior_wall: { preset: "paint", color: "#efe9df" },
   *   floors: { default: "porcelain_tile", drawing: "marble_white", bedroom: "wood_floor_oak", bath: "ceramic_tile",
   *   porch: "paving" }, window_frame: "metal_black", door: "wood_teak", railing: "glass", boundary_wall: "plaster_grey",
   *   gate: "metal_black" })
   * `floors` keys: "default", a RoomType, or a room id (most specific wins).
   */
  structure(opts?: {
    exterior_wall?: MaterialSpec;
    interior_wall?: MaterialSpec;
    floors?: Record<string, MaterialSpec>;
    ceiling?: MaterialSpec;
    window_frame?: MaterialSpec;
    door?: MaterialSpec;
    glass?: MaterialSpec;
    railing?: "glass" | "metal_bars" | "solid";
    boundary_wall?: MaterialSpec;
    gate?: MaterialSpec;
    plinth?: MaterialSpec;
    roof?: {
      form: "flat" | "gable" | "hip";
      pitch_deg?: number; // default 30
      /** "along_road": slopes face the road. "across_road": a gable end faces the road. A long span turns the ridge. */
      ridge?: "along_road" | "across_road" | "auto";
      /** a MaterialSpec ("roof_shingle", "roof_tile", "roof_slate", "roof_metal", or { preset, color }) or plain words */
      material?: MaterialSpec | string;
      overhang_ft?: number; // eaves, default 1.5; cut back at a party wall and the plot edge
      fascia?: MaterialSpec;
      soffit?: MaterialSpec;
    };
  }): void;

  room(id: string): RoomHandle;
  face(side: Side, level?: string): FacadeFace; // building outer face info, for facade math

  facade: {
    /** Clad a rectangle of the outer wall on one side (thin panel, 0.1 ft proud of the wall). */
    cladding(o: FacadeRegion & { depth_ft?: number }): void;
    /** Vertical fins/battens across a region: count, width and depth (proud of wall). A carrier rail lower than 7 ft is
     *  left off where it would cross a porch's car way, a door or gate opening, or the gate-to-main-door walkway. */
    fins(o: FacadeRegion & { count: number; width_ft?: number; depth_ft?: number }): void;
    /** Horizontal louvers across a region. Slats and posts lower than 7 ft are left off where they would cross a porch's
     *  car way, a door or gate opening, or the walkway. */
    louvers(o: FacadeRegion & { count: number; depth_ft?: number; thickness_ft?: number }): void;
    /** Projecting box frame (picture frame); the region is the frame's OUTER bounds. Same projection limits as canopy.
     *  A frame standing on the ground (its bottom within 1 ft of the ground or plinth) is built as a U, posts down to the
     *  ground and no bottom member; no member lower than 7 ft crosses a porch's car way, a door or gate opening, or the
     *  walkway: a post there slides in along the frame until it is clear (or is left off). */
    frame(o: FacadeRegion & { thickness_ft?: number; depth_ft?: number }): void;
    /** Flat projecting slab (canopy/chajja/cantilever) over a plan rect; h_ft = height of its TOP surface. LDA: never past a
     *  zero-setback (party-wall) edge; into an open setback at most 1.5 ft (space < 10 ft) or 3 ft (space ≥ 10 ft). */
    canopy(o: { rect: Rect; h_ft: number; thickness_ft?: number; material: MaterialSpec; downlights?: boolean }): void;
    /** Decorative perforated screen (jaali) or slat screen over a region. */
    screen(o: FacadeRegion & { pattern: "jaali_geometric" | "jaali_star" | "perforated" | "slats" }): void;
    /** Column from h to h at a plan point. */
    column(o: { at: Pt; from_h_ft: number; to_h_ft: number; size_ft?: number; round?: boolean; material: MaterialSpec }): void;
    /** Up/down wall washer light on the facade. */
    wall_light(o: { side: Side; x_ft: number; h_ft: number; color?: string; intensity?: number }): void;
    /** Strip of LED cove light along a facade edge. */
    led_strip(o: { side: Side; from_x_ft: number; to_x_ft: number; h_ft: number; color?: string }): void;
  };

  interior: {
    /** Paint or clad one wall of a room from the inside (accent wall, wood paneling, marble feature wall). */
    accent_wall(o: { room: string; side: Side; material: MaterialSpec; from_h_ft?: number; to_h_ft?: number }): void;
    /** Dropped false ceiling with a recessed cove light around the edge. */
    false_ceiling(o: { room: string; drop_ft?: number; inset_ft?: number; cove_color?: string; material?: MaterialSpec }): void;
    /** Recessed downlights in a grid. */
    downlights(o: { room: string; rows?: number; cols?: number; color?: string }): void;
  };

  /**
   * Place one furniture item. Returns the group so you can tweak it. The engine keeps clearances and may move it:
   * floor items never stand in a door's clear zone (its width × 3 ft on each side, plus the leaf's swing), an
   * open-plan crossing, on a stair or its landings, or (tall items) in front of a window; they slide along their
   * wall, move to another wall, get up to 15% narrower (a wardrobe down to 60 %, then a 1.6 ft deep hanging unit),
   * or are left out quietly. In a bedroom, lounge, drawing, dining, study or prayer room a tall piece never stands
   * across the room's only window (with two or more, only the smallest may be covered as a last resort); a wardrobe
   * that has no other spot is left out with a note. A room's defining piece (a bedroom's bed, a bath's WC, basin and
   * shower or tub, a powder room's WC and basin, a kitchen's fridge and hob, a dressing room's wardrobe) is never
   * silently missing: a smaller version is tried (a 1.5 × 1.2 ft wall-hung basin, a 2.6 ft shower tray, then a
   * wet-area shower on the wall), plants and chairs give way, and if it still has no place the build reports a fail.
   * curtains always hang centred on a window or sliding door (the one on that wall nearest along_ft, else the room's
   * largest), never over a door; a room with no window gets none.
   * Wall items (tv, painting, mirror_wall, ac_split, towel_rail) go only on solid wall, never over a door or window
   * (a picture that would end up over one when its piece moves is re-centred on solid wall, or taken down);
   * a tv lines up over its tv_unit, a mirror over a dresser or vanity, a painting over a sofa or sideboard. A
   * tv_unit keeps 1.5 ft from every door frame and is never on the wall a living room is entered through (the main
   * door's, or the door from the lobby, porch or corridor on the way in: the TV group turns to face the opposite wall
   * when it fits there); in a bedroom it goes only on the wall the bed faces. side_tables
   * stand on the two sides of the bed; table_lamp, hob, sink_kitchen and microwave stand on a nightstand or counter.
   * Cars go into 9 × 18 ft parking bays (8.5 ft wide at the least) that keep the gate-to-main-door walkway clear: one
   * per car the design parks, and as many as the plan's porch asks for ("Car porch (2 cars)"); a car that does not
   * fit is reported. After each section, in every room each door (entry, attached bath, dressing, balcony) and stair
   * landing joins the others by a 3 ft path, and a long side of every bed and the approach to every window can be
   * reached: the engine moves the pieces in the way, then uses a smaller version (a queen becomes a single, a
   * wardrobe narrower, then shallower), then leaves out the least-needed piece with a note ("the wardrobe was left out
   * to keep the way to the bath clear"); a bed whose only spot runs its long side along a window is a smaller bed
   * clear of it. A door no one can get to at all is a fail ("door unreachable").
   */
  furnish(item: FurnitureType, o: FurnishOptions): THREE_NS.Object3D;
  /** Sensible default layout for a room by its type (use when no specific intent). */
  auto_furnish(room: string, o?: { style?: "modern" | "classic" | "minimal" | "traditional"; palette?: string[] }): void;

  /**
   * Clearances for `planter`, `tree` and `hedge` (EN-F1), kept whatever the call asks. An item's footprint is everything
   * it builds below 7 ft (a tree's whole canopy when its crown comes lower than that, a palm's fronds, a planter's
   * shrubs), which is also what the walkthrough treats as solid:
   *  - nothing within 3 ft outside an exterior door, sliding door, arch or garage door, across its width plus 1 ft each
   *    side; nothing within 3 ft of a gate, on either side of the boundary wall;
   *  - nothing on the walkway from the gate to the main door, or in a parked car's way in;
   *  - in a passage (an outdoor room narrower than 8 ft: a side or rear space, a light court) at least 3 ft of clear
   *    walking width is left beside it, between the walls, everything else standing there and the item;
   *  - it never cuts the 3 ft way from the gate to an exterior door or an outdoor room that was open without it.
   * An item that breaks one is slid along (a passage, the street verge) or nearby, made a slim columnar form against the
   * boundary wall (trees: an ashoka first), moved into a wider outdoor space within 30 ft (a lawn, a yard, never the
   * driveway), or left out, each with a warning in the build log (never an as-built note). Hedges keep the stretches
   * that break no rule. Plant passages with slim, boundary-wall trees and keep doors and gates clear.
   */
  landscape: {
    lawn(rect: Rect): void;
    paving(rect: Rect, material?: MaterialSpec): void;
    planter(rect: Rect, o?: { height_ft?: number; material?: MaterialSpec }): void;
    tree(at: Pt, o?: { kind?: "palm" | "ashoka" | "neem" | "ornamental" | "bush"; height_ft?: number }): void;
    hedge(from: Pt, to: Pt, o?: { height_ft?: number }): void;
    /** Street, kerb and pavement in front of the plot (y < 0), plus simple neighbouring houses for context
     *  (tagged kind "context": viewers ghost them when they block the view). The neighbours follow plan.site.street: in a
     *  row or standing apart, with the place's roofs and walls. The other options override it; usually pass none. */
    street(o?: {
      road_width_ft?: number; neighbours?: boolean; streetlights?: boolean;
      form?: "row" | "detached" | "semi-detached"; side_gap_ft?: number; storeys?: number;
      roof?: { form: "flat" | "gable" | "hip"; pitch_deg?: number; ridge?: string };
    }): void;
  };

  lights: {
    /** Sun from the plot facing + hour (6..19). 17.5 gives the golden hour. */
    sun(o?: { hour?: number; intensity?: number }): void;
    /** Warm ceiling lights for every enclosed room (skip if you place your own). */
    interior(o?: { warmth?: "warm" | "neutral"; intensity?: number }): void;
    point(o: { at: Pt; h_ft: number; color?: string; intensity?: number; distance_ft?: number }): void;
  };

  /** Add custom geometry you build with THREE (bespoke facade elements, art, etc.). Always tag it. */
  add(obj: THREE_NS.Object3D, tags: Tags): THREE_NS.Object3D;
}
