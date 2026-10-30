/**
 * The views of one home (DESIGN.md §5 "Navigation model"): Brief · Concepts · Plan · House, plus Revisions
 * (reached from the title menu or "See what changed"). Places, not steps: no numbers, no ticks.
 *
 * Routes: /app/p/:id/:view. The query string holds the state, e.g. ?mode=walk&floor=first&room=f_bed2&v=<vid>&light=night.
 */
import type { Project, Role, Stage } from "@contracts/api-types";

export type ViewId = "brief" | "taste" | "concepts" | "plan" | "house" | "revisions";
export type SwitchViewId = Exclude<ViewId, "revisions">;

export const VIEWS: { id: SwitchViewId; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "taste", label: "Heart" },
  { id: "concepts", label: "Concepts" },
  { id: "plan", label: "Plan" },
  { id: "house", label: "House" },
];

export const VIEW_IDS: ViewId[] = ["brief", "taste", "concepts", "plan", "house", "revisions"];

export function isViewId(v: string | undefined): v is ViewId {
  return !!v && (VIEW_IDS as string[]).includes(v);
}

/** Old step routes → views (setup→brief, design→plan, explore→house). */
export const LEGACY_VIEW: Record<string, ViewId> = {
  setup: "brief",
  concepts: "concepts",
  design: "plan",
  explore: "house",
  revisions: "revisions",
};

const ORDER: Stage[] = ["setup", "concepts", "planning", "building", "ready", "revising"];
export const stageIndex = (s: Stage) => ORDER.indexOf(s);

export const hasVersion = (p: Project) => p.versions.some((v) => v.status === "ready") && !!p.current_version_id;

export function roleOf(p: Project | null | undefined): Role {
  return p?.role ?? "owner";
}

/** Owner and Team edit and revise; Client comments and approves. */
export function canEdit(p: Project | null | undefined): boolean {
  return roleOf(p) !== "client";
}

/** Which views exist yet. Clients only ever see Plan and House. */
export function viewAvailable(p: Project, view: ViewId): boolean {
  const client = roleOf(p) === "client";
  const i = stageIndex(p.stage);
  switch (view) {
    case "brief":
      return !client;
    case "taste":
      return !client || !!p.taste;
    case "concepts":
      return !client && (i >= stageIndex("concepts") || p.concepts.length > 0);
    case "plan":
      return hasVersion(p) || (!client && (!!p.selected_concept_id || i >= stageIndex("planning")));
    case "house":
      return hasVersion(p);
    case "revisions":
      return !client && p.versions.length > 1;
  }
}

/** The view a home opens on. */
export function defaultView(p: Project): ViewId {
  if (roleOf(p) === "client") return hasVersion(p) ? "house" : "plan";
  switch (p.stage) {
    case "setup":
      return "brief";
    case "concepts":
      return p.selected_concept_id && viewAvailable(p, "plan") ? "plan" : "concepts";
    case "planning":
    case "building":
      return "plan";
    case "ready":
    case "revising":
      return hasVersion(p) ? "house" : "plan";
  }
}

/** A short status for cards: "Ready to walk", "Choosing a concept"… */
export function stageLabel(p: Project): string {
  const v = p.versions.length;
  switch (p.stage) {
    case "setup":
      return "Writing the brief";
    case "concepts":
      return p.selected_concept_id ? "Concept chosen" : p.concepts.length ? "Choosing a concept" : "Brief ready";
    case "planning":
      return "Planning";
    case "building":
      return "Building in 3D";
    case "ready":
      return v > 1 ? `Version ${v}` : "Ready to walk";
    case "revising":
      return "Revising";
  }
}

export function stageBusy(p: Project): boolean {
  return p.stage === "planning" || p.stage === "building" || p.stage === "revising";
}

/**
 * The version a view shows from ?v=: a version id or its number (?v=2), else the current version. `known` is false
 * when ?v= names no version of this home (the caller falls back to the current one and says so).
 */
export function resolveVersion(p: Project, v: string | null | undefined): { id: string | null; known: boolean } {
  const current = p.current_version_id ?? null;
  if (!v) return { id: current, known: true };
  if (p.versions.some((x) => x.id === v)) return { id: v, known: true };
  const n = Number(v.replace(/^v/i, ""));
  const byN = Number.isInteger(n) ? p.versions.find((x) => x.n === n) : undefined;
  if (byN) return { id: byN.id, known: true };
  return { id: current, known: false };
}
