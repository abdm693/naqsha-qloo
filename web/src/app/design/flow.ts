/**
 * Flow state for the views (Brief, Concepts, Plan, House, Revisions): the long-running work behind them, in the shape
 * the views read it — a design or revise run with its activity in plain words, a concepts run, night images.
 *
 * There is ONE engine: the shell's project store (`@/app/store/project`). It owns the project, the setup chat, the
 * concepts/design/revise streams, the versions and the comments, so the dock, the conversation sheet, the comments
 * sheet and every view agree. This module only
 *   - mirrors that store into `useFlow` (runs → activity lines, comments by version), and
 *   - forwards the views' actions (`flow.design`, `flow.revise`, …) to it.
 * Night images (POST /concepts/night) are the one stream that lives here: only Concepts uses them.
 *
 * For the dock: `useNaqshaActivity()` says whether Naqsha is working and the line to narrate.
 */
import { useMemo } from "react";
import { create } from "zustand";
import type { Change, Comment, Concept, DesignSection, Version } from "@contracts/api-types";
import type { BuildingPlan, ComplianceReport } from "@contracts/plan";
import { api, isAbortError, type ConceptsBody, type NewComment } from "@/api/client";
import { loadFixLoop } from "@/app/lib/fixloop";
import { inSentence } from "@/app/plan/model";
import { statusLine, summarize } from "@/app/plan/compliance";
import { useProject, type ConceptRun as StoreConceptRun, type Run as StoreRun } from "@/app/store/project";
import { useNarration, type Narration } from "@/app/shell/narration";
import { notify } from "./kit";
import { failures, humanize, namedStage, plural, sectionPhrase, type NamedStage } from "./words";

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────

export interface Activity {
  id: string;
  at: number;
  text: string;
  tone: "default" | "pass" | "warn" | "fail";
  kind: "stage" | "plan" | "check" | "section" | "changes" | "comment" | "version" | "error";
}

export interface Run {
  kind: "design" | "revise";
  pid: string;
  status: "running" | "done" | "error";
  startedAt: number;
  resumed: boolean;
  /** Last raw pipeline stage ("plan", "fix", "compliance", "review", "build", "save", "changes"). */
  stage: string | null;
  /** When this page re-attached to the run: steps before it were replayed in a burst (their times aren't known). */
  attachedAt?: number;
  reached: NamedStage[];
  plan?: BuildingPlan;
  planAttempt?: number;
  compliance?: ComplianceReport;
  complianceAttempt?: number;
  /** Failures per compliance attempt, e.g. [5, 1, 0]. */
  failures: number[];
  sections: DesignSection[];
  changes?: Change[];
  resolved: Comment[];
  version?: Version;
  error?: string;
  activity: Activity[];
  baseVersionId?: string;
  instruction?: string;
  commentIds?: string[];
}

export interface ConceptSlot { key: string; index: number; status: "drawing" | "done" | "failed"; conceptId?: string; message?: string }
export interface ConceptRun { id: string; pid: string; instruction?: string; baseId?: string; slots: ConceptSlot[]; running: boolean; startedAt: number; note?: string }
export interface NightRun { pid: string; ids: string[]; done: string[]; failed: string[]; running: boolean; startedAt: number }

interface FlowState {
  pid: string | null;
  design: Run | null;
  revise: Run | null;
  concepts: ConceptRun | null;
  night: NightRun | null;
  /** Night images by concept id (also merged into project.concepts). */
  nightUrls: Record<string, string>;
  versions: Record<string, Version>;
  /** Comments of the version the store has loaded, keyed by that version id. */
  comments: Record<string, Comment[]>;
}

export const useFlow = create<FlowState>(() => ({
  pid: null,
  design: null,
  revise: null,
  concepts: null,
  night: null,
  nightUrls: {},
  versions: {},
  comments: {},
}));

// ── Mirror of the project store ──────────────────────────────────────────────────────────────────────

const STATUS_WORD: Record<Comment["status"], string> = { open: "Open", resolved: "Done", partial: "Alternative offered", rejected: "Not possible" };

/** What a design-run stage says to people. */
function designStageLine(stage: string, fails: number[]): string {
  switch (stage) {
    case "plan":
      return "Laying out the floors";
    case "fix": {
      const n = fails[fails.length - 1] ?? 0;
      return n ? `Fixing ${plural(n, "issue")}` : "Refining the plan";
    }
    case "compliance":
      return "Checking LDA and livability rules";
    case "review":
    case "critique":
    case "self_review":
      return "Reviewing it like an architect";
    case "build":
      return "Building the house in 3D";
    case "save":
      return "Saving the new version";
    default:
      return humanize(stage);
  }
}

/** The store's run (raw events) → the views' run (named stages, plain-word activity, resolved comments). */
function toRun(kind: Run["kind"], pid: string, r: StoreRun, versions: Record<string, Version>): Run | null {
  if (r.status === "idle") return null;
  const basePlan = r.plan ?? (r.baseVersionId ? versions[r.baseVersionId]?.plan : undefined);
  const activity: Activity[] = [];
  const reached: NamedStage[] = [];
  const resolved: Comment[] = [];
  let stage: string | null = null;
  let fails: number[] = [];
  // The plan each compliance report is about (the latest drawn so far), so the counts match the sheet's.
  let curPlan: BuildingPlan | undefined = r.baseVersionId ? versions[r.baseVersionId]?.plan : undefined;
  // The plan attempt behind each entry of `fails`, and the attempts already counted.
  const attempts: (number | undefined)[] = [];
  const seen = new Set<number>();
  const push = (id: string, at: number, a: Omit<Activity, "id" | "at">) => {
    const last = activity[activity.length - 1];
    if (last && last.text === a.text && last.kind === a.kind) return;
    activity.push({ ...a, id, at });
  };
  for (const it of r.items) {
    switch (it.kind) {
      case "stage": {
        if (it.stage === "wait") break;
        stage = it.stage;
        const named = namedStage(it.stage);
        if (named && !reached.includes(named)) reached.push(named);
        const afterReview = it.stage === "fix" && reached.includes("review");
        const text = kind === "design" ? (afterReview ? "Acting on the review" : designStageLine(it.stage, fails)) : humanize(it.message || designStageLine(it.stage, fails), basePlan);
        push(it.id, it.at, { kind: "stage", text, tone: "default" });
        break;
      }
      case "plan":
        curPlan = it.plan ?? curPlan;
        if (kind === "revise") push(it.id, it.at, { kind: "plan", text: "Updated the plan", tone: "default" });
        break;
      case "compliance": {
        const n = failures(it.report);
        // A design run checks each plan attempt once; the best attempt's report is sent again at the end when a
        // later round was worse. That one replaces its own entry and says the round is kept (one value per attempt).
        const again = kind === "design" && it.attempt != null && seen.has(it.attempt);
        if (again) fails = fails.map((f, i) => (attempts[i] === it.attempt ? n : f));
        else {
          fails = [...fails, n];
          attempts.push(it.attempt);
          if (it.attempt != null) seen.add(it.attempt);
        }
        const rules = it.report.checks.filter((c) => c.status === "fail").slice(0, 2).map((c) => inSentence(c.title)).join(", ");
        // The one phrasing every count uses; the architect's notes are never counted, and "All N checks pass" is
        // said only with nothing to fix and nothing to check.
        const s = summarize(it.report, curPlan);
        const clean = !s.fails.length && !s.warns.length;
        const verdict = clean ? "every check passes" : statusLine(s);
        push(
          it.id,
          it.at,
          again
            ? { kind: "check", text: `Keeping round ${it.attempt}, the best one: ${n ? `${plural(n, "rule")} to fix` : verdict}`, tone: n || !clean ? "warn" : "pass" }
            : n
              ? { kind: "check", text: `${plural(n, "rule")} to fix: ${rules}`, tone: "warn" }
              : clean
                ? { kind: "check", text: `All ${s.checks.length} checks pass`, tone: "pass" }
                : { kind: "check", text: `Checked: ${verdict}`, tone: "warn" },
        );
        break;
      }
      case "section":
        if (kind === "revise") push(it.id, it.at, { kind: "section", text: `Redrew ${sectionPhrase(it.section.name, basePlan)}`, tone: "default" });
        break;
      case "changes":
        if (it.changes.length) push(it.id, it.at, { kind: "changes", text: `Planned ${plural(it.changes.length, "change")}`, tone: "default" });
        break;
      case "comment": {
        const c = it.comment;
        const i = resolved.findIndex((x) => x.id === c.id);
        if (i >= 0) resolved.splice(i, 1);
        resolved.push(c);
        const quote = c.text.length > 60 ? `${c.text.slice(0, 58).trim()}…` : c.text;
        push(it.id, it.at, {
          kind: "comment",
          text: `“${quote}”: ${STATUS_WORD[c.status]}`,
          tone: c.status === "resolved" ? "pass" : c.status === "rejected" ? "fail" : c.status === "partial" ? "warn" : "default",
        });
        break;
      }
      case "version":
        push(it.id, it.at, { kind: "version", text: `Saved version ${it.version.n}`, tone: "pass" });
        break;
      case "error":
        push(it.id, it.at, { kind: "error", text: it.message, tone: "fail" });
        break;
    }
  }
  return {
    kind,
    pid,
    status: r.status,
    startedAt: r.startedAt ?? Date.now(),
    // A re-attached run whose start time the server sent is shown like a fresh one (with its clock).
    resumed: !!r.resumed && !r.serverStart,
    stage,
    reached,
    attachedAt: r.attachedAt,
    plan: r.plan,
    planAttempt: r.planAttempt,
    compliance: r.compliance,
    complianceAttempt: r.complianceAttempt,
    failures: r.failures,
    sections: r.sections,
    changes: r.changes,
    resolved,
    version: r.version,
    error: r.error,
    activity,
    baseVersionId: r.baseVersionId,
    instruction: r.instruction,
    commentIds: r.commentIds,
  };
}

function toConcepts(pid: string, r: StoreConceptRun | null): ConceptRun | null {
  if (!r) return null;
  return { id: r.id, pid, instruction: r.instruction, baseId: r.baseId, running: r.running, startedAt: r.startedAt, slots: r.slots, note: r.note };
}

// Recompute only what changed (reference equality on the store's slices), so selectors stay stable.
let seen: {
  pid: string | null;
  design?: StoreRun;
  revise?: StoreRun;
  conceptRun?: StoreConceptRun | null;
  versions?: Record<string, Version>;
  comments?: Comment[];
  commentsFor?: string | null;
} = { pid: null };

const nightControllers = new Set<AbortController>();

function sync() {
  const st = useProject.getState();
  // A client link uses the store too, but has no flows.
  const pid = st.shareToken ? null : st.pid;
  const patch: Partial<FlowState> = {};
  if (pid !== seen.pid) {
    for (const c of nightControllers) c.abort();
    nightControllers.clear();
    seen = { pid };
    Object.assign(patch, { pid, night: null, nightUrls: {} });
  }
  if (!pid) {
    if (Object.keys(patch).length || useFlow.getState().design || useFlow.getState().revise) {
      useFlow.setState({ ...patch, design: null, revise: null, concepts: null, versions: {}, comments: {} });
    }
    return;
  }
  const versionsChanged = st.versions !== seen.versions;
  if (st.design !== seen.design || (versionsChanged && st.design.status !== "idle")) patch.design = toRun("design", pid, st.design, st.versions);
  if (st.revise !== seen.revise || (versionsChanged && st.revise.status !== "idle")) patch.revise = toRun("revise", pid, st.revise, st.versions);
  if (st.conceptRun !== seen.conceptRun) patch.concepts = toConcepts(pid, st.conceptRun);
  if (versionsChanged) patch.versions = st.versions;
  if (st.comments !== seen.comments || st.commentsFor !== seen.commentsFor) {
    patch.comments = st.commentsFor ? { [st.commentsFor]: st.comments.filter((c) => c.version_id === st.commentsFor) } : {};
  }
  seen = { pid, design: st.design, revise: st.revise, conceptRun: st.conceptRun, versions: st.versions, comments: st.comments, commentsFor: st.commentsFor };
  if (Object.keys(patch).length) useFlow.setState(patch);
}

sync();
useProject.subscribe(sync);

const live = (pid: string) => {
  const st = useProject.getState();
  return st.pid === pid && !st.shareToken;
};

export function patchProject(pid: string, patch: Parameters<ReturnType<typeof useProject.getState>["patchProject"]>[0]) {
  if (live(pid)) useProject.getState().patchProject(patch);
}

export async function refreshProject(pid: string) {
  if (live(pid)) await useProject.getState().refresh();
}

// ── Actions (forwarded to the store) ────────────────────────────────────────────────────────────────

export interface ReviseBody { version_id: string; comment_ids?: string[]; instruction?: string }

export const flow = {
  /** Start a design run (plan → check → review → build). */
  async design(pid: string) {
    if (!live(pid)) return;
    await useProject.getState().runDesign();
  },

  /** Revise a version from comments, a typed instruction, or both. */
  async revise(pid: string, body: ReviseBody) {
    if (!live(pid)) return;
    if (useProject.getState().revise.status === "running") {
      notify.info("Naqsha is still working on the last change", "Ask again when it's done.");
      return;
    }
    await useProject.getState().runRevise(body.version_id, body.comment_ids, body.instruction);
  },

  /** Re-attach to the project's in-flight design or revision after a reload (GET /run). */
  async resume(project: { id: string; stage: string }) {
    if (!live(project.id)) return;
    if (!["planning", "building", "revising"].includes(project.stage)) return;
    await useProject.getState().resumeRun();
  },

  async concepts(pid: string, body: ConceptsBody = { count: 4 }) {
    if (!live(pid)) return;
    await useProject.getState().generateConcepts(body);
  },

  /** Night images for these concepts (lazy, the first time someone switches to Night). */
  async night(pid: string, ids: string[]) {
    if (!live(pid)) return;
    const s = useFlow.getState();
    const todo = ids.filter((id) => !s.nightUrls[id]);
    if (!todo.length || s.night?.running) return;
    useFlow.setState({ night: { pid, ids: todo, done: [], failed: [], running: true, startedAt: Date.now() } });
    const c = new AbortController();
    nightControllers.add(c);
    const mark = (field: "done" | "failed", id: string) => {
      const n = useFlow.getState().night;
      if (n && n.pid === pid && !n[field].includes(id)) useFlow.setState({ night: { ...n, [field]: [...n[field], id] } });
    };
    try {
      await api.conceptsNight(
        pid,
        { ids: todo },
        {
          concept: ({ concept }) => {
            if (!live(pid) || !concept.night_url) return;
            useFlow.setState((st) => ({ nightUrls: { ...st.nightUrls, [concept.id]: concept.night_url! } }));
            const p = useProject.getState().project;
            if (p) patchProject(pid, { concepts: p.concepts.map((x) => (x.id === concept.id ? { ...x, night_url: concept.night_url } : x)) });
            mark("done", concept.id);
          },
          "concept.failed": ({ index }) => {
            const id = todo[index];
            if (id) mark("failed", id);
          },
        },
        { signal: c.signal },
      );
    } catch (e) {
      if (isAbortError(e) || !live(pid)) return;
      const n = useFlow.getState().night;
      if (n) useFlow.setState({ night: { ...n, failed: n.ids.filter((id) => !n.done.includes(id)) } });
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 405) notify.info("Night views aren't ready on this server yet", "The day views are shown instead.");
      else notify.error("The night views didn't come back", e, { label: "Try again", run: () => void flow.night(pid, ids) });
    } finally {
      nightControllers.delete(c);
      const n = useFlow.getState().night;
      if (n && n.pid === pid) {
        const missing = n.ids.filter((id) => !n.done.includes(id) && !n.failed.includes(id));
        useFlow.setState({ night: { ...n, running: false, failed: [...n.failed, ...missing] } });
      }
    }
  },

  async loadVersion(pid: string, vid: string): Promise<Version | null> {
    if (!live(pid)) return null;
    return useProject.getState().loadVersion(vid);
  },

  cacheVersion(v: Version) {
    useProject.getState().cacheVersion(v);
  },

  /** The comments of one version, from the store (which the comments sheet reads too). */
  async loadComments(pid: string, vid: string, force = false): Promise<Comment[]> {
    if (!live(pid)) return [];
    const st = useProject.getState();
    if (force || st.commentsFor !== vid) await st.loadComments(vid);
    const after = useProject.getState();
    return after.commentsFor === vid ? after.comments.filter((c) => c.version_id === vid) : [];
  },

  async addComment(pid: string, body: NewComment): Promise<Comment | null> {
    if (!live(pid)) return null;
    return useProject.getState().addComment(body);
  },

  /** Clear a finished run (e.g. after the person has seen its outcome). */
  clear(key: "design" | "revise") {
    useProject.getState().clearRun(key);
  },
};

// ── Fix loop memory ─────────────────────────────────────────────────────────────────────────────────

/** Failures per compliance attempt of a version's design run ("5 → 1 → 0"), live or remembered in this browser. */
export function fixLoopOf(vid: string | null | undefined): number[] | undefined {
  if (!vid) return undefined;
  const run = useFlow.getState().design;
  if (run?.version?.id === vid && run.failures.length > 1) return run.failures;
  return loadFixLoop(vid);
}

// ── Selectors ───────────────────────────────────────────────────────────────────────────────────────

/** The line a run narrates while it works ("Fixing 2 issues", "Building the house in 3D · 14 parts"). */
export function narration(run: Run | null | undefined): string | null {
  if (!run || run.status !== "running") return null;
  if (run.kind === "revise") return run.activity[run.activity.length - 1]?.text ?? "Reading your changes";
  const stage = run.stage;
  if (!stage) return run.resumed ? "Picking up where I left off" : "Reading the brief";
  if (stage === "build") return run.sections.length ? `Building the house in 3D · ${plural(run.sections.length, "part")}` : "Building the house in 3D";
  if (stage === "fix" && run.reached.includes("review")) return "Acting on the review";
  return designStageLine(stage, run.failures);
}

export interface NaqshaActivity {
  busy: boolean;
  line: string | null;
  /** 0..1 when known (building the 3D parts, drawing concepts). */
  progress?: number;
  kind?: Narration["kind"];
}

/** For the shell's dock: is Naqsha working (setup, concepts, night, design, revise), and what to say while it does. */
export function useNaqshaActivity(): NaqshaActivity {
  const n = useNarration();
  const night = useFlow((s) => !!s.night?.running);
  return useMemo(() => {
    if (n) return { busy: true, line: n.text, progress: n.progress, kind: n.kind };
    if (night) return { busy: true, line: "Turning the lights on", kind: "night" };
    return { busy: false, line: null };
  }, [n, night]);
}

/** Concepts with any night image the flow fetched merged in. */
export function withNight(concepts: Concept[], nightUrls: Record<string, string>): Concept[] {
  return concepts.map((c) => (c.night_url || !nightUrls[c.id] ? c : { ...c, night_url: nightUrls[c.id] }));
}
