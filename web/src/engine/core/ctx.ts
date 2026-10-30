/** BuildCtx: shared state for one buildHouse() run. */
import * as THREE from "three";
import type { Layer } from "@contracts/house-sdk";
import type { PlanModel } from "../plan/model";
import { MaterialLib, type Quality } from "../materials/library";
import { applyTags, type ObjTags } from "./tags";
import { NoteLog } from "./notes";
import type { StructureModel } from "../structure/model";
import type { PitchSpec } from "../structure/pitched-roof";

export interface PlacedItem {
  id: string;
  type: string;
  room: string;
  /** footprint in plan ft (axis-aligned bbox of the rotated item) */
  x0: number; y0: number; x1: number; y1: number;
  /** absolute heights (ft) */
  h0: number; h1: number;
  cls: "floor" | "rug" | "wall" | "ceiling" | "top";
  /** top surface height for items that can support others (ft, absolute), else null */
  topH: number | null;
  group: THREE.Object3D;
  against?: string;
  /** unrotated size (ft) and plan rotation (deg), for later moves (walking-path repair) */
  w?: number;
  d?: number;
  rot?: number;
  /** the variant it was furnished with (e.g. "noHob" for a counter without a hob) */
  variant?: string;
  /** EN3-01: what furnish() was asked (colour, material, size...) and the style, to build a smaller version of it */
  opts?: Record<string, unknown>;
  style?: string;
}

/** A guard (railing) along a straight, axis-aligned line on a level: runs along `axis` at `c`, from a to b. */
export interface GuardSeg {
  level: string;
  axis: "x" | "y";
  c: number;
  a: number;
  b: number;
  /** top of the guard above that level's floor (ft) */
  h: number;
}

export interface GroundSurf {
  x: number; y: number; w: number; d: number;
  h: number;
  obj: THREE.Object3D;
  kind: "site" | "landscape";
}

export class BuildCtx {
  readonly plan: PlanModel;
  readonly root: THREE.Group;
  readonly mats: MaterialLib;
  readonly quality: Quality;
  layer: Layer = "structure";
  section = "";
  sectionGroup: THREE.Group;
  colliders: THREE.Mesh[] = [];
  readonly colliderGroup: THREE.Group;
  realLights = 0;
  readonly maxRealLights = 12;
  objectsThisSection = 0;
  structureBuilt = false;
  private counters = new Map<string, number>();
  private _model: StructureModel | null = null;
  modelFactory: ((ctx: BuildCtx) => StructureModel) | null = null;
  readonly items: PlacedItem[] = [];
  readonly ground: GroundSurf[] = [];
  /** level-floor guards built so far (hole rails, deck railings, catch-all rails), axis-aligned, plan ft */
  readonly guards: GuardSeg[] = [];
  /** as-built notes from furnishing and other passes (the structure model keeps its own) */
  readonly notes = new NoteLog();
  /** facade elements registered as mounting surfaces for lights */
  readonly facadeSurfs: { side: string; plane: number; u0: number; u1: number; h0: number; h1: number }[] = [];
  /** EN3-02: every walk-colliding facade member as built (plan ft box, absolute heights), for the walkway checks */
  readonly facadeBlocks: { kind: string; x0: number; x1: number; y0: number; y1: number; h0: number; h1: number }[] = [];
  /** EN-F1: the footprints (plan ft) of the trees, planters and hedges planted so far, below 7 ft: what a walker meets */
  readonly plantings: { x0: number; x1: number; y0: number; y1: number }[] = [];
  /** callbacks run at the end of the current section (e.g. auto dining chairs) */
  readonly endOfSection: (() => void)[] = [];
  /** the pitched roof over this house, null for a flat one */
  pitched: PitchSpec | null = null;
  /** structure options remembered for later sections */
  structureOpts: Record<string, unknown> = {};
  sunHour = 17.5;
  /** room id → underside height (ft) of a false ceiling placed by interior.false_ceiling */
  readonly falseCeil = new Map<string, number>();
  /** rooms that received recessed downlights */
  readonly downlit = new Set<string>();
  /** cars the design asks for (furnish("car_*") calls counted before the sections run): parking lays out that many bays */
  carsWanted = 0;
  /** EN2-04: cars the plan itself asks for ("Car porch (2 cars)", or "a 2-car porch" in its notes): parked at the end
   *  when the design furnished fewer */
  carsPlan = 0;
  /** cars actually parked / asked for so far (for the "Only N of M cars fit" note) */
  carsParked = 0;
  carsAsked = 0;

  constructor(plan: PlanModel, quality: Quality) {
    this.plan = plan;
    this.quality = quality;
    this.mats = new MaterialLib(quality);
    this.root = new THREE.Group();
    this.root.name = "naqsha-house";
    this.root.userData = { layer: "structure", kind: "root", id: "root", label: "House" };
    this.sectionGroup = this.root;
    this.colliderGroup = new THREE.Group();
    this.colliderGroup.name = "colliders";
    this.colliderGroup.visible = false;
    this.colliderGroup.userData = { layer: "structure", kind: "colliders", id: "colliders", label: "Walk colliders", collide: true };
    this.root.add(this.colliderGroup);
  }

  get model(): StructureModel {
    if (!this._model) this._model = this.modelFactory!(this);
    return this._model;
  }

  /** Derive the structure again from the plan (a pitched roof turns the roof level into an attic first). */
  resetModel(): void {
    this._model = null;
  }

  uid(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return n === 1 ? prefix : `${prefix}_${n}`;
  }

  /** Tag and add an object to the current section. */
  add<T extends THREE.Object3D>(obj: T, tags: Partial<ObjTags> = {}): T {
    const t: Partial<ObjTags> = { layer: this.layer, section: this.section, ...tags };
    if (!t.id) t.id = this.uid(`${t.kind ?? "obj"}`.replace(/[^a-z0-9_]+/gi, "_"));
    applyTags(obj, t);
    this.sectionGroup.add(obj);
    this.objectsThisSection++;
    return obj;
  }

  /** Register a collider mesh (kept in the scene graph; may be invisible). */
  collider(mesh: THREE.Mesh): void {
    this.colliders.push(mesh);
  }

  /** Invisible collider-only geometry (ramps etc.). */
  addColliderOnly(geo: THREE.BufferGeometry, tags: Partial<ObjTags> = {}): THREE.Mesh {
    const m = new THREE.Mesh(geo, COLLIDER_MAT);
    m.visible = false;
    m.userData = { layer: this.layer, section: this.section, kind: "collider", id: this.uid("collider"), label: "Collider", collide: true, ...tags };
    this.colliderGroup.add(m);
    this.colliders.push(m);
    return m;
  }

  takeLight(): boolean {
    if (this.realLights >= this.maxRealLights) return false;
    this.realLights++;
    return true;
  }
}

const COLLIDER_MAT = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, visible: false });
