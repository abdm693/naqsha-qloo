"""Naqsha API: FastAPI app that serves /api/* and the built SPA (web/dist) from one Cloud Run service.

The contract is in contracts/api.md. Identity: a verified Identity Platform ID token (Authorization: Bearer) or the
guest id (X-Naqsha-User). Roles per project: owner, team (design, comment, revise) and client (view and comment).
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import logging
import math
import os
import re
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

from . import auth, busy, config, qloo, runs, sse
from .agents import architect, concepts, heart, importer, intake, jsfix, locality, research, reviser, reviser_adk, taste, views
from .auth import Identity
from .compliance import lda
from .store import blobs, db

logging.basicConfig(level=logging.INFO)
busy.install()
app = FastAPI(title="Naqsha API")
# JSON and the JS bundle go out compressed; images are already compressed and event streams (SSE) are never buffered or
# compressed (text/event-stream is in Starlette's default exclusions).
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)

PUBLIC_FIELDS = ("id", "name", "created_at", "updated_at", "stage", "brief", "envelope", "concepts", "selected_concept_id",
                 "versions", "current_version_id", "thumbnail_url", "brief_changed", "cloned_from", "imported", "taste",
                 "house_taste_fit", "locality", "family", "heart")
CLIENT_FIELDS = ("id", "name", "created_at", "updated_at", "stage", "concepts", "selected_concept_id", "versions",
                 "current_version_id", "thumbnail_url", "taste", "locality", "heart")
RANK = {"client": 1, "team": 2, "owner": 3}
NEED = {"view": 1, "comment": 1, "edit": 2, "owner": 3}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def role_of(p: dict, me: Identity) -> str | None:
    if p.get("owner") in me.owner_keys:
        return "owner"
    for m in p.get("members") or []:
        if (me.uid and m.get("uid") == me.uid) or (me.email and m.get("email") == me.email and me.signed_in):
            return m.get("role") if m.get("role") in ("team", "client") else "client"
    return None


THUMB_W = 640


def thumb_url(url: str | None) -> str | None:
    """A card-sized (640 px WebP) variant of a stored image, made once on first request (see /api/assets)."""
    if not url or not url.startswith("/api/assets/") or "?" in url or url.endswith(".webp"):
        return url
    return f"{url}?w={THUMB_W}"


def public(p: dict, role: str | None = None) -> dict:
    out = {k: p.get(k) for k in (CLIENT_FIELDS if role == "client" else PUBLIC_FIELDS)}
    out["role"] = role or "owner"
    out["members_count"] = len([m for m in p.get("members") or []])
    out["brief_changed"] = bool(p.get("brief_changed")) if role != "client" else False
    out["thumbnail_url"] = thumb_url(p.get("thumbnail_url"))
    if "family" in out:
        out["family"] = _family_out(p.get("id", ""), p.get("family"), role in ("owner", "team", None))
    return out


# --- comment authors: opaque per-project handles ---------------------------------------------------------------------------
# A guest's id is their whole identity (X-Naqsha-User), so comment payloads never carry raw uids or guest ids: each author
# id becomes an HMAC handle that is stable within a project (pins and threads still group by author) and useless outside it.
# Every caller gets the same handle for an author (the owner's own app included), so an author's pin and avatar colour, which
# the app hashes from the id, are the same for everyone. `mine` tells the caller which comments and replies are their own.
_HANDLE_KEY = (config.HANDLE_SECRET or f"naqsha-handles:{config.PROJECT}").encode()
_PUBLIC_AUTHORS = {"naqsha", "owner", "anon", None, ""}


def author_handle(pid: str, raw: str | None) -> str | None:
    if raw in _PUBLIC_AUTHORS:
        return raw
    return "a_" + hmac.new(_HANDLE_KEY, f"{pid}:{raw}".encode(), hashlib.sha256).hexdigest()[:16]


def my_author_ids(me: Identity | None) -> set[str]:
    return {x for x in ((me.uid, me.guest_id) if me else ()) if x and x not in _PUBLIC_AUTHORS}


def comment_out(pid: str, c: dict | None, me: Identity | None) -> dict | None:
    """A comment as the caller may see it: author ids as handles (the same for every caller) and `mine` on the comment and
    each reply."""
    if not c:
        return c
    c = copy.deepcopy(c)
    mine_ids = my_author_ids(me)

    def fix(obj: dict) -> None:
        a = obj.get("author")
        raw = a.get("id") if isinstance(a, dict) else None
        obj["mine"] = bool(raw and raw in mine_ids)
        if isinstance(a, dict):
            a["id"] = author_handle(pid, raw)
    fix(c)
    for r in c.get("replies") or []:
        if isinstance(r, dict):
            fix(r)
    return c


def comments_out(pid: str, cs: list[dict], me: Identity | None) -> list[dict]:
    return [comment_out(pid, c, me) for c in cs]


async def maybe_identity(authorization: str | None = Header(None), x_naqsha_user: str | None = Header(None)) -> Identity:
    """The caller's identity when they have one; an expired sign-in on a public link just reads as a guest."""
    try:
        return await auth.identity(authorization, x_naqsha_user)
    except HTTPException:
        return auth.identity_from(None, auth.valid_guest(x_naqsha_user))


async def access(pid: str, me: Identity, need: str = "view") -> tuple[dict, str]:
    """The project and the caller's role, or 404 (unknown / no access) / 403 (not allowed for this role)."""
    p = await db.get_project(pid)
    role = role_of(p, me) if p else None
    if not p or not role:
        raise HTTPException(404, "project not found")
    if RANK[role] < NEED[need]:
        raise HTTPException(403, "Only the owner can do that." if need == "owner" else "You can view and comment on this home.")
    if role != "owner" and me.signed_in and any(m.get("email") == me.email and m.get("status") != "active" for m in p.get("members") or []):
        await db.resolve_invites(me.email, me.uid, me.name)
    # a city with researched rules: load its rule pack on this instance before anything checks the plan
    await research.ensure((p.get("brief") or {}).get("authority"))
    return p, role


def fresh_version(v: dict | None, brief: dict | None) -> dict | None:
    """Versions saved before the planning rules existed carry LDA-only reports with no categories: re-check them on read so
    every version shows its LDA and livable status honestly (cheap, deterministic, nothing is written)."""
    if v and v.get("plan") and any("category" not in c for c in (v.get("compliance") or {}).get("checks", [{}])):
        try:
            v["compliance"] = lda.check(v["plan"], brief)
        except Exception:
            logging.exception("re-check failed for %s", v.get("id"))
    if v and v.get("sections"):
        try:  # sections saved before declarations were shared still build (nothing is written)
            jsfix.share_declarations(v["sections"])
        except Exception:
            logging.exception("sharing declarations failed for %s", v.get("id"))
    return v


def author_of(me: Identity, role: str, name: str | None = None) -> dict:
    fallback = {"owner": "Owner", "team": "Team member", "client": "Client"}.get(role, "Guest")
    return {"id": me.author_id, "name": (name or "").strip()[:60] or me.display_name(fallback), "role": role}


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    logging.exception("unhandled")
    return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "models": {"setup": config.MODEL_SETUP, "architect": config.MODEL_ARCHITECT, "review": config.MODEL_REVIEW,
                                   "image": config.MODEL_IMAGE}}


# --- accounts ------------------------------------------------------------------------------------------------------
@app.get("/api/config")
def client_config() -> dict:
    """What the SPA needs to sign people in (Identity Platform browser key; public by design, never committed)."""
    return {"auth": {"api_key": config.AUTH_API_KEY or None, "project_id": config.AUTH_PROJECT}}


@app.get("/api/me")
async def me_get(me: Identity = Depends(auth.identity)):
    if not me.signed_in:
        raise HTTPException(401, "Not signed in.")
    await db.resolve_invites(me.email, me.uid, me.name)
    return {"user": {"uid": me.uid, "email": me.email, "name": me.display_name("")}}


class ClaimBody(BaseModel):
    guest_id: str


@app.post("/api/me/claim")
async def me_claim(body: ClaimBody, me: Identity = Depends(auth.identity)):
    """First sign-in: move the guest's projects into the account so nothing is lost."""
    if not me.signed_in:
        raise HTTPException(401, "Sign in first.")
    gid = auth.valid_guest(body.guest_id)
    moved = await db.claim_projects(gid, me.key, me.uid) if gid else 0
    await db.resolve_invites(me.email, me.uid, me.name)
    return {"moved": moved}


# --- projects --------------------------------------------------------------------------------------------------------
class NewProject(BaseModel):
    name: str | None = None
    fresh: bool = False


class PatchProject(BaseModel):
    name: str | None = None
    brief: dict | None = None


@app.get("/api/projects")
async def list_projects(me: Identity = Depends(auth.identity)):
    """Your homes (owned) and homes shared with you (member), newest first, each with your role."""
    seen: dict[str, dict] = {}
    for key in me.owner_keys:
        for p in await db.list_projects(key):
            seen[p["id"]] = public(p, "owner")
    if me.signed_in:
        await db.resolve_invites(me.email, me.uid, me.name)
        for p in await db.list_member_projects(me.uid):
            if p["id"] not in seen:
                seen[p["id"]] = public(p, role_of(p, me))
    return {"projects": sorted(seen.values(), key=lambda d: d.get("updated_at") or "", reverse=True)}


@app.post("/api/projects")
async def create_project(body: NewProject, me: Identity = Depends(auth.identity)):
    return public(await db.create_project(me.key, body.name), "owner")


@app.get("/api/projects/{pid}")
async def get_project(pid: str, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me)
    return public(p, role)


@app.patch("/api/projects/{pid}")
async def patch_project(pid: str, body: PatchProject, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "edit")
    fields: dict = {}
    if body.name is not None:
        fields["name"] = body.name.strip()[:80] or p.get("name")
        fields["auto_named"] = False  # the family named it: the plot no longer renames it
    if body.brief is not None:
        before = p.get("brief") or intake.empty_brief()
        # The brief panel sends whole lists: preferences are replaced (an empty list clears them), not appended.
        brief = intake.merge_brief(before, intake.panel_patch(before, body.brief), [], spaces_mode="replace", prefs_mode="replace")
        brief, _ = intake.clamp_storeys(brief)
        fields.update(brief=brief, envelope=intake.envelope_for(brief), stage=intake.next_stage(p, bool(p.get("intake_complete"))))
        if p.get("versions") and intake._design_fields(before) != intake._design_fields(brief):
            fields["brief_changed"] = True
        if body.name is None and (name := intake.auto_name(p, brief)):
            fields.update(name=name, auto_named=True)
    return public(await db.update_project(pid, **fields) if fields else p, role)


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str, me: Identity = Depends(auth.identity)):
    await access(pid, me, "owner")
    await db.delete_project(pid)
    return {"ok": True}


@app.get("/api/samples")
async def samples():
    """Finished example homes anyone can open (copied into their workspace on demand)."""
    return {"projects": [public(p, "client") | {"brief": p.get("brief"), "envelope": p.get("envelope")}
                         for p in await db.list_projects(db.SAMPLES_OWNER)]}


@app.post("/api/projects/{pid}/clone")
async def clone(pid: str, body: NewProject, me: Identity = Depends(auth.identity)):
    """Copy a sample (or your own project) into your workspace. Opening a sample again returns your copy while it is
    untouched (the name it was made with, no comments, replies or versions of your own; refreshed in place when the sample
    has changed since). Once you have made it yours, or with {fresh: true}, it makes a new copy. Copies drop the
    "Sample · " prefix, and a second copy in the same workspace is named "… (2)"."""
    src = await db.get_project(pid)
    if not src or not (src.get("owner") == db.SAMPLES_OWNER or role_of(src, me) in ("owner", "team")):
        raise HTTPException(404, "project not found")
    if src.get("owner") != db.SAMPLES_OWNER:
        return public(await db.clone_project(pid, me.key, body.name), "owner")
    copies: list[dict] = []
    for key in me.owner_keys:
        copies += await db.list_clones(key, pid)
    if not body.fresh:
        for c in copies:  # newest first
            if not await db.untouched_copy(c, src):
                continue
            if not db.stale_copy(c, src):
                return public(c, "owner")
            # an untouched copy of an older sample: refresh it in place (an older copy's "Sample · …" name loses the prefix)
            name = db.copy_base_name(src.get("name")) if c.get("name") == src.get("name") else c.get("name")
            return public(await db.refresh_clone(c["id"], src, c["owner"], name), "owner")
    taken: set[str] = set()
    for key in me.owner_keys:
        taken |= {str(p.get("name") or "") for p in await db.list_projects(key)}
    name = (body.name or "").strip()[:80] or db.copy_name(src.get("name"), taken)
    # a deterministic id per copy slot, so two tabs opening the sample at once still make one copy
    ids = {c["id"] for c in copies}
    slot = next(k for k in range(1, len(ids) + 2) if db.clone_id(me.key, pid, k) not in ids)
    return public(await db.clone_project(pid, me.key, name, once=True, slot=slot), "owner")


# --- members and sharing --------------------------------------------------------------------------------------------------
class MemberBody(BaseModel):
    email: str
    role: str = "team"
    name: str | None = None


class MemberPatch(BaseModel):
    role: str


class ShareBody(BaseModel):
    enabled: bool


def _share_url(request: Request, token: str | None) -> str | None:
    if not token:
        return None
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}/s/{token}"


def _members_out(p: dict) -> list[dict]:
    return [{k: m.get(k) for k in ("uid", "email", "name", "role", "status") if m.get(k) is not None} for m in p.get("members") or []]


@app.get("/api/projects/{pid}/members")
async def members(pid: str, request: Request, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "view")
    share = {"enabled": bool(p.get("share_enabled"))}
    if role in ("owner", "team") and p.get("share_enabled"):
        share.update(token=p.get("share_token"), url=_share_url(request, p.get("share_token")))
    return {"members": _members_out(p), "share": share, "role": role}


@app.post("/api/projects/{pid}/members")
async def add_member(pid: str, body: MemberBody, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "owner")
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "That email address doesn't look right.")
    if body.role not in ("team", "client"):
        raise HTTPException(400, "Role must be team or client.")
    if me.email and email == me.email:
        raise HTTPException(400, "You already own this home.")
    ms = [m for m in p.get("members") or [] if m.get("email") != email]
    m = {"email": email, "role": body.role, "status": "invited", "invited_at": db.now(), "invited_by": me.author_id,
         **({"name": body.name.strip()[:60]} if body.name else {})}
    old = next((x for x in p.get("members") or [] if x.get("email") == email), None)
    if old and old.get("status") == "active":
        m.update(status="active", uid=old.get("uid"), name=old.get("name") or m.get("name"))
    await db.set_members(pid, ms + [m])
    return {k: m.get(k) for k in ("uid", "email", "name", "role", "status") if m.get(k) is not None}


@app.patch("/api/projects/{pid}/members/{email}")
async def patch_member(pid: str, email: str, body: MemberPatch, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "owner")
    if body.role not in ("team", "client"):
        raise HTTPException(400, "Role must be team or client.")
    ms = p.get("members") or []
    hit = next((m for m in ms if m.get("email") == email.lower()), None)
    if not hit:
        raise HTTPException(404, "member not found")
    hit["role"] = body.role
    await db.set_members(pid, ms)
    return {k: hit.get(k) for k in ("uid", "email", "name", "role", "status") if hit.get(k) is not None}


@app.delete("/api/projects/{pid}/members/{email}")
async def remove_member(pid: str, email: str, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "view")
    leaving_self = me.email and email.lower() == me.email
    if role != "owner" and not leaving_self:
        raise HTTPException(403, "Only the owner can do that.")
    await db.set_members(pid, [m for m in p.get("members") or [] if m.get("email") != email.lower()])
    return {"ok": True}


@app.post("/api/projects/{pid}/share")
async def share(pid: str, body: ShareBody, request: Request, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "owner")
    token = p.get("share_token") or db.new_share_token()
    await db.update_project(pid, share_enabled=body.enabled, share_token=token)
    return {"enabled": body.enabled, "token": token, "url": _share_url(request, token)}


# --- client link (/s/<token>): view and comment, no account needed ---------------------------------------------------------------
async def _shared(token: str) -> dict:
    p = await db.find_by_share_token(token)
    if not p:
        raise HTTPException(404, "This link is no longer shared.")
    await research.ensure((p.get("brief") or {}).get("authority"))
    return p


@app.get("/api/share/{token}")
async def share_view(token: str, me: Identity = Depends(maybe_identity)):
    p = await _shared(token)
    v = await db.get_version(p["id"], p["current_version_id"]) if p.get("current_version_id") else None
    return {"project": public(p, "client"), "version": fresh_version(v, p.get("brief")),
            "comments": comments_out(p["id"], await db.list_comments(p["id"]), me), "role": "client"}


@app.get("/api/share/{token}/meta")
async def share_meta(token: str):
    """What the client link polls (every 30 s): the current version and the version list, without the plan or comments."""
    p = await _shared(token)
    return {"current_version_id": p.get("current_version_id"),
            "versions": [{"id": v["id"], "n": v.get("n")} for v in p.get("versions") or [] if isinstance(v, dict) and v.get("id")]}


@app.get("/api/share/{token}/versions/{vid}")
async def share_version(token: str, vid: str):
    p = await _shared(token)
    v = await db.get_version(p["id"], vid)
    if not v:
        raise HTTPException(404, "version not found")
    return fresh_version(v, p.get("brief"))


@app.get("/api/share/{token}/comments")
async def share_comments(token: str, version_id: str | None = None, me: Identity = Depends(maybe_identity)):
    p = await _shared(token)
    return {"comments": comments_out(p["id"], await db.list_comments(p["id"], version_id), me)}


class ShareComment(BaseModel):
    author_name: str | None = None
    text: str
    anchor: dict
    camera: dict
    snapshot_data_url: str | None = None
    version_id: str | None = None
    kind: str | None = None  # "approval": the client approves this version (stored resolved, never applied)


class ReplyBody(BaseModel):
    text: str
    author_name: str | None = None


APPROVAL_RE = re.compile(r"^\s*approved?\s+(?:version\s+|v)\d+\s*\.?\s*$", re.I)


def _general(anchor: dict) -> bool:
    return not (anchor or {}).get("room") and not (anchor or {}).get("element_id")


async def _spread(pid: str, version_id: str, anchor: dict, plot_w_ft: float | None = None) -> dict:
    """General notes ("Whole home", "This view") share one anchor point; move each new one to the first free slot so pins
    don't stack (see spread_slots)."""
    pos = (anchor or {}).get("position")
    if not _general(anchor) or not (isinstance(pos, list) and len(pos) == 3):
        return anchor
    try:
        p0 = [float(v) for v in pos]
    except (TypeError, ValueError):
        return anchor
    others = [c for c in await db.list_comments(pid, version_id) if _general(c.get("anchor") or {})]
    taken = []
    for c in others:
        try:
            q = [float(v) for v in (c.get("anchor") or {}).get("position") or []]
        except (TypeError, ValueError):
            continue
        if len(q) == 3:
            taken.append(q)
    step = spread_step(plot_w_ft)
    for cand in spread_slots(p0, step):
        if all(math.dist(cand, q) >= 0.75 * step - 1e-6 for q in taken):
            return {**anchor, "position": cand}
    return anchor


def spread_step(plot_w_ft: float | None) -> float:
    """Metres between general pins: a quarter of the plot's width (at least 1.6 m). The hero view frames the whole plot, so
    this is the same on-screen gap on any plot: ~50 px on a 35 ft plot at the default view, wider than a pin (24 px on a
    desktop, ~48 px on a phone)."""
    try:
        w = float(plot_w_ft or 35.0)
    except (TypeError, ValueError):
        w = 35.0
    return round(max(1.6, 0.25 * w * 0.3048), 2)


def spread_slots(p0: list[float], step: float):
    """Where general pins go: 0, +step, -step, +2 step along x, then the same four 0.9 step higher, and so on (a slot within
    0.75 step of another general pin is taken)."""
    for row in range(10):
        for k in range(4):
            dx = step * ((k + 1) // 2) * (1 if k % 2 else -1)
            yield [round(p0[0] + dx, 2), round(p0[1] + 0.9 * step * row, 2), round(p0[2], 2)]


async def _new_comment(p: dict, version_id: str, text: str, anchor: dict, camera: dict, snapshot: str | None, author: dict,
                       kind: str | None = None) -> dict:
    cid = db.new_id("cm_")
    snap = None
    if snapshot:
        data, mime = blobs.decode_data_url(snapshot)
        snap = await blobs.put(f"projects/{p['id']}/comments/{cid}.{'jpg' if 'jpeg' in mime else 'png'}", data, mime)
    anchor = await _spread(p["id"], version_id, anchor, ((p.get("brief") or {}).get("plot") or {}).get("width_ft"))
    c = {"id": cid, "version_id": version_id, "text": text.strip(), "anchor": anchor, "camera": camera, "snapshot_url": snap,
         "created_at": db.now(), "status": "open", "author": author, "replies": []}
    if kind == "approval":  # a sign-off, not a change request: closed from the start, so Revise and Apply leave it out
        c.update(kind="approval", status="resolved")
    return await db.add_comment(p["id"], c)


@app.post("/api/share/{token}/comments")
async def share_comment(token: str, body: ShareComment, me: Identity = Depends(auth.identity)):
    p = await _shared(token)
    if not body.text.strip():
        raise HTTPException(400, "Write a comment first.")
    role = role_of(p, me) or "client"
    vid = body.version_id or p.get("current_version_id")
    if not vid:
        raise HTTPException(400, "There's nothing to comment on yet.")
    kind = "approval" if body.kind == "approval" or (APPROVAL_RE.match(body.text) and _general(body.anchor)) else None
    c = await _new_comment(p, vid, body.text, body.anchor, body.camera, body.snapshot_data_url,
                           author_of(me, role, body.author_name), kind)
    return comment_out(p["id"], c, me)


@app.post("/api/share/{token}/comments/{cid}/replies")
async def share_reply(token: str, cid: str, body: ReplyBody, me: Identity = Depends(auth.identity)):
    p = await _shared(token)
    return comment_out(p["id"], await _reply(p, cid, body, author_of(me, role_of(p, me) or "client", body.author_name)), me)


async def _reply(p: dict, cid: str, body: ReplyBody, author: dict) -> dict:
    if not body.text.strip():
        raise HTTPException(400, "Write a reply first.")
    c = await db.add_reply(p["id"], cid, {"id": db.new_id("rp_"), "author": author, "text": body.text.strip(), "created_at": db.now()})
    if not c:
        raise HTTPException(404, "comment not found")
    return c


# --- setup agent -----------------------------------------------------------------------------------------------------------
class IntakeBody(BaseModel):
    message: str | None = None
    action: str | None = None  # start | skip_question | skip_all
    chips: list[str] | None = None


@app.get("/api/projects/{pid}/messages")
async def messages(pid: str, me: Identity = Depends(auth.identity)):
    await access(pid, me, "edit")
    return {"messages": await db.list_messages(pid)}


@app.post("/api/projects/{pid}/intake")
async def intake_turn(pid: str, body: IntakeBody, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "edit")
    return sse.stream(intake.run_turn(p, body.message, body.action, body.chips))


# --- the family: everyone answers on their own link; what they share becomes the heart of the home --------------------
class FamilyMember(BaseModel):
    id: str | None = None
    name: str


class FamilyBody(BaseModel):
    people: list[FamilyMember]


class AnswerBody(BaseModel):
    favourites: list[Favourite]


def _family_out(pid: str, family: dict | None, owner: bool) -> dict | None:
    """Who has answered. The owner also gets each person's private link; nobody sees anyone else's answers from here."""
    if not family:
        return None
    people = []
    for m in family.get("people") or []:
        x = {"id": m["id"], "name": m["name"], "answered": bool(m.get("answered_at"))}
        if owner:
            x["token"] = f"{pid}.{m['id']}.{m['secret']}"
        people.append(x)
    return {"people": people}


async def _member(token: str) -> tuple[dict, dict]:
    try:
        pid, mid, secret = token.split(".", 2)
    except ValueError:
        raise HTTPException(404, "This link isn't right.")
    p = await db.get_project(pid)
    m = next((x for x in ((p or {}).get("family") or {}).get("people") or [] if x["id"] == mid), None)
    if not m or not hmac.compare_digest(m.get("secret") or "", secret):
        raise HTTPException(404, "This link isn't right.")
    return p, m


def _link_out(p: dict, m: dict) -> dict:
    return {"you": {"name": m["name"], "favourites": m.get("favourites") or []}, "where": _where(p.get("brief") or {}) or None,
            "family": [{"name": x["name"], "you": x["id"] == m["id"], "answered": bool(x.get("answered_at"))}
                       for x in p["family"]["people"]], "heart": bool(p.get("heart"))}


@app.get("/api/suggest")
async def suggest(q: str = ""):
    """What someone may mean as they type, with pictures."""
    try:
        return {"results": await qloo.suggest(q[:80])}
    except qloo.QlooError:
        return {"results": []}


@app.put("/api/projects/{pid}/family")
async def set_family(pid: str, body: FamilyBody, me: Identity = Depends(auth.identity)):
    """Who lives here. Everyone keeps their link and answers; a new name gets a new link."""
    p, role = await access(pid, me, "edit")
    have = {m["id"]: m for m in (p.get("family") or {}).get("people") or []}
    people = []
    for x in body.people[:8]:
        name = x.name.strip()[:40]
        if not name:
            continue
        people.append({**have[x.id], "name": name} if x.id in have else
                      {"id": db.new_id("m_"), "name": name, "secret": secrets.token_urlsafe(12), "favourites": [], "answered_at": None})
    return public(await db.update_project(pid, family={"people": people}), role)


@app.post("/api/projects/{pid}/family/{mid}/answer")
async def answer_here(pid: str, mid: str, body: AnswerBody, me: Identity = Depends(auth.identity)):
    """Someone answers on the owner's device."""
    p, role = await access(pid, me, "edit")
    fam = copy.deepcopy(p.get("family") or {})
    m = next((x for x in fam.get("people") or [] if x["id"] == mid), None)
    if not m:
        raise HTTPException(404, "no such person")
    m.update(favourites=[f.model_dump() for f in body.favourites][:12], answered_at=db.now())
    return public(await db.update_project(pid, family=fam), role)


@app.get("/api/link/{token}")
async def link_open(token: str):
    p, m = await _member(token)
    return _link_out(p, m)


@app.post("/api/link/{token}")
async def link_answer(token: str, body: AnswerBody):
    """One person's answers, from their own link. Only their own."""
    p, m = await _member(token)
    fresh = copy.deepcopy(await db.get_project(p["id"]) or p)
    mine = next(x for x in fresh["family"]["people"] if x["id"] == m["id"])
    mine.update(favourites=[f.model_dump() for f in body.favourites][:12], answered_at=db.now())
    saved = await db.update_project(p["id"], family=fresh["family"])
    return _link_out(saved, mine)


@app.post("/api/projects/{pid}/heart")
async def read_heart(pid: str, me: Identity = Depends(auth.identity)):
    """Find what the family shares. Everyone who has answered counts; the room the words become goes into the brief."""
    p, role = await access(pid, me, "edit")
    people = [m for m in (p.get("family") or {}).get("people") or [] if m.get("favourites")]
    if not people:
        raise HTTPException(400, "Nobody has answered yet.")
    brief = p.get("brief") or {}
    home = {k: brief.get(k) for k in ("city", "scheme", "storeys", "bedrooms", "style") if brief.get(k)}
    found = await heart.read(people, home)
    found["near"] = await heart.near_home(people, _where(brief))
    prefs = [x for x in brief.get("preferences") or [] if not str(x).startswith(("The heart of the home", "A room for "))]
    if found.get("room"):
        prefs.append(f"The heart of the home is {found['room']}, at the centre of the plan, with the other rooms opening towards it")
    prefs += [f"A room for {x['name']}: {x['room']}" for x in found.get("people") or [] if x.get("room")]
    new_brief = {**brief, "preferences": prefs}
    return public(await db.update_project(pid, heart=found, brief=new_brief, brief_changed=bool(p.get("versions"))), role)


# --- the neighbourhood ------------------------------------------------------------------------------------------------
class LocalityBody(BaseModel):
    location: str | None = None


def _where(brief: dict) -> str:
    return ", ".join(x for x in (brief.get("scheme"), brief.get("city")) if x)


@app.post("/api/projects/{pid}/locality")
async def read_locality(pid: str, body: LocalityBody, me: Identity = Depends(auth.identity)):
    """Read the neighbourhood as soon as the place is known: the map, how it feels, and what a house there could take from
    it. Kept on the project until the place changes."""
    p, role = await access(pid, me, "edit")
    where = (body.location or "").strip()[:120] or _where(p.get("brief") or {})
    if not where:
        raise HTTPException(400, "Tell me where the house will be first.")
    cur = p.get("locality") or {}
    if cur.get("location") == where and cur.get("ideas"):
        return public(p, role)
    got = await locality.read(where, p.get("brief") or {})
    return public(await db.update_project(pid, locality=got), role)


# --- taste (Qloo) ------------------------------------------------------------------------------------------------------
class Favourite(BaseModel):
    kind: str | None = None
    name: str
    id: str | None = None        # the real thing they picked (their favourite may be Selena, not Selena Gomez)
    image: str | None = None
    heart: bool = False          # where their heart lives


class TastePerson(BaseModel):
    label: str = "You"
    role: str | None = None   # e.g. parents, kids, everyone
    favourites: list[Favourite] = []


class TasteBody(BaseModel):
    people: list[TastePerson]
    location: str | None = None
    notes: str | None = None


@app.post("/api/projects/{pid}/taste")
async def taste_run(pid: str, body: TasteBody, me: Identity = Depends(auth.identity)):
    """The family's favourites and neighbourhood -> Qloo -> their style brief (streamed: step, favourites, profile, brief)."""
    p, _ = await access(pid, me, "edit")
    data = body.model_dump()
    data["people"] = [{**x, "favourites": [f for f in x["favourites"] if f["name"].strip()][:12]} for x in data["people"]][:6] or _family_people(p)

    return sse.stream(_taste_events(pid, p, data))


def _family_people(p: dict) -> list[dict]:
    return [{"label": m["name"], "role": None, "favourites": m["favourites"]} for m in (p.get("family") or {}).get("people") or [] if m.get("favourites")]


async def _taste_events(pid: str, p: dict, data: dict):
    """Run the taste agent and save its result on the project (the brief's style follows the family's taste)."""
    brief = p.get("brief") or {}
    data = {**data, "heart": p.get("heart")}
    async for ev in taste.run(brief, data):
        if ev[0] == "brief":
            style = ev[1]["style"]
            saved = {"input": data, "profile": ev[1]["profile"], "style": style, "at": db.now()}
            ext = style.get("exterior") or {}
            new_brief = {**brief, "taste": data}
            if ext.get("style"):
                new_brief["style"] = ext["style"]
                new_brief["style_notes"] = "; ".join(x for x in [", ".join(ext.get("materials") or []), ext.get("massing")] if x)
            await db.update_project(pid, taste=saved, brief=new_brief, brief_changed=bool(p.get("versions")))
            yield "taste", saved
        else:
            yield ev



class RoomBody(BaseModel):
    follows: str | None = None   # a person's label, or "everyone"
    image: bool = True


@app.post("/api/projects/{pid}/taste/rooms/{index}")
async def taste_room(pid: str, index: int, body: RoomBody, me: Identity = Depends(auth.identity)):
    """Style one room: optionally re-read it for one person's taste, then picture it (a photoreal interior)."""
    p, role = await access(pid, me, "edit")
    t = copy.deepcopy(p.get("taste") or {})
    rooms = (t.get("style") or {}).get("rooms") or []
    if not 0 <= index < len(rooms):
        raise HTTPException(404, "no such room")
    room = rooms[index]
    if body.follows and body.follows != room.get("for"):
        room = await taste.restyle_room(t, room, body.follows)
    if body.image:
        refs = await taste.room_refs(p, room)
        resp = await concepts._image_call(refs + [taste.room_prompt(t["style"], room, p.get("brief") or {}, bool(refs))], aspect="4:3")
        got = concepts._image_bytes(resp)
        if not got:
            raise HTTPException(502, "The image model returned no image. Try again.")
        room["image"] = await blobs.put(f"projects/{pid}/rooms/{db.new_id('r_')}.png", got[0], got[1])
    fresh = copy.deepcopy((await db.get_project(pid) or {}).get("taste") or t)   # another room may have changed meanwhile
    fresh_rooms = (fresh.get("style") or {}).get("rooms") or rooms
    fresh_rooms[index] = room
    return public(await db.update_project(pid, taste=fresh), role)


# --- LDA --------------------------------------------------------------------------------------------------------------
@app.get("/api/lda/envelope")
def lda_envelope(width_ft: float, depth_ft: float, authority: str = "LDA", corner: bool = False):
    env = lda.envelope(width_ft, depth_ft, authority, corner)
    env.pop("_band", None)
    return env


class CheckBody(BaseModel):
    plan: dict
    brief: dict | None = None


@app.post("/api/lda/check")
def lda_check(body: CheckBody):
    return lda.check(body.plan, body.brief)


# --- concepts ---------------------------------------------------------------------------------------------------------
class ConceptBody(BaseModel):
    count: int = 4
    instruction: str | None = None
    base_concept_id: str | None = None


class NightBody(BaseModel):
    ids: list[str] | None = None


@app.post("/api/projects/{pid}/concepts")
async def make_concepts(pid: str, body: ConceptBody, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "edit")
    if not p.get("brief"):
        raise HTTPException(400, "finish the setup first")

    async def gen():
        proj = p
        brief = p.get("brief") or {}
        where = _where(brief)
        if where and not body.base_concept_id and (proj.get("locality") or {}).get("location") != where:
            # the street comes first: the concepts take their facade and garden from the neighbourhood
            yield "stage", {"stage": "wait", "message": f"Walking around {where.split(',')[0]}…"}
            try:
                proj = await db.update_project(pid, locality=await locality.read(where, brief))
            except Exception as e:
                logging.getLogger("naqsha").warning("locality before concepts failed: %r", e)
        if not proj.get("taste") and where and not body.base_concept_id:
            # no favourites shared: the design still follows its locality, read from Qloo before anything is drawn
            async for ev in _taste_events(pid, proj, {"people": _family_people(proj), "location": where, "notes": None}):
                if ev[0] == "step":
                    yield "stage", {"stage": "wait", "message": ev[1]["message"]}
                elif ev[0] == "taste":
                    yield ev
            proj = await db.get_project(pid) or p
        async for ev in concepts.generate(proj, max(1, min(4, body.count)), body.instruction, body.base_concept_id):
            yield ev
    return sse.stream(gen())


@app.post("/api/projects/{pid}/concepts/night")
async def night_concepts(pid: str, body: NightBody, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "view")
    if not p.get("concepts"):
        raise HTTPException(400, "There are no concepts yet.")
    return sse.stream(concepts.night(p, body.ids))


@app.post("/api/projects/{pid}/concepts/{cid}/select")
async def select_concept(pid: str, cid: str, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "edit")
    c = next((c for c in p.get("concepts", []) if c["id"] == cid), None)
    if not c:
        raise HTTPException(404, "concept not found")
    return public(await db.update_project(pid, selected_concept_id=cid, thumbnail_url=p.get("thumbnail_url") if p.get("versions") else c["url"]), role)


# --- design --------------------------------------------------------------------------------------------------------------
def _attach(run: runs.Run):
    """Stream a run from the start (the `run` header first, so the client can reset its view and keep its timer)."""
    return sse.stream(run.follow())


@app.post("/api/projects/{pid}/design")
async def design(pid: str, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "edit")
    if not p.get("brief"):
        raise HTTPException(400, "finish the setup first")
    if (run := runs.active(pid)):  # already designing or revising: attach and replay instead of starting another
        return _attach(run)
    brief = p["brief"]
    if intake.missing(brief) or not brief.get("plot"):
        brief, _ = intake.defaults_for(brief)
    # within the authority's storeys, and at the limit no enclosed room on the roof (a brief saved before that rule)
    brief, _ = intake.clamp_storeys(brief)
    if brief != p["brief"]:
        p = await db.update_project(pid, brief=brief, envelope=intake.envelope_for(brief))
    return _attach(runs.start(pid, "design", lambda: architect.design(p)))


@app.get("/api/projects/{pid}/run")
async def attach_run(pid: str, me: Identity = Depends(auth.identity)):
    """Re-attach to a running design/revise pipeline (replays all events so far). 204 when nothing is running."""
    await access(pid, me, "view")
    run = runs.active(pid)
    if not run:
        return Response(status_code=204)
    return _attach(run)


@app.get("/api/projects/{pid}/versions/{vid}")
async def get_version(pid: str, vid: str, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "view")
    v = await db.get_version(pid, vid)
    if not v:
        raise HTTPException(404, "version not found")
    return fresh_version(v, p.get("brief"))


class RepairBody(BaseModel):
    section: str
    error: str


@app.post("/api/projects/{pid}/versions/{vid}/repair")
async def repair(pid: str, vid: str, body: RepairBody, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "edit")
    v = await db.get_version(pid, vid)
    if not v:
        raise HTTPException(404, "version not found")

    async def gen():
        fixed = await architect.repair_section(p, v, body.section, body.error)
        v["sections"] = [fixed if s["name"] == body.section else s for s in v["sections"]]
        jsfix.share_declarations(v["sections"])
        fixed = next(s for s in v["sections"] if s["name"] == body.section)
        await db.save_version(pid, v)
        idx = next(i for i, s in enumerate(v["sections"]) if s["name"] == body.section)
        yield "section", {"section": fixed, "index": idx}
    return sse.stream(gen())


class ThumbBody(BaseModel):
    image_data_url: str


@app.post("/api/projects/{pid}/versions/{vid}/thumbnail")
async def version_thumbnail(pid: str, vid: str, body: ThumbBody, me: Identity = Depends(auth.identity)):
    """Store a viewport capture as the version's (and project's) thumbnail."""
    await access(pid, me, "edit")
    v = await db.get_version(pid, vid)
    if not v:
        raise HTTPException(404, "version not found")
    data, mime = blobs.decode_data_url(body.image_data_url)
    url = await blobs.put(f"projects/{pid}/versions/{vid}.{'jpg' if 'jpeg' in mime else 'png'}", data, mime)
    v["thumbnail_url"] = url
    await db.save_version(pid, v)
    await db.update_project(pid, thumbnail_url=url)
    return {"url": url}


class AsBuiltBody(BaseModel):
    summary: dict


@app.post("/api/projects/{pid}/versions/{vid}/asbuilt")
async def asbuilt(pid: str, vid: str, body: AsBuiltBody, me: Identity = Depends(auth.identity)):
    """Check the house as the 3D engine built it. The report is stored on the version (as_built) when the caller can edit, so
    Plan counts the same notes from the 3D model after a reload; viewers get the report without writing anything."""
    _, role = await access(pid, me, "view")
    v = await db.get_version(pid, vid)
    if not v:
        raise HTTPException(404, "version not found")
    report = lda.check_asbuilt(v["plan"], body.summary)
    if RANK[role] >= NEED["edit"] and v.get("as_built") != report:
        try:
            await db.patch_version(pid, vid, as_built=report)
        except Exception:
            logging.exception("storing the as-built report failed for %s/%s", pid, vid)
    return report


# --- photos of the house from several angles, and the concept match ------------------------------------------------------
class Shot(BaseModel):
    angle: str
    label: str | None = None
    image_data_url: str


class ViewsBody(BaseModel):
    shots: list[Shot]


@app.post("/api/projects/{pid}/versions/{vid}/views")
async def version_views(pid: str, vid: str, body: ViewsBody, me: Identity = Depends(auth.identity)):
    """Photographs of the house from several angles, each made from a capture of the 3D model (geometry kept)."""
    p, _ = await access(pid, me, "edit")
    v = await db.get_version(pid, vid)
    if not v:
        raise HTTPException(404, "version not found")
    shots = [s.model_dump() for s in body.shots if s.angle in views.ANGLES][:5]
    if not shots:
        raise HTTPException(400, "no shots")
    return sse.stream(views.photos(p, v, shots))


class MatchBody(BaseModel):
    image_data_url: str
    # more captures of the model (e.g. the street corner), so a feature hidden from the front still counts
    extra_image_data_urls: list[str] | None = None
    refit: bool = True


@app.post("/api/projects/{pid}/versions/{vid}/match")
async def version_match(pid: str, vid: str, body: MatchBody, me: Identity = Depends(auth.identity)):
    """Compare the 3D model (its front view) with the chosen concept, feature by feature; with `refit`, rewrite the facade
    sections for what is missing. Streams `match`, then `section` events for rewritten sections, then `done`."""
    p, _ = await access(pid, me, "edit")
    v = await db.get_version(pid, vid)
    if not v:
        raise HTTPException(404, "version not found")
    capture = blobs.decode_data_url(body.image_data_url)
    extra = [blobs.decode_data_url(u) for u in (body.extra_image_data_urls or [])[:2]]

    async def gen():
        yield "stage", {"stage": "match", "message": "Comparing the 3D model with the concept, feature by feature…"}
        res = await views.match(p, v, capture, extra)
        yield "match", {"match": res}
        fresh = await db.get_version(pid, vid) or v
        prev = fresh.get("concept_match") or {}
        history = prev.get("history") or []
        history.append({"score": res.get("score"), "at": res.get("checked_at")})
        stored = {**res, "history": history[-6:]}
        before = prev.get("pre_refit")
        if not body.refit and before and (res.get("score") or 0) < (before.get("score") or 0):
            # the rebuilt facade matches the concept less well: put the earlier one back (a refit only ever helps)
            await db.patch_version(pid, vid, sections=before["sections"])
            for i, sec in enumerate(before["sections"]):
                if sec.get("layer") == "facade":
                    yield "section", {"section": sec, "index": i}
            kept = {**before["match"], "history": stored["history"],
                    "reverted": {"score": res.get("score"), "at": res.get("checked_at")}}
            await db.patch_version(pid, vid, concept_match=kept)
            yield "match", {"match": kept}
            yield "done", {"match": kept, "refit_sections": [], "reverted": True}
            return
        new_secs: list[dict] = []
        if body.refit and res.get("features") and any(f["status"] != "present" and f.get("importance") != "low" for f in res["features"]):
            yield "stage", {"stage": "match", "message": "Rebuilding the facade features that don't match yet…"}
            try:
                new_secs = await views.refit(p, fresh, res)
            except Exception:
                logging.exception("refit failed for %s/%s", pid, vid)
            if new_secs:
                stored["pre_refit"] = {"score": res.get("score"), "sections": fresh["sections"],
                                       "match": {k: val for k, val in stored.items() if k != "pre_refit"}}
                merged = reviser.merge_sections(fresh["sections"], new_secs, [])
                before_codes = {x["name"]: x["code"] for x in merged}
                jsfix.share_declarations(merged)
                new_secs = [x for x in merged if x["name"] in {n["name"] for n in new_secs} or x["code"] != before_codes[x["name"]]]
                await db.patch_version(pid, vid, sections=merged)
                for sec in new_secs:
                    idx = next(i for i, x in enumerate(merged) if x["name"] == sec["name"])
                    yield "section", {"section": sec, "index": idx}
                stored["refit"] = {"sections": [x["name"] for x in new_secs], "at": db.now()}
        await db.patch_version(pid, vid, concept_match=stored)
        yield "done", {"match": stored, "refit_sections": [x["name"] for x in new_secs]}
    return sse.stream(gen())


# --- start from the family's own drawing ---------------------------------------------------------------------------------
class DrawingBody(BaseModel):
    images: list[str]  # data URLs (PNG/JPEG/WebP), one per sheet


@app.post("/api/projects/{pid}/drawing")
async def upload_drawing(pid: str, body: DrawingBody, me: Identity = Depends(auth.identity)):
    """Read an uploaded floor plan (Gemini), derive the brief from it and keep the transcribed layout, so the design
    is built from the family's drawing."""
    p, role = await access(pid, me, "edit")
    imgs = []
    for d in body.images[:4]:
        data, mime = blobs.decode_data_url(d)
        if len(data) > 12_000_000:
            raise HTTPException(413, "That image is too large (12 MB at most).")
        imgs.append((data, mime))
    if not imgs:
        raise HTTPException(400, "no images")
    try:
        got = await importer.import_drawings(p, imgs)
    except ValueError as e:
        raise HTTPException(422, str(e))
    brief = intake.merge_brief(p.get("brief") or {}, got["brief_patch"], [], spaces_mode="union")
    for k, v in (("city", "Lahore"), ("authority", "LDA"), ("style", "Modern Contemporary"), ("water_tank", "plastic"),
                 ("solar", "ready")):
        if not brief.get(k):
            brief[k] = v
    brief["preferences"] = list(dict.fromkeys((brief.get("preferences") or []) + ["keep the layout of our own drawing"]))
    fields = {"brief": brief, "imported": got["imported"], "envelope": intake.envelope_for(brief)}
    if p.get("stage") in (None, "setup"):
        fields["stage"] = "setup"
    updated = await db.update_project(pid, **fields)
    # the setup chat hears about the drawing, so it asks only what the drawing doesn't say
    lay = got["imported"]["layout"]
    floors = [lv for lv in lay.get("levels") or [] if lv != "roof"]
    still = intake.to_ask(brief)
    text = (f"I read your drawing: {got['imported']['rooms']} rooms on {len(floors)} floor{'s' if len(floors) != 1 else ''}, "
            f"on a {lay['plot']['width_ft']:g} × {lay['plot']['depth_ft']:g} ft plot"
            + (" (I assumed that size; tell me if it's different)" if lay["plot"].get("assumed") else "")
            + ". The design will keep your layout and change only what the rules need. "
            + ("Tell me anything the drawing doesn't show, or tap Decide everything for me." if still else
               "Tap Show me concepts when you're ready."))
    try:
        await db.add_message(pid, {"role": "assistant", "text": text})
    except Exception:
        logging.exception("posting the drawing message failed")
    return public(updated, role)


# --- comments ------------------------------------------------------------------------------------------------------------
class CommentBody(BaseModel):
    version_id: str
    text: str
    anchor: dict
    camera: dict
    snapshot_data_url: str | None = None
    author_name: str | None = None


class CommentPatch(BaseModel):
    text: str | None = None
    status: str | None = None


@app.get("/api/projects/{pid}/comments")
async def list_comments(pid: str, version_id: str | None = None, me: Identity = Depends(auth.identity)):
    await access(pid, me, "view")
    return {"comments": comments_out(pid, await db.list_comments(pid, version_id), me)}


@app.post("/api/projects/{pid}/comments")
async def add_comment(pid: str, body: CommentBody, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "comment")
    if not body.text.strip():
        raise HTTPException(400, "Write a comment first.")
    c = await _new_comment(p, body.version_id, body.text, body.anchor, body.camera, body.snapshot_data_url,
                           author_of(me, role, body.author_name))
    return comment_out(pid, c, me)


@app.patch("/api/projects/{pid}/comments/{cid}")
async def patch_comment(pid: str, cid: str, body: CommentPatch, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "comment")
    c = await db.get_comment(pid, cid)
    if not c:
        raise HTTPException(404, "comment not found")
    mine = (c.get("author") or {}).get("id") in (None, me.author_id) or role == "owner"
    fields = body.model_dump(exclude_none=True)
    if "text" in fields and not mine:
        raise HTTPException(403, "You can only edit your own comments.")
    if "status" in fields:
        if fields["status"] not in ("open", "resolved", "partial", "rejected"):
            raise HTTPException(400, "Unknown status.")
        if role == "client" and not mine:
            raise HTTPException(403, "Only the owner or the team can change that.")
    return comment_out(pid, await db.update_comment(pid, cid, **fields), me)


@app.delete("/api/projects/{pid}/comments/{cid}")
async def delete_comment(pid: str, cid: str, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "comment")
    c = await db.get_comment(pid, cid)
    if c and role != "owner" and (c.get("author") or {}).get("id") not in (None, me.author_id):
        raise HTTPException(403, "You can only delete your own comments.")
    await db.delete_comment(pid, cid)
    return {"ok": True}


@app.post("/api/projects/{pid}/comments/{cid}/replies")
async def reply(pid: str, cid: str, body: ReplyBody, me: Identity = Depends(auth.identity)):
    p, role = await access(pid, me, "comment")
    return comment_out(pid, await _reply(p, cid, body, author_of(me, role, body.author_name)), me)


# --- revise (comments and/or a typed request → new version) --------------------------------------------------------------------
class ReviseBody(BaseModel):
    version_id: str
    comment_ids: list[str] | None = None
    instruction: str | None = None


async def revise_comments(pid: str, version_id: str, comment_ids: list[str] | None, instruction: str | None) -> list[dict]:
    """Which comments a revision applies. Named comments are exactly those ([] means none; any not resolved yet, on any
    version). A typed request with no comment_ids applies no comments: what the family typed is the whole ask, so a comment
    held back in the chooser stays held back. Neither (the Next pill's "Apply open comments") means every open comment on
    the version. A client's sign-off is never a change request."""
    if comment_ids is not None:
        chosen = set(comment_ids)
        comments = [c for c in await db.list_comments(pid) if c["id"] in chosen and c.get("status") != "resolved"] if chosen else []
    elif instruction:
        comments = []
    else:
        comments = [c for c in await db.list_comments(pid, version_id) if c.get("status") == "open"]
    return [c for c in comments if c.get("kind") != "approval"]


@app.post("/api/projects/{pid}/revise")
async def revise(pid: str, body: ReviseBody, me: Identity = Depends(auth.identity)):
    p, _ = await access(pid, me, "edit")
    if (run := runs.active(pid)):
        return _attach(run)
    v = await db.get_version(pid, body.version_id)
    if not v:
        raise HTTPException(404, "version not found")
    instruction = (body.instruction or "").strip() or None
    comments = await revise_comments(pid, body.version_id, body.comment_ids, instruction)
    if not comments and not instruction:
        raise HTTPException(400, "Add a comment or tell me what to change.")

    async def gen():
        try:  # agentic ADK reviser first; the single-shot reviser is the safety net (ADK writes nothing until it finishes)
            async for ev in reviser_adk.revise(p, v, comments, instruction):
                yield _out(ev)
        except Exception as e:
            logging.exception("ADK reviser failed; falling back")
            yield "stage", {"stage": "changes", "message": f"Trying a simpler route ({type(e).__name__})…"}
            async for ev in reviser.revise(p, v, comments, instruction):
                yield _out(ev)

    def _out(ev):  # the run stream reaches the team too: comment authors as handles
        return (ev[0], {**ev[1], "comment": comment_out(pid, ev[1]["comment"], me)}) if ev[0] == "comment" else ev
    return _attach(runs.start(pid, "revise", gen))


# --- AI render of the current viewport -------------------------------------------------------------------------------------
class RenderBody(BaseModel):
    image_data_url: str
    prompt: str | None = None
    version_id: str | None = None


@app.post("/api/projects/{pid}/render")
async def render(pid: str, body: RenderBody, me: Identity = Depends(auth.identity)):
    await access(pid, me, "edit")
    data, mime = blobs.decode_data_url(body.image_data_url)
    return {"url": await concepts.render_view(pid, data, mime, body.prompt)}


# --- assets (GCS proxy) ----------------------------------------------------------------------------------------------------
@app.get("/api/assets/{path:path}")
async def asset(path: str, w: int | None = None):
    """A stored image. ?w=320|640|960|1600 serves a WebP that wide (made on first request and kept): workspace cards,
    concept tiles (960) and the concept lightbox (1600)."""
    if w is not None:
        if w not in (320, 640, 960, 1600) or path.startswith("thumbs/"):
            raise HTTPException(400, "unsupported size")
        got = await blobs.thumb(path, w)
    else:
        got = await blobs.get(path)
    if not got:
        raise HTTPException(404, "not found")
    return Response(content=got[0], media_type=got[1], headers={"Cache-Control": "public, max-age=31536000, immutable"})


# --- SPA (built web app) ---------------------------------------------------------------------------------------------------
class ImmutableAssets(StaticFiles):
    """Vite's /assets files have content hashes in their names: cache them for a year, publicly (CDN and browser)."""

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


WEB_DIST = Path(os.environ.get("WEB_DIST", Path(__file__).resolve().parents[2] / "web" / "dist"))
if WEB_DIST.exists():
    if (WEB_DIST / "assets").exists():
        app.mount("/assets", ImmutableAssets(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        f = WEB_DIST / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(WEB_DIST / "index.html")
