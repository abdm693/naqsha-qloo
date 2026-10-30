/** TypeScript mirror of contracts/api.md (shared by web/src/api, app and viewer). */
import type { Authority, BuildingPlan, ComplianceReport, Rect } from "./plan";
import type { Layer } from "./house-sdk";

export type Stage = "setup" | "concepts" | "planning" | "building" | "ready" | "revising";

export interface BriefPlot { width_ft: number; depth_ft: number; area_marla: number; corner: boolean }

export interface Brief {
  /** Researched building rules (Tavily + Nemotron) when the authority isn't one Naqsha ships rules for. */
  rules_pack?: RulesPack;
  city: string;
  authority: Authority;
  scheme?: string;
  coordinates?: { lat: number; lng: number };
  /** null until the plot size is known (a first message without one saves an empty brief). */
  plot: BriefPlot | null;
  facing?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  storeys: number;
  basement: boolean;
  bedrooms: number;
  bathrooms: number;
  spaces: string[];
  style: string;
  style_notes?: string;
  inspiration_image_url?: string;
  budget?: "economy" | "standard" | "premium" | "luxury";
  notes?: string;
  /**
   * Facts Naqsha chose, not the family: field names, plus "corner" (plot.corner is an assumed mid-row until
   * corner_stated), "storeys" (also when the authority capped the count: see storeys_asked) and "porch" (the car porch
   * in spaces is Naqsha's default). Show a fact under "You said" only when it isn't here.
   */
  auto_filled: string[];
  /** True only when the family said corner or mid-row (a chip, the panel or their words); otherwise plot.corner is assumed. */
  corner_stated?: boolean;
  /** The storeys the family asked for when the authority's limit kept the brief lower ("Kept to 2 storeys: DHA's limit"). */
  storeys_asked?: number;
  /** Per-floor program, e.g. [{level:"ground", rooms:["drawing","kitchen","bedroom:1","bath:2"]}]. */
  floors?: { level: string; rooms: string[] }[];
  water_tank?: "plastic" | "concrete";
  /** "ready" = keep the roof clear for panels later; "panels" = include panels now. */
  solar?: "none" | "ready" | "panels";
  /** Soft wishes captured verbatim from the conversation. */
  preferences?: string[];
}

export interface Envelope {
  authority: Authority;
  band: string;
  setbacks_ft: { front: number; rear: number; left: number; right: number };
  side_space_note?: string;
  max_coverage_pct: number;
  max_far: number;
  max_height_ft: number;
  max_storeys: number;
  buildable_rect: Rect;
  max_ground_coverage_sqft: number;
  notes: string[];
}

export interface Chip { label: string; value: string; image_url?: string; hint?: string }

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  chips?: Chip[];
  multi?: boolean;
  input?: "text" | "number" | "plot" | "map" | "style" | "rooms" | "floors" | null;
  /** "Here's what I understood" card: guaranteed = hard rules we will meet (LDA + livable), preferences = wishes we will
   *  try to honour, assumptions = things the agent decided itself (editable). Sent after a rich message and at completion. */
  understood?: { guaranteed: string[]; preferences: string[]; assumptions: string[] };
  /** Suggested next prompts shown as chips under the message ("What's next"). */
  suggestions?: string[];
  field?: string;
  allow_skip?: boolean;
}

export interface Concept {
  id: string; url: string; night_url?: string; prompt: string; model: string; created_at: string; parent_id?: string; instruction?: string;
  /** The design take's name ("Stone and teak") and one-line direction (massing and materials), for captions. */
  title?: string;
  summary?: string;
  /** Drawn FROM the designed house (its elevation and floor plan, or the family's uploaded drawing). */
  from_design?: boolean;
  /** The concept read as a build specification (Gemini): what the 3D model must reproduce. */
  spec?: ConceptSpec;
  /** A direction from the family's Qloo taste: why it suits them, and the evidence ids behind it. */
  from_taste?: boolean;
  why?: string;
  because?: string[];
}

export interface ConceptFeature { id: string; what: string; where?: string; material?: string; colour?: string; importance?: "high" | "medium" | "low" }
export interface ConceptSpec { summary: string; palette: Record<string, string>; features: ConceptFeature[] }

/** A photograph of the house as built, made from a capture of the 3D model at one camera angle. */
export interface HouseView { angle: "front" | "corner" | "garden" | "aerial" | "interior"; label: string; url: string; model_url?: string; model?: string; created_at: string }

/** How the 3D model compares with the chosen concept, feature by feature (Nemotron VL). */
export interface ConceptMatch {
  score: number | null;
  summary: string;
  features: { id: string; what: string; where?: string; importance?: string; status: "present" | "partial" | "missing"; note: string }[];
  checked_at?: string;
  history?: { score: number | null; at?: string }[];
  refit?: { sections: string[]; at: string };
  /** The rebuilt facade scored lower, so the earlier facade (and its score) was kept. */
  reverted?: { score: number | null; at?: string };
}

/** The family's own drawing, read room by room (Nemotron VL) and used as the starting layout. */
export interface ImportedDrawing {
  images: string[];
  rooms: number;
  at: string;
  model?: string;
  layout: { levels: string[]; plot: { width_ft: number; depth_ft: number; assumed?: boolean };
            floors: Record<string, { name: string; type: string; rect: { x: number; y: number; w: number; d: number } }[]> };
}

/** Building rules researched on the web (Tavily) for an authority Naqsha has no rule pack for. */
export interface RulesPack {
  authority: string; name?: string; instrument?: string;
  sources: { title?: string; url: string; official?: boolean }[];
  caveats?: string[];
}

export interface DesignSection { name: string; layer: Layer; code: string }

export interface Change { id: string; summary: string; kind: "plan" | "section"; targets: string[]; comment_ids: string[];
  /** Made for the typed request (revise {instruction}) rather than a pinned comment. */
  from_request?: boolean }

export interface Version {
  id: string;
  n: number;
  created_at: string;
  parent_id?: string;
  plan: BuildingPlan;
  sections: DesignSection[];
  compliance: ComplianceReport;
  changes?: Change[];
  status: "building" | "ready" | "failed";
  thumbnail_url?: string;
  /** The architect's self-review of the drawn floors (design runs). applied = the plan was revised after it. Issues it
   *  didn't resolve stay open: open_issues counts them, and each is also a livable "warn" check in `compliance` with id
   *  "review.<n>" (plain words, never all-clear while any remain). */
  review?: { verdict: "approve" | "revise" | "skipped"; summary: string; applied?: boolean; open_issues?: number;
             rejected_because?: string[];
             /** "skipped_time": a late run got the critique only (no revision); reason "timeout": the critique ran over */
             revision?: "skipped_time"; reason?: "time" | "timeout";
             issues: { severity: "major" | "minor"; rooms?: string[]; problem: string; fix?: string }[] };
  /** The floor drawings the review looked at, one PNG per level. */
  plan_images?: { level: string; name: string; url: string }[];
  /** Plan rounds: fails/warns per attempt and the deterministic repairs applied. */
  fix_history?: { attempt: number; fail: number; warn: number; failed: string[]; repairs?: string[]; review?: boolean }[];
  /** What a revision was made from. `answer`: Naqsha's answer to the typed request (what changed, in feet and inches). */
  source?: { comment_ids: string[]; instruction?: string | null; answer?: string };
  /** The version rail's label ("“bigger kitchen” · 36/36 LDA · 12/12 livable · 1 architect's note"), also on the `version`
   *  event so the rail can be labelled without a reload. */
  summary?: string;
  /** Photographs from several angles, each made from the 3D model. */
  views?: HouseView[];
  concept_match?: ConceptMatch;
}

export interface VersionSummary { id: string; n: number; created_at: string; status: Version["status"]; summary?: string }

export type Role = "owner" | "team" | "client";

export interface Author { id: string; name: string; role: Role | "agent" | "guest" }

export interface Member { uid?: string; email: string; name?: string; role: Role; status: "active" | "invited" }

export interface Project {
  id: string;
  /** The caller's role on this project. */
  role?: Role;
  members_count?: number;
  /** The brief changed after the current version was designed (offer "Revise" or "Design again"; the stage never regresses). */
  brief_changed?: boolean;
  /** The sample (or project) this one was copied from. */
  cloned_from?: string;
  name: string;
  created_at: string;
  updated_at: string;
  stage: Stage;
  brief: Brief | null;
  envelope: Envelope | null;
  concepts: Concept[];
  selected_concept_id: string | null;
  versions: VersionSummary[];
  current_version_id: string | null;
  thumbnail_url: string | null;
  /** Set when the project started from an uploaded floor plan. */
  imported?: ImportedDrawing | null;
  /** The family's taste, read with Qloo, and the style brief it led to. */
  taste?: Taste | null;
}

// ---- taste (Qloo) ----------------------------------------------------------------------------------------------------
export type FavouriteKind = "destination" | "film" | "show" | "artist" | "restaurant" | "brand" | "book" | "podcast";
export interface Favourite { kind?: FavouriteKind | string; name: string }
export interface TastePerson { label: string; role?: string | null; favourites: Favourite[] }
export interface TasteInput { people: TastePerson[]; location?: string | null; notes?: string | null }

/** One piece of Qloo evidence the style brief cites: E… entity, T… tag, P… place. */
export interface Evidence { eid: string; name: string; type?: string; image?: string; address?: string; via?: string[]; from?: string[]; affinity?: number }
export interface TasteTag { eid: string; name: string; type?: string; affinity?: number | null; from?: string[] }
export interface FoundFavourite { eid: string; who: string; asked: string; name: string; type?: string; image?: string }
export interface TasteProfile {
  family: TasteTag[];
  feel: TasteTag[];
  people: { label: string; role?: string | null; tags: TasteTag[] }[];
  destinations: { eid: string; name: string; image?: string; affinity?: number }[];
  brands: { eid: string; name: string; image?: string; adjectives?: unknown }[];
  area?: { location: string; tags: TasteTag[]; places: TastePlace[]; makers?: TastePlace[] };
  favourites?: FoundFavourite[];
}
export interface TastePlace { eid: string; name: string; address?: string; image?: string; tags: string[] }
export interface Swatch { name: string; hex: string }
export interface StyleBrief {
  headline: string;
  story: string;
  family_tags?: { name: string; id?: string }[];
  people?: { label: string; signature: string; tags?: string[]; room?: string; because?: string[] }[];
  exterior?: { style: string; massing?: string; materials?: string[]; palette?: Swatch[]; details?: string[]; because?: string[] };
  interiors?: { mood?: string; palette?: Swatch[]; materials?: string[]; lighting?: string; furniture?: string; objects?: string; because?: string[] };
  rooms?: { room: string; for?: string; mood?: string; palette?: string[]; ideas?: string[]; because?: string[]; image?: string | null }[];
  landscape?: { idea?: string; plants?: string[]; because?: string[] };
  neighbourhood?: { reading?: string; response?: string; because?: string[] };
  takes?: { title: string; direction: string; why?: string; because?: string[] }[];
  decisions?: { decision: string; reason?: string; because?: string[] }[];
  shop?: { id: string; why?: string }[];
  evidence: Record<string, Evidence>;
}
export interface Taste { input: TasteInput; profile: TasteProfile; style: StyleBrief; at: string }

export type Vec3 = [number, number, number];

export interface CommentAnchor {
  position: Vec3;
  normal: Vec3;
  level?: string;
  room?: string;
  element_id?: string;
  kind?: string;
  label?: string;
}

export interface Comment {
  id: string;
  version_id: string;
  text: string;
  anchor: CommentAnchor;
  camera: { position: Vec3; target: Vec3 };
  snapshot_url?: string;
  created_at: string;
  status: "open" | "resolved" | "partial" | "rejected";
  resolution?: string;
  resolved_in_version?: string;
  /** Author ids in comment payloads are opaque per-project handles ("a_…"), never uids or guest ids. */
  author?: Author;
  /** Whether the caller wrote this comment (computed per request; use it instead of comparing author ids). */
  mine?: boolean;
  /** "approval": a client's sign-off on a version (stored resolved; never counted, applied or revised). */
  kind?: "approval";
  /** Set when an open comment was carried over to a newer version: the version it was written on. */
  from_version_id?: string;
  replies?: { id: string; author: Author; text: string; created_at: string; mine?: boolean }[];
}

export interface Me { uid: string; email: string; name?: string }

export interface AsBuiltSummary {
  objects: { id: string; layer: Layer; kind?: string; level?: string; room?: string; bbox_ft: { min: Vec3; max: Vec3 } }[];
  section_errors: { section: string; error: string }[];
  /**
   * What the engine repaired or could not repair while building (Naqsha "livable" rules enforced in 3D): ids are
   * "asbuilt.<rule>:<element>", e.g. asbuilt.stair_fit, asbuilt.roof_door_moved, asbuilt.guard_added,
   * asbuilt.opening_skipped, asbuilt.furniture_moved, asbuilt.furniture_dropped, asbuilt.path_blocked, asbuilt.car_dropped.
   */
  checks?: { id: string; title: string; status: "pass" | "warn" | "fail"; message: string; element_ids?: string[] }[];
}

/** SSE event payloads by event name. */
export interface SSEEvents {
  "message.delta": { text: string };
  message: ChatMessage;
  brief: { brief: Brief; envelope: Envelope | null };
  "intake.complete": { brief: Brief; envelope: Envelope | null };
  "concept.started": { index: number; prompt: string };
  concept: { index: number; concept: Concept };
  "concept.failed": { index: number; message: string };
  /** busy: a model back-off wait ("Busy right now, retrying in 20 s…"); stage "review" = the architect's self-review;
   *  stage "wait" = a back-off inside a non-run stream (concepts, setup). */
  stage: { stage: "plan" | "compliance" | "fix" | "review" | "build" | "save" | "changes" | "wait" | "match"; message: string;
           busy?: boolean; retry_in?: number | null };
  /** First event of every design/revise stream (fresh or re-attached): reset the view, keep the timer from started_at. */
  run: { kind: "design" | "revise"; started_at: string; elapsed_s: number };
  plan: { plan: BuildingPlan; attempt: number };
  compliance: { report: ComplianceReport; attempt: number };
  section: { section: DesignSection; index: number };
  progress: { chars: number };
  version: { version: Version };
  view: { index: number; view: HouseView };
  "view.failed": { index: number; message: string };
  match: { match: ConceptMatch };
  changes: { changes: Change[] };
  comment: { comment: Comment };
  /** The taste agent: a step it is on (and the Qloo tool it is calling). */
  step: { id: string; message: string; tool?: string };
  favourites: { found: FoundFavourite[]; missing: { who: string; asked: string }[] };
  profile: TasteProfile;
  taste: Taste;
  ping: Record<string, never>;
  done: Record<string, unknown>;
  error: { message: string; recoverable?: boolean };
}
