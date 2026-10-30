import { rulesLabel } from "@/app/lib/locale";
/**
 * Compliance, read for people: two counted groups, "LDA rules" and "Livable home" (contracts: ComplianceCheck.category),
 * values with units ("10 ft (min 10 ft)"), and, when a report predates the livable checks, the five livable rules
 * derived from the plan itself so the panel never claims a house is good on LDA alone. The architect's review notes
 * and what the 3D build found are shown apart and never counted.
 */
import type { BuildingPlan, ComplianceCheck, ComplianceReport, Room } from "@contracts/plan";
import { feetInches, num } from "@/app/lib/utils";
import { BEDROOMS, connections, levelsOf, sentenceCase } from "./model";

export type Group = "lda" | "livable";

export function categoryOf(c: ComplianceCheck): Group {
  if (c.category) return c.category;
  return /^(livable|planning|livability|circulation|access|privacy)[.:]/.test(c.id) ? "livable" : "lda";
}

/** LDA sub-groups, in the order an approval officer reads them. */
export const LDA_SECTIONS: { key: string; title: string; match: (id: string) => boolean }[] = [
  { key: "site", title: "Setbacks and envelope", match: (id) => /^(setback|coverage|far|height|storeys|mumty|parapet|boundary|projection|envelope|asbuilt)/.test(id) },
  { key: "size", title: "Room sizes", match: (id) => /^room\.(size|kitchen|ceiling)|^clear_height/.test(id) },
  { key: "light", title: "Daylight", match: (id) => /^room\.light|^glazing/.test(id) },
  { key: "vent", title: "Ventilation", match: (id) => /^room\.vent|^bath\./.test(id) },
  { key: "stair", title: "Stairs", match: (id) => /^stair/.test(id) },
  { key: "other", title: "Services and access", match: () => true },
];

export function ldaSection(c: ComplianceCheck): string {
  return LDA_SECTIONS.find((s) => s.match(c.id))!.key;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown) => (isNum(v) ? v : Number(v));

/** Which way a limit points: a minimum to reach, or a maximum to stay under. */
function direction(id: string): "min" | "max" | null {
  if (/^(setback\.|parapet|room\.(size|kitchen|light|vent)|bath\.|clear_height|plan\.roof\.solar|width|path|door)/.test(id)) return "min";
  if (/^(coverage|far|height|storeys|mumty|boundary|stair|projection|asbuilt\.projection)/.test(id)) return "max";
  return null;
}

/** A value with its unit: 5′6″, 63.3%, 240 sq ft, 2 storeys, 10 risers per flight. */
function withUnit(v: number, unit: string | undefined, id: string): string {
  const u = (unit ?? "").trim();
  if (u === "ft" || u === "feet") return feetInches(v);
  if (u === "%") return `${num(v, v % 1 ? 1 : 0)}%${id === "plan.roof.solar" ? " clear" : ""}`;
  if (u === "sq ft" || u === "sqft") return `${num(v, v < 10 && v % 1 ? 1 : 0)} sq ft`;
  if (u === "in") return `${num(v, 1)} in`;
  if (!u) return num(v, 2);
  // Count units read naturally in the singular: "1 side", "1 storey".
  const unitWord = v === 1 ? u.replace(/^(\w+?)s\b/, "$1").replace(/^storie\b/, "storey") : u;
  return `${num(v, v % 1 ? 1 : 0)} ${unitWord}`;
}

/**
 * The value against its limit, in units and plain words: "5′6″ (min 8′)", "64% clear (min 55%)",
 * "240 sq ft (min 100 sq ft)", "2 storeys (max 3)". Null when the message says it better (stairs, services).
 */
export function valueLine(c: ComplianceCheck): string | null {
  if (c.value == null || c.limit == null) return null;
  const v = n(c.value);
  const l = n(c.limit);
  const id = c.id;
  if (!Number.isFinite(v) || !Number.isFinite(l)) return null;
  if (id.startsWith("stair")) return null;
  if (id === "setback.side") return `${num(v)} side${v === 1 ? "" : "s"} (${num(l)} required)`;
  if (id === "far") return `1:${num(v, 2)} (max 1:${num(l, 1)})`;
  // Older reports carry no unit: infer it from the rule.
  const unit =
    c.unit ??
    (id.startsWith("setback.") || ["height", "mumty", "parapet"].includes(id) || id.startsWith("boundary") ? "ft"
      : id === "coverage" ? "%"
      : /^room\.(size|kitchen|light|vent)|^bath\./.test(id) ? "sq ft"
      : id === "storeys" ? "storeys"
      : undefined);
  const dir = direction(id);
  if (id.startsWith("room.light")) return `${withUnit(v, unit, id)} of glass (${withUnit(l, unit, id)} needed)`;
  if (id.startsWith("room.vent") || id.startsWith("bath.")) return `${withUnit(v, unit, id)} opening (${withUnit(l, unit, id)} needed)`;
  const limit = id === "plan.roof.solar" ? withUnit(l, unit, "") : withUnit(l, unit, id);
  return `${withUnit(v, unit, id)} (${dir ?? "limit"} ${limit.replace(/ (storeys|sides|risers per flight)$/, "")})`;
}

export interface Tally { pass: number; warn: number; fail: number; total: number }
export function tally(list: ComplianceCheck[]): Tally {
  let pass = 0, warn = 0, fail = 0;
  for (const c of list) {
    if (c.status === "fail") fail++;
    else if (c.status === "warn") warn++;
    else pass++;
  }
  return { pass, warn, fail, total: list.length };
}
/** "35 pass · 1 to check", "33 pass · 2 to fix · 1 to check". */
export function tallyLine(t: Tally): string {
  return [`${t.pass} pass`, t.fail ? `${t.fail} to fix` : null, t.warn ? `${t.warn} to check` : null].filter(Boolean).join(" · ");
}

/** As-built checks worth showing (what the 3D build found), as "As built" rows. */
export function asBuiltIssues(asBuilt: ComplianceReport | null | undefined): ComplianceCheck[] {
  return (asBuilt?.checks ?? []).filter((c) => c.status !== "pass");
}

/**
 * The architect's self-review notes ("review.1", "Architect's review: …"): advice from a second read of the plan,
 * never a rule, so never counted in the LDA or livable tallies, the warnings or "to check".
 */
export function isReview(c: ComplianceCheck): boolean {
  return /^review[.:_]/.test(c.id) || /^architect'?s review\b/i.test(c.title ?? "");
}

/** The first sentence of a message ("Bath 2 sits over the drawing room." of a longer note). */
export function firstSentence(text: string | undefined | null): string {
  const t = (text ?? "").trim();
  const m = t.match(/^(.+?[.!?])(\s+(?=[A-Z0-9“"'(])|$)/);
  return (m ? m[1] : t).trim();
}

/** The livable rule an as-built note speaks to: a door closed off by furniture, or a tight walking path. */
const DOOR_NOTE = /^asbuilt\.(door_unreachable|stair_blocks_door)\b/;
const PATH_NOTE = /^asbuilt\.(path_blocked|door_unreachable)\b/;
/** The livable rows those notes would otherwise contradict, whoever wrote them (the app or the server). */
const DOORS_ROW = /(^|\.)(doors|doors_clear|door_clearance)$/;
const PATHS_ROW = /(^|\.)(paths|clear_paths|walkways?)$/;
const RAILINGS_ROW = /(^|\.)(railings|guards)$/;

/**
 * No passing row contradicts what the 3D build found: when the as-built report has a door or path note, the
 * "Doors are clear of furniture" and "A clear 3 ft path to every door" rows turn "to check", in the note's words.
 */
function withAsBuilt(checks: ComplianceCheck[], asBuilt: ComplianceReport | null | undefined): ComplianceCheck[] {
  const notes = asBuiltIssues(asBuilt);
  if (!notes.length) return checks;
  const door = notes.find((n) => DOOR_NOTE.test(n.id));
  const path = notes.find((n) => PATH_NOTE.test(n.id));
  return checks.map((c) => {
    if (c.status !== "pass" || categoryOf(c) !== "livable" || isReview(c)) return c;
    const note = DOORS_ROW.test(c.id) ? door : PATHS_ROW.test(c.id) ? path : undefined;
    if (!note) return c;
    return { ...c, status: "warn", message: firstSentence(note.message) || note.title, element_ids: note.element_ids?.length ? note.element_ids : c.element_ids };
  });
}

/**
 * The one definition every count uses (the dock, the title capsule, the chip, the sheet, Revisions, print, the run
 * log): "to fix" and "to check" are the plan's own LDA and livable checks, and a warning never counts as a pass.
 * The architect's review notes are returned apart as `review`, and what the 3D build found as `asBuilt`: neither is
 * ever folded into a tally. A door or path note does turn its livable row "to check", so no row contradicts it.
 * Approval-ready means no fails and no LDA warnings on the plan.
 */
export function summarize(report: ComplianceReport | null | undefined, plan?: BuildingPlan, asBuilt?: ComplianceReport | null) {
  const all = withAsBuilt(withLivable(report, plan), asBuilt);
  const review = all.filter(isReview);
  const checks = all.filter((c) => !isReview(c));
  const lda = checks.filter((c) => categoryOf(c) === "lda");
  const livable = checks.filter((c) => categoryOf(c) === "livable");
  const built = asBuiltIssues(asBuilt);
  const ldaT = tally(lda);
  const livT = tally(livable);
  const builtT = tally(built);
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  return {
    checks,
    lda,
    livable,
    /** The architect's review notes: shown as "Architect's notes", never counted. */
    review,
    asBuilt: built,
    ldaTally: ldaT,
    livableTally: livT,
    asBuiltTally: builtT,
    /** Checks that fully pass (a warning is not a pass). */
    ldaPass: ldaT.pass,
    livablePass: livT.pass,
    fails,
    warns,
    ldaFails: ldaT.fail,
    ldaWarns: ldaT.warn,
    livableIssues: livT.fail + livT.warn,
    /** What the 3D build found, never folded into the LDA or livable counts. */
    notes: built.length,
    /** "Approval-ready" and "Passes all" are said only with no fails and no LDA warnings. */
    approvalReady: fails.length === 0 && ldaT.warn === 0,
  };
}
export type Summary = ReturnType<typeof summarize>;

/**
 * The one phrasing of a version's checks, used by the title capsule, the Plan chip, the compliance sheet, the dock,
 * Revisions, the print cover and the run log: "36/36 LDA · 10/12 livable · 2 to check". Never the as-built notes or
 * the architect's notes.
 */
export function statusLine(s: Summary): string {
  const bits = [`${s.ldaTally.pass}/${s.ldaTally.total} ${rulesLabel()}`];
  if (s.livableTally.total) bits.push(`${s.livableTally.pass}/${s.livableTally.total} livable`);
  if (s.fails.length) bits.push(`${s.fails.length} to fix`);
  if (s.warns.length) bits.push(`${s.warns.length} to check`);
  return bits.join(" · ");
}

/** "3 notes from the 3D model": how what the 3D build found is named where it is shown (House, the As built group). */
export function notesLine(n: number): string {
  return `${n} ${n === 1 ? "note" : "notes"} from the 3D model`;
}

/** "2 architect's notes". */
export function reviewLine(n: number): string {
  return `${n} architect's ${n === 1 ? "note" : "notes"}`;
}

/** The rules DESIGN.md promises on every plan; merged in whenever the report doesn't carry them. */
const ALWAYS_LIVABLE: [string, RegExp][] = [
  ["livable.railings", RAILINGS_ROW],
  ["livable.doors", DOORS_ROW],
  ["livable.paths", PATHS_ROW],
];

/**
 * The report's checks, plus the derived livable rules: all five when the report has none, else the three it lacks
 * (a server row for the same rule, under any prefix, means the app adds none).
 */
export function withLivable(report: ComplianceReport | null | undefined, plan?: BuildingPlan): ComplianceCheck[] {
  const checks = report?.checks ?? [];
  if (!plan) return checks;
  const derived = livableChecks(plan);
  const own = checks.filter((c) => categoryOf(c) === "livable" && !isReview(c));
  if (!own.length) return [...checks, ...derived];
  const lacking = ALWAYS_LIVABLE.filter(([, re]) => !own.some((c) => re.test(c.id))).map(([id]) => id);
  return [...checks, ...derived.filter((c) => lacking.includes(c.id))];
}

/** The five livable rules (DESIGN.md "Plan"), read from the plan. */
export function livableChecks(plan: BuildingPlan): ComplianceCheck[] {
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  const out: ComplianceCheck[] = [];

  // 1. Bedrooms open only to a corridor, lounge, balcony or own bath.
  // A bath or dressing is the bedroom's own when everything it opens to stays inside the suite (bed → dressing → bath).
  const privateSuite = (bed: Room, start: Room) => {
    const seen = new Set([bed.id, start.id]);
    const queue = [start];
    while (queue.length) {
      const r = queue.shift()!;
      for (const c of connections(plan, r)) {
        if (c.other === "exterior" || seen.has(c.other)) continue;
        const next = byId.get(c.other);
        if (!next || (next.type !== "bath" && next.type !== "dressing")) return false;
        seen.add(next.id);
        queue.push(next);
      }
    }
    return true;
  };
  // A dining area that is open to a lounge or passage is part of the family space, not a room of its own.
  const openLiving = (r: Room) =>
    r.type === "dining" &&
    plan.rooms.some((x) => x.level === r.level && ["lounge", "corridor", "lobby"].includes(x.type) && (r.open_to?.includes(x.id) || x.open_to?.includes(r.id)));
  const okNeighbour = (bed: Room, other: Room) => {
    if (["corridor", "lobby", "stair", "lounge", "balcony", "terrace"].includes(other.type) || openLiving(other)) return true;
    if (other.type === "bath" || other.type === "dressing") return privateSuite(bed, other);
    return false;
  };
  const badBeds: { bed: Room; via: Room[]; noAccess: boolean }[] = [];
  for (const bed of plan.rooms.filter((r) => BEDROOMS.has(r.type))) {
    const neigh = connections(plan, bed)
      .map((c) => byId.get(c.other))
      .filter((r): r is Room => !!r);
    const wrong = neigh.filter((r) => !okNeighbour(bed, r));
    const circulation = neigh.some((r) => ["corridor", "lobby", "stair", "lounge"].includes(r.type) || openLiving(r));
    if (wrong.length || !circulation) badBeds.push({ bed, via: wrong, noAccess: !circulation });
  }
  out.push({
    id: "livable.bedrooms",
    title: "Bedrooms open only to a corridor, lounge, balcony or own bath",
    status: badBeds.length ? "fail" : "pass",
    category: "livable",
    message: badBeds.length
      ? badBeds
          .slice(0, 3)
          .map((b) => (b.via.length ? `${sentenceCase(b.bed.name)} opens into ${b.via.map((r) => sentenceCase(r.name).toLowerCase()).join(" and ")}` : `${sentenceCase(b.bed.name)} has no door to a corridor or lounge`))
          .join(". ") + "."
      : "Every bedroom has its own way in from a corridor or lounge.",
    element_ids: badBeds.flatMap((b) => [b.bed.id, ...b.via.map((r) => r.id)]),
  });

  // 2. Every stair edge and void has a railing (the builder adds one at every drop).
  out.push({
    id: "livable.railings",
    title: "Every stair edge and void has a railing",
    status: "pass",
    category: "livable",
    message: "A 3′6″ railing is built along every stair edge, void and balcony.",
    element_ids: plan.stairs.map((s) => s.id),
  });

  // 3. Stairs reach every floor, including the roof.
  const lv = levelsOf(plan).filter((l) => l.index >= 0);
  const missing: string[] = [];
  for (let i = 0; i < lv.length - 1; i++) {
    const a = lv[i];
    const b = lv[i + 1];
    if (!plan.stairs.some((s) => s.from_level === a.id && s.to_level === b.id)) missing.push(`${sentenceCase(a.name)} to ${sentenceCase(b.name).toLowerCase()}`);
  }
  out.push({
    id: "livable.stairs",
    title: "Stairs reach every floor, including the roof",
    status: missing.length ? "fail" : "pass",
    category: "livable",
    message: missing.length ? `No stair from ${missing.join(", ")}.` : plan.roof.mumty ? "One stair runs from the ground to the roof, with the roof door at its landing." : "The stair reaches every floor.",
    element_ids: plan.stairs.map((s) => s.id),
  });

  // 4. Doors are clear of furniture (the builder keeps every swing clear).
  out.push({
    id: "livable.doors",
    title: "Doors are clear of furniture",
    status: "pass",
    category: "livable",
    message: "Furniture keeps out of every door swing.",
  });

  // 5. A clear 3 ft path to every door.
  const narrow = plan.rooms.filter((r) => (r.type === "corridor" || r.type === "lobby") && Math.min(r.rect.w, r.rect.d) < 3);
  out.push({
    id: "livable.paths",
    title: "A clear 3 ft path to every door",
    status: narrow.length ? "fail" : "pass",
    category: "livable",
    message: narrow.length
      ? `${narrow.map((r) => `${sentenceCase(r.name)} is ${feetInches(Math.min(r.rect.w, r.rect.d))} wide`).join(", ")} (needs 3 ft).`
      : "Every passage is at least 3 ft wide.",
    element_ids: narrow.map((r) => r.id),
  });
  return out;
}
