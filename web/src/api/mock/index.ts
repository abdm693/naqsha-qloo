/**
 * Mock implementation of the Api interface (VITE_MOCK=1).
 * Accounts, members, client links and threaded comments are simulated too: the caller is whoever is signed in
 * through api/auth.ts (mock identity), otherwise the browser's guest.
 */
import type { Author, Comment, Locality, Member, Project, Role } from "@contracts/api-types";
import type { Api, Reply } from "../client";
import { currentUser } from "../auth";
import { mockUserName } from "./auth";
import { ApiError } from "../errors";
import { userId } from "../mode";
import { clone, db, latency, now, save, sleep, touch, uid, withPlot } from "./db";
import { RENDER_IMAGE } from "./fixtures";
import { envelopeFor, recheck } from "./lda";
import { nightOf } from "./night";
import { conceptsScript, designScript } from "./scripts";
import { reviseScript } from "./revise";
import { tasteScript } from "./taste";
import dha6 from "./data/locality-dha6.json";
import { ensureSamples, seedIfEmpty } from "./seed";
import { ev, play, type Step } from "./stream";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    throw new ApiError(e instanceof Error ? e.message : "Mock error", status);
  }
}

// ── Who is calling, and what may they see ───────────────────────────────────────────────────────────

/** The caller's role on a project, or null when they can't see it. */
function roleOn(pid: string): Role | null {
  const d = db();
  const me = currentUser();
  const owner = d.owners[pid];
  if (!owner) return d.members[pid]?.some((m) => m.email === "*") ? null : "owner"; // the browser guest's own
  if (me && owner === me.uid) return "owner";
  if (!me) return null;
  const m = d.members[pid]?.find((x) => x.email === "*" || x.email.toLowerCase() === me.email.toLowerCase());
  return m ? m.role : null;
}

function withRole(p: Project): Project {
  const role = roleOn(p.id) ?? undefined;
  const members = (db().members[p.id] ?? []).filter((m) => m.email !== "*");
  return { ...clone(p), role, members_count: members.length };
}

function visible(pid: string): Project {
  const p = db().projects.find((x) => x.id === pid);
  if (!p || !roleOn(pid)) throw httpError(404, "Project not found.");
  return p;
}

function editable(pid: string): Project {
  const p = visible(pid);
  if (roleOn(pid) === "client") throw httpError(403, "Clients can comment, but not change the design.");
  return p;
}

function ownerOnly(pid: string): Project {
  const p = visible(pid);
  if (roleOn(pid) !== "owner") throw httpError(403, "Only the owner can do that.");
  if (!currentUser()) throw httpError(401, "Sign in to share.");
  return p;
}

function displayName(): string {
  const me = currentUser();
  return me?.name || (me?.email ? me.email.split("@")[0] : "Owner");
}

function meAuthor(pid: string): Author {
  const me = currentUser();
  const role = roleOn(pid) ?? "owner";
  return me ? { id: me.uid, name: displayName(), role } : { id: userId(), name: "Owner", role };
}

function newProject(name?: string): Project {
  const t = now();
  return {
    id: uid("p"),
    name: name?.trim() || "Untitled home",
    created_at: t,
    updated_at: t,
    stage: "setup",
    brief: null,
    envelope: null,
    concepts: [],
    selected_concept_id: null,
    versions: [],
    current_version_id: null,
    thumbnail_url: null,
  };
}

/** Shrink a PNG data URL to a small JPEG so snapshots fit in localStorage. */
async function thumbnail(dataUrl: string, maxW = 480): Promise<string> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, maxW / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    return dataUrl;
  }
}

function shareByToken(token: string): { pid: string; project: Project } {
  const d = db();
  const pid = Object.keys(d.shares).find((k) => d.shares[k].token === token && d.shares[k].enabled);
  const project = pid ? d.projects.find((x) => x.id === pid) : undefined;
  if (!pid || !project) throw httpError(404, "This link is switched off, or it never existed.");
  return { pid, project };
}

function findComment(pid: string, cid: string): Comment {
  const c = (db().comments[pid] ?? []).find((x) => x.id === cid);
  if (!c) throw httpError(404, "Comment not found.");
  return c;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const mockApi: Api = {
  mock: true,

  async health() {
    await latency(60);
    return { ok: true, models: { mode: "mock" } };
  },

  // ── Accounts ──────────────────────────────────────────────────────────────────────────────────────
  async me() {
    await latency(80);
    const me = currentUser();
    return me ? { uid: me.uid, email: me.email, name: me.name } : null;
  },

  async claim(guestId) {
    await latency(300);
    const me = currentUser();
    if (!me) throw new ApiError("Sign in first.", 401);
    seedIfEmpty();
    const d = db();
    let moved = 0;
    for (const p of d.projects) {
      if (d.owners[p.id] || d.members[p.id]?.some((m) => m.email === "*")) continue;
      d.owners[p.id] = me.uid;
      moved++;
      for (const c of d.comments[p.id] ?? []) {
        if (c.author?.id === guestId) c.author = { id: me.uid, name: displayName(), role: "owner" };
        for (const r of c.replies ?? []) if (r.author.id === guestId) r.author = { id: me.uid, name: displayName(), role: "owner" };
      }
    }
    save();
    return { moved };
  },

  // ── Projects ──────────────────────────────────────────────────────────────────────────────────────
  async listProjects() {
    await latency();
    seedIfEmpty();
    return db()
      .projects.filter((p) => roleOn(p.id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(withRole);
  },

  async createProject(name) {
    await latency(260);
    const p = newProject(name);
    db().projects.push(p);
    const me = currentUser();
    if (me) db().owners[p.id] = me.uid;
    save();
    return withRole(p);
  },

  async listSamples() {
    await latency(140);
    ensureSamples();
    return clone(db().samples);
  },

  async cloneProject(pid, name, opts) {
    await latency(450);
    return wrap(() => {
      ensureSamples();
      const d = db();
      const existing = d.clones[pid] ? d.projects.find((x) => x.id === d.clones[pid] && roleOn(x.id)) : undefined;
      if (existing && !opts?.fresh) return withRole(existing);
      const src = d.projects.find((p) => p.id === pid && roleOn(p.id)) ?? d.samples.find((p) => p.id === pid);
      if (!src) throw httpError(404, "Project not found.");
      const t = now();
      const copy: Project = { ...clone(src), id: uid("p"), name: name?.trim() || src.name, created_at: t, updated_at: t };
      delete copy.role;
      delete copy.members_count;
      // Versions are immutable and shared; messages, comments and intake state are copied.
      d.messages[copy.id] = clone(d.messages[pid] ?? []);
      d.comments[copy.id] = clone(d.comments[pid] ?? []);
      if (d.intake[pid]) d.intake[copy.id] = clone(d.intake[pid]);
      const me = currentUser();
      if (me) d.owners[copy.id] = me.uid;
      d.projects.push(copy);
      if (d.samples.some((x) => x.id === pid)) d.clones[pid] = copy.id;
      save();
      return withRole(copy);
    });
  },

  async getProject(pid) {
    await latency(120);
    seedIfEmpty();
    return wrap(() => withRole(visible(pid)));
  },

  async updateProject(pid, patch) {
    await latency();
    return wrap(() => {
      const p = editable(pid);
      if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
      if (patch.brief) {
        p.brief = clone(patch.brief);
        const { width_ft = 0, depth_ft = 0, corner = false } = patch.brief.plot ?? {};
        p.envelope = width_ft && depth_ft ? envelopeFor(width_ft, depth_ft, corner, patch.brief.authority) : null;
        const st = db().intake[pid];
        if (st) st.brief = withPlot(clone(patch.brief));
      }
      touch(p);
      save();
      return withRole(p);
    });
  },

  async deleteProject(pid) {
    await latency();
    wrap(() => {
      if (roleOn(pid) !== "owner") throw httpError(403, "Only the owner can delete this home.");
    });
    const d = db();
    const p = d.projects.find((x) => x.id === pid);
    d.projects = d.projects.filter((x) => x.id !== pid);
    delete d.messages[pid];
    delete d.comments[pid];
    delete d.intake[pid];
    delete d.members[pid];
    delete d.shares[pid];
    delete d.owners[pid];
    for (const k of Object.keys(d.clones)) if (d.clones[k] === pid) delete d.clones[k];
    // Clones share versions with their source: only drop versions nothing else uses.
    const inUse = new Set([...d.projects, ...d.samples].flatMap((x) => x.versions.map((v) => v.id)));
    for (const v of p?.versions ?? []) if (!inUse.has(v.id)) delete d.versions[v.id];
    save();
  },

  // ── Setup ─────────────────────────────────────────────────────────────────────────────────────────
  async getMessages(pid) {
    await latency(120);
    return clone(db().messages[pid] ?? []);
  },

  async intake(pid, body, handlers, opts) {
    // The overhaul's conversational setup agent ("Here's what I understood", floors, roof, style).
    const { mockIntake } = await import("@/app/setup/mock-agent");
    return mockIntake(pid, body, handlers, opts);
  },

  async getEnvelope(q) {
    await sleep(60);
    return envelopeFor(q.width_ft, q.depth_ft, q.corner, q.authority);
  },

  async checkPlan(plan) {
    await latency(400);
    return recheck(plan);
  },

  // ── Concepts ──────────────────────────────────────────────────────────────────────────────────────
  generateConcepts(pid, body, handlers, opts) {
    return play(conceptsScript(pid, body), handlers, opts?.signal);
  },

  async styleRoom(pid, index, body) {
    await latency(1800);
    const p = editable(pid);
    const room = p.taste?.style.rooms?.[index];
    if (room) {
      if (body.follows) room.for = body.follows;
      if (body.image !== false) room.image = RENDER_IMAGE;
      touch(p);
      save();
    }
    return clone(p);
  },

  async suggest() {
    return { results: [] };
  },
  async setFamily(pid, people) {
    const p = editable(pid);
    p.family = { people: people.map((x, i) => ({ id: x.id ?? `m_${i}`, name: x.name, answered: false, token: `${pid}.m_${i}.mock` })) };
    touch(p);
    save();
    return clone(p);
  },
  async answerHere(pid, mid) {
    const p = editable(pid);
    p.family?.people.forEach((x) => { if (x.id === mid) x.answered = true; });
    touch(p);
    save();
    return clone(p);
  },
  async openLink() {
    return { you: { name: "You", favourites: [] }, family: [{ name: "You", you: true, answered: false }], heart: false };
  },
  async answerLink() {
    return { you: { name: "You", favourites: [] }, family: [{ name: "You", you: true, answered: true }], heart: false };
  },
  async readHeart(pid) {
    const p = editable(pid);
    await latency(1200);
    p.heart = { words: ["Traditional", "exquisite"], line: "A graceful home where treasured heritage meets fine craftsmanship.", room: "a central courtyard", level: "all",
      people: (p.family?.people ?? []).map((x) => ({ id: x.id, name: x.name, room: "a room of their own", line: null })), between: [], at: new Date().toISOString() };
    touch(p);
    save();
    return clone(p);
  },
  async readLocality(pid, body) {
    await latency(1400);
    const p = editable(pid);
    p.locality = { ...(dha6 as Locality), location: body?.location || [p.brief?.scheme, p.brief?.city].filter(Boolean).join(", ") || dha6.location, at: new Date().toISOString() };
    touch(p);
    save();
    return clone(p);
  },

  readTaste(pid, body, handlers, opts) {
    async function* script(): AsyncGenerator<Step> {
      const p = editable(pid);
      for await (const step of tasteScript(body)) {
        if (typeof step !== "number" && step.event === "taste") {
          p.taste = step.data as Project["taste"];
          touch(p);
          save();
        }
        yield step;
      }
    }
    return play(script(), handlers, opts?.signal);
  },

  conceptsNight(pid, body, handlers, opts) {
    async function* script(): AsyncGenerator<Step> {
      const p = editable(pid);
      const list = p.concepts.filter((c) => (body.ids?.length ? body.ids.includes(c.id) : true));
      // They run in parallel on the server and land a moment apart.
      const jobs = list.map((c) => (c.night_url ? Promise.resolve(c.night_url) : nightOf(c.url)));
      for (let i = 0; i < list.length; i++) {
        yield 900 + i * 350;
        const night_url = await jobs[i];
        const c = p.concepts.find((x) => x.id === list[i].id);
        if (!c) continue;
        c.night_url = night_url;
        save();
        yield ev("concept", { index: i, concept: clone(c) });
      }
      yield ev("done", {});
    }
    return play(script(), handlers, opts?.signal);
  },

  async selectConcept(pid, cid) {
    await latency(220);
    return wrap(() => {
      const p = editable(pid);
      const c = p.concepts.find((x) => x.id === cid);
      if (!c) throw httpError(404, "Concept not found.");
      p.selected_concept_id = cid;
      p.thumbnail_url = c.url;
      if (p.stage === "setup") p.stage = "concepts";
      touch(p);
      save();
      return withRole(p);
    });
  },

  // ── Design ────────────────────────────────────────────────────────────────────────────────────────
  design(pid, handlers, opts) {
    return play(designScript(pid), handlers, opts?.signal);
  },

  async getVersion(pid, vid) {
    await latency(150);
    return wrap(() => {
      const v = db().versions[vid];
      if (!v) throw httpError(404, "Version not found.");
      return clone(v);
    });
  },

  async repairSection(pid, vid, body, handlers, opts) {
    const v = db().versions[vid];
    const index = v?.sections.findIndex((s) => s.name === body.section) ?? -1;
    async function* script() {
      yield 1200;
      if (v && index >= 0) yield { event: "section" as const, data: { section: v.sections[index], index } };
      yield { event: "done" as const, data: {} };
    }
    return play(script(), handlers, opts?.signal);
  },

  async asBuilt(pid, vid) {
    await latency(300);
    return wrap(() => {
      const v = db().versions[vid];
      if (!v) throw httpError(404, "Version not found.");
      return clone(v.compliance);
    });
  },

  // ── Comments ──────────────────────────────────────────────────────────────────────────────────────
  async listComments(pid, versionId) {
    await latency(120);
    wrap(() => visible(pid));
    const list = db().comments[pid] ?? [];
    return clone(versionId ? list.filter((c) => c.version_id === versionId) : list);
  },

  async createComment(pid, body) {
    await latency(240);
    wrap(() => visible(pid));
    const snapshot = body.snapshot_data_url ? await thumbnail(body.snapshot_data_url) : undefined;
    const c: Comment = {
      id: uid("cm"),
      version_id: body.version_id,
      text: body.text,
      anchor: body.anchor,
      camera: body.camera,
      snapshot_url: snapshot,
      created_at: now(),
      status: "open",
      author: meAuthor(pid),
      replies: [],
    };
    (db().comments[pid] ??= []).push(c);
    const p = db().projects.find((x) => x.id === pid);
    if (p) touch(p);
    save();
    return clone(c);
  },

  async updateComment(pid, cid, patch) {
    await latency();
    return wrap(() => {
      visible(pid);
      const c = findComment(pid, cid);
      if (patch.text !== undefined) c.text = patch.text;
      if (patch.status) c.status = patch.status;
      save();
      return clone(c);
    });
  },

  async deleteComment(pid, cid) {
    await latency();
    wrap(() => visible(pid));
    const d = db();
    d.comments[pid] = (d.comments[pid] ?? []).filter((c) => c.id !== cid);
    save();
  },

  async replyToComment(pid, cid, body) {
    await latency(200);
    return wrap(() => {
      visible(pid);
      const c = findComment(pid, cid);
      const reply: Reply = { id: uid("rp"), author: meAuthor(pid), text: body.text, created_at: now() };
      c.replies = [...(c.replies ?? []), reply];
      save();
      return clone(c);
    });
  },

  // ── Revise ────────────────────────────────────────────────────────────────────────────────────────
  revise(pid, body, handlers, opts) {
    try {
      editable(pid);
    } catch (e) {
      return Promise.reject(new ApiError((e as Error).message, (e as { status?: number }).status ?? 403));
    }
    return play(reviseScript(pid, body.version_id, body.comment_ids, body.instruction), handlers, opts?.signal);
  },

  async resumeRun() {
    // Mock runs live in the page that started them; after a reload there is nothing to re-attach to.
    await latency(80);
    return false;
  },

  async render() {
    await sleep(6500);
    return { url: RENDER_IMAGE };
  },

  async views(_pid, _vid, _body, handlers) {
    handlers.done?.({ count: 0 });
  },

  async matchConcept(_pid, _vid, _body, handlers) {
    handlers.done?.({ refit_sections: [] });
  },

  async uploadDrawing() {
    throw new Error("Uploading a drawing needs the live service.");
  },

  async saveThumbnail(pid, vid, imageDataUrl) {
    const url = await thumbnail(imageDataUrl, 640);
    const d = db();
    const v = d.versions[vid];
    if (v) v.thumbnail_url = url;
    const p = d.projects.find((x) => x.id === pid);
    if (p) { p.thumbnail_url = url; touch(p); }
    save();
    return { url };
  },

  // ── Sharing ───────────────────────────────────────────────────────────────────────────────────────
  async listMembers(pid) {
    await latency(160);
    return wrap(() => {
      visible(pid);
      const d = db();
      const s = d.shares[pid];
      return {
        members: clone((d.members[pid] ?? []).filter((m) => m.email !== "*")),
        share: s?.enabled ? { enabled: true, token: s.token, url: `/s/${s.token}` } : { enabled: false },
      };
    });
  },

  async inviteMember(pid, body) {
    await latency(380);
    return wrap(() => {
      ownerOnly(pid);
      const email = body.email.trim().toLowerCase();
      if (!EMAIL.test(email)) throw httpError(422, "That doesn't look like an email address.");
      if (email === currentUser()?.email.toLowerCase()) throw httpError(422, "That's you. You already own this home.");
      const d = db();
      const list = (d.members[pid] ??= []);
      const found = list.find((m) => m.email.toLowerCase() === email);
      if (found) {
        found.role = body.role;
        save();
        return clone(found);
      }
      const m: Member = { email, role: body.role, status: "invited" };
      list.push(m);
      save();
      return clone(m);
    });
  },

  async updateMember(pid, email, body) {
    await latency(200);
    wrap(() => {
      ownerOnly(pid);
      const m = (db().members[pid] ?? []).find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!m) throw httpError(404, "That person isn't on this home.");
      m.role = body.role;
      save();
    });
  },

  async removeMember(pid, email) {
    await latency(200);
    wrap(() => {
      ownerOnly(pid);
      const d = db();
      d.members[pid] = (d.members[pid] ?? []).filter((x) => x.email.toLowerCase() !== email.toLowerCase());
      save();
    });
  },

  async setShare(pid, enabled) {
    await latency(260);
    return wrap(() => {
      ownerOnly(pid);
      const d = db();
      const s = (d.shares[pid] ??= { enabled, token: `s${Math.random().toString(36).slice(2, 12)}` });
      s.enabled = enabled;
      save();
      return { enabled, token: s.token, url: `/s/${s.token}` };
    });
  },

  // ── The client view ───────────────────────────────────────────────────────────────────────────────
  async listSharedComments(token) {
    const s = await this.getShared(token);
    return s.comments;
  },
  async getSharedMeta(token) {
    const s = await this.getShared(token);
    return { current_version_id: s.project.current_version_id ?? s.version.id, versions: s.project.versions.map((v) => ({ id: v.id, n: v.n })) };
  },
  async getShared(token) {
    await latency(220);
    seedIfEmpty();
    return wrap(() => {
      const d = db();
      const { pid, project } = shareByToken(token);
      const vid = project.current_version_id;
      const version = vid ? d.versions[vid] : undefined;
      if (!version) throw httpError(404, "This home has no design to show yet.");
      const ownerName = d.ownerNames[pid] ?? mockUserName(d.owners[pid]);
      return {
        project: { ...clone(project), role: "client" as const },
        version: clone(version),
        comments: clone((d.comments[pid] ?? []).filter((c) => c.version_id === version.id)),
        role: "client" as const,
        shared_by: ownerName,
      };
    });
  },

  async createSharedComment(token, body) {
    await latency(260);
    const { pid } = wrap(() => shareByToken(token));
    const snapshot = body.snapshot_data_url ? await thumbnail(body.snapshot_data_url) : undefined;
    const me = currentUser();
    const name = body.author_name.trim() || "Guest";
    const c: Comment = {
      id: uid("cm"),
      version_id: body.version_id,
      text: body.text,
      anchor: body.anchor,
      camera: body.camera,
      snapshot_url: snapshot,
      created_at: now(),
      status: "open",
      author: { id: me?.uid ?? `guest_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, name, role: "client" },
      replies: [],
    };
    (db().comments[pid] ??= []).push(c);
    save();
    return clone(c);
  },

  async replyToSharedComment(token, cid, body) {
    await latency(200);
    return wrap(() => {
      const { pid } = shareByToken(token);
      const c = findComment(pid, cid);
      const me = currentUser();
      const name = body.author_name?.trim() || me?.name || "Guest";
      const reply: Reply = {
        id: uid("rp"),
        author: { id: me?.uid ?? `guest_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, name, role: "client" },
        text: body.text,
        created_at: now(),
      };
      c.replies = [...(c.replies ?? []), reply];
      save();
      return clone(c);
    });
  },
};
