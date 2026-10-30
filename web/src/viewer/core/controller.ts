/**
 * ViewerController: the imperative core behind <HouseViewer>. React renders the shell once; everything that
 * changes per frame (camera, walk physics, hover, pins, animations) lives here, outside React state.
 */
import * as THREE from "three";
import type CameraControlsImpl from "camera-controls";
import type { EffectComposer as EffectComposerImpl, OutlineEffect } from "postprocessing";
import type { BuildingPlan, Level, Room } from "@contracts/plan";
import type { AsBuiltSummary, Comment, CommentAnchor, Vec3 } from "@contracts/api-types";
import type { BuildResult, SectionResult } from "@/engine";
import type { HouseViewerProps } from "../HouseViewer";
import { BuildManager } from "./build";
import { ContextFX, ghostAt, GHOST } from "./context";
import { engineExtras } from "./engineExtras";
import { grabCanvas, projectToNdc } from "./capture";
import { FloorLift, floorList, isFloorNumberKey, levelForKey } from "./floors";
import { ghostBox, heroPose, houseBox, photoPose, plotBox, roomPose, PHOTO_ANGLES, PHOTO_LABELS, type PhotoAngle, type SafeArea } from "./framing";
import { hitNormal, pick, accelerateLater } from "./pick";
import { makeViewerStore, type BuildState, type Quality, type ViewerMode, type ViewerStore } from "./store";
import { sunState, type Facing } from "./sun";
import { displayLabel, humanLabel, inSentence, resolveHitTags, roomName, type PartRange } from "./tags";
import { FT, clamp, damp, isCoarsePointer, planToWorld, prefersReducedMotion, sleep, smoothstep, worldToPlan, zOf } from "./units";
import { VisibilityController, type LevelBand } from "./visibility";
import { Atmosphere } from "../scene/atmosphere";
import { WindowGlow } from "../scene/windowGlow";
import { buildColliderBVH, disposeCollider, type ColliderBVH } from "../walk/collider";
import { glideSeconds, Navigator, type BlockCause, type RoutePlan } from "../walk/route";
import { BLOCK } from "../walk/navgrid";
import { DRAG_SENS, EYE, LOCK_SENS, WalkController } from "../walk/WalkController";

export type SuspendableControls = CameraControlsImpl & { suspended: boolean };

type ModeSource = "props" | "handle" | "user" | "flyTo";

const ORBIT_FOV = 50;
const WALK_FOV = 70;
/**
 * Walking field of view: 70° vertical on landscape screens; on a portrait phone that would be a 38° slit, so widen
 * the vertical angle until about 56° of the room shows side to side (capped before it distorts).
 */
function walkFov(aspect: number) {
  if (!Number.isFinite(aspect) || aspect <= 0) return WALK_FOV;
  const v = (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(56) / 2) / aspect) * 180) / Math.PI;
  return clamp(v, WALK_FOV, 92);
}
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
const OUTDOOR = new Set(["porch", "balcony", "terrace", "lawn", "driveway", "courtyard", "open_space", "garage"]);
const IDLE_MS = 2500;
const HINTS_KEY = "naqsha.walk.coachmark";

const v3 = (v: THREE.Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];
const round = (n: number) => Math.round(n * 1000) / 1000;
const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

interface OutlineTarget {
  obj: THREE.Object3D;
  part: PartRange | null;
}

/** Invisible in the beauty pass; the Outline effect renders its own mask from the selection layer. */
const OVERLAY_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/** Geometry of one consolidated part (triangle range) as a child of the merged mesh, for outlining. */
function partOverlay(mesh: THREE.Mesh, part: PartRange): THREE.Mesh | null {
  const g = mesh.geometry;
  const pos = g.getAttribute("position");
  if (!pos || part.count <= 0) return null;
  const count = Math.min(part.count, 60000);
  const out = new Float32Array(count * 9);
  const idx = g.index;
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const i = (part.start + t) * 3 + k;
      const vi = idx ? (i < idx.count ? idx.getX(i) : 0) : i;
      out[(t * 3 + k) * 3] = pos.getX(vi);
      out[(t * 3 + k) * 3 + 1] = pos.getY(vi);
      out[(t * 3 + k) * 3 + 2] = pos.getZ(vi);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(out, 3));
  const m = new THREE.Mesh(geo, OVERLAY_MAT);
  m.userData = { noPick: true, viewer: "outline-part" };
  m.renderOrder = mesh.renderOrder;
  return m;
}

/** A thin accent frame on a room's floor (orbit goToRoom), fading out. */
function roomFrame(rect: { x: number; y: number; w: number; d: number }, floorFt: number): THREE.Mesh {
  const t = 0.09; // m
  const x0 = rect.x * FT, x1 = (rect.x + rect.w) * FT, z0 = zOf(rect.y + rect.d), z1 = zOf(rect.y);
  const shape = new THREE.Shape([new THREE.Vector2(x0, z0), new THREE.Vector2(x1, z0), new THREE.Vector2(x1, z1), new THREE.Vector2(x0, z1)]);
  shape.holes.push(new THREE.Path([new THREE.Vector2(x0 + t, z0 + t), new THREE.Vector2(x0 + t, z1 - t), new THREE.Vector2(x1 - t, z1 - t), new THREE.Vector2(x1 - t, z0 + t)]));
  const geo = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
  // ShapeGeometry is in XY; after rotating +90° about X, shape-y maps to world z
  const mat = new THREE.MeshBasicMaterial({ color: "#7d93ff", transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = floorFt * FT + 0.04;
  m.renderOrder = 9;
  m.userData = { noPick: true, viewer: "room-frame" };
  return m;
}

/** An element that is solid from the floor up while walking (furniture, fixtures, roof equipment). */
interface SolidBox {
  box: THREE.Box3;
  id: string;
  layer: string;
  level?: string;
}

export interface ThreeBits {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  invalidate: () => void;
}

export class ViewerController {
  readonly store: ViewerStore;
  readonly vis = new VisibilityController();
  readonly walk = new WalkController();
  readonly builds: BuildManager;
  readonly holder = new THREE.Group();
  readonly ctxfx = new ContextFX();
  readonly lift = new FloorLift();
  /** Night: warm light in every outside window. */
  readonly glow = new WindowGlow();
  readonly nav: Navigator;
  props: HouseViewerProps;

  gl: THREE.WebGLRenderer | null = null;
  scene: THREE.Scene | null = null;
  camera: THREE.PerspectiveCamera | null = null;
  atmosphere: Atmosphere | null = null;
  controls: SuspendableControls | null = null;
  composer: EffectComposerImpl | null = null;
  outline: OutlineEffect | null = null;
  pinsGroup: THREE.Group | null = null;
  container: HTMLDivElement | null = null;
  tooltipEl: HTMLDivElement | null = null;
  minimapMarker: SVGGElement | null = null;

  private r3fInvalidate: (() => void) | null = null;
  private raycaster = new THREE.Raycaster();
  private collider: ColliderBVH | null = null;
  private colliderDirty = true;
  private colliderTimer = 0;
  private engineSun: THREE.DirectionalLight | null = null;
  private engineHemi: THREE.HemisphereLight | null = null;
  private cancelAccel: (() => void) | null = null;
  private hoverPending: { x: number; y: number } | null = null;
  private hoverKey = "";
  private crosshairAt = 0;
  private roomAt = 0;
  private pinCursor = 0;
  private fovTarget = ORBIT_FOV;
  private shadowsDirty = true;
  private perf = { samples: 0, sum: 0, settleUntil: 0, locked: false };
  private down: { x: number; y: number; t: number; button: number; id: number; type: string } | null = null;
  private drag: { x: number; y: number; moved: number } | null = null;
  private edge = { since: 0, side: 0 };
  private sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private spawnedFor = new WeakSet<BuildResult>();
  private heroDone = false;
  private hadResult = false;
  private readyWaiters: (() => void)[] = [];
  private toastSeq = 0;
  private toastTimer = 0;
  private draftTimer = 0;
  private hintsTimer = 0;
  private promptTimer = 0;
  private pinnedTimer = 0;
  /** the pointer is over (or focus is in) the minimap / help card: the HUD never steps back meanwhile */
  private hudHover = false;
  private lastDocMove = 0;
  private glideTimer = 0;
  private routeTimer = 0;
  private routeSeq = 0;
  private pinEls = new Map<string, HTMLElement | null>();
  private disposed = false;
  private unmountTimer = 0;
  private lastInput = 0;
  private unlockedAt = 0;
  private lockEverSucceeded = false;
  private walkerOnFallback = false;
  private navWarm = false;
  private ghostTarget = 1;
  /** the (room, level) last told to the app through onRoomChange */
  private lastRoomKey: string | undefined = undefined;
  private xfade: HTMLCanvasElement | null = null;
  private frames: { mesh: THREE.Mesh; start: number }[] = [];
  /** watches the container's ancestors: the app hides a kept-mounted House with a class (visibility: hidden) */
  private hiddenObs: MutationObserver | null = null;
  private cssHidden = false;
  result: BuildResult | null = null;

  constructor(props: HouseViewerProps) {
    this.props = props;
    this.store = makeViewerStore("orbit", isCoarsePointer());
    this.builds = new BuildManager(this);
    this.nav = new Navigator(props.plan, this.walk);
    this.nav.sight = (from, dir, max) => {
      const rc = new THREE.Raycaster(from, dir.clone().normalize(), 0, max);
      rc.layers.enableAll();
      const hit = pick(rc, [this.holder], { far: max });
      return hit ? hit.distance : max;
    };
    this.nav.classify = (p, r) => this.solidKindAt(p, r);
    this.nav.entry = this.walk.spawn.feet;
    this.holder.name = "naqsha-house";
    this.raycaster.layers.enableAll();
    // the app's chrome can recede with the walk HUD: `:root[data-nq-walk-idle]` (viewer.css, DESIGN "after 2.5s idle")
    this.store.subscribe((s, prev) => {
      if (s.idle !== prev.idle && typeof document !== "undefined") document.documentElement.toggleAttribute("data-nq-walk-idle", s.idle && s.mode === "walk");
    });
    try {
      const q = localStorage.getItem("naqsha.viewer.quality") as Quality | null;
      if (q === "high" || q === "balanced" || q === "performance") {
        this.store.setState({ quality: q });
        this.perf.locked = true;
      }
    } catch {
      /* storage blocked */
    }
  }

  get plan(): BuildingPlan {
    return this.props.plan;
  }

  private get levelsSorted(): Level[] {
    return [...this.plan.levels].sort((a, b) => a.index - b.index);
  }

  /** Imperative handle exposed through forwardRef (contracts/web-modules.md). */
  readonly handle = {
    capture: (opts?: { width?: number; height?: number }) => this.capture(opts),
    captureAngles: (angles?: string[], opts?: { width?: number; height?: number }) => this.captureAngles(angles, opts),
    flyTo: (comment: Comment) => this.flyTo(comment),
    setMode: (mode: ViewerMode) => this.setMode(mode, "handle"),
    goToRoom: (roomId: string) => this.goToRoom(roomId),
    setFloor: (levelId: string) => this.setFloor(levelId),
    resetView: () => this.resetView(),
    cancelDraft: () => this.cancelDraft(),
  };

  // ───────────────────────────── lifecycle ─────────────────────────────

  mount() {
    window.clearTimeout(this.unmountTimer);
    this.disposed = false;
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keydown", this.onKeyDownLate);
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onBlur);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("pointerlockerror", this.onPointerLockError);
    document.addEventListener("mousemove", this.onLockedMouseMove);
    document.addEventListener("pointermove", this.onDocPointerMove, { passive: true });
  }

  /** Moving the mouse anywhere (the app's chrome too) brings a receded walk HUD back. */
  private onDocPointerMove = (e: PointerEvent) => {
    const s = this.store.getState();
    if (e.pointerType === "touch" || s.mode !== "walk" || !s.active) return;
    const now = performance.now();
    if (now - this.lastDocMove < 100) return;
    this.lastDocMove = now;
    this.activity();
  };

  /** Deferred so a StrictMode remount (unmount → mount in the same tick) keeps the built house. */
  unmount() {
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("keydown", this.onKeyDownLate);
    window.removeEventListener("keyup", this.onKeyUp, { capture: true });
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onBlur);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("pointerlockerror", this.onPointerLockError);
    document.removeEventListener("mousemove", this.onLockedMouseMove);
    document.removeEventListener("pointermove", this.onDocPointerMove);
    document.documentElement.removeAttribute("data-nq-walk-idle");
    if (this.isLocked()) document.exitPointerLock?.();
    this.unmountTimer = window.setTimeout(() => this.dispose(), 0);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.builds.cancel();
    this.builds.invalidate();
    this.cancelAccel?.();
    disposeCollider(this.collider);
    this.collider = null;
    this.builds.disposeAll();
    this.ctxfx.dispose();
    this.glow.dispose();
    this.result = null;
    for (const t of [this.toastTimer, this.draftTimer, this.hintsTimer, this.routeTimer, this.promptTimer, this.pinnedTimer]) window.clearTimeout(t);
    window.clearTimeout(this.glideTimer);
    this.xfade?.remove();
    this.xfade = null;
    this.hiddenObs?.disconnect();
    this.hiddenObs = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.probeEl?.remove();
    this.probeEl = null;
    if (import.meta.env.DEV && (window as unknown as { __viewerDebug?: { ctrl?: unknown } }).__viewerDebug?.ctrl === this) {
      delete (window as unknown as { __viewerDebug?: unknown }).__viewerDebug;
    }
  }

  attachThree(t: ThreeBits) {
    this.gl = t.gl;
    this.scene = t.scene;
    this.camera = t.camera;
    this.r3fInvalidate = t.invalidate;
    t.scene.add(this.holder, this.glow.group);
    t.gl.shadowMap.autoUpdate = false;
    t.gl.shadowMap.needsUpdate = true;
    t.gl.localClippingEnabled = false;
    // transmission glass re-renders the opaque scene every frame; half resolution is visually identical here
    t.gl.transmissionResolutionScale = 0.5;
    // big, dense canvases (e.g. a 1440-wide panel on a retina laptop) start one tier down
    if (!this.perf.locked) {
      const px = t.gl.domElement.clientWidth * t.gl.domElement.clientHeight * Math.min(window.devicePixelRatio || 1, 1.5) ** 2;
      if (px > 2.6e6) this.store.setState({ quality: "balanced" });
    }
    t.camera.near = 0.08;
    t.camera.far = 3000;
    t.camera.fov = ORBIT_FOV;
    t.camera.updateProjectionMatrix();
    this.atmosphere = new Atmosphere(t.gl, t.scene);
    this.atmosphere.shadowFocus.copy(houseBox(this.plan)).expandByScalar(1.5);
    const plotCenter = plotBox(this.plan).getCenter(new THREE.Vector3());
    this.atmosphere.ground.position.set(plotCenter.x, -0.06, plotCenter.z);
    this.atmosphere.configureShadow(this.atmosphere.fallbackSun, this.store.getState().quality);
    if (this.engineSun) {
      // the house (and its own sun) landed before the canvas existed: never light it with a second, day sun
      this.atmosphere.baseIntensity(this.engineSun);
      this.atmosphere.setFallbackActive(false);
      this.atmosphere.configureShadow(this.engineSun, this.store.getState().quality);
    }
    this.syncGhostBox();
    this.syncSun();
    this.syncSectionCut();
    this.syncVisibility();
    this.placeHero(false);
    if (this.store.getState().mode === "walk") this.enterWalk(true);
    this.readyWaiters.splice(0).forEach((r) => r());
    if (import.meta.env.DEV) this.installDebug();
  }

  detachThree() {
    this.holder.removeFromParent();
    this.glow.group.removeFromParent();
    this.atmosphere?.dispose();
    this.atmosphere = null;
    this.gl = null;
    this.scene = null;
    this.camera = null;
    this.r3fInvalidate = null;
  }

  attachControls(c: SuspendableControls | null) {
    this.controls = c;
    if (!c) return;
    c.smoothTime = 0.3;
    c.draggingSmoothTime = 0.12;
    c.dollyToCursor = true;
    c.minDistance = 1.2;
    c.maxDistance = 180;
    c.maxPolarAngle = Math.PI / 2 - 0.035;
    c.dollySpeed = 0.6;
    c.truckSpeed = 1.6;
    c.restThreshold = 0.004;
    c.suspended = this.store.getState().mode === "walk";
    c.enabled = !c.suspended;
    const b = plotBox(this.plan).expandByScalar(18);
    b.min.y = -2;
    c.setBoundary(b);
    c.addEventListener("controlstart", () => {
      this.clearHover();
      this.leaveHero();
    });
    this.placeHero(false);
  }

  whenReady(): Promise<void> {
    if (this.gl) return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  setProps(p: HouseViewerProps) {
    this.props = p;
  }

  setContainer = (el: HTMLDivElement | null) => {
    if (this.container) {
      const c = this.container;
      c.removeEventListener("pointerdown", this.onPointerDown);
      c.removeEventListener("pointermove", this.onPointerMove);
      c.removeEventListener("pointerup", this.onPointerUp);
      c.removeEventListener("pointercancel", this.onPointerUp);
      c.removeEventListener("pointerleave", this.onPointerLeave);
      c.removeEventListener("dblclick", this.onDblClick);
      c.removeEventListener("wheel", this.onWheel);
      c.removeEventListener("contextmenu", this.onContextMenu);
    }
    this.container = el;
    this.watchHidden(el);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (!el) return;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(el);
    }
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("dblclick", this.onDblClick);
    el.addEventListener("wheel", this.onWheel, { passive: true });
    el.addEventListener("contextmenu", this.onContextMenu);
  };

  invalidate() {
    this.r3fInvalidate?.();
  }

  // ───────────────────────────── on screen / hidden ─────────────────────────────

  /**
   * The app keeps House mounted but hidden behind Plan, Concepts and Revisions (an ancestor with visibility: hidden,
   * toggled by class). Watch the ancestors' class/style so the viewer knows without the app having to say so.
   */
  private watchHidden(el: HTMLElement | null) {
    this.hiddenObs?.disconnect();
    this.hiddenObs = null;
    if (!el || typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(() => this.syncActive());
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      obs.observe(p, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
    }
    this.hiddenObs = obs;
    this.syncActive();
  }

  /** `active` prop or the container's own visibility changed. */
  syncActive() {
    const el = this.container;
    if (el && el.isConnected) {
      const cs = getComputedStyle(el);
      this.cssHidden = cs.visibility === "hidden" || cs.display === "none" || el.getClientRects().length === 0;
    } else this.cssHidden = false;
    const active = this.props.active !== false && !this.cssHidden;
    const s = this.store.getState();
    if (s.active === active) return;
    if (!active) {
      // hidden mid-walk: no key stays held, the pointer is let go, and the app's chrome never stays receded
      this.onBlur();
      if (this.isLocked()) document.exitPointerLock?.();
      this.clearHover();
      this.hudHover = this.hudPointer = this.hudFocus = false;
      this.store.setState({ active, idle: false });
    } else {
      this.lastInput = performance.now();
      this.store.setState({ active });
    }
    this.invalidate();
  }

  markDirty() {
    this.shadowsDirty = true;
    this.invalidate();
  }

  // ───────────────────────────── per frame ─────────────────────────────

  frame(dt: number) {
    const cam = this.camera, gl = this.gl;
    if (!cam || !gl) return;
    const now = performance.now();
    let busy = false;
    if (this.builds.tick(now)) {
      busy = true;
      this.shadowsDirty = true;
    }
    if (this.lift.tick(now)) {
      busy = true;
      this.shadowsDirty = true;
    }
    const s = this.store.getState();
    const mode = s.mode;
    if (mode === "orbit" && Math.abs(cam.fov - this.fovTarget) > 0.02) {
      cam.fov += (this.fovTarget - cam.fov) * damp(7, dt);
      if (Math.abs(cam.fov - this.fovTarget) < 0.05) cam.fov = this.fovTarget;
      cam.updateProjectionMatrix();
      busy = true;
    }
    if (this.tickGhost(dt)) busy = true;
    if (this.tickVehicles(dt, mode)) busy = true;
    if (this.tickFrames(now)) busy = true;
    if (mode === "walk") this.walkFrame(dt, now, cam);
    else if (this.hoverPending) this.processHover();
    this.updatePins(cam);
    if (this.colliderDirty && mode === "walk" && now > this.colliderTimer) this.ensureCollider();
    if (mode === "walk" && !this.navWarm && this.collider) this.navWarm = this.nav.warm(3);
    // a quality change re-sizes (drops) the sun's shadow map: decide it before this frame's shadow pass
    this.monitorPerf(dt, now);
    if (this.shadowsDirty || this.shadowMapMissing()) {
      gl.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    gl.toneMappingExposure = (this.atmosphere?.exposure ?? 1) * (mode === "walk" ? 1.1 : 1);
    if (busy) this.invalidate();
  }

  /**
   * Would this frame draw a shadow-casting light that has no shadow map yet? three.js then binds its shared empty
   * depth texture, which (set up without a compare mode) makes every lit draw a WebGL INVALID_OPERATION ("Mismatch
   * between texture format and sampler type"). Render the shadow pass instead.
   */
  private shadowMapMissing(): boolean {
    const atm = this.atmosphere;
    for (const l of [atm?.fallbackSun, this.engineSun]) if (l && l.castShadow && l.visible && !l.shadow.map) return true;
    return false;
  }

  private walkFrame(dt: number, now: number, cam: THREE.PerspectiveCamera) {
    const wasIntro = !!this.walk.transition;
    // follow the screen's shape (rotating a phone, resizing a panel)
    const fov = walkFov(cam.aspect);
    if (Math.abs(fov - this.walk.fov) > 0.5) this.walk.fov = fov;
    if (!this.walk.transition && Math.abs(cam.fov - this.walk.fov) > 0.05) {
      cam.fov = this.walk.fov;
      cam.updateProjectionMatrix();
    }
    this.walk.update(dt, cam);
    if (wasIntro && !this.walk.transition) this.onIntroDone();
    if (this.minimapMarker) {
      // minimap draws the plan with the road at the bottom (SVG y = D − y_ft); heading: yaw 0 looks into the plot (up)
      const p = worldToPlan(this.walk.feet);
      const D = this.plan.site.plot.depth_ft;
      this.minimapMarker.setAttribute("transform", `translate(${p.x.toFixed(2)} ${(D - p.y).toFixed(2)}) rotate(${((-this.walk.yaw * 180) / Math.PI).toFixed(1)})`);
    }
    if (now - this.roomAt > 160) {
      this.roomAt = now;
      this.updateRoomLabel();
    }
    const s = this.store.getState();
    if (now - this.crosshairAt > 120 && s.walk === "look" && !s.gliding) {
      this.crosshairAt = now;
      this.updateCrosshairTarget();
    }
    // the HUD steps back when nothing happens for a while
    if (Math.hypot(this.walk.vel.x, this.walk.vel.z) > 0.05 || this.walk.glide) this.lastInput = now;
    // never while the pointer rests on (or focus is in) the minimap or the help card: "click to go" must still work
    const idle = (s.walk === "free" || s.walk === "look") && s.active && !this.hudHover && !s.help && now - this.lastInput > IDLE_MS;
    if (idle !== s.idle) this.store.setState({ idle });
  }

  private activity() {
    this.lastInput = performance.now();
    if (this.store.getState().idle) this.store.setState({ idle: false });
  }

  private hudFocus = false;
  private hudPointer = false;

  /** The minimap / help card is under the pointer or has focus (MiniMap reports it). */
  setHudHover(on: boolean, via: "pointer" | "focus" = "pointer") {
    if (via === "pointer") this.hudPointer = on;
    else this.hudFocus = on;
    this.hudHover = this.hudPointer || this.hudFocus;
    this.activity();
  }

  /** Show "Click (or drag) to look around" for a few seconds (after starting to walk, or letting go of the mouse). */
  private showLookPrompt(ms = 4000) {
    const s = this.store.getState();
    if (s.touch || s.mode !== "walk") return;
    window.clearTimeout(this.promptTimer);
    if (!s.prompt) this.store.setState({ prompt: true });
    this.promptTimer = window.setTimeout(() => this.store.setState({ prompt: false }), ms);
  }

  /** The first look, step or glide: the prompt (and the one-time coachmark) have done their job. */
  private hideLookPrompt(alsoHints = false) {
    window.clearTimeout(this.promptTimer);
    const s = this.store.getState();
    if (s.prompt) this.store.setState({ prompt: false });
    if (alsoHints && s.hints) {
      window.clearTimeout(this.hintsTimer);
      this.store.setState({ hints: false });
    }
  }

  // ───────────────────────────── build hooks (called by BuildManager) ─────────────────────────────

  setBuildState(partial: Partial<BuildState>) {
    this.store.setState((s) => ({ build: { ...s.build, ...partial } }));
  }

  levelIndexMap() {
    return new Map(this.plan.levels.map((l) => [l.id, l.index] as [string, number]));
  }

  currentRoot(): THREE.Object3D | null {
    return this.holder.children[0] ?? null;
  }

  onRootAttached(root: THREE.Group) {
    this.cancelAccel?.();
    this.cancelAccel = null;
    this.engineSun = null;
    this.engineHemi = null;
    this.lift.finish();
    // the previous result went off screen; walking keeps using its merged BVH until the new build lands
    this.result = null;
    this.atmosphere?.setFallbackActive(true);
    this.configureVisibility();
    this.vis.apply(root);
    this.clearHover();
    this.markDirty();
  }

  onSectionApplied(root: THREE.Object3D, r: SectionResult | null) {
    this.vis.apply(root);
    if (!this.engineSun || r?.layer === "lighting") this.adoptEngineSun(root);
    this.markDirty();
  }

  onBuildComplete(result: BuildResult, _mock: boolean) {
    const replacing = this.hadResult;
    this.hadResult = true;
    this.result = result;
    this.nav.reset(this.plan, []);
    this.navWarm = false;
    this.ctxfx.install(result.root);
    this.syncGhostBox();
    this.applyVehicleTargets(true);
    this.configureVisibility();
    this.vis.apply(result.root);
    this.adoptEngineSun(result.root);
    if (this.atmosphere) {
      this.atmosphere.shadowFocus.copy(houseBox(this.plan)).expandByScalar(1.5);
      const sun = this.engineSun ?? this.atmosphere.fallbackSun;
      this.atmosphere.configureShadow(sun, this.store.getState().quality);
    }
    this.syncSun();
    this.colliderDirty = true;
    this.cancelAccel?.();
    this.cancelAccel = accelerateLater(result.root);
    this.perf.settleUntil = performance.now() + 2500;
    const walking = this.store.getState().mode === "walk";
    if (walking) {
      this.ensureCollider();
      if (!this.walk.ready || this.walkerOnFallback) this.spawnWalker(true);
      else if (replacing) this.keepWalkerStanding();
    }
    if (replacing && this.props.preserveCamera === false) {
      if (walking) this.spawnWalker(true);
      else this.placeHero(true);
    } else if (!walking && this.heroPristine) {
      // the app's chrome (the dock) has settled by the time the house is up: frame it against what's really there
      this.placeHero(false, true);
    }
    this.pinEls.clear();
    this.markDirty();
    // engine textures stream in from workers after buildHouse resolves: keep repainting (demand loop) until done
    const pending = engineExtras.texturesReady?.();
    if (pending) {
      const iv = window.setInterval(() => this.invalidate(), 300);
      const stop = () => {
        window.clearInterval(iv);
        this.ctxfx.syncClones();
        this.invalidate();
      };
      pending.then(stop, stop);
      window.setTimeout(() => window.clearInterval(iv), 20000);
    }
  }

  onAnimationsSettled() {
    this.colliderDirty = true;
    this.markDirty();
  }

  private adoptEngineSun(root: THREE.Object3D) {
    const lights: THREE.DirectionalLight[] = [];
    root.traverse((o) => {
      if ((o as THREE.DirectionalLight).isDirectionalLight) lights.push(o as THREE.DirectionalLight);
    });
    const sun = lights.find((l) => l.userData?.kind === "sun") ?? lights.find((l) => l.castShadow) ?? null;
    if (sun === this.engineSun) return;
    this.engineSun = sun;
    // the engine pairs its sun with a hemisphere "sky" fill (engine/lights.ts addSun)
    this.engineHemi = null;
    root.traverse((o) => {
      if (!this.engineHemi && (o as THREE.HemisphereLight).isHemisphereLight) this.engineHemi = o as THREE.HemisphereLight;
    });
    if (sun && this.atmosphere) {
      this.atmosphere.baseIntensity(sun);
      this.atmosphere.setFallbackActive(false);
      this.atmosphere.configureShadow(sun, this.store.getState().quality);
      if (!sun.target.parent) sun.parent?.add(sun.target);
      this.syncSun();
    }
  }

  // ───────────────────────────── crossfade ─────────────────────────────

  /**
   * Freeze the current frame over the canvas (a 2D copy) so a scene swap can dissolve instead of cut. Returns false
   * when there is nothing to show yet or motion is reduced.
   */
  beginCrossfade(): boolean {
    const gl = this.gl, el = this.container;
    if (!gl || !el || !this.currentRoot() || document.hidden) return false;
    try {
      this.renderNow();
      const src = gl.domElement;
      const c = this.xfade ?? document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      c.getContext("2d")!.drawImage(src, 0, 0);
      c.className = "nq-xfade";
      c.style.transition = "none";
      c.style.opacity = "1";
      if (!c.isConnected) el.appendChild(c);
      this.xfade = c;
      return true;
    } catch {
      return false;
    }
  }

  /** Dissolve the frozen frame once the new scene has drawn (two frames later). */
  endCrossfade(ms: number) {
    const c = this.xfade;
    if (!c) return;
    const d = prefersReducedMotion() ? 120 : ms;
    this.markDirty();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.xfade !== c) return;
        c.style.transition = `opacity ${d}ms cubic-bezier(.22, 1, .36, 1)`;
        c.style.opacity = "0";
        window.setTimeout(() => {
          if (this.xfade === c && c.style.opacity === "0") {
            c.remove();
            this.xfade = null;
          }
        }, d + 80);
      }),
    );
  }

  private flashTimer = 0;
  private flashOverlays: THREE.Mesh[] = [];

  /**
   * After a version swap: a 1.2 s accent outline on what changed (DESIGN Revisions), found by diffing the as-built
   * summaries (new elements, or ones that moved or resized by more than 3 inches). Skipped when most of the house
   * changed (a different design altogether) and while walking.
   */
  flashChanges(prev: AsBuiltSummary | null, next: BuildResult, delayMs: number) {
    if (!prev || !this.outline || prefersReducedMotion()) return;
    const before = new Map(prev.objects.map((o) => [o.id, o]));
    const changed = new Set<string>();
    const moved = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 0.25;
    for (const o of next.summary.objects) {
      if (!o.id || o.id === "unknown" || o.id.startsWith("merged_") || /^light:|^collider|^stair:(ramp|landing)/.test(o.kind ?? "")) continue;
      const b = before.get(o.id);
      if (!b || moved(o.bbox_ft.min, b.bbox_ft.min) || moved(o.bbox_ft.max, b.bbox_ft.max)) changed.add(o.id);
    }
    if (!changed.size || changed.size > next.summary.objects.length * 0.35) return;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      if (this.result !== next || this.store.getState().mode !== "orbit" || !this.outline) return;
      this.clearFlash();
      const targets: THREE.Object3D[] = [];
      let budget = 160;
      next.root.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || o.userData?.viewer || budget <= 0) return;
        const parts = o.userData?.parts as PartRange[] | undefined;
        if (parts?.length) {
          for (const part of parts) {
            if (budget <= 0 || !changed.has(String(part.tags.id ?? ""))) continue;
            const ov = partOverlay(m, part);
            if (!ov) continue;
            m.add(ov);
            this.flashOverlays.push(ov);
            targets.push(ov);
            budget--;
          }
        } else if (changed.has(String(o.userData?.id ?? ""))) {
          targets.push(o);
          budget--;
        }
      });
      if (!targets.length) return;
      this.outline.selection.set(targets);
      this.invalidate();
      this.flashTimer = window.setTimeout(() => {
        this.clearFlash();
        // put the hover outline back, if any
        const t = this.outlined;
        this.outlined = null;
        this.setOutline(t);
        this.invalidate();
      }, 1200);
    }, delayMs);
  }

  private clearFlash() {
    for (const ov of this.flashOverlays) {
      ov.removeFromParent();
      ov.geometry.dispose();
    }
    this.flashOverlays = [];
    this.outline?.selection.clear();
  }

  // ───────────────────────────── prop syncs ─────────────────────────────

  private bands(): LevelBand[] {
    if (this.result?.levels?.length) return this.result.levels;
    return this.plan.levels.map((l) => ({ id: l.id, floor_y: l.elevation_ft * FT, top_y: (l.elevation_ft + l.height_ft) * FT }));
  }

  /**
   * Levels to show: the app's `visibleLevels`, further limited by setFloor in orbit. Walking never hides geometry
   * (DESIGN: "it never hides geometry … and never leaves you mid-air").
   */
  private effectiveVisibleLevels(): string[] | undefined {
    const s = this.store.getState();
    if (s.mode === "walk" || this.photo) return undefined;
    const all = this.levelsSorted;
    let ids = this.props.visibleLevels ?? all.map((l) => l.id);
    if (s.orbitFloor) {
      const top = all.find((l) => l.id === s.orbitFloor);
      if (top) ids = ids.filter((id) => (all.find((l) => l.id === id)?.index ?? 0) <= top.index);
    }
    return ids.length === all.length ? undefined : ids;
  }

  private configureVisibility() {
    this.vis.configure({ visibleLevels: this.effectiveVisibleLevels(), layers: this.photo ? undefined : this.props.layers }, this.plan.levels, this.bands());
  }

  /** Which plan levels currently render (after the dollhouse rule). */
  private shownLevels(): Set<string> {
    return new Set(this.plan.levels.filter((l) => !this.vis.levelsShown || this.vis.levelsShown.has(l.id)).map((l) => l.id));
  }

  syncVisibility() {
    const root = this.currentRoot();
    const before = this.shownLevels();
    const animate = !!root && this.store.getState().mode === "orbit" && !prefersReducedMotion() && !this.store.getState().build.first;
    let liftMeshes: THREE.Mesh[] = [];
    if (animate) {
      this.lift.finish();
      this.configureVisibility();
      const after = this.shownLevels();
      const goingAway = [...before].filter((id) => !after.has(id));
      if (goingAway.length) liftMeshes = this.levelMeshes(root!, new Set(goingAway), true);
    } else this.configureVisibility();
    const after = this.shownLevels();
    if (root) this.vis.apply(root);
    this.glow.syncVisibility((o) => this.vis.hiddenByTags(o));
    if (animate) {
      if (liftMeshes.length && this.scene) this.lift.liftAway(liftMeshes, this.scene);
      const arriving = [...after].filter((id) => !before.has(id));
      if (arriving.length) this.lift.settleIn(this.levelRoots(root!, new Set(arriving)));
    }
    this.colliderDirty = true;
    this.colliderTimer = performance.now() + 150;
    this.syncGhostBox();
    this.clearHover();
    this.markDirty();
  }

  /**
   * The volume neighbours must not hide: the plot up to the top of what is on show (a dollhouse cut or a section
   * cut lowers it, so neighbours only ghost where they really cover the house).
   */
  private syncGhostBox() {
    const b = ghostBox(this.plan);
    if (this.vis.levelsShown) {
      const shown = this.bands().filter((l) => this.vis.levelsShown!.has(l.id));
      const top = Math.max(...shown.map((l) => l.top_y), 0);
      if (shown.length) b.max.y = Math.min(b.max.y, top + 0.6);
    }
    const cut = this.clipY();
    if (cut !== null) b.max.y = Math.min(b.max.y, cut);
    b.max.y = Math.max(b.max.y, b.min.y + 0.5);
    this.ctxfx.setHouseBox(b);
  }

  private levelOf(o: THREE.Object3D, root: THREE.Object3D): string | undefined {
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (typeof p.userData?.level === "string") return p.userData.level;
    return undefined;
  }

  /** Visible meshes of these levels (for the lift-away stand-ins). */
  private levelMeshes(root: THREE.Object3D, ids: Set<string>, visibleOnly: boolean): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D) => {
      if (visibleOnly && !o.visible) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && !o.userData?.viewer && !o.userData?.collide && ids.has(this.levelOf(o, root) ?? "")) {
        const mat = m.material as THREE.Material;
        if (mat && mat.visible !== false && mat.colorWrite !== false && mat.blending !== THREE.AdditiveBlending) out.push(m);
      }
      for (const c of o.children) visit(c);
    };
    visit(root);
    return out;
  }

  /** Topmost objects of these levels (moved as units when floors settle back in). */
  private levelRoots(root: THREE.Object3D, ids: Set<string>): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const visit = (o: THREE.Object3D) => {
      const lv = o.userData?.level;
      if (o !== root && typeof lv === "string" && ids.has(lv) && !o.userData?.viewer && o.userData?.kind !== "merged" && o.userData?.kind !== "section") {
        out.push(o);
        return;
      }
      for (const c of o.children) visit(c);
    };
    visit(root);
    return out;
  }

  syncSectionCut() {
    const gl = this.gl;
    if (!gl) return;
    const cut = this.photo ? null : this.props.sectionCut;
    if (cut === null || cut === undefined || !Number.isFinite(cut)) gl.clippingPlanes = [];
    else {
      this.sectionPlane.constant = cut;
      gl.clippingPlanes = [this.sectionPlane];
    }
    this.syncGhostBox();
    this.clearHover();
    this.markDirty();
  }

  syncSun() {
    const atm = this.atmosphere;
    if (!atm) return;
    const facing = (this.plan.site?.facing ?? "N") as Facing;
    // photos: by day (the slider's hour, or mid-afternoon when the view is set to dusk or night)
    const hour = this.photo ? this.photo.hour : this.props.sunHour;
    const root = this.currentRoot();
    const ex = engineExtras;
    const hasHour = hour !== undefined && hour !== null && Number.isFinite(hour);
    let altDeg = 30;
    if (this.engineSun && hasHour && ex.updateSun) {
      // the engine's own sun model: the slider can never disagree with `s.lights.sun({hour})`
      ex.updateSun(this.engineSun, this.plan, hour, this.engineHemi);
      if (root) ex.setTimeOfDay?.(root, this.plan, hour);
      const alt = ex.sunDirection?.(this.plan, hour).altitude;
      atm.syncSkyToLight(this.engineSun, alt, !!this.engineHemi);
      altDeg = alt !== undefined ? (alt * 180) / Math.PI : sunState(hour, facing).altitudeDeg;
    } else if (!hasHour) {
      // no slider: keep the design's own sun (engine set it from `s.lights.sun({hour})`)
      if (this.engineSun) atm.syncSkyToLight(this.engineSun, undefined, !!this.engineHemi);
      else atm.applySun(atm.fallbackSun, sunState(17.5, facing), { owned: false, root });
      altDeg = sunState(17.5, facing).altitudeDeg;
    } else {
      const sun = sunState(hour, facing);
      if (this.engineSun) atm.applySun(this.engineSun, sun, { owned: true, hemi: this.engineHemi, root });
      else atm.applySun(atm.fallbackSun, sun, { owned: false, root });
      altDeg = sun.altitudeDeg;
    }
    // night: the `night` prop, or the slider past dusk (civil twilight)
    const fromSun = hasHour ? 1 - smoothstep(-9, 0.5, altDeg) : 0;
    const n = this.props.night && !this.photo ? 1 : fromSun;
    atm.daylightNight = 1 - smoothstep(-2, 16, altDeg);
    atm.applyNightMode(n, this.engineSun ?? atm.fallbackSun, this.engineHemi, root);
    this.glow.build(this.plan);
    // windows glow at full night (View > Night, the slider well past dusk); Day and Dusk keep their look
    this.glow.setNight(root ? smoothstep(0.35, 1, n) : 0);
    this.glow.syncVisibility((o) => this.vis.hiddenByTags(o));
    this.markDirty();
  }

  syncCommentMode() {
    if (!this.props.commentMode) this.setOutline(null);
    this.invalidate();
  }

  onCommentsChanged() {
    this.pinEls.clear();
    const draft = this.store.getState().draft;
    if (draft) {
      // the draft became a real comment (same anchor): its pin replaces the draft one. Other changes (a teammate's
      // note arriving) leave the draft alone while the composer is still open.
      const near = (a: Vec3 | undefined, b: Vec3) => !!a && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.01;
      const saved = (this.props.comments ?? []).some((c) => near(c.anchor?.position, draft.position));
      if (saved) {
        window.clearTimeout(this.draftTimer);
        this.store.setState({ draft: null });
        if (this.store.getState().walk === "commenting") this.notePinned();
      }
    }
    this.invalidate();
  }

  /** ghostContext / hideVehicles changed. */
  syncContext() {
    this.applyVehicleTargets(false);
    // shown cars are solid while walking, hidden ones are not
    this.colliderDirty = true;
    this.colliderTimer = performance.now() + 150;
    this.invalidate();
  }

  // ───────────────────────────── clear view: ghosting + cars ─────────────────────────────

  private tickGhost(dt: number): boolean {
    const mode = this.store.getState().mode;
    this.ghostTarget = mode === "orbit" && this.props.ghostContext !== false ? 1 : 0;
    // the buildings at the camera fade away (an eye-level street view never looks out of the house opposite)
    if (this.camera && this.ctxfx.updateNear(this.camera, this.ghostTarget > 0)) this.invalidate();
    const g = GHOST.nqGhost;
    if (g.value === this.ghostTarget) return false;
    const step = prefersReducedMotion() ? 1 : dt / 0.42;
    g.value = this.ghostTarget > g.value ? Math.min(this.ghostTarget, g.value + step) : Math.max(this.ghostTarget, g.value - step);
    return true;
  }

  private vehicleTarget(mode: ViewerMode): number {
    const h = this.props.hideVehicles;
    if (mode === "orbit") return h === true ? 0 : 1;
    return h === false ? 1 : 0;
  }

  /** Snap (or start fading) cars toward their target. */
  private applyVehicleTargets(snap: boolean) {
    if (!snap) return;
    const t = this.vehicleTarget(this.store.getState().mode);
    for (const v of this.ctxfx.vehicles) this.ctxfx.setVehicleOpacity(v, t, (o, hidden) => this.vis.suppress(o, hidden));
  }

  private tickVehicles(dt: number, mode: ViewerMode): boolean {
    const vs = this.ctxfx.vehicles;
    if (!vs.length) return false;
    const base = this.vehicleTarget(mode);
    let busy = false;
    const eye = mode === "walk" ? this.walk.eyePosition(new THREE.Vector3()) : null;
    for (const v of vs) {
      let target = base;
      // shown while walking: they are solid, so they only thin out when you get close (never an invisible wall)
      if (eye && target > 0) target = 0.4 + 0.6 * smoothstep(0.6, 2.0, v.box.distanceToPoint(eye));
      if (Math.abs(target - v.opacity) < 0.002) {
        if (v.opacity !== target) this.ctxfx.setVehicleOpacity(v, target, (o, hidden) => this.vis.suppress(o, hidden));
        continue;
      }
      const k = prefersReducedMotion() ? 1 : damp(7, dt);
      const next = Math.abs(target - v.opacity) < 0.01 ? target : v.opacity + (target - v.opacity) * k;
      this.ctxfx.setVehicleOpacity(v, next, (o, hidden) => this.vis.suppress(o, hidden));
      busy = true;
    }
    return busy;
  }

  private tickFrames(now: number): boolean {
    if (!this.frames.length) return false;
    this.frames = this.frames.filter((f) => {
      const t = (now - f.start) / 1900;
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.95 * (1 - smoothstep(0.55, 1, t));
      if (t >= 1) {
        f.mesh.removeFromParent();
        f.mesh.geometry.dispose();
        mat.dispose();
        return false;
      }
      return true;
    });
    return true;
  }

  // ───────────────────────────── quality ─────────────────────────────

  setQuality(q: Quality, lock = false) {
    if (lock) this.perf.locked = true;
    if (this.store.getState().quality === q) return;
    // DPR follows the tier through the Canvas `dpr` prop (HouseViewer re-renders on quality changes)
    this.store.setState({ quality: q });
    const sun = this.engineSun ?? this.atmosphere?.fallbackSun;
    if (sun && this.atmosphere) this.atmosphere.configureShadow(sun, q);
    this.perf.settleUntil = performance.now() + 2500;
    this.markDirty();
  }

  /** Auto-detect slow GPUs from continuous frames only (orbit is demand-rendered): high → balanced → performance. */
  private monitorPerf(dt: number, now: number) {
    if (this.perf.locked || now < this.perf.settleUntil || dt <= 0 || dt > 0.2) return;
    // only sample while frames are back-to-back: walking, or the orbit camera is moving
    const continuous = this.store.getState().mode === "walk" || !!this.controls?.active;
    if (!continuous) return;
    this.perf.sum += dt;
    if (++this.perf.samples < 90) return;
    const fps = this.perf.samples / this.perf.sum;
    this.perf.samples = 0;
    this.perf.sum = 0;
    const q = this.store.getState().quality;
    if (q !== "performance" && fps < 30) this.setQuality("performance");
    else if (q === "high" && fps < 50) this.setQuality("balanced");
    else if (q === "balanced" && fps < 45) this.setQuality("performance");
  }

  // ───────────────────────────── orbit ─────────────────────────────

  /** The hero 3/4 aerial front view, on the sunny side of the house. */
  placeHero(animate: boolean, refit = false) {
    const c = this.controls, cam = this.camera;
    if (!c || !cam || (this.heroDone && !animate && !refit)) return;
    this.heroDone = true;
    this.syncAspect(cam);
    const facing = (this.plan.site?.facing ?? "N") as Facing;
    const sun = sunState(this.props.sunHour ?? 16.5, facing);
    const side: 1 | -1 = sun.dir.x >= 0 ? 1 : -1;
    const pose = heroPose(this.plan, cam, side, 30, 31, this.heroSafe());
    c.setLookAt(pose.position.x, pose.position.y, pose.position.z, pose.target.x, pose.target.y, pose.target.z, animate);
    // until you move the camera yourself, the hero view follows the screen's shape (rotating a phone, a resize)
    this.heroPristine = true;
    this.heroSize = this.canvasSize();
    this.invalidate();
  }

  /** The hero view is on screen and you haven't moved the camera since (a resize then re-frames it). */
  private heroPristine = false;
  private heroSize = "";
  private resizeObs: ResizeObserver | null = null;
  private probeEl: HTMLDivElement | null = null;

  private canvasSize() {
    const el = this.gl?.domElement;
    return el ? `${el.clientWidth}x${el.clientHeight}` : "";
  }

  /** The camera's aspect from the canvas itself, so a fit never uses a stale shape (the first fit on a phone). */
  private syncAspect(cam: THREE.PerspectiveCamera) {
    const el = this.gl?.domElement;
    const w = el?.clientWidth ?? 0, h = el?.clientHeight ?? 0;
    if (w > 0 && h > 0 && Math.abs(cam.aspect - w / h) > 1e-3) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  /** The camera moved for another reason (you, a room, a comment): stop re-framing the hero view on resize. */
  private leaveHero() {
    this.heroPristine = false;
  }

  /** A CSS length the app's shell publishes (e.g. --chrome-top, --dock-h), in px, or the fallback. */
  private cssLength(name: string, fallback: number): number {
    const host = this.container;
    if (!host || typeof document === "undefined") return fallback;
    if (!this.probeEl || this.probeEl.parentElement !== host) {
      this.probeEl = document.createElement("div");
      this.probeEl.setAttribute("aria-hidden", "true");
      this.probeEl.style.cssText = "position:absolute;left:0;top:0;width:0;visibility:hidden;pointer-events:none";
      host.appendChild(this.probeEl);
    }
    this.probeEl.style.height = `var(${name}, ${fallback}px)`;
    const h = this.probeEl.getBoundingClientRect().height;
    return Number.isFinite(h) ? h : fallback;
  }

  /**
   * Phones (a canvas under 768 px wide): the part of the canvas the hero view may use, clear of the app's top chrome
   * (its row and view switch) and the dock, with 16 px at the sides. Null on wider screens (the usual margins).
   */
  private heroSafe(): SafeArea | null {
    const el = this.gl?.domElement;
    if (!el) return null;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h || w >= 768) return null;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || h;
    const chromeBottom = this.cssLength("--chrome-top", 120);
    const dockTop = vh - this.cssLength("--dock-h", 96);
    const top = Math.max(0, chromeBottom - r.top) + 8;
    const bottom = Math.max(0, r.bottom - dockTop) + 8;
    // never squeeze the house into a sliver if the chrome is unusually tall
    if (h - top - bottom < h * 0.35) return { w, h, top: h * 0.2, bottom: h * 0.2, left: 16, right: 16 };
    return { w, h, top, bottom, left: 16, right: 16 };
  }

  /** The canvas changed shape: re-frame the hero view if it's still the one on screen. */
  private onResize = () => {
    const size = this.canvasSize();
    if (!size || size === this.heroSize) return;
    if (this.heroPristine && this.store.getState().mode === "orbit" && this.camera) this.placeHero(false, true);
    else this.heroSize = size;
  };

  focusAt(clientX: number, clientY: number) {
    const c = this.controls;
    const hit = this.pickClient(clientX, clientY);
    if (!c || !hit || !this.camera) return;
    const cam = this.camera;
    const dir = cam.position.clone().sub(hit.point).normalize();
    const dist = THREE.MathUtils.clamp(cam.position.distanceTo(hit.point) * 0.45, 2.5, 14);
    const pos = hit.point.clone().addScaledVector(dir, dist);
    pos.y = Math.max(pos.y, hit.point.y + 0.4);
    this.leaveHero();
    c.setLookAt(pos.x, pos.y, pos.z, hit.point.x, hit.point.y, hit.point.z, true);
  }

  /** Orbit: show the house up to `levelId` (dollhouse cut); null shows every floor. */
  setOrbitFloor(levelId: string | null) {
    if (this.store.getState().orbitFloor === levelId) return;
    this.store.setState({ orbitFloor: levelId });
    this.syncVisibility();
  }

  /** Orbit goToRoom: cut the house at the room's floor and look down into it, with a brief outline. */
  private frameRoom(room: Room) {
    const lvl = this.plan.levels.find((l) => l.id === room.level);
    const c = this.controls;
    if (!lvl || !c) return;
    const top = this.levelsSorted[this.levelsSorted.length - 1];
    this.setOrbitFloor(top && top.id === lvl.id ? null : lvl.id);
    const az = c.azimuthAngle;
    const pose = roomPose(room.rect, lvl.elevation_ft, az);
    this.leaveHero();
    c.setLookAt(pose.position.x, pose.position.y, pose.position.z, pose.target.x, pose.target.y, pose.target.z, !prefersReducedMotion());
    if (this.scene) {
      const f = roomFrame(room.rect, lvl.elevation_ft);
      this.scene.add(f);
      this.frames.push({ mesh: f, start: performance.now() });
    }
    this.invalidate();
  }

  // ───────────────────────────── handle: floors, rooms, reset ─────────────────────────────

  setFloor(levelId: string) {
    const lvl = this.plan.levels.find((l) => l.id === levelId) ?? null;
    if (this.store.getState().mode === "walk") {
      if (lvl) this.walkToLevel(lvl);
      return;
    }
    this.setOrbitFloor(lvl ? (lvl.id === this.levelsSorted[this.levelsSorted.length - 1]?.id ? null : lvl.id) : null);
  }

  goToRoom(roomId: string) {
    const room = this.plan.rooms.find((r) => r.id === roomId);
    if (!room) {
      console.warn(`[viewer] goToRoom: no room "${roomId}"`);
      return;
    }
    if (this.store.getState().mode === "walk") this.walkToRoom(room);
    else if (this.nav.isVoid(room)) this.toast("That's open to the floor below");
    else this.frameRoom(room);
  }

  resetView() {
    this.store.setState({ orbitFloor: null });
    if (this.store.getState().mode === "walk") this.leaveWalk("user");
    else this.syncVisibility();
    this.placeHero(true);
  }

  // ───────────────────────────── modes ─────────────────────────────

  setMode(next: ViewerMode, source: ModeSource) {
    const prev = this.store.getState().mode;
    if (prev === next) return;
    if (next === "walk") this.enterWalk(false);
    else this.leaveWalk(source);
  }

  private enterWalk(initial: boolean) {
    this.leaveHero();
    this.store.setState({ mode: "walk", walk: "intro", target: null, hover: null, idle: false, help: false });
    const cam = this.camera, c = this.controls;
    if (!cam) return; // attachThree() calls back once the canvas exists
    this.clearHover();
    this.builds.finishAnims();
    this.lift.finish();
    // every floor comes back while walking
    this.configureVisibility();
    const root = this.currentRoot();
    if (root) this.vis.apply(root);
    this.colliderDirty = true;
    this.ensureCollider();
    this.spawnWalker(false);
    if (c) {
      c.suspended = true;
      c.enabled = false;
    }
    this.walk.fov = walkFov(cam.aspect);
    this.walk.enabled = false;
    this.walk.beginTransition(cam, initial || prefersReducedMotion() ? 0.01 : 1.15);
    this.perf.settleUntil = performance.now() + 2500;
    this.lastRoomKey = undefined;
    this.markDirty();
  }

  /** The main door from the plan: stand outside it, facing in (DESIGN "Spawn at the main door, facing in"). */
  private doorSpawn(): { pos: THREE.Vector3; look: THREE.Vector3 } | null {
    const plan = this.plan;
    const ground = this.levelsSorted.find((l) => l.index >= 0) ?? this.levelsSorted[0];
    if (!ground) return null;
    const ops = (plan.openings ?? []).filter((o) => o.level === ground.id);
    const roomOf = (id: string) => plan.rooms.find((r) => r.id === id);
    const outsideish = (id: string) => id === "exterior" || OUTDOOR.has(roomOf(id)?.type ?? "");
    const main =
      ops.find((o) => o.type === "main_door") ??
      ops.find((o) => (o.type === "door" || o.type === "double_door") && o.between.some(outsideish) && o.between.some((b) => !outsideish(b)));
    if (!main) return null;
    const inside = main.between.map(roomOf).find((r) => r && !OUTDOOR.has(r.type));
    if (!inside) return null;
    const [ax, ay] = main.at;
    const r = inside.rect;
    const sides: [number, number, number][] = [
      [Math.abs(ay - r.y), 0, -1],
      [Math.abs(ay - (r.y + r.d)), 0, 1],
      [Math.abs(ax - r.x), -1, 0],
      [Math.abs(ax - (r.x + r.w)), 1, 0],
    ];
    sides.sort((a, b) => a[0] - b[0]);
    const [, nx, ny] = sides[0];
    const elev = ground.elevation_ft;
    return { pos: planToWorld(ax + nx * 6.5, ay + ny * 6.5, elev), look: planToWorld(ax, ay, elev + 5.2) };
  }

  private spawnWalker(force: boolean) {
    const res = this.result;
    if (res && (force || !this.spawnedFor.has(res))) {
      this.spawnedFor.add(res);
      const door = this.doorSpawn();
      if (door) {
        this.walk.setSpawn(door.pos, door.look);
        // the door spot must be on a floor and free; otherwise trust the engine's spawn
        if (this.walk.overlaps(this.walk.feet) || Math.abs(this.walk.feet.y - door.pos.y) > 1.2) this.engineSpawn(res);
      } else this.engineSpawn(res);
      this.walkerOnFallback = false;
    } else if (!this.walk.ready) {
      // no house yet: stand on the road facing the plot until the build lands
      const W = this.plan.site.plot.width_ft;
      this.walk.setSpawn(planToWorld(W / 2, -6, 0), planToWorld(W / 2, 26, 5.2));
      this.walkerOnFallback = true;
    }
  }

  private engineSpawn(res: BuildResult) {
    const p = res.spawn.position.clone();
    const levels = [...this.plan.levels].sort((a, b) => b.elevation_ft - a.elevation_ft);
    const lvl = levels.find((l) => l.elevation_ft * FT <= p.y + 0.35) ?? levels[levels.length - 1];
    this.walk.setSpawn(p, res.spawn.lookAt.clone(), lvl ? lvl.elevation_ft * FT : undefined);
  }

  /** After a rebuild under your feet: stay put if you still can, else step to the nearest free spot. */
  private keepWalkerStanding() {
    const f = this.walk.feet;
    const g = this.walk.groundAt(f, f.y + 0.4, f.y - 0.6);
    if (g !== null && !this.walk.overlaps(f.clone().setY(g))) {
      f.y = g;
      return;
    }
    const spot = this.walk.findFreeSpot(f, g ?? f.y, 3);
    if (spot) this.walk.place(spot, this.walk.yaw, this.walk.pitch);
    else this.spawnWalker(true);
  }

  private onIntroDone() {
    const s = this.store.getState();
    if (s.walk !== "intro") return;
    this.walk.enabled = true;
    this.lastInput = performance.now();
    this.store.setState({ walk: this.isLocked() ? "look" : "free" });
    this.maybeShowHints();
    if (!this.isLocked()) this.showLookPrompt();
  }

  private maybeShowHints() {
    let seen = false;
    try {
      seen = localStorage.getItem(HINTS_KEY) === "1";
      localStorage.setItem(HINTS_KEY, "1");
    } catch {
      /* storage blocked: show it this once */
    }
    if (seen) return;
    this.store.setState({ hints: true });
    window.clearTimeout(this.hintsTimer);
    this.hintsTimer = window.setTimeout(() => this.store.setState({ hints: false }), 4000);
  }

  private leaveWalk(source: ModeSource) {
    if (this.isLocked()) document.exitPointerLock?.();
    this.walk.enabled = false;
    this.walk.transition = null;
    if (this.walk.glide) this.walk.cancelGlide();
    this.walk.input.keys.clear();
    this.walk.input.turn.yaw = this.walk.input.turn.pitch = 0;
    window.clearTimeout(this.routeTimer);
    const cam = this.camera, c = this.controls;
    window.clearTimeout(this.promptTimer);
    window.clearTimeout(this.pinnedTimer);
    this.hudHover = this.hudPointer = this.hudFocus = false;
    this.store.setState({ mode: "orbit", walk: "off", target: null, room: null, roomId: null, level: null, gliding: false, route: null, idle: false, hints: false, prompt: false, pinned: false, help: false, mapLevel: null });
    this.fireRoomChange(null, null);
    this.setOutline(null);
    this.syncVisibility();
    if (cam && c) {
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const ahead = cam.position.clone().addScaledVector(fwd, 3.5);
      c.suspended = false;
      c.enabled = true;
      c.setLookAt(cam.position.x, cam.position.y, cam.position.z, ahead.x, ahead.y, ahead.z, false);
      if (source !== "flyTo") {
        // a calm overview from the side you were looking at (not hovering over the water tank)
        const h = new THREE.Vector3(fwd.x, 0, fwd.z);
        if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
        h.normalize();
        // keep your heading when it shows the street side (a three-quarter front view, never side-on over a
        // neighbour's roof); otherwise the usual sunny three-quarter front view
        const sunny = 30 * (sunState(this.props.sunHour ?? 16.5, (this.plan.site?.facing ?? "N") as Facing).dir.x >= 0 ? 1 : -1);
        let azDeg = THREE.MathUtils.radToDeg(Math.atan2(-h.x, -h.z));
        if (Math.abs(azDeg) > 55) azDeg = sunny;
        else azDeg = clamp(Math.abs(azDeg), 18, 40) * (azDeg < 0 ? -1 : 1);
        // and never from over (or inside) a neighbouring house: try the mirror view, then the sunny one
        const candidates = [azDeg, -azDeg, sunny, -sunny, 0];
        this.syncAspect(cam);
        const safe = this.heroSafe();
        let pose = heroPose(this.plan, cam, 1, azDeg, 32, safe);
        for (const az of candidates) {
          const p = heroPose(this.plan, cam, 1, az, 32, safe);
          if (!this.overNeighbour(p.position)) {
            pose = p;
            break;
          }
        }
        c.setLookAt(pose.position.x, pose.position.y, pose.position.z, pose.target.x, pose.target.y, pose.target.z, !prefersReducedMotion());
      }
    }
    this.fovTarget = ORBIT_FOV;
    this.invalidate();
    if (source !== "props" && this.props.mode !== "orbit") {
      try {
        this.props.onExitWalk?.(source === "flyTo" ? "flyTo" : "exit");
      } catch (e) {
        console.warn("[viewer] onExitWalk threw", e);
      }
    }
  }

  /**
   * Is this camera spot above or inside a house on our side of the street (its footprint grown by 2 m)? From over
   * the row across the road the house is framed over the street, so that one doesn't count.
   */
  private overNeighbour(p: THREE.Vector3): boolean {
    return this.ctxfx.buildings.some((b) => b.min.z < 0 && p.x > b.min.x - 2 && p.x < b.max.x + 2 && p.z > b.min.z - 2 && p.z < b.max.z + 2);
  }

  /**
   * F / "Finish": ask the app to wrap up. The viewer only frees the pointer (so a confirm sheet can be used) and
   * stays in walk mode; the app confirms and then sets `mode` to "orbit" — or keeps walking if you cancel.
   */
  finishWalk() {
    if (this.store.getState().mode !== "walk") return;
    if (this.isLocked()) document.exitPointerLock?.();
    this.walk.input.keys.clear();
    try {
      this.props.onExitWalk?.("finish");
    } catch (e) {
      console.warn("[viewer] onExitWalk threw", e);
    }
  }

  /** Exit / Back-to-overview: leave walk mode, onExitWalk("exit"). */
  exitWalk() {
    if (this.store.getState().mode !== "walk") return;
    this.leaveWalk("user");
  }

  // ───────────────────────────── walk navigation ─────────────────────────────

  private currentLevel(): Level {
    return this.nav.levelAt(this.walk.feet.y);
  }

  /** Floor stack while walking: glide up/down the stair to that floor's landing, facing into the floor. */
  private walkToLevel(lvl: Level) {
    if (!this.camera) return;
    if (this.walk.transition) this.walk.transition.t = 1;
    this.ensureCollider();
    if (!this.walk.ready || !this.collider) return;
    if (this.currentLevel().id === lvl.id && !this.walk.glide) {
      this.toast(`You're on the ${lvl.name.toLowerCase()}`);
      return;
    }
    this.walk.cancelGlide();
    const feet = this.walk.feet.clone();
    const route = this.nav.route(feet, { kind: "level", level: lvl });
    const floorName = lvl.name.toLowerCase();
    if (route.ok && route.pts.length > 1 && !route.rough) {
      this.startGlide(route);
      return;
    }
    // sealed off where you stand (a yard you were brought into): walk on from the nearest connected spot
    const out = route.rough || !route.ok ? this.nav.escape(feet) : null;
    if (out) {
      const alt = this.nav.route(out.clone(), { kind: "level", level: lvl });
      if (alt.ok && alt.pts.length > 1 && !alt.rough) {
        const a = alt.pts[0], b = alt.pts[Math.min(alt.pts.length - 1, 6)];
        this.jumpTo(out, Math.hypot(b.x - a.x, b.z - a.z) > 0.05 ? Math.atan2(-(b.x - a.x), -(b.z - a.z)) : this.walk.yaw, -0.06);
        this.toast(`Taking you to the ${floorName}`);
        this.startGlide(alt);
        return;
      }
    }
    if (route.ok && route.pts.length > 1) {
      // the way to the stair is only on the plan (furniture in it): never glide through anything at eye height
      if (route.blocked) {
        this.jumpTo(route.end, route.yaw, route.pitch);
        this.toast(`Taking you to the ${floorName}`);
      } else this.startGlide(route);
      return;
    }
    // no stair joins these floors: hop there directly (crossfade) to the stair hall or the biggest room
    const spot = this.levelFallbackSpot(lvl);
    if (!spot) {
      this.toast(`No clear spot on the ${lvl.name.toLowerCase()}`);
      return;
    }
    this.jumpTo(spot, this.nav.intoFloorYaw(lvl, spot), -0.06);
    this.toast(`No stair reaches the ${lvl.name.toLowerCase()} yet, so I've taken you straight there`);
  }

  private levelFallbackSpot(lvl: Level): THREE.Vector3 | null {
    const rooms = this.plan.rooms.filter((r) => r.level === lvl.id);
    const enclosed = rooms.filter((r) => !OUTDOOR.has(r.type));
    const pickRoom = enclosed.find((r) => r.type === "stair") ?? [...enclosed].sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)[0];
    let target: THREE.Vector3;
    if (pickRoom) target = planToWorld(pickRoom.rect.x + pickRoom.rect.w / 2, pickRoom.rect.y + pickRoom.rect.d / 2, lvl.elevation_ft);
    else {
      const m = this.plan.roof?.mumty?.rect;
      const W = this.plan.site.plot.width_ft, D = this.plan.site.plot.depth_ft;
      target = m ? planToWorld(m.x + m.w + 3, m.y + m.d / 2, lvl.elevation_ft) : planToWorld(W / 2, D / 2, lvl.elevation_ft);
    }
    return this.walk.findFreeSpot(target, lvl.elevation_ft * FT) ?? this.walk.findFreeSpot(target.clone().setY(target.y + 0.3), lvl.elevation_ft * FT);
  }

  /**
   * Room navigator while walking: glide there along the walk grid. When no walk gets there, crossfade straight into
   * the room (always inside its walls) and say why, naming the real cause: planting, furniture, or no door. Standing
   * somewhere sealed off yourself (a yard you were brought into), walk on from the nearest connected spot.
   */
  private walkToRoom(room: Room) {
    if (!this.camera) return;
    if (this.walk.transition) this.walk.transition.t = 1;
    this.ensureCollider();
    if (!this.walk.ready || !this.collider) return;
    this.walk.cancelGlide();
    const name = inSentence(room.name);
    if (this.nav.isVoid(room)) {
      this.toast("That's open to the floor below");
      return;
    }
    const feet = this.walk.feet.clone();
    const clean = (r: RoutePlan) => r.ok && !r.rough && !r.blocked;
    const route = this.nav.route(feet, { kind: "room", room });
    if (clean(route)) {
      if (route.pts.length > 1) this.startGlide(route, room.id);
      else this.walk.place(feet, route.yaw, route.pitch); // already there: just look into the room
      return;
    }
    // sealed off where you stand: hop to the nearest connected spot and walk on from there
    const out = this.nav.escape(feet);
    if (out) {
      const alt = this.nav.route(out.clone(), { kind: "room", room });
      if (clean(alt) && alt.pts.length > 1) {
        const a = alt.pts[0], b = alt.pts[Math.min(alt.pts.length - 1, 6)];
        this.jumpTo(out, Math.hypot(b.x - a.x, b.z - a.z) > 0.05 ? Math.atan2(-(b.x - a.x), -(b.z - a.z)) : this.walk.yaw, -0.06);
        this.toast(`Taking you to the ${name}`);
        this.startGlide(alt, room.id);
        return;
      }
    }
    const stance = this.nav.roomStance(room);
    if (!stance) {
      this.toast(`There's no room to stand in the ${name}`);
      return;
    }
    // why (asked from the connected spot when you stand sealed off: the room's own trouble, not yours)
    const cause: BlockCause | "stair" = !route.ok && route.reason === "no stair" ? "stair" : this.nav.blockCause(room, out ?? feet);
    this.jumpTo(stance.end, stance.yaw, -0.06);
    const lvl = this.plan.levels.find((l) => l.id === room.level);
    const why: Record<BlockCause | "stair", string> = {
      planting: `Planting blocks the way into the ${name}`,
      furniture: `Furniture blocks the way into the ${name}`,
      other: `Something solid blocks the way into the ${name}`,
      nodoor: `No door reaches the ${name} yet`,
      stair: `No stair reaches the ${(lvl?.name ?? "floor").toLowerCase()} yet`,
    };
    this.toast(`${why[cause]}, so I've brought you straight in`);
  }

  /** Minimap click on open ground (no room there): walk to that spot. */
  walkToPoint(levelId: string, xFt: number, yFt: number) {
    const lvl = this.plan.levels.find((l) => l.id === levelId);
    if (!lvl || this.store.getState().mode !== "walk") return;
    if (this.walk.transition) this.walk.transition.t = 1;
    this.ensureCollider();
    if (!this.walk.ready || !this.collider) return;
    this.walk.cancelGlide();
    const target = { kind: "point" as const, level: lvl, x: xFt * FT, z: zOf(yFt) };
    const feet = this.walk.feet.clone();
    const route = this.nav.route(feet, target);
    if (route.ok && route.pts.length > 1 && !route.rough) {
      this.startGlide(route);
      return;
    }
    // sealed off where you stand: walk on from the nearest connected spot (never glide through a wall or a hedge)
    const out = this.nav.escape(feet);
    const alt = out ? this.nav.route(out.clone(), target) : null;
    if (out && alt && alt.ok && alt.pts.length > 1 && !alt.rough) {
      const a = alt.pts[0], b = alt.pts[Math.min(alt.pts.length - 1, 6)];
      this.jumpTo(out, Math.hypot(b.x - a.x, b.z - a.z) > 0.05 ? Math.atan2(-(b.x - a.x), -(b.z - a.z)) : this.walk.yaw, -0.06);
      this.startGlide(alt);
      return;
    }
    if (route.ok && route.pts.length > 1 && !route.blocked) this.startGlide(route);
    else this.toast("No way to walk there");
  }

  /** Draw the route on the minimap (300 ms), then glide along it. */
  private startGlide(route: RoutePlan, toRoom?: string) {
    window.clearTimeout(this.routeTimer);
    const id = ++this.routeSeq;
    this.hideLookPrompt();
    this.walk.input.look.dx = this.walk.input.look.dy = 0;
    this.store.setState({ route: { id, byLevel: route.byLevel, to: toRoom }, gliding: true, mapLevel: null, idle: false });
    // the app's room pill reads the destination until arrival (endGlide names the room actually reached)
    const dest = this.placeAt(route.end, toRoom);
    this.fireRoomChange(dest.roomId, dest.levelId);
    if (prefersReducedMotion()) {
      this.jumpTo(route.end, route.yaw, route.pitch);
      this.endGlide(id);
      return;
    }
    const go = () => {
      if (this.routeSeq !== id || this.store.getState().mode !== "walk") return;
      this.walk.beginGlide(route.pts, glideSeconds(route), route.yaw, route.pitch, () => this.endGlide(id), undefined, route.weights);
    };
    this.routeTimer = window.setTimeout(go, 300);
  }

  private endGlide(id: number) {
    if (this.routeSeq !== id) return;
    this.store.setState({ gliding: false });
    this.updateRoomLabel();
    this.lastInput = performance.now();
    window.clearTimeout(this.routeTimer);
    this.routeTimer = window.setTimeout(() => {
      if (this.routeSeq === id) this.store.setState({ route: null });
    }, 700);
  }

  /** Teleport with a short crossfade (no route, or reduced motion). */
  private jumpTo(feet: THREE.Vector3, yaw: number, pitch: number) {
    const fade = this.beginCrossfade();
    this.walk.cancelGlide();
    this.walk.place(feet, yaw, pitch);
    if (fade) this.endCrossfade(300);
    this.updateRoomLabel();
  }

  // ───────────────────────────── pointer lock ─────────────────────────────

  /** Start / resume mouse look: pointer lock on desktop (needs a user gesture); touch and drag mode just walk. */
  requestLock() {
    const s = this.store.getState();
    if (s.mode !== "walk") return;
    if (this.walk.transition) this.walk.transition.t = 1;
    if (s.walk === "commenting") this.resumeWalk(false);
    if (s.touch || s.lockRefused) {
      this.walk.enabled = true;
      if (this.store.getState().walk !== "free") this.store.setState({ walk: "free" });
      return;
    }
    const el = this.gl?.domElement as (HTMLCanvasElement & { requestPointerLock(o?: unknown): Promise<void> | void }) | undefined;
    if (!el?.requestPointerLock) {
      this.onLockFailed();
      return;
    }
    const plain = () => {
      try {
        const p2 = el.requestPointerLock();
        if (p2 && typeof (p2 as Promise<void>).catch === "function") (p2 as Promise<void>).catch(() => this.onLockFailed());
      } catch {
        this.onLockFailed();
      }
    };
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(plain);
    } catch {
      plain();
    }
  }

  /**
   * Chrome refuses a re-lock for ~1 s after the user pressed Esc. If lock has worked before in this session, that is
   * the likely cause: ask for another click instead of dropping to drag-to-look for good.
   */
  private onLockFailed() {
    // one message only: the centre prompt ("Click to look around" again, or "Drag to look around"), never a toast too
    if (!this.lockEverSucceeded) this.store.setState({ lockRefused: true });
    if (this.store.getState().walk === "free") this.showLookPrompt();
  }

  isLocked() {
    return !!this.gl && document.pointerLockElement === this.gl.domElement;
  }

  private onPointerLockChange = () => {
    const s = this.store.getState();
    if (this.isLocked()) {
      this.lockEverSucceeded = true;
      this.walk.lookLag = 40;
      if (s.mode === "walk" && s.walk !== "intro") {
        this.walk.enabled = true;
        this.store.setState({ walk: "look", lockRefused: false, target: null });
        this.hideLookPrompt(true);
      }
    } else {
      this.unlockedAt = performance.now();
      if (s.walk === "look") {
        this.walk.input.keys.clear();
        this.store.setState({ walk: "free", target: null });
        // let go of the mouse (Esc): say once more how to get it back
        this.showLookPrompt();
      }
      this.setOutline(null);
    }
  };

  private onPointerLockError = () => this.onLockFailed();

  private onLockedMouseMove = (e: MouseEvent) => {
    if (!this.isLocked() || !this.walk.enabled || this.walk.glide) return;
    this.activity();
    // clamp occasional spikes from some platforms
    this.walk.input.look.dx += THREE.MathUtils.clamp(e.movementX, -180, 180) * LOCK_SENS;
    this.walk.input.look.dy += THREE.MathUtils.clamp(e.movementY, -180, 180) * LOCK_SENS;
  };

  /** Leave the commenting pause and walk again (re-locking the pointer when that is how you were looking). */
  resumeWalk(relock = true) {
    const s = this.store.getState();
    if (s.mode !== "walk") return;
    window.clearTimeout(this.pinnedTimer);
    this.walk.enabled = true;
    this.lastInput = performance.now();
    this.store.setState({ walk: "free", pinned: false });
    if (relock && !s.touch && !s.lockRefused) this.requestLock();
    else this.showLookPrompt();
  }

  /**
   * The app closed the comment composer without saving (Esc, ×): drop the draft pin and walk on right away.
   * Exposed on the handle (`cancelDraft`).
   */
  cancelDraft() {
    window.clearTimeout(this.draftTimer);
    if (this.store.getState().draft) this.store.setState({ draft: null });
    if (this.store.getState().walk === "commenting") this.resumeWalk(false);
    this.invalidate();
  }

  /** The note was saved: "Note pinned" for about 2 s, then walking resumes. */
  private notePinned() {
    window.clearTimeout(this.pinnedTimer);
    this.store.setState({ pinned: true });
    this.pinnedTimer = window.setTimeout(() => {
      this.store.setState({ pinned: false });
      if (this.store.getState().walk === "commenting") this.resumeWalk(false);
    }, 2000);
  }

  setHelp(open: boolean) {
    this.store.setState({ help: open, hints: false });
    if (open) this.activity();
  }

  setMapLevel(levelId: string | null) {
    this.store.setState({ mapLevel: levelId });
    this.activity();
  }

  // ───────────────────────────── keyboard ─────────────────────────────

  private onKeyDown = (e: KeyboardEvent) => {
    const s = this.store.getState();
    if (s.mode !== "walk" || !s.active || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    let walking = s.walk === "free" || s.walk === "look";
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (MOVE_KEYS.has(e.code)) {
      // "Note pinned" is showing: a step means walk on now
      if (s.walk === "commenting" && s.pinned && !s.draft) {
        this.resumeWalk(false);
        walking = true;
      }
      if (walking) {
        this.activity();
        if (e.code !== "ShiftLeft" && e.code !== "ShiftRight") this.hideLookPrompt();
        // the route is still drawing: walking yourself wins
        if (s.gliding && !this.walk.glide && e.code !== "ShiftLeft" && e.code !== "ShiftRight") {
          window.clearTimeout(this.routeTimer);
          this.routeSeq++;
          this.store.setState({ gliding: false, route: null });
        }
        this.walk.input.keys.add(e.code);
        consume();
      }
      return;
    }
    if (e.repeat) {
      if (e.code === "Space") e.preventDefault();
      return;
    }
    switch (e.code) {
      case "KeyC":
        if (walking) {
          consume();
          this.placeComment(0, 0, true);
        }
        break;
      case "KeyF":
        if (s.walk !== "intro") {
          consume();
          this.finishWalk();
        }
        break;
      case "Slash":
        if (e.shiftKey) {
          consume();
          this.setHelp(!s.help);
        }
        break;
      case "Enter":
      case "Space":
        // a focused button (the app's Next, a sheet) keeps its own Enter/Space
        if ((e.target as Element | null)?.closest?.("button, a[href], [role='button'], summary")) break;
        if (s.walk === "free" || s.walk === "commenting") {
          consume();
          this.requestLock();
        } else if (e.code === "Space") e.preventDefault();
        break;
      default: {
        // floors by the floor stack's own labels: G (or 0), 1, 2…, R, B; a number no floor carries says which exist
        if (!walking) break;
        const lvl = levelForKey(e.code, this.plan.levels);
        if (lvl) {
          consume();
          this.setFloor(lvl.id);
        } else if (isFloorNumberKey(e.code)) {
          consume();
          this.toast(`This home has ${floorList(this.plan.levels)}`);
        }
      }
    }
  };

  /** Esc runs last (bubble phase) so an app sheet that handles it first (preventDefault) wins. */
  private onKeyDownLate = (e: KeyboardEvent) => {
    if (e.code !== "Escape" || e.defaultPrevented || isEditable(e.target)) return;
    const s = this.store.getState();
    if (s.mode !== "walk" || !s.active) return;
    // the Esc that released the pointer lock is not also "leave walk"
    if (this.isLocked() || performance.now() - this.unlockedAt < 400) return;
    if (s.help) return this.setHelp(false);
    if (s.walk === "commenting") return this.resumeWalk(false);
    if (s.gliding) {
      this.walk.cancelGlide();
      return;
    }
    if (s.walk === "free" || s.walk === "intro") this.exitWalk();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.walk.input.keys.delete(e.code);
  };

  private onBlur = () => {
    this.walk.input.keys.clear();
    this.walk.input.joy.x = this.walk.input.joy.y = 0;
    this.walk.input.turn.yaw = this.walk.input.turn.pitch = 0;
  };

  // ───────────────────────────── pointer ─────────────────────────────

  private isUiEvent(e: Event) {
    const t = e.target as Element | null;
    return !!t?.closest?.("[data-nq-ui]");
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.container!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.isUiEvent(e)) return;
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, id: e.pointerId, type: e.pointerType };
    const s = this.store.getState();
    if (s.mode !== "walk") return;
    this.activity();
    if (e.pointerType !== "touch" && !this.isLocked() && (s.walk === "free" || s.walk === "commenting")) {
      // drag to look (any button; right-drag for people who'd rather not lock the pointer)
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
      this.walk.lookLag = 18;
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const s = this.store.getState();
    if (s.mode === "walk") {
      if (e.pointerType === "touch") return;
      this.activity();
      const d = this.drag;
      if (d && e.buttons && s.walk === "free" && !this.walk.glide) {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        d.moved += Math.abs(dx) + Math.abs(dy);
        if (d.moved > 8 && (s.prompt || s.hints)) this.hideLookPrompt(true);
        if (d.moved > 40 && !s.dragged) this.store.setState({ dragged: true });
        this.walk.input.look.dx += dx * DRAG_SENS;
        this.walk.input.look.dy += dy * DRAG_SENS;
        this.walk.input.turn.yaw = 0;
        return;
      }
      this.edgeLook(e);
      return;
    }
    if (this.isUiEvent(e) || e.pointerType === "touch") return;
    if (e.buttons) {
      if (this.store.getState().hover) this.clearHover();
      return;
    }
    const p = this.local(e);
    this.hoverPending = { x: p.x, y: p.y };
    if (this.tooltipEl) this.tooltipEl.style.transform = `translate3d(${Math.round(p.x + 16)}px, ${Math.round(p.y + 18)}px, 0)`;
    this.invalidate();
  };

  /**
   * Hover-at-the-edge look for embedded browsers without pointer lock: resting the mouse near the left or right
   * edge turns the view (after a short dwell, so passing through on the way to a button does nothing).
   */
  private edgeLook(e: PointerEvent) {
    const s = this.store.getState();
    const turn = this.walk.input.turn;
    if (!s.lockRefused || s.walk !== "free" || e.buttons || this.isUiEvent(e) || this.walk.glide || !this.container) {
      turn.yaw = 0;
      this.edge.side = 0;
      return;
    }
    const p = this.local(e);
    const band = Math.min(90, p.w * 0.07);
    let side = p.x < band ? -1 : p.x > p.w - band ? 1 : 0;
    // never while the pointer is on, or within 24 px of, any control (the floor rail, the bottom-left buttons…)
    if (side && this.nearHud(e.clientX, e.clientY, 24)) side = 0;
    const now = performance.now();
    if (side !== this.edge.side) {
      this.edge = { since: now, side };
      turn.yaw = 0;
      return;
    }
    if (!side || now - this.edge.since < 260) {
      turn.yaw = 0;
      return;
    }
    const depth = side < 0 ? 1 - p.x / band : 1 - (p.w - p.x) / band;
    turn.yaw = side * (0.35 + 1.0 * clamp(depth, 0, 1));
    this.hideLookPrompt(true);
  }

  /**
   * Is anything but the 3D view under the pointer or within `pad` px of it? The app's chrome floats over the viewer
   * as siblings (not our children), so this asks the document what is on top at a few points around the cursor.
   */
  private nearHud(x: number, y: number, pad: number): boolean {
    const c = this.container;
    if (!c) return false;
    for (const dy of [0, -pad, pad])
      for (const dx of [0, -pad, pad]) {
        const el = document.elementFromPoint(x + dx, y + dy);
        if (!el) continue;
        if (!c.contains(el) || el.closest("[data-nq-ui], button, a[href], input, select, textarea, [role='button']")) return true;
      }
    return false;
  }

  private onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    const drag = this.drag;
    this.drag = null;
    if (!d || this.isUiEvent(e)) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) + (drag?.moved ?? 0) * 0.25;
    if (e.type === "pointercancel" || moved > 6 || performance.now() - d.t > 650) return;
    if (d.button === 0) this.onClick(e);
  };

  private onClick(e: PointerEvent) {
    const s = this.store.getState();
    if (s.mode === "orbit") {
      if (this.props.commentMode) {
        const p = this.local(e);
        this.placeComment((p.x / p.w) * 2 - 1, -(p.y / p.h) * 2 + 1, false);
      }
      return;
    }
    if (s.walk === "intro") {
      if (this.walk.transition) this.walk.transition.t = 1;
      return;
    }
    if (s.walk === "commenting") {
      this.resumeWalk(true);
      return;
    }
    if (s.walk === "look") {
      if (this.props.commentMode) this.placeComment(0, 0, true);
      return;
    }
    // free: drop a pin where you click (comment mode), else take the mouse for looking around
    if (this.props.commentMode) {
      const p = this.local(e);
      this.placeComment((p.x / p.w) * 2 - 1, -(p.y / p.h) * 2 + 1, true);
    } else if (!s.touch && !s.lockRefused) this.requestLock();
  }

  private onDblClick = (e: MouseEvent) => {
    if (this.isUiEvent(e) || this.store.getState().mode !== "orbit" || this.props.commentMode) return;
    this.focusAt(e.clientX, e.clientY);
  };

  private onPointerLeave = () => {
    this.hoverPending = null;
    this.walk.input.turn.yaw = 0;
    this.edge.side = 0;
    this.clearHover();
  };

  private onWheel = () => this.clearHover();

  private onContextMenu = (e: Event) => {
    if (!this.isUiEvent(e)) e.preventDefault();
  };

  // ───────────────────────────── picking / hover ─────────────────────────────

  private clipY() {
    const c = this.props.sectionCut;
    return c === null || c === undefined || !Number.isFinite(c) ? null : c;
  }

  /** Hits on neighbours that are ghosted out of the way don't count: you are clicking the house behind them. */
  private skipGhosted = (h: THREE.Intersection) => !!h.object.userData?.nqGhost && !!this.camera && ghostAt(h.point, this.camera.position) > 0.02;

  pickNdc(x: number, y: number, far = 250) {
    if (!this.camera) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    return pick(this.raycaster, [this.holder], { clipY: this.clipY(), far, skip: this.skipGhosted });
  }

  private pickClient(clientX: number, clientY: number) {
    if (!this.container) return null;
    const p = this.local({ clientX, clientY });
    return this.pickNdc((p.x / p.w) * 2 - 1, -(p.y / p.h) * 2 + 1);
  }

  private processHover() {
    const p = this.hoverPending;
    this.hoverPending = null;
    if (!p || !this.container || !this.camera) return;
    const c = this.controls;
    if (c && c.currentAction !== 0) return this.clearHover();
    const r = this.container.getBoundingClientRect();
    const hit = this.pickNdc((p.x / r.width) * 2 - 1, -(p.y / r.height) * 2 + 1);
    if (!hit) return this.clearHover();
    const tags = resolveHitTags(hit, this.currentRoot());
    const key = tags.part ? `${hit.object.uuid}:${tags.part.start}` : tags.element.uuid;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.setOutline({ obj: tags.element, part: tags.part });
    this.store.setState({ hover: displayLabel(tags, this.plan) });
  }

  clearHover() {
    if (!this.hoverKey && !this.store.getState().hover) return;
    this.hoverKey = "";
    this.setOutline(null);
    this.store.setState({ hover: null });
  }

  private outlined: OutlineTarget | null = null;
  private partOverlay: THREE.Mesh | null = null;

  /** Outline an element: its meshes, or — for a consolidated (merged) mesh — just that element's triangles. */
  setOutline(t: OutlineTarget | null) {
    const same = (a: OutlineTarget | null, b: OutlineTarget | null) => a?.obj === b?.obj && a?.part?.start === b?.part?.start;
    if (same(t, this.outlined)) return;
    this.outlined = t;
    if (this.partOverlay) {
      this.partOverlay.removeFromParent();
      this.partOverlay.geometry.dispose();
      this.partOverlay = null;
    }
    const o = this.outline;
    if (!o) return;
    const meshes: THREE.Object3D[] = [];
    if (t?.part && (t.obj as THREE.Mesh).isMesh) {
      const overlay = partOverlay(t.obj as THREE.Mesh, t.part);
      if (overlay) {
        t.obj.add(overlay);
        this.partOverlay = overlay;
        meshes.push(overlay);
      }
    } else if (t) {
      t.obj.traverseVisible((c) => {
        if ((c as THREE.Mesh).isMesh && meshes.length < 400 && !c.userData?.noPick && !c.userData?.viewer) meshes.push(c);
      });
      // whole-house or giant groups: tooltip only
      const box = new THREE.Box3().setFromObject(t.obj);
      if (meshes.length >= 400 || box.getSize(new THREE.Vector3()).length() > 40) meshes.length = 0;
    }
    o.selection.set(meshes);
    this.invalidate();
  }

  // ───────────────────────────── walk HUD helpers ─────────────────────────────

  /** {level, room} for a world point from plan rects + level elevations (tags missing → still useful anchors). */
  locate(p: THREE.Vector3, tolerance = 0.1): { level?: string; room?: string } {
    const levels = this.levelsSorted;
    let level = levels[0];
    for (const l of levels) if (l.elevation_ft * FT <= p.y + tolerance) level = l;
    if (!level) return {};
    const { x, y } = worldToPlan(p);
    const rooms = this.plan.rooms.filter((r) => r.level === level.id && x >= r.rect.x - 0.3 && x <= r.rect.x + r.rect.w + 0.3 && y >= r.rect.y - 0.3 && y <= r.rect.y + r.rect.d + 0.3);
    rooms.sort((a, b) => a.rect.w * a.rect.d - b.rect.w * b.rect.d);
    return { level: level.id, room: rooms[0]?.id };
  }

  private fireRoomChange(roomId: string | null, levelId: string | null) {
    // the level counts too: from the street (no room) up to the roof (no room) is still a change of place
    const key = `${roomId ?? ""}|${levelId ?? ""}`;
    if (this.lastRoomKey === key) return;
    this.lastRoomKey = key;
    try {
      this.props.onRoomChange?.(roomId, levelId);
    } catch (e) {
      console.warn("[viewer] onRoomChange threw", e);
    }
  }

  /** The room (and level) at a feet position, or `roomId` itself when given (a glide's destination). */
  private placeAt(feet: THREE.Vector3, roomId?: string): { room: string; roomId: string | null; levelId: string | null } {
    const where = this.locate(new THREE.Vector3(feet.x, feet.y + 0.05, feet.z), 0.45);
    const roomObj = this.plan.rooms.find((r) => r.id === (roomId ?? where.room));
    const levelId = roomObj?.level ?? where.level ?? null;
    const lvl = this.plan.levels.find((l) => l.id === levelId);
    const lowest = Math.min(...this.plan.levels.map((l) => l.index));
    // no room rect here: outdoors on the ground, otherwise name the level (roof terrace, open first-floor area…)
    const room = roomObj?.name ?? (lvl && lvl.index > lowest ? lvl.name : "Outside");
    return { room, roomId: roomObj?.id ?? null, levelId };
  }

  /**
   * Where the walker is. The minimap follows it live, gliding too (its floor and "you are here"); the app's room pill
   * (onRoomChange) does not during a glide: startGlide named the destination, and endGlide names the room reached.
   */
  private updateRoomLabel() {
    const { room, roomId, levelId } = this.placeAt(this.walk.feet);
    const s = this.store.getState();
    if (s.room !== room || s.level !== levelId || s.roomId !== roomId) this.store.setState({ room, roomId, level: levelId });
    if (!s.gliding && !this.walk.glide) this.fireRoomChange(roomId, levelId);
  }

  private updateCrosshairTarget() {
    const hit = this.pickNdc(0, 0, 9);
    if (!hit) {
      if (this.store.getState().target) this.store.setState({ target: null });
      if (this.props.commentMode) this.setOutline(null);
      return;
    }
    const tags = resolveHitTags(hit, this.currentRoot());
    const label = displayLabel(tags, this.plan);
    const cur = this.store.getState().target;
    if (!cur || cur.title !== label.title || cur.subtitle !== label.subtitle) this.store.setState({ target: label });
    this.setOutline(this.props.commentMode ? { obj: tags.element, part: tags.part } : null);
  }

  // ───────────────────────────── colliders ─────────────────────────────

  ensureCollider() {
    if (!this.colliderDirty && this.collider) return;
    const res = this.result;
    if (!res) return;
    this.builds.finishAnims();
    this.lift.finish();
    const root = this.currentRoot();
    const list = (res.colliders ?? []).filter((m) => m && this.vis.colliderEnabled(m, root));
    const extra = this.extraSolids(res).filter((m) => this.vis.colliderEnabled(m, root));
    // Furniture, fixtures and roof equipment are obstacles from the floor up and never ground (no climbing an
    // armchair or the solar panels). Parked cars: hidden while walking (the default) they never block the way in;
    // shown (the Cars toggle) they are solid like furniture.
    const carsShown = this.vehicleTarget("walk") > 0;
    const solid = this.solidBoxes(res).filter((s) => !this.vis.hiddenByTags({ userData: { layer: s.layer, level: s.level } } as unknown as THREE.Object3D));
    this.navSolids = solid;
    const boxes = solid.map((s) => s.box.clone());
    if (carsShown) boxes.push(...this.ctxfx.exclusionBoxes());
    // furniture the engine left out of the colliders (coffee tables, plants, outdoor chairs): its own triangles
    const fill = (i: number) => (i < solid.length ? this.elementSolid(res, solid[i].id) : null);
    const next = buildColliderBVH(list, carsShown ? [] : this.ctxfx.exclusionBoxes(), { boxes, meshes: extra, fill, clear: this.doorways() });
    disposeCollider(this.collider);
    this.collider = next;
    this.walk.setCollider(next?.bvh ?? null, next?.solid?.bvh ?? null);
    this.nav.reset(this.plan, list);
    this.navWarm = false;
    this.colliderDirty = false;
  }

  private solidBoxCache = new WeakMap<BuildResult, SolidBox[]>();
  /** The solid elements in the current walk collider (for telling planting from furniture). */
  private navSolids: SolidBox[] = [];

  /**
   * What solid a capsule standing at `p` (radius r) runs into, as a BLOCK mask: planting (landscape: trees, hedges,
   * planters), furniture, or something else (the water tank, a shown car).
   */
  private solidKindAt(p: THREE.Vector3, r: number): number {
    const lo = p.y + 0.03, hi = p.y + 1.78;
    let mask = 0;
    for (const s of this.navSolids) {
      const b = s.box;
      if (b.max.x < p.x - r || b.min.x > p.x + r || b.max.z < p.z - r || b.min.z > p.z + r || b.max.y < lo || b.min.y > hi) continue;
      mask |= s.layer === "landscape" ? BLOCK.planting : s.layer === "furniture" ? BLOCK.furniture : BLOCK.other;
    }
    return mask || BLOCK.other;
  }

  /**
   * World boxes of the elements that are solid from the floor up: furniture and fixtures (not rugs and mats), roof
   * equipment (water tank, solar), garden planters, trees and swings. Each box is lifted 3 cm off its bottom so the
   * slab it stands on stays walkable; whole-street aggregates (context) and implausibly big boxes are skipped.
   */
  private solidBoxes(res: BuildResult): SolidBox[] {
    const hit = this.solidBoxCache.get(res);
    if (hit) return hit;
    const out: SolidBox[] = [];
    const FLAT = /(^|:)(rug|carpet|prayer_mat|mat|doormat)$/;
    const EQUIPMENT = /(^|:)(water_tank|tank|solar\w*|ac_outdoor|generator|planter|tree|swing|bench|fountain|bbq|kiosk)$/;
    for (const o of res.summary?.objects ?? []) {
      const kind = o.kind ?? "";
      if (/(^|:)(context|vehicle)($|:)/.test(kind) || !o.bbox_ft) continue;
      const furniture = o.layer === "furniture" && !FLAT.test(kind);
      if (!furniture && !EQUIPMENT.test(kind)) continue;
      const [x0, y0, z0] = o.bbox_ft.min, [x1, y1, z1] = o.bbox_ft.max;
      // plan feet [x, y, up] → world metres (z = −y)
      const b = new THREE.Box3(new THREE.Vector3(x0 * FT, z0 * FT, -y1 * FT), new THREE.Vector3(x1 * FT, z1 * FT, -y0 * FT));
      const size = b.getSize(new THREE.Vector3());
      if (b.isEmpty() || size.x > 9 || size.z > 9 || size.y < 0.08) continue;
      b.min.y += 0.03;
      b.expandByVector(new THREE.Vector3(0.02, 0, 0.02));
      b.max.y += 0.02;
      out.push({ box: b, id: o.id, layer: o.layer, level: o.level });
    }
    this.solidBoxCache.set(res, out);
    return out;
  }

  /**
   * The walking zone through every door (its width, 0.6 m each side of the wall, floor to 2.2 m): furniture never
   * seals a doorway even when a plan leaves a chair or a tall unit standing in one.
   */
  private doorways(): THREE.Box3[] {
    const out: THREE.Box3[] = [];
    const DOOR = /^(main_door|door|double_door|sliding_door|arch|garage_door|opening)$/;
    for (const o of this.plan.openings ?? []) {
      if (!DOOR.test(o.type)) continue;
      const lvl = this.plan.levels.find((l) => l.id === o.level);
      if (!lvl) continue;
      const host = o.between.map((id) => this.plan.rooms.find((r) => r.id === id)).find((r) => !!r);
      const [ax, ay] = o.at;
      // the wall the door sits in: the host rect edge nearest the door point
      let horizontal = true;
      if (host) {
        const r = host.rect;
        const dy = Math.min(Math.abs(ay - r.y), Math.abs(ay - (r.y + r.d)));
        const dx = Math.min(Math.abs(ax - r.x), Math.abs(ax - (r.x + r.w)));
        horizontal = dy <= dx;
      }
      const half = o.width_ft / 2, depth = 0.6 / FT;
      const [x0, x1, y0, y1] = horizontal ? [ax - half, ax + half, ay - depth, ay + depth] : [ax - depth, ax + depth, ay - half, ay + half];
      const floor = lvl.elevation_ft * FT;
      out.push(new THREE.Box3(new THREE.Vector3(x0 * FT, floor - 0.2, -y1 * FT), new THREE.Vector3(x1 * FT, floor + 2.2, -y0 * FT)));
    }
    return out;
  }

  private partIndex = new WeakMap<BuildResult, Map<string, { mesh: THREE.Mesh; ranges: { start: number; count: number }[] }[]>>();
  private elementSolidCache = new WeakMap<BuildResult, Map<string, THREE.Mesh | null>>();

  /** One element's visible triangles, baked to world space (cached per build). */
  private elementSolid(res: BuildResult, id: string): THREE.Mesh | null {
    let cache = this.elementSolidCache.get(res);
    if (!cache) this.elementSolidCache.set(res, (cache = new Map()));
    if (cache.has(id)) return cache.get(id)!;
    let index = this.partIndex.get(res);
    if (!index) {
      index = new Map();
      const idx = index;
      res.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || o.userData?.viewer || (m as THREE.InstancedMesh).isInstancedMesh) return;
        const parts = o.userData?.parts as PartRange[] | undefined;
        if (parts?.length) {
          for (const p of parts) {
            const pid = String(p.tags.id ?? "");
            if (!pid) continue;
            const list = idx.get(pid) ?? idx.set(pid, []).get(pid)!;
            const last = list[list.length - 1];
            if (last?.mesh === m) last.ranges.push(p);
            else list.push({ mesh: m, ranges: [p] });
          }
        } else if (typeof o.userData?.id === "string") {
          const g = m.geometry, n = (g.index ? g.index.count : g.getAttribute("position")?.count ?? 0) / 3;
          const list = idx.get(o.userData.id) ?? idx.set(o.userData.id, []).get(o.userData.id)!;
          list.push({ mesh: m, ranges: [{ start: 0, count: n }] });
        }
      });
      this.partIndex.set(res, index);
    }
    const srcs = index.get(id);
    let out: THREE.Mesh | null = null;
    if (srcs?.length) {
      res.root.updateMatrixWorld(true);
      const arr: number[] = [];
      const v = new THREE.Vector3();
      for (const { mesh, ranges } of srcs) {
        const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
        if (!pos) continue;
        const ix = mesh.geometry.index;
        for (const r of ranges)
          for (let t = r.start; t < r.start + r.count; t++)
            for (let k = 0; k < 3; k++) {
              const i = t * 3 + k;
              v.fromBufferAttribute(pos, ix ? ix.getX(i) : i).applyMatrix4(mesh.matrixWorld);
              arr.push(v.x, v.y, v.z);
            }
      }
      if (arr.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
        out = new THREE.Mesh(g);
        out.userData = { kind: "collider:solid", viewer: "solid" };
      }
    }
    cache.set(id, out);
    return out;
  }

  private solidsCache = new WeakMap<BuildResult, THREE.Mesh[]>();

  /**
   * Roof objects you can't walk through that some engine builds leave out of the colliders (the water tank, solar
   * frames): baked into world-space meshes once per build and added to the walk collider.
   */
  private extraSolids(res: BuildResult): THREE.Mesh[] {
    const hit = this.solidsCache.get(res);
    if (hit) return hit;
    const SOLID = /(^|:)(water_tank|tank|solar(_panels?|_array|_frame)?)($|:)/;
    const out: THREE.Mesh[] = [];
    const v = new THREE.Vector3();
    res.root.updateMatrixWorld(true);
    res.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData?.viewer || (m as THREE.InstancedMesh).isInstancedMesh) return;
      const pos = m.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const idx = m.geometry.index;
      const parts = o.userData?.parts as PartRange[] | undefined;
      const ranges: { start: number; count: number }[] = [];
      if (parts?.length) {
        for (const p of parts) if (SOLID.test(String(p.tags.kind ?? ""))) ranges.push(p);
      } else if (SOLID.test(String(o.userData?.kind ?? ""))) ranges.push({ start: 0, count: (idx ? idx.count : pos.count) / 3 });
      if (!ranges.length) return;
      const arr: number[] = [];
      for (const r of ranges)
        for (let t = r.start; t < r.start + r.count; t++)
          for (let k = 0; k < 3; k++) {
            const i = t * 3 + k;
            v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
            arr.push(v.x, v.y, v.z);
          }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const solid = new THREE.Mesh(g);
      solid.userData = { kind: "collider:solid", level: o.userData?.level, viewer: "solid" };
      out.push(solid);
    });
    this.solidsCache.set(res, out);
    return out;
  }

  // ───────────────────────────── pins ─────────────────────────────

  private pinEl(id: string): HTMLElement | null {
    if (!this.pinEls.has(id) || !this.pinEls.get(id)?.isConnected) {
      this.pinEls.set(id, (this.container?.querySelector(`[data-pin="${CSS.escape(id)}"]`) as HTMLElement | null) ?? null);
    }
    return this.pinEls.get(id) ?? null;
  }

  private updatePins(cam: THREE.PerspectiveCamera) {
    const g = this.pinsGroup;
    if (!g || !g.children.length) return;
    const cut = this.clipY();
    const kids = g.children;
    for (const pinObj of kids) {
      const id = pinObj.userData?.pin as string | undefined;
      if (!id) continue;
      const level = pinObj.userData.level as string | undefined;
      const hiddenLevel = !!level && !!this.vis.levelsShown && this.plan.levels.some((l) => l.id === level) && !this.vis.levelsShown.has(level);
      const visible = !hiddenLevel && (cut === null || pinObj.position.y <= cut + 0.05);
      pinObj.visible = visible;
      const el = this.pinEl(id);
      if (el) el.dataset.hidden = visible ? "0" : "1";
    }
    // occlusion: a couple of pins per frame, visibility-aware (hidden floors never occlude)
    const n = Math.min(2, kids.length);
    for (let i = 0; i < n; i++) {
      this.pinCursor = (this.pinCursor + 1) % kids.length;
      const pinObj = kids[this.pinCursor];
      const id = pinObj.userData?.pin as string | undefined;
      if (!id || !pinObj.visible) continue;
      const nrm = pinObj.userData.normal as THREE.Vector3 | undefined;
      const p = pinObj.position.clone();
      if (nrm) p.addScaledVector(nrm, 0.08);
      const dir = p.clone().sub(cam.position);
      const dist = dir.length();
      this.raycaster.set(cam.position, dir.normalize());
      const hit = pick(this.raycaster, [this.holder], { clipY: cut, far: Math.max(0, dist - 0.05), skip: this.skipGhosted });
      const el = this.pinEl(id);
      if (el) el.dataset.occluded = hit ? "1" : "0";
    }
  }

  // ───────────────────────────── comments ─────────────────────────────

  /** Raycast at NDC (x, y) and hand a CommentAnchor + camera + snapshot to the app. */
  placeComment(x: number, y: number, fromWalk: boolean) {
    const cam = this.camera;
    if (!cam || !this.gl) return;
    this.builds.finishAnims();
    this.lift.finish();
    const hit = this.pickNdc(x, y, 80);
    if (!hit) {
      this.toast("Aim at a wall, floor or object to pin a comment");
      return;
    }
    const tags = resolveHitTags(hit, this.currentRoot());
    const normal = hitNormal(hit, this.raycaster.ray.direction);
    const where = this.locate(hit.point.clone().addScaledVector(normal, 0.05));
    const anchor: CommentAnchor = { position: v3(hit.point), normal: v3(normal) };
    // untagged hits: infer level/room from the plan, but only when the point is inside a room (not a street tree)
    const level = tags.level ?? (where.room ? where.level : undefined), room = tags.room ?? where.room;
    // one human label: "TV in the upper family lounge", "Floor plant in the drawing room"
    const label = humanLabel(tags.kind, tags.label, roomName(this.plan, room), this.plan.levels.map((l) => l.name));
    if (level) anchor.level = level;
    if (room) anchor.room = room;
    if (tags.id) anchor.element_id = tags.id;
    if (tags.kind) anchor.kind = tags.kind;
    if (label) anchor.label = label;
    const position = cam.position.clone();
    const target = position.clone().addScaledVector(this.raycaster.ray.direction, hit.distance);
    const snapshot = this.snapshot({ width: 640, pin: hit.point, maxAspect: 0.75 });
    window.clearTimeout(this.draftTimer);
    window.clearTimeout(this.pinnedTimer);
    this.store.setState({ draft: { position: anchor.position, normal: anchor.normal }, pinned: false });
    // safety net only: the app closes the draft with cancelDraft() or by saving it
    this.draftTimer = window.setTimeout(() => this.cancelDraft(), 15 * 60000);
    if (fromWalk && this.store.getState().mode === "walk") {
      this.walk.enabled = false;
      this.walk.input.keys.clear();
      this.hideLookPrompt(true);
      this.store.setState({ walk: "commenting", target: null, idle: false });
      if (this.isLocked()) document.exitPointerLock?.();
    }
    try {
      this.props.onAddComment?.({ anchor, camera: { position: v3(position), target: v3(target) }, snapshot });
    } catch (e) {
      console.warn("[viewer] onAddComment threw", e);
    }
    this.invalidate();
  }

  flyTo(comment: Comment) {
    const cam = this.camera;
    if (!cam || !comment?.camera) return;
    this.store.setState({ selectedPin: comment.id });
    const pos = new THREE.Vector3(...comment.camera.position);
    const tgt = new THREE.Vector3(...comment.camera.target);
    if (this.store.getState().mode === "walk") {
      this.ensureCollider();
      const g = this.walk.groundAt(pos, pos.y - EYE + 0.4, pos.y - EYE - 1.2);
      if (g !== null) {
        const feet = new THREE.Vector3(pos.x, g, pos.z);
        const d = tgt.clone().sub(new THREE.Vector3(pos.x, g + EYE, pos.z));
        this.walk.cancelGlide();
        this.walk.place(feet, Math.atan2(-d.x, -d.z), THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -1.3, 1.3));
        this.walk.beginTransition(cam, prefersReducedMotion() ? 0.01 : 0.7);
        this.flashPin(comment.id);
        return;
      }
      this.leaveWalk("flyTo");
    }
    // the comment's floor must be on show
    const lvl = comment.anchor?.level;
    const orbitFloor = this.store.getState().orbitFloor;
    if (lvl && orbitFloor) {
      const want = this.plan.levels.find((l) => l.id === lvl), cur = this.plan.levels.find((l) => l.id === orbitFloor);
      if (want && cur && want.index > cur.index) this.setOrbitFloor(want.id);
    }
    this.leaveHero();
    this.controls?.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, true);
    this.flashPin(comment.id);
    this.invalidate();
  }

  /** A pin was clicked: select it (2 px accent ring) and tell the app. */
  selectPin(id: string) {
    this.store.setState({ selectedPin: id });
    try {
      this.props.onSelectComment?.(id);
    } catch (e) {
      console.warn("[viewer] onSelectComment threw", e);
    }
  }

  private flashPin(id: string) {
    const el = this.pinEl(id);
    if (!el) return;
    el.dataset.flash = "1";
    window.setTimeout(() => {
      if (el.dataset.flash === "1") el.dataset.flash = "0";
    }, 1800);
  }

  // ───────────────────────────── capture ─────────────────────────────

  /** Render a fresh frame and read it back in the same task (preserveDrawingBuffer stays false). */
  renderNow() {
    const gl = this.gl, scene = this.scene, cam = this.camera;
    if (!gl || !scene || !cam) return;
    if (this.shadowsDirty || this.shadowMapMissing()) {
      gl.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    gl.toneMappingExposure = (this.atmosphere?.exposure ?? 1) * (this.store.getState().mode === "walk" ? 1.1 : 1);
    if (this.composer) this.composer.render(0);
    else gl.render(scene, cam);
  }

  snapshot(o: { width?: number; height?: number; pin?: THREE.Vector3 | null; maxAspect?: number; type?: "image/png" | "image/jpeg" } = {}): string {
    const gl = this.gl, cam = this.camera;
    if (!gl || !cam) return "";
    const pinsVisible = this.pinsGroup?.visible ?? true;
    if (this.pinsGroup) this.pinsGroup.visible = false;
    const outlined = this.outlined;
    this.setOutline(null);
    let url = "";
    try {
      this.renderNow();
      const pinNdc = o.pin ? projectToNdc(o.pin, cam) : null;
      url = grabCanvas(gl.domElement, { width: o.width, height: o.height, pinNdc, maxAspect: o.maxAspect, pinColor: "#6B2A5E", type: o.type, quality: 0.9 });
    } finally {
      if (this.pinsGroup) this.pinsGroup.visible = pinsVisible;
      this.setOutline(outlined);
      this.invalidate();
    }
    return url;
  }

  /** Before a capture: the canvas exists, textures have streamed in (or 4 s passed) and nothing is mid-animation. */
  private async prepareCapture() {
    await this.whenReady();
    // an AI render of half-loaded textures is wasted: give streaming textures a moment
    const tex = engineExtras.texturesReady?.();
    if (tex) await Promise.race([tex.catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
    this.builds.finishAnims();
    this.lift.finish();
  }

  /**
   * Render and grab one frame for an AI render. It keeps the street "as massed": a ghosted neighbour would come back
   * as a glass building (with the trees and tank behind it showing through). Draw the neighbours solid for this one
   * frame, and leave out the fading room-frame accent; snapshot() already hides the pins and the outline.
   */
  private grabForRender(opts?: { width?: number; height?: number; type?: "image/png" | "image/jpeg" }): string {
    const cam = this.camera;
    if (cam) this.ctxfx.updateNear(cam, this.ghostTarget > 0);
    const frames = this.frames.filter((f) => f.mesh.visible);
    for (const f of frames) f.mesh.visible = false;
    GHOST.nqCapture.value = 1;
    try {
      return this.snapshot({ width: opts?.width, height: opts?.height, type: opts?.type });
    } finally {
      GHOST.nqCapture.value = 0;
      for (const f of frames) f.mesh.visible = true;
      // orbit ghosting is back on the next frame
      this.invalidate();
    }
  }

  async capture(opts?: { width?: number; height?: number }): Promise<string> {
    await this.prepareCapture();
    return this.grabForRender(opts);
  }

  /** Photos: set while captureAngles runs (every floor and layer shown, no section cut, daylight). */
  private photo: { hour: number } | null = null;

  /** The house is built: no build running (one the app just asked for has started), and no drop-ins in flight. */
  private async whenBuilt(timeoutMs = 120_000) {
    // a section the app changed a moment ago starts its build in a React effect: let that run first
    await sleep(60);
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const b = this.store.getState().build;
      if (this.disposed) return;
      if ((b.phase === "ready" || b.phase === "error") && !this.builds.animating) return;
      await sleep(150);
    }
  }

  /**
   * Captures of the model from fixed cameras worked out from the plan (front, corner, garden, aerial), for the photos
   * made from them. Leaves walk mode first, shows the whole house (every floor and layer, no cut) by day, renders each
   * at `width`×`height` (1280×720) as JPEG, then puts the camera and the view back as they were.
   */
  async captureAngles(angles?: string[], opts?: { width?: number; height?: number }): Promise<{ angle: string; label: string; image: string }[]> {
    const want = (angles?.length ? angles : PHOTO_ANGLES).filter((a): a is PhotoAngle => (PHOTO_ANGLES as string[]).includes(a));
    if (!want.length) return [];
    if (this.store.getState().mode === "walk") this.leaveWalk("user");
    await this.whenBuilt();
    await this.prepareCapture();
    const gl = this.gl, cam = this.camera;
    if (!gl || !cam || this.disposed) return [];
    const W = Math.round(opts?.width ?? 1280), H = Math.round(opts?.height ?? 720);
    const facing = (this.plan.site?.facing ?? "N") as Facing;
    const side: 1 | -1 = sunState(this.props.sunHour ?? 16.5, facing).dir.x >= 0 ? 1 : -1;
    const dayHour = this.props.night || (this.props.sunHour ?? 13) > 17.5 ? 15.5 : this.props.sunHour ?? 15.5;

    const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), up: cam.up.clone(), fov: cam.fov, aspect: cam.aspect };
    const size = gl.getSize(new THREE.Vector2());
    const dpr = gl.getPixelRatio();
    const resize = (w: number, h: number) => {
      if (this.composer) this.composer.setSize(w, h, false);
      else gl.setSize(w, h, false);
    };
    const out: { angle: string; label: string; image: string }[] = [];
    this.photo = { hour: dayHour };
    try {
      this.setOutline(null);
      this.configureVisibility();
      const root = this.currentRoot();
      if (root) this.vis.apply(root);
      this.glow.syncVisibility((o) => this.vis.hiddenByTags(o));
      this.syncGhostBox();
      this.syncSectionCut();
      this.syncSun();
      this.shadowsDirty = true;
      // render at the photo's own size, whatever the shape of the screen (a phone in portrait too)
      gl.setPixelRatio(1);
      resize(W, H);
      cam.aspect = W / H;
      for (const angle of want) {
        const pose = photoPose(this.plan, angle, W / H, side);
        cam.up.set(0, 1, 0);
        cam.position.copy(pose.position);
        cam.fov = pose.fov;
        cam.updateProjectionMatrix();
        cam.lookAt(pose.target);
        cam.updateMatrixWorld();
        const image = this.grabForRender({ width: W, height: H, type: "image/jpeg" });
        if (image) out.push({ angle, label: PHOTO_LABELS[angle], image });
      }
    } finally {
      this.photo = null;
      gl.setPixelRatio(dpr);
      resize(size.x, size.y);
      cam.position.copy(saved.pos);
      cam.quaternion.copy(saved.quat);
      cam.up.copy(saved.up);
      cam.fov = saved.fov;
      cam.aspect = saved.aspect;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      this.configureVisibility();
      const root = this.currentRoot();
      if (root) this.vis.apply(root);
      this.glow.syncVisibility((o) => this.vis.hiddenByTags(o));
      this.syncGhostBox();
      this.syncSectionCut();
      this.syncSun();
      this.ctxfx.updateNear(cam, this.ghostTarget > 0);
      this.markDirty();
    }
    return out;
  }

  // ───────────────────────────── misc ─────────────────────────────

  toast(text: string) {
    window.clearTimeout(this.toastTimer);
    this.store.setState({ toast: { id: ++this.toastSeq, text } });
    this.toastTimer = window.setTimeout(() => this.store.setState({ toast: null }), 2800);
  }

  /** Dev-only hooks for automated testing (synthetic pointer lock, key presses, teleport). */
  private installDebug() {
    const ctrl = this;
    const dbg = {
      ctrl,
      walk: this.walk,
      nav: this.nav,
      state: () => ({ ...ctrl.store.getState(), feet: ctrl.walk.feet.toArray(), yaw: ctrl.walk.yaw, pitch: ctrl.walk.pitch, grounded: ctrl.walk.grounded, colliderTris: ctrl.collider?.triangles ?? 0, fov: ctrl.camera?.fov, ghost: GHOST.nqGhost.value, vehicles: ctrl.ctxfx.vehicles.map((v) => ({ id: v.id, opacity: v.opacity })) }),
      /** Start walking without real pointer lock (automation can't grant it). */
      activate: () => {
        if (ctrl.walk.transition) ctrl.walk.transition.t = 1;
        ctrl.walk.enabled = true;
        ctrl.store.setState({ walk: "free", lockRefused: true });
      },
      hold: (code: string, ms: number) =>
        new Promise<void>((res) => {
          ctrl.walk.input.keys.add(code);
          window.setTimeout(() => {
            ctrl.walk.input.keys.delete(code);
            res();
          }, ms);
        }),
      /** Look by (dx, dy) pointer-lock pixels. */
      look: (dx: number, dy = 0) => {
        ctrl.walk.input.look.dx += dx * LOCK_SENS;
        ctrl.walk.input.look.dy += dy * LOCK_SENS;
      },
      setYaw: (deg: number, pitchDeg = 0) => ctrl.walk.setLook(THREE.MathUtils.degToRad(deg), THREE.MathUtils.degToRad(pitchDeg)),
      teleport: (x: number, y: number, z: number) => ctrl.walk.teleport(new THREE.Vector3(x, y, z)),
      teleportPlan: (xFt: number, yFt: number, hFt = 30) => ctrl.walk.teleport(planToWorld(xFt, yFt, hFt)),
      comment: () => ctrl.placeComment(0, 0, ctrl.store.getState().mode === "walk"),
      commentAt: (x: number, y: number) => ctrl.placeComment(x, y, false),
      hero: () => ctrl.placeHero(true),
      setQuality: (q: Quality) => ctrl.setQuality(q, true),
      snapshot: (w = 640) => ctrl.snapshot({ width: w }),
      setLookAt: (p: Vec3, t: Vec3, animate = false) => ctrl.controls?.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], animate),
      goToRoom: (id: string) => ctrl.goToRoom(id),
      setFloor: (id: string) => ctrl.setFloor(id),
      route: (roomId: string) => {
        const room = ctrl.plan.rooms.find((r) => r.id === roomId);
        return room ? ctrl.nav.route(ctrl.walk.feet.clone(), { kind: "room", room }) : null;
      },
    };
    (window as unknown as { __viewerDebug: typeof dbg }).__viewerDebug = dbg;
  }
}
