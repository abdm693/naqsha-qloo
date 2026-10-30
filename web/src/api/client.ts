/**
 * API client (track: APP-SHELL). Same-origin /api; see contracts/api.md.
 *
 * Identity: every call sends X-Naqsha-User (the guest UUID). Signed-in people also send
 * `Authorization: Bearer <Identity Platform ID token>`, refreshed before it expires; a 401 refreshes once and retries.
 *
 * `api` is the single entry point for the UI. With VITE_MOCK=1 (or localStorage["naqsha.mock"]="1") it is backed by
 * an in-browser mock that persists to localStorage and simulates SSE timing, so the whole journey (accounts, sharing
 * and the client view included) is clickable without the backend.
 */
import type {
  AsBuiltSummary,
  Brief,
  ChatMessage,
  Comment,
  CommentAnchor,
  Envelope,
  Me,
  Member,
  Project,
  Role,
  Version,
  TasteInput,
} from "@contracts/api-types";
import type { Authority, BuildingPlan, ComplianceReport } from "@contracts/plan";
import { openSSE, StreamError, type SSEHandlers, type StreamOptions } from "./sse";
import { ApiError } from "./errors";
import { idToken } from "./auth";
import { mockEnabled, userId } from "./mode";
import { mockApi } from "./mock";

export type { SSEHandlers, StreamOptions } from "./sse";
export { StreamError, isAbortError } from "./sse";
export { ApiError } from "./errors";
export { userId } from "./mode";

export interface IntakeBody {
  message?: string;
  action?: "start" | "skip_question" | "skip_all";
  chips?: string[];
}
export interface ConceptsBody { count?: number; instruction?: string; base_concept_id?: string }
export interface NewComment {
  version_id: string;
  text: string;
  anchor: CommentAnchor;
  camera: Comment["camera"];
  snapshot_data_url?: string;
}
export interface EnvelopeQuery { width_ft: number; depth_ft: number; authority?: Authority; corner?: boolean }
export interface ReviseBody {
  version_id: string;
  /** Which open comments to apply (the owner can untick some). */
  comment_ids?: string[];
  /** A conversational change typed into Ask ("make the kitchen bigger"). */
  instruction?: string;
}
export interface MembersResponse { members: Member[]; share: { enabled: boolean; url?: string; token?: string } }
export interface ShareState { enabled: boolean; token?: string; url?: string }
/** GET /api/share/{token}: what a client sees. */
export interface SharedProject {
  project: Project;
  version: Version;
  comments: Comment[];
  role: "client";
  /** Owner's display name or firm, for "Shared by …" (optional; additive). */
  shared_by?: string;
}
export type Reply = NonNullable<Comment["replies"]>[number];

/** Every endpoint in contracts/api.md, typed. Streams resolve on `done` and reject on `error`. */
export interface Api {
  readonly mock: boolean;
  health(): Promise<{ ok: boolean; models?: Record<string, string> }>;

  // Accounts
  me(): Promise<Me | null>;
  /** Move a guest's projects into the signed-in account. */
  claim(guestId: string): Promise<{ moved: number }>;

  // Projects
  listProjects(): Promise<Project[]>;
  createProject(name?: string): Promise<Project>;
  /** Finished example homes anyone can open (GET /samples). */
  listSamples(): Promise<Project[]>;
  /** Copy a sample into your workspace; returns your existing copy unless `fresh`. */
  cloneProject(pid: string, name?: string, opts?: { fresh?: boolean }): Promise<Project>;
  getProject(pid: string): Promise<Project>;
  updateProject(pid: string, patch: { name?: string; brief?: Brief }): Promise<Project>;
  deleteProject(pid: string): Promise<void>;

  // Setup
  getMessages(pid: string): Promise<ChatMessage[]>;
  intake(pid: string, body: IntakeBody, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  getEnvelope(q: EnvelopeQuery, opts?: { signal?: AbortSignal }): Promise<Envelope>;
  checkPlan(plan: BuildingPlan): Promise<ComplianceReport>;

  // Concepts
  generateConcepts(pid: string, body: ConceptsBody, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  /** Read the family's taste with Qloo and write their style brief: step, favourites, profile, then taste. */
  readTaste(pid: string, body: TasteInput, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  /** Style one room: re-read it for one person's taste (or everyone's) and/or picture it. Returns the project. */
  styleRoom(pid: string, index: number, body: { follows?: string; image?: boolean }): Promise<Project>;
  /** Read the neighbourhood (map, feel, ideas) for the brief's place, or the one given. Returns the project. */
  readLocality(pid: string, body?: { location?: string }): Promise<Project>;
  /** Night versions of concepts (same camera), streamed as `concept` events with night_url filled in. */
  conceptsNight(pid: string, body: { ids?: string[] }, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  selectConcept(pid: string, cid: string): Promise<Project>;

  // Design
  design(pid: string, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  getVersion(pid: string, vid: string): Promise<Version>;
  repairSection(pid: string, vid: string, body: { section: string; error: string }, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  asBuilt(pid: string, vid: string, summary: AsBuiltSummary): Promise<ComplianceReport>;

  // Comments
  listComments(pid: string, versionId?: string): Promise<Comment[]>;
  createComment(pid: string, body: NewComment): Promise<Comment>;
  updateComment(pid: string, cid: string, patch: { text?: string; status?: Comment["status"] }): Promise<Comment>;
  deleteComment(pid: string, cid: string): Promise<void>;
  /** Returns the parent comment with its replies (or the new reply, from older servers). */
  replyToComment(pid: string, cid: string, body: { text: string }): Promise<Comment | Reply>;

  // Revise
  revise(pid: string, body: ReviseBody, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  /**
   * Re-attach to the project's in-flight design or revise run (GET /run): replays every event so far,
   * then follows it live. Resolves false when nothing is running (204).
   */
  resumeRun(pid: string, handlers: SSEHandlers, opts?: StreamOptions): Promise<boolean>;
  render(pid: string, body: { image_data_url: string; prompt?: string; version_id?: string }): Promise<{ url: string }>;
  /** Store a viewport capture as the version's (and the project's) thumbnail. */
  saveThumbnail(pid: string, vid: string, imageDataUrl: string): Promise<{ url: string }>;
  /** Photographs from several angles, each made from a capture of the 3D model (events: view, view.failed, done). */
  views(pid: string, vid: string, body: { shots: { angle: string; label?: string; image_data_url: string }[] }, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  /** Compare the 3D model's front view (plus up to 2 more captures) with the concept; with refit, rebuild missing facade features (events: stage, match, section, done). */
  matchConcept(pid: string, vid: string, body: { image_data_url: string; extra_image_data_urls?: string[]; refit?: boolean }, handlers: SSEHandlers, opts?: StreamOptions): Promise<void>;
  /** Start from the family's own floor plan drawing (data URLs, one per sheet). */
  uploadDrawing(pid: string, images: string[]): Promise<Project>;

  // Sharing
  listMembers(pid: string): Promise<MembersResponse>;
  inviteMember(pid: string, body: { email: string; role: Exclude<Role, "owner"> }): Promise<Member>;
  updateMember(pid: string, email: string, body: { role: Exclude<Role, "owner"> }): Promise<void>;
  removeMember(pid: string, email: string): Promise<void>;
  setShare(pid: string, enabled: boolean): Promise<ShareState>;

  // The client view (/s/:token)
  getShared(token: string): Promise<SharedProject>;
  /** Comments only (GET /share/{token}/comments): the client's light 10 s poll. */
  listSharedComments(token: string): Promise<Comment[]>;
  /**
   * Which version is current, cheaply: GET /share/{token}/meta when the server has it, else the full share read
   * (polled less often by the caller).
   */
  getSharedMeta(token: string): Promise<{ current_version_id: string | null; versions: { id: string; n: number }[] }>;
  createSharedComment(token: string, body: NewComment & { author_name: string }): Promise<Comment>;
  replyToSharedComment(token: string, cid: string, body: { text: string; author_name?: string }): Promise<Comment | Reply>;
}

// ── Real implementation ────────────────────────────────────────────────────────────────────────────

const BASE = "/api";

/** Headers for every request: the guest id, plus the account's ID token when signed in. */
export async function authHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { "X-Naqsha-User": userId() };
  const token = await idToken(forceRefresh);
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function readError(res: Response): Promise<ApiError> {
  let msg = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail)) msg = "The request was not valid.";
      else if (typeof j.message === "string") msg = j.message;
      else msg = text;
    } catch { msg = text; }
  } catch { /* ignore */ }
  if (!msg || /^\s*</.test(msg)) {
    msg =
      res.status === 404 ? "Not found." :
      res.status === 401 ? "Please sign in to do that." :
      res.status === 403 ? "You don't have access to that." :
      `The server returned ${res.status}.`;
  }
  return new ApiError(msg.slice(0, 300), res.status);
}

async function http<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const send = async (force: boolean) => {
    try {
      return await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(await authHeaders(force)) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ApiError("Can't reach the Naqsha server. Check your connection and try again.", 0);
    }
  };
  let res = await send(false);
  // An expired or revoked token: refresh once and retry.
  if (res.status === 401 && (await idToken())) res = await send(true);
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function stream(path: string, body: unknown, handlers: SSEHandlers, opts?: StreamOptions): Promise<void> {
  await openSSE(`${BASE}${path}`, { method: "POST", body, headers: await authHeaders() }, handlers, opts);
}

const p = (pid: string) => `/projects/${encodeURIComponent(pid)}`;
const s = (token: string) => `/share/${encodeURIComponent(token)}`;
const e = encodeURIComponent;

const realApi: Api = {
  mock: false,
  health: () => http("GET", "/health"),

  me: async () => {
    try {
      const r = await http<{ user?: Me } & Partial<Me>>("GET", "/me");
      return r.user ?? (r.uid ? (r as Me) : null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) return null;
      throw err;
    }
  },
  claim: (guest_id) => http("POST", "/me/claim", { guest_id }),

  listProjects: async () => (await http<{ projects: Project[] }>("GET", "/projects")).projects,
  createProject: (name) => http("POST", "/projects", name ? { name } : {}),
  listSamples: async () => (await http<{ projects: Project[] }>("GET", "/samples")).projects ?? [],
  cloneProject: (pid, name, opts) => http("POST", `${p(pid)}/clone`, { ...(name ? { name } : {}), ...(opts?.fresh ? { fresh: true } : {}) }),
  getProject: (pid) => http("GET", p(pid)),
  updateProject: (pid, patch) => http("PATCH", p(pid), patch),
  deleteProject: async (pid) => { await http("DELETE", p(pid)); },

  getMessages: async (pid) => (await http<{ messages: ChatMessage[] }>("GET", `${p(pid)}/messages`)).messages,
  intake: (pid, body, handlers, opts) => stream(`${p(pid)}/intake`, body, handlers, opts),

  getEnvelope: (q, opts) => {
    const qs = new URLSearchParams({
      width_ft: String(q.width_ft),
      depth_ft: String(q.depth_ft),
      authority: q.authority ?? "LDA",
      corner: String(!!q.corner),
    });
    return http("GET", `/lda/envelope?${qs}`, undefined, opts?.signal);
  },
  checkPlan: (plan) => http("POST", "/lda/check", { plan }),

  generateConcepts: (pid, body, handlers, opts) => stream(`${p(pid)}/concepts`, body, handlers, opts),
  readTaste: (pid, body, handlers, opts) => stream(`${p(pid)}/taste`, body, handlers, { idleTimeoutMs: 120_000, ...opts }),
  styleRoom: (pid, index, body) => http("POST", `${p(pid)}/taste/rooms/${index}`, body),
  readLocality: (pid, body) => http("POST", `${p(pid)}/locality`, body ?? {}),
  conceptsNight: (pid, body, handlers, opts) => stream(`${p(pid)}/concepts/night`, body, handlers, { idleTimeoutMs: 120_000, ...opts }),
  selectConcept: (pid, cid) => http("POST", `${p(pid)}/concepts/${e(cid)}/select`),

  design: (pid, handlers, opts) => stream(`${p(pid)}/design`, {}, handlers, { idleTimeoutMs: 120_000, ...opts }),
  getVersion: (pid, vid) => http("GET", `${p(pid)}/versions/${e(vid)}`),
  repairSection: (pid, vid, body, handlers, opts) => stream(`${p(pid)}/versions/${e(vid)}/repair`, body, handlers, opts),
  asBuilt: (pid, vid, summary) => http("POST", `${p(pid)}/versions/${e(vid)}/asbuilt`, { summary }),

  listComments: async (pid, versionId) => {
    const qs = versionId ? `?version_id=${e(versionId)}` : "";
    return (await http<{ comments: Comment[] }>("GET", `${p(pid)}/comments${qs}`)).comments;
  },
  createComment: (pid, body) => http("POST", `${p(pid)}/comments`, body),
  updateComment: (pid, cid, patch) => http("PATCH", `${p(pid)}/comments/${e(cid)}`, patch),
  deleteComment: async (pid, cid) => { await http("DELETE", `${p(pid)}/comments/${e(cid)}`); },
  replyToComment: (pid, cid, body) => http("POST", `${p(pid)}/comments/${e(cid)}/replies`, body),

  revise: (pid, body, handlers, opts) => stream(`${p(pid)}/revise`, body, handlers, { idleTimeoutMs: 120_000, ...opts }),
  resumeRun: async (pid, handlers, opts) =>
    (await openSSE(`${BASE}${p(pid)}/run`, { method: "GET", headers: await authHeaders() }, handlers, { idleTimeoutMs: 120_000, ...opts })) === "done",
  render: (pid, body) => http("POST", `${p(pid)}/render`, body),
  saveThumbnail: (pid, vid, image_data_url) => http("POST", `${p(pid)}/versions/${e(vid)}/thumbnail`, { image_data_url }),
  views: (pid, vid, body, handlers, opts) => stream(`${p(pid)}/versions/${e(vid)}/views`, body, handlers, { idleTimeoutMs: 180_000, ...opts }),
  matchConcept: (pid, vid, body, handlers, opts) => stream(`${p(pid)}/versions/${e(vid)}/match`, body, handlers, { idleTimeoutMs: 240_000, ...opts }),
  uploadDrawing: (pid, images) => http("POST", `${p(pid)}/drawing`, { images }),

  listMembers: async (pid) => {
    const r = await http<Partial<MembersResponse>>("GET", `${p(pid)}/members`);
    return { members: r.members ?? [], share: r.share ?? { enabled: false } };
  },
  inviteMember: (pid, body) => http("POST", `${p(pid)}/members`, body),
  updateMember: async (pid, email, body) => { await http("PATCH", `${p(pid)}/members/${e(email)}`, body); },
  removeMember: async (pid, email) => { await http("DELETE", `${p(pid)}/members/${e(email)}`); },
  setShare: (pid, enabled) => http("POST", `${p(pid)}/share`, { enabled }),

  getShared: (token) => http("GET", s(token)),
  listSharedComments: async (token) => (await http<{ comments: Comment[] }>("GET", `${s(token)}/comments`)).comments ?? [],
  getSharedMeta: async (token) => {
    try {
      const m = await http<{ current_version_id?: string | null; versions?: { id: string; n: number }[] }>("GET", `${s(token)}/meta`);
      if (m && "current_version_id" in m) return { current_version_id: m.current_version_id ?? null, versions: m.versions ?? [] };
    } catch {
      /* older servers: no /meta */
    }
    const full = await http<SharedProject>("GET", s(token));
    return { current_version_id: full.project.current_version_id ?? full.version?.id ?? null, versions: full.project.versions.map((v) => ({ id: v.id, n: v.n })) };
  },
  createSharedComment: (token, body) => http("POST", `${s(token)}/comments`, body),
  replyToSharedComment: (token, cid, body) => http("POST", `${s(token)}/comments/${e(cid)}/replies`, body),
};

export const api: Api = mockEnabled() ? mockApi : realApi;

/** Resolve an asset URL from the API (absolute, data:, /api/assets/... or /mock/...). */
export function assetUrl(url: string | null | undefined, opts?: { w?: 320 | 640 | 960 | 1600 }): string | undefined {
  if (!url) return undefined;
  const full = /^(https?:|data:|blob:|\/)/.test(url) ? url : `${BASE}/assets/${url}`;
  // ?w= asks the API for a WebP that wide (made once and cached): only for its own stored images.
  if (opts?.w && full.startsWith(`${BASE}/assets/`) && !full.includes("?") && !full.includes("/assets/thumbs/")) return `${full}?w=${opts.w}`;
  return full;
}

/** The public link for a share token (the server's `url` wins when it sends one). */
export function shareUrl(share: { url?: string; token?: string } | null | undefined): string | undefined {
  if (share?.url) return /^https?:/.test(share.url) ? share.url : `${location.origin}${share.url.startsWith("/") ? "" : "/"}${share.url}`;
  return share?.token ? `${location.origin}/s/${share.token}` : undefined;
}

/** Turn provider errors ("429 RESOURCE_EXHAUSTED {…}") into a sentence people can act on. */
export function friendlyError(message: string): string {
  if (/^\s*<|<\/?(html|body|head|title|h1|div)\b/i.test(message)) return "Naqsha couldn't reply. Try again.";
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) return "Naqsha is busy right now. Try again in a minute.";
  if (/\b50[34]\b|UNAVAILABLE|overloaded/i.test(message)) return "Naqsha is briefly unavailable. Try again shortly.";
  if (/DEADLINE_EXCEEDED|timed? ?out|timeout/i.test(message)) return "That took too long. Try again.";
  return message;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof StreamError) return friendlyError(err.message);
  if (err instanceof Error) return friendlyError(err.message || "Something went wrong.");
  return "Something went wrong.";
}
