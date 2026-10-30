/**
 * The open project: data, chat, and the long-running streams (concepts, design, revise).
 * Streams live here rather than in step components, so they keep running while the user moves
 * between steps, and a page reload re-attaches to an in-flight design/revise run (GET /run).
 */
import { create } from "zustand";
import type { Change, ChatMessage, Comment, Concept, DesignSection, Project, Role, SSEEvents, Version } from "@contracts/api-types";
import type { BuildingPlan, ComplianceReport } from "@contracts/plan";
import {
  api,
  errorMessage,
  isAbortError,
  type ConceptsBody,
  type IntakeBody,
  type NewComment,
  type Reply,
  type SharedProject,
  type SSEHandlers,
  type StreamOptions,
} from "@/api/client";
import { plotLabel } from "@/api/domain";
import { currentUser } from "@/api/auth";
import { userId } from "@/api/mode";
import { saveFixLoop } from "@/app/lib/fixloop";
import { toast } from "./toast";

/**
 * What the 3D build found, as the server stored it with the version (POST …/asbuilt), so Plan counts the same notes
 * after a reload; a report this session made after building the house wins.
 */
function seedAsBuilt(asBuilt: Record<string, ComplianceReport>, v: Version): Record<string, ComplianceReport> {
  const stored = (v as Version & { as_built?: ComplianceReport | null }).as_built;
  return stored?.checks && !asBuilt[v.id] ? { ...asBuilt, [v.id]: stored } : asBuilt;
}

export interface ConceptSlot {
  key: string;
  index: number;
  status: "drawing" | "done" | "failed";
  prompt?: string;
  conceptId?: string;
  message?: string;
}

export interface ConceptRun {
  id: string;
  instruction?: string;
  baseId?: string;
  slots: ConceptSlot[];
  running: boolean;
  startedAt: number;
  /** What the run is doing before the drawings start (reading the locality's taste with Qloo). */
  note?: string;
}

type StageName = SSEEvents["stage"]["stage"];

export type FeedItem =
  | { id: string; at: number; kind: "stage"; stage: StageName; message: string }
  | { id: string; at: number; kind: "plan"; attempt: number; plan: BuildingPlan }
  | { id: string; at: number; kind: "compliance"; attempt: number; report: ComplianceReport }
  | { id: string; at: number; kind: "section"; index: number; section: DesignSection }
  | { id: string; at: number; kind: "changes"; changes: Change[] }
  | { id: string; at: number; kind: "comment"; comment: Comment }
  | { id: string; at: number; kind: "version"; version: Version }
  | { id: string; at: number; kind: "error"; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewItem = DistributiveOmit<FeedItem, "id" | "at">;

export interface Run {
  status: "idle" | "running" | "done" | "error";
  items: FeedItem[];
  plan?: BuildingPlan;
  planAttempt?: number;
  compliance?: ComplianceReport;
  complianceAttempt?: number;
  /** Failures per compliance attempt, e.g. [5, 1, 0]. */
  failures: number[];
  sections: DesignSection[];
  chars: number;
  changes?: Change[];
  version?: Version;
  error?: string;
  startedAt?: number;
  /** startedAt came from the server's `run` event (so a re-attached run can show its real time). */
  serverStart?: boolean;
  resumed?: boolean;
  baseVersionId?: string;
  /** Re-attached (GET /run): when, so replayed steps aren't stamped with the re-attach time. */
  attachedAt?: number;
  /** Revise: what was typed into Ask, and which comments were picked. */
  instruction?: string;
  commentIds?: string[];
}

const idleRun = (): Run => ({ status: "idle", items: [], sections: [], chars: 0, failures: [] });
type RunKey = "design" | "revise";

interface ProjectState {
  pid: string | null;
  project: Project | null;
  loadState: "idle" | "loading" | "ready" | "error";
  loadError?: string;

  messages: ChatMessage[];
  draft: string | null;
  intakeBusy: boolean;
  intakeFailed: IntakeBody | null;

  conceptRun: ConceptRun | null;
  design: Run;
  revise: Run;
  versions: Record<string, Version>;
  /** What the 3D build found, per version (POST /asbuilt once House has built it): merged into the counts. */
  asBuilt: Record<string, ComplianceReport>;
  comments: Comment[];
  commentsFor: string | null;
  /** Rename/brief edits: "Saving…" then "Saved" for 1.5 s in the title capsule (never a toast). */
  saveState: "idle" | "saving" | "saved";

  /** Set when the project was opened from a client link (/s/:token): comments go through the share endpoints. */
  shareToken: string | null;
  sharedBy: string | null;
  /** The client's name for their comments (asked once, remembered in this browser). */
  guestName: string | null;

  open(pid: string): Promise<void>;
  /** Open a project from a client link. */
  openShared(token: string): Promise<SharedProject | null>;
  setGuestName(name: string): void;
  close(): void;
  refresh(): Promise<void>;
  rename(name: string): Promise<void>;
  patchProject(p: Partial<Project>): void;

  startIntake(): Promise<void>;
  sendIntake(body: IntakeBody, display?: string): Promise<void>;
  retryIntake(): Promise<void>;

  generateConcepts(body?: ConceptsBody): Promise<void>;
  selectConcept(cid: string): Promise<boolean>;

  runDesign(): Promise<void>;
  resumeRun(): Promise<void>;
  loadVersion(vid: string): Promise<Version | null>;
  cacheVersion(v: Version): void;
  setAsBuilt(vid: string, report: ComplianceReport | null): void;

  loadComments(versionId: string): Promise<void>;
  /** Quietly pick up comments and replies others added (a client's notes) for the loaded version. */
  refreshComments(): Promise<void>;
  addComment(body: NewComment): Promise<Comment | null>;
  updateComment(cid: string, patch: { text?: string; status?: Comment["status"] }): Promise<void>;
  /** Removes it at once and offers Undo for 5 s; the server delete follows (sooner if the page is hidden). */
  deleteComment(cid: string): Promise<void>;
  replyToComment(cid: string, text: string): Promise<boolean>;

  /** Apply comments (all open ones by default) and/or a typed instruction ("make the kitchen bigger"). */
  runRevise(versionId: string, commentIds?: string[], instruction?: string): Promise<void>;
  /** Forget a finished design or revise run (its outcome has been seen). */
  clearRun(key: RunKey): void;
}

const controllers = new Map<string, AbortController>();
function controller(key: string): AbortController {
  controllers.get(key)?.abort();
  const c = new AbortController();
  controllers.set(key, c);
  return c;
}
function abortAll() {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
}

const commentLoads = new Map<string, Promise<void>>();

let seq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// ── Undoable comment deletes ─────────────────────────────────────────────────────────────────────────
// A deleted comment disappears at once; the DELETE is sent after the 5 s undo window, or straight away when the
// page is hidden or another project opens.
const pendingDeletes = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
function flushDeletes() {
  for (const p of [...pendingDeletes.values()]) {
    clearTimeout(p.timer);
    p.run();
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDeletes());
  window.addEventListener("pagehide", flushDeletes);
}

// ── A first message typed before the project existed (workspace composer) ───────────────────────────
const firstMessages = new Map<string, string>();
/** Send `text` as the first setup message when project `pid` opens. */
export function queueFirstMessage(pid: string, text: string) {
  if (text.trim()) firstMessages.set(pid, text.trim());
}
const canWrite = (p: Project) => p.role !== "client";

// ── Who is writing ─────────────────────────────────────────────────────────────────────────────────
const GUEST_NAME_KEY = "naqsha.guestName";
function readGuestName(): string | null {
  try { return localStorage.getItem(GUEST_NAME_KEY) || null; } catch { return null; }
}

// The client view asks a visitor's name once, before their first note or reply (see setNameAsker).
let nameAsker: (() => Promise<string | null>) | null = null;
/** The client view registers how to ask a visitor's name; comments and replies wait for it. */
export function setNameAsker(fn: (() => Promise<string | null>) | null) {
  nameAsker = fn;
}

/** The author shown on an optimistic reply until the server's copy arrives. */
function currentAuthor(role: Role | undefined, guestName: string | null, client: boolean): Reply["author"] {
  const u = currentUser();
  if (client) return { id: u?.uid ?? "me", name: guestName || u?.name || "You", role: "client" };
  return { id: u?.uid ?? userId(), name: u?.name || u?.email?.split("@")[0] || "You", role: role ?? "owner" };
}

let savedTimer: ReturnType<typeof setTimeout> | undefined;
function markSaved(pid: string) {
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    const st = useProject.getState();
    if (st.pid === pid && st.saveState === "saved") useProject.setState({ saveState: "idle" });
  }, 1500);
}
const failuresOf = (r: ComplianceReport) => r.checks.filter((c) => c.status === "fail").length;

/**
 * A design run's failures, one per plan attempt in the order they first ran ("3 → 2 → 1 → 2"). The architect re-sends
 * the best attempt's compliance at the end (when a later round was worse): it replaces that attempt's own entry rather
 * than adding a fifth value.
 */
export function failuresByAttempt(items: FeedItem[]): number[] {
  const order: string[] = [];
  const byAttempt = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.kind !== "compliance") return;
    const k = it.attempt != null ? `a${it.attempt}` : `i${i}`;
    if (!byAttempt.has(k)) order.push(k);
    byAttempt.set(k, failuresOf(it.report));
  });
  return order.map((k) => byAttempt.get(k)!);
}

export const useProject = create<ProjectState>((set, get) => {
  /** Ignore late events from a project the user already left. */
  const live = (pid: string) => get().pid === pid;

  const pushItem = (key: RunKey, item: NewItem) => {
    const run = get()[key];
    set({ [key]: { ...run, items: [...run.items, { ...item, id: nid("fi"), at: Date.now() } as FeedItem] } } as Partial<ProjectState>);
  };
  const patchRun = (key: RunKey, patch: Partial<Run>) => {
    set({ [key]: { ...get()[key], ...patch } } as Partial<ProjectState>);
  };

  /** Handlers shared by POST /design, POST /revise and GET /run. */
  const runHandlers = (pid: string, key: () => RunKey): SSEHandlers => ({
    // First event of every design/revise stream (fresh or re-attached): the timer runs from when the server started.
    run: ({ started_at }) => {
      if (!live(pid)) return;
      const t = Date.parse(started_at);
      if (Number.isFinite(t)) patchRun(key(), { startedAt: t, serverStart: true });
    },
    stage: ({ stage, message }) => {
      if (!live(pid)) return;
      // Each writing pass (plan, fix, build) counts its own characters.
      if (stage === "plan" || stage === "fix" || stage === "build") patchRun(key(), { chars: 0 });
      pushItem(key(), { kind: "stage", stage, message });
      if (key() === "design" && stage === "build") get().patchProject({ stage: "building" });
    },
    plan: ({ plan, attempt }) => {
      if (!live(pid)) return;
      patchRun(key(), { plan, planAttempt: attempt });
      pushItem(key(), { kind: "plan", plan, attempt });
    },
    compliance: ({ report, attempt }) => {
      if (!live(pid)) return;
      const k = key();
      pushItem(k, { kind: "compliance", report, attempt });
      // Design: one value per plan attempt. Revise: every applied edit is checked as "attempt 1", so each one counts.
      const failures = k === "design" ? failuresByAttempt(get()[k].items) : [...get()[k].failures, failuresOf(report)];
      patchRun(k, { compliance: report, complianceAttempt: attempt, failures });
    },
    section: ({ section, index }) => {
      if (!live(pid)) return;
      const k = key();
      const cur = get()[k].sections;
      const next = cur.some((s) => s.name === section.name) ? cur.map((s) => (s.name === section.name ? section : s)) : [...cur, section];
      patchRun(k, { sections: next });
      pushItem(k, { kind: "section", section, index });
    },
    progress: ({ chars }) => live(pid) && patchRun(key(), { chars }),
    changes: ({ changes }) => {
      if (!live(pid)) return;
      patchRun(key(), { changes });
      pushItem(key(), { kind: "changes", changes });
    },
    comment: ({ comment }) => {
      if (!live(pid)) return;
      const exists = get().comments.some((x) => x.id === comment.id);
      set({ comments: exists ? get().comments.map((x) => (x.id === comment.id ? comment : x)) : [...get().comments, comment] });
      pushItem(key(), { kind: "comment", comment });
    },
    version: ({ version }) => {
      if (!live(pid)) return;
      const k = key();
      if (k === "design") saveFixLoop(version.id, get().design.failures);
      set({ versions: { ...get().versions, [version.id]: version } });
      patchRun(k, k === "design" ? { version, plan: version.plan, compliance: version.compliance, sections: version.sections } : { version });
      pushItem(k, { kind: "version", version });
      const p = get().project;
      if (p) {
        // The rail names a new version at once: the event's summary (the server's own words) when it carries one,
        // else what was asked or the first change, so it never reads "A revision" until a reload.
        const said = (version as Version & { summary?: string }).summary;
        const summary = said || version.source?.instruction?.trim() || version.changes?.[0]?.summary || undefined;
        const entry = { id: version.id, n: version.n, created_at: version.created_at, status: version.status, ...(summary ? { summary } : {}) };
        get().patchProject({
          versions: p.versions.some((v) => v.id === version.id)
            ? p.versions.map((v) => (v.id === version.id ? { ...v, ...entry, summary: v.summary || summary } : v))
            : [...p.versions, entry],
          current_version_id: version.id,
          stage: "ready",
        });
      }
    },
  });

  /** Drive one design/revise stream into the run state, with error handling and retry. */
  const drive = async (
    pid: string,
    key: () => RunKey,
    open: (h: SSEHandlers, o: StreamOptions) => Promise<unknown>,
    retry: () => void,
  ): Promise<unknown> => {
    const c = controller("run");
    try {
      const result = await open(runHandlers(pid, key), { signal: c.signal });
      if (live(pid) && get()[key()].status === "running") patchRun(key(), { status: "done" });
      return result;
    } catch (e) {
      if (isAbortError(e) || !live(pid)) return undefined;
      const message = errorMessage(e);
      const k = key();
      pushItem(k, { kind: "error", message });
      patchRun(k, { status: "error", error: message });
      toast.error(k === "design" ? "The design run stopped" : "The revision stopped", e, { label: "Try again", run: retry });
      return undefined;
    } finally {
      if (live(pid)) void get().refresh();
    }
  };

  return {
    pid: null,
    project: null,
    loadState: "idle",
    messages: [],
    draft: null,
    intakeBusy: false,
    intakeFailed: null,
    conceptRun: null,
    design: idleRun(),
    revise: idleRun(),
    versions: {},
    asBuilt: {},
    comments: [],
    commentsFor: null,
    saveState: "idle",
    shareToken: null,
    sharedBy: null,
    guestName: readGuestName(),

    async open(pid) {
      flushDeletes();
      if (get().pid === pid && get().loadState === "ready" && !get().shareToken) {
        void get().refresh();
        return;
      }
      abortAll();
      set({
        pid,
        project: null,
        loadState: "loading",
        loadError: undefined,
        messages: [],
        draft: null,
        intakeBusy: false,
        intakeFailed: null,
        conceptRun: null,
        design: idleRun(),
        revise: idleRun(),
        versions: {},
        asBuilt: {},
        comments: [],
        commentsFor: null,
        saveState: "idle",
        shareToken: null,
        sharedBy: null,
      });
      try {
        const [project, messages] = await Promise.all([api.getProject(pid), api.getMessages(pid)]);
        if (!live(pid)) return;
        set({ project, messages, loadState: "ready" });
        // A home started from the workspace composer: its first message is the brief.
        const first = firstMessages.get(pid);
        firstMessages.delete(pid);
        if (first && !messages.length && canWrite(project)) void get().sendIntake({ message: first });
        if (["planning", "building", "revising"].includes(project.stage)) void get().resumeRun();
      } catch (e) {
        if (!live(pid)) return;
        set({ loadState: "error", loadError: errorMessage(e) });
      }
    },

    close() {
      abortAll();
      flushDeletes();
      set({ pid: null, project: null, loadState: "idle", shareToken: null, sharedBy: null });
    },

    async openShared(token) {
      abortAll();
      flushDeletes();
      set({
        pid: null,
        project: null,
        loadState: "loading",
        loadError: undefined,
        messages: [],
        draft: null,
        conceptRun: null,
        design: idleRun(),
        revise: idleRun(),
        versions: {},
        asBuilt: {},
        comments: [],
        commentsFor: null,
        shareToken: token,
        sharedBy: null,
      });
      try {
        const shared = await api.getShared(token);
        if (get().shareToken !== token) return null;
        const project: Project = { ...shared.project, role: "client", current_version_id: shared.version.id };
        set({
          pid: project.id,
          project,
          versions: { [shared.version.id]: shared.version },
          asBuilt: seedAsBuilt({}, shared.version),
          comments: shared.comments,
          commentsFor: shared.version.id,
          sharedBy: shared.shared_by ?? null,
          loadState: "ready",
        });
        return shared;
      } catch (e) {
        if (get().shareToken === token) set({ loadState: "error", loadError: errorMessage(e) });
        return null;
      }
    },

    setGuestName(name) {
      const n = name.trim();
      try { localStorage.setItem(GUEST_NAME_KEY, n); } catch { /* ignore */ }
      set({ guestName: n || null });
    },

    async refresh() {
      const pid = get().pid;
      if (!pid || get().shareToken) return;
      try {
        const project = await api.getProject(pid);
        if (live(pid)) set({ project });
      } catch (e) {
        if (!isAbortError(e)) console.warn("refresh failed", e);
      }
    },

    async rename(name) {
      const pid = get().pid;
      const p = get().project;
      if (!pid || !p || !name.trim() || name === p.name) return;
      set({ project: { ...p, name }, saveState: "saving" });
      try {
        const project = await api.updateProject(pid, { name });
        if (live(pid)) set({ project: { ...project, role: project.role ?? p.role }, saveState: "saved" });
        markSaved(pid);
      } catch (e) {
        toast.error("Couldn't rename this home", e);
        if (live(pid)) set({ project: p, saveState: "idle" });
      }
    },

    patchProject(patch) {
      const p = get().project;
      if (p) set({ project: { ...p, ...patch } });
    },

    // ── Setup ───────────────────────────────────────────────────────────────────────────────────────
    async startIntake() {
      if (get().messages.length || get().intakeBusy) return;
      await get().sendIntake({ action: "start" });
    },

    async sendIntake(body, display) {
      const pid = get().pid;
      if (!pid || get().intakeBusy) return;
      const isRetry = get().intakeFailed === body;
      if (body.action !== "start" && !isRetry) {
        const text =
          display ?? (body.action === "skip_question" ? "Decide for me" : body.action === "skip_all" ? "Decide everything for me" : body.message ?? "");
        set({ messages: [...get().messages, { id: nid("local"), role: "user", text, created_at: new Date().toISOString() }] });
      }
      set({ intakeBusy: true, draft: "", intakeFailed: null });
      const c = controller("intake");
      try {
        await api.intake(
          pid,
          body,
          {
            "message.delta": ({ text }) => live(pid) && set({ draft: (get().draft ?? "") + text }),
            message: (m) => {
              if (!live(pid)) return;
              if (m.role === "user") {
                // The server echoes the user's turn (its wording may differ, e.g. "Skip — you decide.").
                // Keep our optimistic text on screen, but adopt the server's id.
                const msgs = [...get().messages];
                let i = -1;
                for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].id.startsWith("local-")) { i = k; break; }
                if (i >= 0) msgs[i] = { ...m, text: msgs[i].text };
                else if (!msgs.some((x) => x.id === m.id)) msgs.push(m);
                set({ messages: msgs });
                return;
              }
              set({ messages: [...get().messages.filter((x) => x.id !== m.id), m], draft: null });
            },
            brief: ({ brief, envelope }) => live(pid) && get().patchProject({ brief, envelope }),
            "intake.complete": ({ brief, envelope }) => {
              if (!live(pid)) return;
              const p = get().project;
              get().patchProject({ brief, envelope, stage: p && p.stage === "setup" ? "concepts" : p?.stage });
              // Give "Untitled home" a name people recognise in the workspace, e.g. "10 marla house, Johar Town".
              if (p && /^untitled (home|project)$/i.test(p.name.trim()) && brief?.plot?.area_marla) {
                const size = plotLabel(brief.plot.area_marla).replace(/^\w/, (c) => c.toUpperCase());
                void get().rename(`${size} house, ${brief.scheme || brief.city || "your city"}`);
              }
            },
          },
          { signal: c.signal, idleTimeoutMs: 90_000 },
        );
      } catch (e) {
        if (isAbortError(e) || !live(pid)) return;
        set({ intakeFailed: body });
        toast.error("Naqsha couldn't reply. Try again.", e, { label: "Try again", run: () => void get().retryIntake() });
      } finally {
        if (live(pid)) {
          const draft = get().draft;
          // If the stream ended mid-message, keep what was said rather than dropping it.
          if (draft && draft.trim()) {
            set({ messages: [...get().messages, { id: nid("partial"), role: "assistant", text: draft, created_at: new Date().toISOString() }] });
          }
          set({ intakeBusy: false, draft: null });
          void get().refresh();
        }
      }
    },

    async retryIntake() {
      const body = get().intakeFailed;
      if (body) await get().sendIntake(body);
    },

    // ── Concepts ────────────────────────────────────────────────────────────────────────────────────
    async generateConcepts(body = { count: 4 }) {
      const pid = get().pid;
      if (!pid || get().conceptRun?.running) return;
      const count = body.count ?? 4;
      const runId = nid("run");
      const run: ConceptRun = {
        id: runId,
        instruction: body.instruction,
        baseId: body.base_concept_id,
        running: true,
        startedAt: Date.now(),
        slots: Array.from({ length: count }, (_, i) => ({ key: `${runId}-${i}`, index: i, status: "drawing" })),
      };
      set({ conceptRun: run });
      const updateSlot = (index: number, patch: Partial<ConceptSlot>) => {
        const r = get().conceptRun;
        if (!r || r.id !== runId) return;
        set({ conceptRun: { ...r, slots: r.slots.map((s) => (s.index === index ? { ...s, ...patch } : s)) } });
      };
      const c = controller("concepts");
      try {
        await api.generateConcepts(
          pid,
          { ...body, count },
          {
            "concept.started": ({ index, prompt }) => {
              if (!live(pid)) return;
              updateSlot(index, { prompt });
              const r = get().conceptRun;
              if (r?.id === runId && r.note) set({ conceptRun: { ...r, note: undefined } });
            },
            stage: ({ message }) => {
              const r = get().conceptRun;
              if (live(pid) && r?.id === runId) set({ conceptRun: { ...r, note: message } });
            },
            taste: (t) => live(pid) && get().patchProject({ taste: t }),
            baseline: ({ concept }) => {
              const p = get().project;
              if (live(pid) && p?.taste) get().patchProject({ taste: { ...p.taste, baseline: concept } });
            },
            concept: ({ index, concept }) => {
              if (!live(pid)) return;
              const p = get().project;
              if (p && !p.concepts.some((x) => x.id === concept.id)) {
                get().patchProject({
                  concepts: [...p.concepts, concept],
                  thumbnail_url: p.thumbnail_url ?? concept.url,
                  stage: p.stage === "setup" ? "concepts" : p.stage,
                });
              }
              updateSlot(index, { status: "done", conceptId: concept.id });
            },
            "concept.failed": ({ index, message }) => live(pid) && updateSlot(index, { status: "failed", message }),
          },
          { signal: c.signal, idleTimeoutMs: 120_000 },
        );
      } catch (e) {
        if (isAbortError(e) || !live(pid)) return;
        const r = get().conceptRun;
        if (r?.id === runId) set({ conceptRun: { ...r, slots: r.slots.map((s) => (s.status === "drawing" ? { ...s, status: "failed", message: errorMessage(e) } : s)) } });
        toast.error("Concept generation stopped", e, { label: "Try again", run: () => void get().generateConcepts(body) });
      } finally {
        const r = get().conceptRun;
        if (live(pid) && r?.id === runId) set({ conceptRun: { ...r, running: false } });
        if (live(pid)) void get().refresh();
      }
    },

    async selectConcept(cid) {
      const pid = get().pid;
      if (!pid) return false;
      try {
        const project = await api.selectConcept(pid, cid);
        if (live(pid)) set({ project });
        return true;
      } catch (e) {
        toast.error("Couldn't select that concept", e);
        return false;
      }
    },

    // ── Design ──────────────────────────────────────────────────────────────────────────────────────
    async runDesign() {
      const pid = get().pid;
      if (!pid || get().design.status === "running") return;
      set({ design: { ...idleRun(), status: "running", startedAt: Date.now() } });
      get().patchProject({ stage: "planning" });
      await drive(pid, () => "design", (h, o) => api.design(pid, h, o), () => void get().runDesign());
    },

    async resumeRun() {
      const pid = get().pid;
      const p = get().project;
      if (!pid || !p || get().design.status === "running" || get().revise.status === "running") return;
      // The project stage says which pipeline is running; the first stage event confirms it.
      let key: RunKey = p.stage === "revising" ? "revise" : "design";
      let decided = false;
      set({ [key]: { ...idleRun(), status: "running", startedAt: Date.now(), resumed: true, attachedAt: Date.now() } } as Partial<ProjectState>);
      const switchTo = (actual: RunKey) => {
        if (actual === key) return;
        set({ [key]: idleRun(), [actual]: { ...get()[key], status: "running" } } as Partial<ProjectState>);
        key = actual;
      };
      const handlers = (h: SSEHandlers): SSEHandlers => ({
        ...h,
        run: (data) => {
          if (!decided && (data.kind === "design" || data.kind === "revise")) {
            decided = true;
            switchTo(data.kind);
          }
          h.run?.(data);
        },
        stage: (data) => {
          if (!decided) {
            decided = true;
            switchTo(data.stage === "changes" ? "revise" : data.stage === "plan" || data.stage === "fix" ? "design" : key);
          }
          h.stage?.(data);
        },
      });
      const attached = await drive(
        pid,
        () => key,
        async (h, o) => api.resumeRun(pid, handlers(h), o),
        () => void get().resumeRun(),
      );
      if (attached === false && live(pid)) {
        // Nothing in flight (finished, or the server restarted): settle the UI on the saved state.
        set({ [key]: idleRun() } as Partial<ProjectState>);
      }
    },

    async loadVersion(vid) {
      const cached = get().versions[vid];
      if (cached) return cached;
      const pid = get().pid;
      if (!pid) return null;
      try {
        const v = await api.getVersion(pid, vid);
        if (live(pid)) set({ versions: { ...get().versions, [vid]: v }, asBuilt: seedAsBuilt(get().asBuilt, v) });
        return v;
      } catch (e) {
        toast.error("Couldn't load that version", e);
        return null;
      }
    },

    cacheVersion(v) {
      set({ versions: { ...get().versions, [v.id]: v }, asBuilt: seedAsBuilt(get().asBuilt, v) });
    },

    setAsBuilt(vid, report) {
      const next = { ...get().asBuilt };
      if (report) next[vid] = report;
      else delete next[vid];
      set({ asBuilt: next });
    },

    // ── Comments ────────────────────────────────────────────────────────────────────────────────────
    async loadComments(versionId) {
      const pid = get().pid;
      if (!pid) return;
      if (get().shareToken) {
        if (get().commentsFor !== versionId) set({ commentsFor: versionId });
        return;
      }
      // The shell and the view both ask when a version opens: share one request.
      const key = `${pid}:${versionId}`;
      const running = commentLoads.get(key);
      if (running) return running;
      const load = (async () => {
        try {
          const comments = await api.listComments(pid, versionId);
          if (live(pid)) set({ comments: comments.filter((c) => !pendingDeletes.has(c.id)), commentsFor: versionId });
        } catch (e) {
          toast.error("Couldn't load comments", e);
        } finally {
          commentLoads.delete(key);
        }
      })();
      commentLoads.set(key, load);
      return load;
    },

    async refreshComments() {
      const pid = get().pid;
      const vid = get().commentsFor;
      if (!pid || !vid || get().shareToken || commentLoads.size) return;
      try {
        const list = await api.listComments(pid, vid);
        if (!live(pid) || get().commentsFor !== vid) return;
        // Keep replies still on their way to the server.
        const pending = new Map(get().comments.map((c) => [c.id, (c.replies ?? []).filter((r) => r.id.startsWith("reply-"))]));
        const next = list
          .filter((c) => !pendingDeletes.has(c.id))
          .map((c) => {
            const mine = pending.get(c.id);
            return mine?.length ? { ...c, replies: [...(c.replies ?? []), ...mine] } : c;
          });
        if (JSON.stringify(next) !== JSON.stringify(get().comments)) set({ comments: next });
      } catch {
        /* quiet: try again next time */
      }
    },

    async addComment(body) {
      const pid = get().pid;
      if (!pid) return null;
      const token = get().shareToken;
      if (token && !get().guestName && nameAsker && !(await nameAsker())) return null;
      try {
        const c = token
          ? await api.createSharedComment(token, { ...body, author_name: get().guestName ?? "Guest" })
          : await api.createComment(pid, body);
        if (live(pid)) set({ comments: [...get().comments, c] });
        return c;
      } catch (e) {
        toast.error("Couldn't save the comment", e);
        return null;
      }
    },

    async updateComment(cid, patch) {
      const pid = get().pid;
      if (!pid || get().shareToken) return;
      const before = get().comments;
      set({ comments: before.map((c) => (c.id === cid ? { ...c, ...patch } : c)) });
      try {
        const c = await api.updateComment(pid, cid, patch);
        if (live(pid)) set({ comments: get().comments.map((x) => (x.id === cid ? { ...x, ...c, replies: c.replies ?? x.replies } : x)) });
      } catch (e) {
        if (live(pid)) set({ comments: before });
        toast.error("Couldn't update the comment", e);
      }
    },

    async deleteComment(cid) {
      const pid = get().pid;
      if (!pid || get().shareToken) return;
      const list = get().comments;
      const index = list.findIndex((c) => c.id === cid);
      if (index < 0) return;
      const removed = list[index];
      set({ comments: list.filter((c) => c.id !== cid) });
      const restore = () => {
        if (!live(pid) || get().comments.some((c) => c.id === cid)) return;
        const now = get().comments;
        set({ comments: [...now.slice(0, index), removed, ...now.slice(index)] });
      };
      const run = () => {
        pendingDeletes.delete(cid);
        api.deleteComment(pid, cid).catch((e) => {
          restore();
          toast.error("Couldn't delete the comment", e);
        });
      };
      pendingDeletes.set(cid, { timer: setTimeout(run, 5000), run });
      toast.undo("Comment deleted", () => {
        const p = pendingDeletes.get(cid);
        if (!p) return;
        clearTimeout(p.timer);
        pendingDeletes.delete(cid);
        restore();
      });
    },

    async replyToComment(cid, text) {
      const pid = get().pid;
      const body = text.trim();
      if (!pid || !body) return false;
      const token = get().shareToken;
      // A visitor's first reply asks their name too, so one person never shows as two authors.
      if (token && !get().guestName && nameAsker && !(await nameAsker())) return false;
      const me = currentAuthor(get().project?.role, get().guestName, !!token);
      const temp: Reply = { id: nid("reply"), author: me, text: body, created_at: new Date().toISOString() };
      const patchReplies = (fn: (r: Reply[]) => Reply[]) =>
        set({ comments: get().comments.map((c) => (c.id === cid ? { ...c, replies: fn(c.replies ?? []) } : c)) });
      patchReplies((r) => [...r, temp]);
      try {
        const res = token
          ? await api.replyToSharedComment(token, cid, { text: body, author_name: get().guestName ?? undefined })
          : await api.replyToComment(pid, cid, { text: body });
        if (!live(pid)) return true;
        if ("version_id" in res) {
          // The server sent the whole thread back.
          set({ comments: get().comments.map((c) => (c.id === cid ? { ...c, ...res, replies: res.replies ?? c.replies } : c)) });
        } else {
          patchReplies((r) => r.map((x) => (x.id === temp.id ? res : x)));
        }
        return true;
      } catch (e) {
        if (live(pid)) patchReplies((r) => r.filter((x) => x.id !== temp.id));
        toast.error("Couldn't send the reply", e);
        return false;
      }
    },

    // ── Revise ──────────────────────────────────────────────────────────────────────────────────────
    async runRevise(versionId, commentIds, instruction) {
      const pid = get().pid;
      if (!pid || get().shareToken || get().revise.status === "running") return;
      set({ revise: { ...idleRun(), status: "running", startedAt: Date.now(), baseVersionId: versionId, instruction, commentIds } });
      get().patchProject({ stage: "revising" });
      await drive(
        pid,
        () => "revise",
        (h, o) => api.revise(pid, { version_id: versionId, comment_ids: commentIds, instruction }, h, o),
        () => void get().runRevise(versionId, commentIds, instruction),
      );
    },

    clearRun(key) {
      if (get()[key].status !== "running") set({ [key]: idleRun() } as Partial<ProjectState>);
    },
  };
});

export function conceptById(project: Project | null, id: string | null | undefined): Concept | undefined {
  return id ? project?.concepts.find((c) => c.id === id) : undefined;
}
