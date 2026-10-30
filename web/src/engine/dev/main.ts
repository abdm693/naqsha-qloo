/** Engine dev harness (web/dev/engine.html): builds the fixture with buildHouse and renders it. */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import { N8AOPostPass } from "n8ao";
import type { BuildingPlan } from "@contracts/plan";
import planFixture from "@contracts/fixtures/plan-10-marla.json";
import planArgon from "@contracts/fixtures/argon-v1-plan.json";
import designFixture from "@contracts/fixtures/design-10-marla.js?raw";
import designArgon from "@contracts/fixtures/argon-v1-design.js?raw";
import planKanal from "@contracts/fixtures/argon-1kanal-plan.json";
import designKanal from "@contracts/fixtures/argon-1kanal-design.js?raw";
import { buildHouse, defaultDesign, parseDesign, setTimeOfDay, sunDirection, texturesReady, updateSun, type BuildResult, type DesignSectionSrc } from "../index";
import { asBuiltCheck } from "./asbuilt";
import { runChecks, type Check } from "./checks";
import { drawPlan } from "./planview";

const app = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
renderer.transmissionResolutionScale = 0.6;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#9fb6cc");
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 900);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;

const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene.environment = envRT.texture;
scene.environmentIntensity = 0.32;

const sky = new Sky();
sky.scale.setScalar(4000);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 4;
skyU.rayleigh.value = 1.4;
skyU.mieCoefficient.value = 0.004;
skyU.mieDirectionalG.value = 0.82;

// post-processing
const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
const n8 = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
n8.configuration.aoRadius = 0.9;
n8.configuration.distanceFalloff = 1.2;
n8.configuration.intensity = 2.2;
n8.configuration.halfRes = true;
n8.configuration.gammaCorrection = false;
composer.addPass(n8);
const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
composer.addPass(new EffectPass(camera, new SMAAEffect(), tone));
let usePost = true;

const designs: Record<string, () => { plan: BuildingPlan; sections: DesignSectionSrc[] }> = {
  fixture: () => ({ plan: planFixture as unknown as BuildingPlan, sections: parseDesign(designFixture) }),
  "fixture-default": () => ({ plan: planFixture as unknown as BuildingPlan, sections: defaultDesign(planFixture as unknown as BuildingPlan) }),
  argon: () => ({ plan: planArgon as unknown as BuildingPlan, sections: parseDesign(designArgon) }),
  "argon-default": () => ({ plan: planArgon as unknown as BuildingPlan, sections: defaultDesign(planArgon as unknown as BuildingPlan) }),
  kanal: () => ({ plan: planKanal as unknown as BuildingPlan, sections: parseDesign(designKanal) }),
  "kanal-default": () => ({ plan: planKanal as unknown as BuildingPlan, sections: defaultDesign(planKanal as unknown as BuildingPlan) }),
  // the same house with the overhaul's roof choices: solar panels and an RCC tank
  "kanal-solar": () => {
    const p = JSON.parse(JSON.stringify(planKanal)) as BuildingPlan;
    p.roof.solar = { mode: "panels" };
    if (p.roof.water_tank) p.roof.water_tank.material = "concrete";
    return { plan: p, sections: parseDesign(designKanal) };
  },
  // the same 1 kanal house as a detached home elsewhere: a gable or hip roof over the walls, neighbours standing apart
  "kanal-gable": () => localHouse("gable", "parallel"),
  "kanal-gable-side": () => localHouse("gable", "perpendicular"),
  "kanal-hip": () => localHouse("hip", "auto"),
  "kanal-gable-solar": () => {
    const d = localHouse("gable", "perpendicular");
    d.plan.roof.solar = { mode: "panels" };
    d.plan.site.facing = "E";
    return d;
  },
  // one half of a semi-detached pair, on a street of pairs
  "argon-semi": () => {
    const p = JSON.parse(JSON.stringify(planArgon)) as BuildingPlan;
    delete p.roof.water_tank;
    delete p.roof.solar;
    p.roof.pitched = { form: "gable", pitch_deg: 40, ridge: "across_road", material: "charcoal asphalt shingles", overhang_ft: 1 };
    p.site.street = { form: "semi-detached", side_gap_ft: 4, setback_ft: 15, storeys: 2, front_wall: false, roof_tank: false, walls: ["red clay brick"], roof: { form: "gable", pitch_deg: 40, ridge: "across_road" } };
    p.site.boundary_wall = { ...p.site.boundary_wall, front_height_ft: 0 };
    return { plan: p, sections: parseDesign(designArgon) };
  },
  // a row house with a pitched roof: nothing may pass the party walls
  "row-gable": () => {
    const p = JSON.parse(JSON.stringify(planArgon)) as BuildingPlan;
    delete p.roof.water_tank;
    delete p.roof.solar;
    p.roof.pitched = { form: "gable", pitch_deg: 35, ridge: "along_road", material: "grey slate", overhang_ft: 1.5 };
    p.site.street = { form: "row", storeys: 2, roof: { form: "gable", pitch_deg: 35, ridge: "along_road" }, front_wall: true };
    return { plan: p, sections: parseDesign(designArgon) };
  },
  "argon-solar": () => {
    const p = JSON.parse(JSON.stringify(planArgon)) as BuildingPlan;
    p.roof.solar = { mode: "panels" };
    if (p.roof.water_tank) p.roof.water_tank.material = "plastic";
    return { plan: p, sections: parseDesign(designArgon) };
  },
};

function localHouse(form: "gable" | "hip", ridge: string): { plan: BuildingPlan; sections: DesignSectionSrc[] } {
  const p = JSON.parse(JSON.stringify(planKanal)) as BuildingPlan;
  delete p.roof.water_tank;
  delete p.roof.solar;
  p.roof.pitched = { form, pitch_deg: 30, ridge, material: "charcoal asphalt shingles", overhang_ft: 2 };
  p.site.street = { form: "detached", side_gap_ft: 8, setback_ft: 20, storeys: 2, front_wall: false, roof_tank: false, walls: ["limestone", "painted siding"], roof: { form, pitch_deg: 30, ridge } };
  p.site.boundary_wall = { ...p.site.boundary_wall, front_height_ft: 0 };
  return { plan: p, sections: parseDesign(designKanal) };
}

let current: BuildResult | null = null;
let currentPlan: BuildingPlan = planFixture as unknown as BuildingPlan;
let visibleLevels: Set<string> | null = null;
let buildMs = 0;
let clip: THREE.Plane | null = null;
let building = false;
let hideContext = false;
let texWaitMs = 0;

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
if (params.has("prof")) (globalThis as unknown as { __naqshaProf?: object }).__naqshaProf = {};
($("design") as HTMLSelectElement).value = params.get("design") ?? "fixture";
($("quality") as HTMLSelectElement).value = params.get("quality") ?? "high";

let buildSeq = 0;
/** Every root put in the scene by a build (a superseded build in flight must not leave its house behind). */
const liveRoots = new Set<THREE.Object3D>();

/** ?src=<url>: a saved version ({plan, sections} as the API returns it) instead of a bundled fixture. */
let srcVersion: { plan: BuildingPlan; sections: DesignSectionSrc[] } | null = null;
async function loadSrc(): Promise<void> {
  const url = params.get("src");
  if (!url || srcVersion) return;
  const v = (await (await fetch(url)).json()) as { plan: BuildingPlan; sections: (DesignSectionSrc & { code?: string })[] };
  srcVersion = { plan: v.plan, sections: v.sections.map((s) => ({ name: s.name, layer: s.layer, body: s.body ?? s.code ?? "" })) };
}

async function rebuild(): Promise<void> {
  const seq = ++buildSeq;
  const key = ($("design") as HTMLSelectElement).value;
  const quality = ($("quality") as HTMLSelectElement).value as "high" | "medium";
  await loadSrc();
  const { plan, sections } = srcVersion ? { plan: JSON.parse(JSON.stringify(srcVersion.plan)) as BuildingPlan, sections: srcVersion.sections } : designs[key]();
  currentPlan = plan;
  for (const r of liveRoots) scene.remove(r);
  liveRoots.clear();
  if (current) {
    current.dispose();
    current = null;
  }
  $("stats").textContent = "building…";
  $("sections").innerHTML = "";
  building = true;
  const t0 = performance.now();
  let live: THREE.Group | null = null;
  const res = await buildHouse(plan, sections, {
    quality,
    onSection: (r, root) => {
      if (seq !== buildSeq) return;
      if (!live) {
        live = root;
        scene.add(root);
        liveRoots.add(root);
      }
      const d = document.createElement("div");
      d.innerHTML = `<span class="${r.ok ? "" : "err"}">${r.ok ? "✓" : "✗"} ${r.name} <i style="color:#777">[${r.layer}]</i>${r.error ? `<span class="msg">${escapeHtml(r.error)}</span>` : ""}</span><span>${r.ms.toFixed(0)} ms · ${r.objects}</span>`;
      $("sections").appendChild(d);
    },
  });
  const stale = () => {
    if (seq === buildSeq) return false;
    scene.remove(res.root);
    liveRoots.delete(res.root);
    res.dispose();
    return true;
  };
  if (stale()) return;
  buildMs = performance.now() - t0;
  const tTex = performance.now();
  await texturesReady();
  texWaitMs = performance.now() - tTex;
  if (stale()) return;
  building = false;
  current = res;
  if (!live) {
    scene.add(res.root);
    liveRoots.add(res.root);
  }
  buildLevelButtons(res);
  applyLevels();
  setHour(parseFloat(($("hour") as HTMLInputElement).value));
  const st = (res as unknown as { stats?: Record<string, number> }).stats;
  (window as unknown as Record<string, unknown>).__lastStats = st;
  renderer.compile(scene, camera);
  setView(params.get("view") ?? "aerial");
  frame();
  updateStats(st);
  buildPlanButtons(res);
  if (params.get("checks") !== "0") setTimeout(() => void showChecks(), 30);
}

// ── livability checklist + plan overlay ──────────────────────────────────────────────────────────────────
let lastChecks: Check[] = [];
let planLevel: string | null = null;
async function showChecks(): Promise<Check[]> {
  if (!current) return [];
  $("chkList").innerHTML = '<div class="d">running…</div>';
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  lastChecks = runChecks(current);
  const ms = performance.now() - t0;
  const n = { pass: 0, warn: 0, fail: 0 };
  for (const c of lastChecks) n[c.status]++;
  $("chkSum").textContent = `${n.pass} pass · ${n.warn} warn · ${n.fail} fail · ${ms.toFixed(0)} ms`;
  $("chkList").innerHTML = lastChecks
    .map((c) => `<div class="chk ${c.status}"><span class="dot"></span><span class="t">${escapeHtml(c.title)}</span><span class="d">${escapeHtml(c.detail)}${c.spots?.length ? `<br>at ${c.spots.slice(0, 6).map((sp) => `${sp.level} (${sp.x}, ${sp.y}) ${escapeHtml(sp.note)}`).join("; ")}` : ""}</span></div>`)
    .join("");
  const notes = current.summary.checks ?? [];
  if (notes.length)
    $("chkList").innerHTML += `<div class="chk warn"><span class="dot"></span><span class="t">As-built notes (${notes.length})</span><span class="d">${notes.map((x) => escapeHtml(x.message)).join("<br>")}</span></div>`;
  (window as unknown as { __checks?: Check[] }).__checks = lastChecks;
  if (planLevel) drawPlan($("plan") as HTMLCanvasElement, current, planLevel, lastChecks);
  return lastChecks;
}
function buildPlanButtons(res: BuildResult): void {
  const box = $("planBtns");
  box.innerHTML = "";
  const mk = (label: string, id: string | null) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => setPlan(id);
    b.dataset.lv = id ?? "";
    box.appendChild(b);
  };
  for (const l of res.levels) mk(`Plan ${l.name.replace(/ Floor$/, "")}`, l.id);
  if (planLevel && !res.levels.some((l) => l.id === planLevel)) planLevel = null;
  setPlan(planLevel);
}
function setPlan(id: string | null): void {
  planLevel = planLevel === id ? null : id;
  const cv = $("plan") as HTMLCanvasElement;
  cv.classList.toggle("on", !!planLevel);
  document.querySelectorAll("#planBtns button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.lv === planLevel));
  if (planLevel && current) drawPlan(cv, current, planLevel, lastChecks);
}
$("runChecks").onclick = () => void showChecks();
window.addEventListener("resize", () => {
  if (planLevel && current) drawPlan($("plan") as HTMLCanvasElement, current, planLevel, lastChecks);
});
$("chkToggle").onclick = () => $("checks").classList.toggle("min");

function buildLevelButtons(res: BuildResult): void {
  const box = $("levels");
  box.innerHTML = "";
  const mk = (label: string, ids: string[] | null) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      visibleLevels = ids ? new Set(ids) : null;
      clip = null;
      applyLevels();
    };
    box.appendChild(b);
  };
  mk("All", null);
  const ids = res.levels.map((l) => l.id);
  res.levels.forEach((l, i) => mk(`≤ ${l.name}`, ids.slice(0, i + 1)));
}

function applyLevels(): void {
  if (!current) return;
  current.root.traverse((o) => {
    if (o.userData.mergeGroup === "context" || o.userData.kind === "landscape:neighbour") {
      o.visible = !hideContext;
      return;
    }
    const lv = o.userData.level as string | undefined;
    if (lv && (o as THREE.Mesh).isMesh) o.visible = !visibleLevels || visibleLevels.has(lv);
    if (lv && (o as THREE.Light).isLight && !(o.userData.kind === "sun" || o.userData.kind === "sky")) o.visible = !visibleLevels || visibleLevels.has(lv);
  });
  renderer.clippingPlanes = clip ? [clip] : [];
  // clipped solids: draw their back faces as a flat light-grey "poché" so cut walls, door leaves and frames
  // read as solid sections (lit back faces would show shadow acne)
  const seen = new Set<THREE.Material>();
  current.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || seen.has(m.material)) return;
    seen.add(m.material);
    const mat = m.material as THREE.Material;
    mat.userData.side0 ??= mat.side;
    if (mat.userData.side0 === THREE.DoubleSide || mat.transparent) return; // glass, leaves, cards: leave alone
    if (!mat.userData.capPatched) {
      mat.userData.capPatched = true;
      const prev = mat.onBeforeCompile.bind(mat);
      mat.onBeforeCompile = (sh, r) => {
        prev(sh, r);
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <dithering_fragment>",
          "#include <dithering_fragment>\n  if (!gl_FrontFacing) gl_FragColor = vec4(vec3(0.56, 0.55, 0.53), 1.0);",
        );
      };
      const key0 = mat.customProgramCacheKey.bind(mat);
      mat.customProgramCacheKey = () => key0() + "|cap";
    }
    const want = clip ? THREE.DoubleSide : (mat.userData.side0 as THREE.Side);
    if (mat.side !== want) {
      mat.side = want;
      mat.needsUpdate = true;
    }
  });
}

function setHour(h: number): void {
  $("hourv").textContent = h.toFixed(2);
  if (!current) return;
  let sun: THREE.DirectionalLight | null = null;
  let hemi: THREE.HemisphereLight | null = null;
  current.root.traverse((o) => {
    if (o.userData.kind === "sun") sun = o as THREE.DirectionalLight;
    if (o.userData.kind === "sky") hemi = o as THREE.HemisphereLight;
  });
  if (sun) updateSun(sun, currentPlan, h, hemi);
  setTimeOfDay(current.root, currentPlan, h);
  const { dir } = sunDirection(currentPlan, h);
  skyU.sunPosition.value.copy(dir);
  const alt = Math.asin(dir.y);
  renderer.toneMappingExposure = 0.85 + 0.25 * Math.min(1, alt / 0.5);
}

const FT = 0.3048;
function roomCenter(type: string, level?: string): { x: number; y: number; w: number; d: number; floor: number } | null {
  const r = currentPlan.rooms.find((q) => q.type === type && (!level || q.level === level));
  if (!r) return null;
  const lv = currentPlan.levels.find((l) => l.id === r.level)!;
  return { x: r.rect.x, y: r.rect.y, w: r.rect.w, d: r.rect.d, floor: lv.elevation_ft };
}

function setView(name: string): void {
  // world mapping: x = x_ft·FT, z = −y_ft·FT (the road is at +z)
  const Wf = currentPlan.site.plot.width_ft, Df = currentPlan.site.plot.depth_ft;
  const P = (xf: number, yf: number, hm: number) => new THREE.Vector3(xf * FT, hm, -yf * FT);
  visibleLevels = null;
  clip = null;
  hideContext = false;
  camera.fov = 42;
  let pos: THREE.Vector3, tgt: THREE.Vector3;
  switch (name) {
    case "front":
      pos = P(Wf / 2, -48, 1.75);
      tgt = P(Wf / 2, Df * 0.22, 4.6);
      break;
    case "back":
      pos = P(Wf * 0.2, Df + 52, 9);
      tgt = P(Wf / 2, Df * 0.6, 4);
      break;
    case "dollhouse": {
      const ids = current?.levels.map((l) => l.id) ?? [];
      visibleLevels = new Set(ids.slice(0, 1));
      hideContext = true;
      const g0 = currentPlan.levels.find((l) => l.index === 0) ?? currentPlan.levels[0];
      clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), g0.elevation_ft * FT + 2.3);
      pos = P(Wf * 0.5 - 20, -16, 19);
      tgt = P(Wf * 0.5, Df * 0.5, 0.5);
      camera.fov = 38;
      break;
    }
    case "lounge":
    case "master": {
      const r = name === "lounge" ? roomCenter("lounge", "ground") ?? roomCenter("lounge") : roomCenter("master_bedroom") ?? roomCenter("bedroom");
      if (r) {
        camera.fov = 64;
        // candidate eye points (corners, then wall midpoints) looking across the room; keep the ones whose view
        // is not blocked by furniture right in front of the lens, then prefer corners far from the doors
        const room = currentPlan.rooms.find((q) => q.rect.x === r.x && q.rect.y === r.y)!;
        const doors = currentPlan.openings.filter((o) => o.level === room.level && o.between.includes(room.id) && !/window|ventilator/.test(o.type));
        // aim at the room's hero piece (bed / sofa) when there is one, else across the room
        const heroRe = name === "master" ? /bed/ : /sofa/;
        const hero = current?.summary.objects.find((o) => o.room === room.id && heroRe.test(o.kind ?? ""));
        const hx = hero ? (hero.bbox_ft.min[0] + hero.bbox_ft.max[0]) / 2 : r.x + r.w / 2;
        const hy = hero ? (hero.bbox_ft.min[1] + hero.bbox_ft.max[1]) / 2 : r.y + r.d / 2;
        const i = 1.7;
        const pts: [number, number][] = [
          [r.x + i, r.y + i], [r.x + r.w - i, r.y + i], [r.x + i, r.y + r.d - i], [r.x + r.w - i, r.y + r.d - i],
          [r.x + r.w / 2, r.y + i], [r.x + r.w / 2, r.y + r.d - i], [r.x + i, r.y + r.d / 2], [r.x + r.w - i, r.y + r.d / 2],
        ];
        const cands: [number, number, number, number][] = pts.map(([x, y]) => {
          // look at the hero, or across the room through the centre when the hero is right beside the eye
          const far = Math.hypot(hx - x, hy - y) > 6;
          return far ? [x, y, hx, hy] : [x, y, x + (r.x + r.w / 2 - x) * 1.6, y + (r.y + r.d / 2 - y) * 1.6];
        });
        const meshes: THREE.Object3D[] = [];
        current?.root.traverseVisible((o) => {
          if ((o as THREE.Mesh).isMesh && !String(o.userData.kind ?? "").includes("glow")) meshes.push(o);
        });
        const rc = new THREE.Raycaster();
        const eyeH = (r.floor + 5.0) * FT;
        const aim = (c: [number, number, number, number]) => P(c[2], c[3], (r.floor + 2.8) * FT);
        const clear = (c: [number, number, number, number]) => {
          const from = P(c[0], c[1], eyeH);
          const to = aim(c);
          const dir = to.clone().sub(from);
          const len = Math.max(0.5, dir.length() - 0.9);
          dir.normalize();
          // a fan of rays across the frame: big surfaces right in front of the lens (an open door leaf, a
          // wardrobe side) ruin the shot, so score the near field (first 2.5 m) of each ray
          let sum = 0, worst = 1;
          const fan = [-0.5, -0.32, -0.16, 0, 0.16, 0.32, 0.5];
          const near = Math.min(2.5, len);
          for (const a of fan) {
            rc.set(from, dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a));
            rc.far = near;
            const hit = rc.intersectObjects(meshes, false)[0];
            const f = hit ? hit.distance / near : 1;
            sum += f;
            worst = Math.min(worst, f);
          }
          // the eye must not be inside something (short rays in 4 directions)
          let boxed = 0;
          for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            rc.set(from, new THREE.Vector3(d[0], 0, d[1]));
            rc.far = 0.35;
            if (rc.intersectObjects(meshes, false).length) boxed++;
          }
          return 0.6 * (sum / fan.length) + 0.4 * worst - boxed * 0.3;
        };
        const doorDist = (c: [number, number, number, number]) => Math.min(30, ...doors.map((o) => Math.hypot(o.at[0] - c[0], o.at[1] - c[1])));
        // prefer a comfortable distance to the subject (≈ 10–16 ft) and corners (they show two walls)
        const dist = (c: [number, number, number, number]) => Math.hypot(c[2] - c[0], c[3] - c[1]);
        // the hero faces away from the wall it stands against: view it from the front, not over its back
        let face: [number, number] | null = null;
        if (hero) {
          const b = hero.bbox_ft;
          const gaps: [number, [number, number]][] = [
            [b.min[0] - r.x, [1, 0]], [r.x + r.w - b.max[0], [-1, 0]], [b.min[1] - r.y, [0, 1]], [r.y + r.d - b.max[1], [0, -1]],
          ];
          gaps.sort((a, b2) => a[0] - b2[0]);
          if (gaps[0][0] < 2) face = gaps[0][1];
        }
        const facing = (c: [number, number, number, number]) => {
          if (!face) return 0;
          const dx = c[0] - hx, dy = c[1] - hy, l = Math.hypot(dx, dy) || 1;
          return (dx * face[0] + dy * face[1]) / l;
        };
        const score = (c: [number, number, number, number], k: number) =>
          clear(c) * 60 + Math.min(dist(c), 16) * 1.2 + Math.min(doorDist(c), 12) * 0.3 + (k < 4 ? 5 : 0) + facing(c) * 14;
        const ranked = cands.map((c, k) => ({ c, s: score(c, k), clear: clear(c), dist: dist(c) })).sort((a, b) => b.s - a.s);
        (window as unknown as { __camDebug?: unknown }).__camDebug = ranked;
        const best = ranked[0].c;
        pos = P(best[0], best[1], eyeH);
        tgt = aim(best).setY((r.floor + 3.2) * FT);
      } else {
        pos = P(Wf / 2, -40, 10);
        tgt = P(Wf / 2, Df / 2, 3);
      }
      break;
    }
    default:
      pos = P(Wf + 26, -40, 17);
      tgt = P(Wf * 0.45, Df * 0.4, 3.5);
  }
  camera.position.copy(pos);
  controls.target.copy(tgt);
  camera.updateProjectionMatrix();
  controls.update();
  applyLevels();
  document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.view === name));
}

function frame(): void {
  renderer.info.reset();
  if (usePost) composer.render();
  else renderer.render(scene, camera);
}

function updateStats(st?: Record<string, number>): void {
  frame();
  const info = renderer.info;
  const sec = current?.sections ?? [];
  const errs = sec.filter((s) => !s.ok).length;
  $("stats").textContent =
    `build ${buildMs.toFixed(0)} ms (engine ${st?.totalMs?.toFixed(0) ?? "?"} · merge ${st?.consolidateMs?.toFixed(0) ?? "?"}) · textures +${texWaitMs.toFixed(0)} ms\n` +
    `meshes ${st?.meshesBefore ?? "?"} → ${st?.meshesAfter ?? "?"}\n` +
    `draw calls ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
    `geometries ${info.memory.geometries} · textures ${info.memory.textures}\n` +
    `sections ${sec.length} · errors ${errs} · colliders ${current?.colliders.length ?? 0}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

$("rebuild").onclick = () => void rebuild();
$("design").onchange = () => void rebuild();
$("quality").onchange = () => void rebuild();
$("toggle").onclick = () => $("ui").classList.toggle("min");
document.querySelectorAll("#views button").forEach((b) => ((b as HTMLElement).onclick = () => setView((b as HTMLElement).dataset.view!)));
$("hour").oninput = (e) => setHour(parseFloat((e.target as HTMLInputElement).value));
$("post").onchange = (e) => {
  usePost = (e.target as HTMLInputElement).checked;
  renderer.toneMapping = usePost ? THREE.NoToneMapping : THREE.AgXToneMapping;
};
renderer.toneMapping = THREE.NoToneMapping;

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

let statTick = 0;
renderer.setAnimationLoop(() => {
  if (building) return;
  controls.update();
  frame();
  if (++statTick % 60 === 0 && current) updateStats((window as unknown as { __lastStats?: Record<string, number> }).__lastStats);
});

// automation hooks for screenshots / checks
(window as unknown as Record<string, unknown>).__engine = {
  rebuild,
  setView,
  setHour: (h: number) => {
    ($("hour") as HTMLInputElement).value = String(h);
    setHour(h);
  },
  capture: (w?: number, h?: number) => {
    if (w && h) {
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    frame();
    return renderer.domElement.toDataURL("image/png");
  },
  /** Eye at plan (x, y, h ft) looking at (tx, ty, th ft); everything visible, no section cut. */
  look: (x: number, y: number, h: number, tx: number, ty: number, th: number, fov = 70) => {
    visibleLevels = null;
    clip = null;
    camera.fov = fov;
    camera.position.set(x * FT, h * FT, -y * FT);
    controls.target.set(tx * FT, th * FT, -ty * FT);
    camera.updateProjectionMatrix();
    controls.update();
    applyLevels();
  },
  stats: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, buildMs, texWaitMs, ...(window as unknown as { __lastStats?: object }).__lastStats }),
  /** Draw calls of the main colour pass alone (no shadow map, AO or post passes). */
  mainPassCalls: () => {
    const au = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.info.reset();
    renderer.render(scene, camera);
    const out = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    renderer.shadowMap.autoUpdate = au;
    return out;
  },
  renderer,
  /** Livability checklist on the current build (also shown in the Checks panel). */
  checks: () => showChecks().then((cs) => cs.map((c) => ({ id: c.id, status: c.status, detail: c.detail, spots: c.spots }))),
  plan: (id: string | null) => setPlan(id),
  /** The 2D as-built plan of one level as a PNG data URL (for reports). */
  planImage: (id: string, w = 900, h = 1500) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    if (current) drawPlan(c, current, id, lastChecks);
    return c.toDataURL("image/png");
  },
  /** Replica of the backend's as-built projection check on the current build (empty = pass). */
  asBuilt: () => (current ? asBuiltCheck(currentPlan, current.summary) : null),
  texturesReady,
  camera,
  controls,
  scene,
  get result() {
    return current;
  },
};

async function swatches(): Promise<void> {
  const { MaterialLib, PRESETS, texturesReady: ready } = await import("../materials/library");
  const lib = new MaterialLib("high");
  const names = Object.keys(PRESETS);
  const g = new THREE.Group();
  const cols = 8;
  const geo = new THREE.SphereGeometry(0.42, 48, 32);
  const box = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  // box-projected UVs in meters so textures show true scale
  for (const gg of [geo, box]) {
    const p = gg.getAttribute("position"), n = gg.getAttribute("normal");
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      const [u, v] = ax >= ay && ax >= az ? [p.getZ(i), p.getY(i)] : ay >= az ? [p.getX(i), p.getZ(i)] : [p.getX(i), p.getY(i)];
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
    gg.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  names.forEach((name, i) => {
    const m = lib.get(name as never);
    const x = (i % cols) * 2.1, z = Math.floor(i / cols) * 2.3;
    const s1 = new THREE.Mesh(box, m);
    s1.position.set(x - 0.45, 0.4, z);
    const s2 = new THREE.Mesh(geo, m);
    s2.position.set(x + 0.5, 0.42, z);
    s1.castShadow = s2.castShadow = s1.receiveShadow = s2.receiveShadow = true;
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 48;
    const c2 = cv.getContext("2d")!;
    c2.fillStyle = "#111";
    c2.fillRect(0, 0, 256, 48);
    c2.fillStyle = "#eee";
    c2.font = "26px Inter, sans-serif";
    c2.fillText(name, 8, 33);
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.3), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), toneMapped: false }));
    lab.position.set(x, 0.01, z + 0.85);
    lab.rotation.x = -Math.PI / 2;
    g.add(s1, s2, lab);
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), new THREE.MeshStandardMaterial({ color: 0x8a8a88, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(7, 0, 6);
  floor.receiveShadow = true;
  g.add(floor);
  const sun = new THREE.DirectionalLight(0xfff1e0, 3);
  sun.position.set(-6, 10, -4);
  sun.target.position.set(7, 0, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
  g.add(sun, sun.target, new THREE.HemisphereLight(0xbcd4ee, 0x6d5a47, 0.5));
  scene.add(g);
  camera.position.set(7, 9, -6);
  controls.target.set(7, 0, 6);
  controls.update();
  await ready();
  $("stats").textContent = `${names.length} presets`;
}

if (params.has("swatches")) void swatches();
else void rebuild();
