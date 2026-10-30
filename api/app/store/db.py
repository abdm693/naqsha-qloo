"""Firestore persistence: projects and their messages, concepts, versions and comments (subcollections).

Collaboration lives on the project document:
- `owner`: a guest id or "user:<uid>";
- `members`: [{email, uid?, name?, role: "team" | "client", status: "active" | "invited", invited_at}];
- `member_uids` / `member_emails`: flat copies for array-contains queries (the workspace, invite resolution);
- `share_enabled` / `share_token`: the client link.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import time
import uuid
from functools import lru_cache
from typing import Any

from google.api_core.exceptions import AlreadyExists, Conflict
from google.cloud import firestore

from .. import config


@lru_cache(maxsize=1)
def fs() -> firestore.AsyncClient:
    return firestore.AsyncClient(project=config.PROJECT, database=config.FIRESTORE_DB)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:12]


def _p(pid: str):
    return fs().collection("projects").document(pid)


async def _query(field: str, op: str, value) -> list[dict]:
    q = fs().collection("projects").where(filter=firestore.FieldFilter(field, op, value))
    return [d.to_dict() async for d in q.stream()]


async def list_projects(owner: str) -> list[dict]:
    docs = await _query("owner", "==", owner)
    return sorted(docs, key=lambda d: d.get("updated_at", ""), reverse=True)


async def list_member_projects(uid: str) -> list[dict]:
    return await _query("member_uids", "array_contains", uid)


async def create_project(owner: str, name: str | None) -> dict:
    pid = new_id("p_")
    doc = {"id": pid, "owner": owner, "name": name or "Untitled home", "created_at": now(), "updated_at": now(),
           "stage": "setup", "brief": None, "envelope": None, "concepts": [], "selected_concept_id": None,
           "versions": [], "current_version_id": None, "thumbnail_url": None, "intake_complete": False,
           "members": [], "member_uids": [], "member_emails": [], "share_enabled": False, "share_token": None}
    await _p(pid).set(doc)
    return doc


async def get_project(pid: str) -> dict | None:
    snap = await _p(pid).get()
    return snap.to_dict() if snap.exists else None


async def update_project(pid: str, **fields: Any) -> dict:
    fields["updated_at"] = now()
    await _p(pid).update(fields)
    return await get_project(pid)  # type: ignore[return-value]


async def patch_project(pid: str, **fields: Any) -> dict:
    """Update without reading the document back (the caller merges the fields itself). Returns the written fields."""
    fields["updated_at"] = now()
    await _p(pid).update(fields)
    return fields


async def delete_project(pid: str) -> None:
    for sub in ("messages", "versions", "comments"):
        async for d in _p(pid).collection(sub).stream():
            await d.reference.delete()
    await _p(pid).delete()


# --- members, invites, sharing ----------------------------------------------------------------------------------------
def _flat(members: list[dict]) -> dict:
    return {"members": members, "member_uids": sorted({m["uid"] for m in members if m.get("uid") and m.get("status") == "active"}),
            "member_emails": sorted({m["email"] for m in members if m.get("email")})}


async def set_members(pid: str, members: list[dict]) -> dict:
    return await update_project(pid, **_flat(members))


async def resolve_invites(email: str | None, uid: str, name: str | None = None) -> int:
    """When someone signs in, every invite to their email becomes an active membership."""
    if not email:
        return 0
    n = 0
    for p in await _query("member_emails", "array_contains", email.lower()):
        members = p.get("members") or []
        changed = False
        for m in members:
            if m.get("email") == email.lower() and (m.get("status") != "active" or m.get("uid") != uid):
                m.update(status="active", uid=uid, name=m.get("name") or name, joined_at=m.get("joined_at") or now())
                changed = True
        if changed:
            await _p(p["id"]).update(_flat(members))
            n += 1
    return n


async def find_by_share_token(token: str) -> dict | None:
    if not token or len(token) < 12:
        return None
    docs = await _query("share_token", "==", token)
    return next((d for d in docs if d.get("share_enabled")), None)


def new_share_token() -> str:
    return secrets.token_urlsafe(18)


async def claim_projects(guest_id: str, owner_key: str, uid: str) -> int:
    """Move a guest's projects (and their comment authorship) to a signed-in account."""
    moved = 0
    for p in await _query("owner", "==", guest_id):
        await _p(p["id"]).update({"owner": owner_key, "claimed_from": guest_id, "updated_at": now()})
        async for d in _p(p["id"]).collection("comments").stream():
            c = d.to_dict()
            changed = False
            if (c.get("author") or {}).get("id") == guest_id:
                c["author"]["id"] = uid
                changed = True
            for r in c.get("replies") or []:
                if (r.get("author") or {}).get("id") == guest_id:
                    r["author"]["id"] = uid
                    changed = True
            if changed:
                await d.reference.set(c)
        moved += 1
    return moved


# --- messages ---------------------------------------------------------------------------------------
def make_message(msg: dict) -> dict:
    msg = {"id": new_id("m_"), "created_at": now(), "seq": time.time_ns(), **msg}
    return {k: v for k, v in msg.items() if v is not None}


async def put_message(pid: str, msg: dict) -> dict:
    await _p(pid).collection("messages").document(msg["id"]).set(msg)
    return msg


async def add_message(pid: str, msg: dict) -> dict:
    return await put_message(pid, make_message(msg))


async def list_messages(pid: str) -> list[dict]:
    docs = [d.to_dict() async for d in _p(pid).collection("messages").stream()]
    return sorted(docs, key=lambda d: (d.get("seq") or 0, d.get("created_at", ""), d.get("role") != "user")
                  if all(x.get("seq") for x in docs) else (d.get("created_at", ""), d.get("role") != "user"))


# --- versions -----------------------------------------------------------------------------------------
async def save_version(pid: str, version: dict) -> dict:
    await _p(pid).collection("versions").document(version["id"]).set(version)
    return version


async def patch_version(pid: str, vid: str, **fields: Any) -> None:
    """Set some fields on a version without rewriting the rest (a concurrent repair keeps its sections)."""
    await _p(pid).collection("versions").document(vid).update(fields)


async def get_version(pid: str, vid: str) -> dict | None:
    snap = await _p(pid).collection("versions").document(vid).get()
    return snap.to_dict() if snap.exists else None


# --- comments -----------------------------------------------------------------------------------------
async def add_comment(pid: str, comment: dict) -> dict:
    comment.setdefault("replies", [])
    await _p(pid).collection("comments").document(comment["id"]).set(comment)
    return comment


async def get_comment(pid: str, cid: str) -> dict | None:
    snap = await _p(pid).collection("comments").document(cid).get()
    return snap.to_dict() if snap.exists else None


async def list_comments(pid: str, version_id: str | None = None) -> list[dict]:
    col = _p(pid).collection("comments")
    q = col.where(filter=firestore.FieldFilter("version_id", "==", version_id)) if version_id else col
    docs = [d.to_dict() async for d in q.stream()]
    for d in docs:
        d.setdefault("replies", [])
    return sorted(docs, key=lambda d: d.get("created_at", ""))


async def update_comment(pid: str, cid: str, **fields: Any) -> dict | None:
    ref = _p(pid).collection("comments").document(cid)
    snap = await ref.get()
    if not snap.exists:
        return None
    await ref.update(fields)
    snap = await ref.get()
    d = snap.to_dict()
    d.setdefault("replies", [])
    return d


async def add_reply(pid: str, cid: str, reply: dict) -> dict | None:
    ref = _p(pid).collection("comments").document(cid)
    snap = await ref.get()
    if not snap.exists:
        return None
    await ref.update({"replies": firestore.ArrayUnion([reply])})
    d = (await ref.get()).to_dict()
    d.setdefault("replies", [])
    return d


async def delete_comment(pid: str, cid: str) -> None:
    await _p(pid).collection("comments").document(cid).delete()


async def move_open_comments(pid: str, from_vid: str, to_vid: str) -> int:
    """Carry every comment still open on `from_vid` over to `to_vid` (a newer version), keeping its anchor and thread and
    recording the version it was written on (`from_version_id`). Resolved, partial and rejected threads stay where they were
    answered. Returns how many moved."""
    if not from_vid or not to_vid or from_vid == to_vid:
        return 0
    col = _p(pid).collection("comments")
    n = 0
    async for d in col.where(filter=firestore.FieldFilter("version_id", "==", from_vid)).stream():
        c = d.to_dict() or {}
        if (c.get("status") or "open") != "open":
            continue
        await d.reference.update({"version_id": to_vid, "from_version_id": c.get("from_version_id") or from_vid,
                                  "moved_at": now()})
        n += 1
    return n


# --- samples & cloning ------------------------------------------------------------------------------
SAMPLES_OWNER = "samples"


async def _sub_ids(pid: str, sub: str) -> set[str]:
    return {d.id async for d in _p(pid).collection(sub).select([]).stream()}


SAMPLE_PREFIX = "Sample · "


def copy_base_name(src_name: str) -> str:
    """A sample copy's name: the sample's without the "Sample · " prefix (it is the family's home now)."""
    name = str(src_name or "").strip()
    return name[len(SAMPLE_PREFIX):].strip() if name.startswith(SAMPLE_PREFIX) else name or "Untitled home"


def copy_name(src_name: str, taken: set[str]) -> str:
    """The next free copy name in a workspace: "10 marla modern home", then "10 marla modern home (2)", "(3)"…"""
    base = copy_base_name(src_name)
    if base not in taken:
        return base
    n = 2
    while f"{base} ({n})" in taken:
        n += 1
    return f"{base} ({n})"


def renamed(copy: dict, src: dict) -> bool:
    """Whether the family renamed a copy: a copy keeps the name it was made with (`clone_name`); a copy made before that
    field existed carries the sample's own name."""
    name = str(copy.get("name") or "")
    if copy.get("clone_name") is not None:
        return name != copy["clone_name"]
    return name not in (str(src.get("name") or ""), copy_base_name(src.get("name")))


async def _comment_marks(pid: str) -> dict[str, tuple]:
    """Each comment's (status, number of replies, text): what a family's own review of a copy would change."""
    marks = {}
    async for d in _p(pid).collection("comments").stream():
        x = d.to_dict() or {}
        marks[d.id] = (x.get("status"), len(x.get("replies") or []), x.get("text"))
    return marks


async def untouched_copy(copy: dict, src: dict) -> bool:
    """A copy with nothing of its own: the name it was made with, the sample's concept choice and brief, no members or
    client link, and no messages, comments, replies or versions beyond the sample's."""
    if renamed(copy, src) or copy.get("brief_changed") or copy.get("members") or copy.get("share_enabled"):
        return False
    if (copy.get("selected_concept_id") or None) != (src.get("selected_concept_id") or None):
        return False
    if len(copy.get("concepts") or []) > len(src.get("concepts") or []):
        return False
    if {v.get("id") for v in copy.get("versions") or []} - {v.get("id") for v in src.get("versions") or []}:
        return False
    for sub in ("messages", "versions"):
        if await _sub_ids(copy["id"], sub) - await _sub_ids(src["id"], sub):
            return False
    mine, theirs = await _comment_marks(copy["id"]), await _comment_marks(src["id"])
    return all(theirs.get(cid) == mark for cid, mark in mine.items())


async def list_clones(owner: str, src_pid: str) -> list[dict]:
    """The copies of a project in one workspace, newest first."""
    return [p for p in await list_projects(owner) if p.get("cloned_from") == src_pid]


def stale_copy(copy: dict, src: dict) -> bool:
    """Made before the sample was last updated (so an untouched copy is refreshed with the current sample)."""
    return bool(src.get("updated_at") and (copy.get("created_at") or "") < src["updated_at"])


def clone_id(owner: str, src_pid: str, slot: int = 1) -> str:
    """The id a sample's copy gets in a workspace (slot 1, 2… for the first, second… copy), so parallel opens can't make
    two copies of the same slot."""
    key = f"{owner}:{src_pid}" + (f":{slot}" if slot > 1 else "")
    return "p_" + hashlib.sha1(key.encode()).hexdigest()[:12]


def _copy_doc(src: dict, pid: str, owner: str, name: str | None) -> dict:
    doc = {**src, "id": pid, "owner": owner, "name": name or src["name"], "created_at": now(), "updated_at": now(),
           "cloned_from": src["id"], "members": [], "member_uids": [], "member_emails": [], "share_enabled": False,
           "share_token": None, "auto_named": False, "brief_changed": False}
    if src.get("owner") == SAMPLES_OWNER:
        doc["clone_name"] = doc["name"]  # a rename makes it the family's own copy (opening the sample again makes a new one)
    return doc


async def _copy_subs(src_pid: str, pid: str) -> None:
    for sub in ("messages", "versions", "comments"):
        async for d in _p(src_pid).collection(sub).stream():
            await _p(pid).collection(sub).document(d.id).set(d.to_dict())


async def clone_project(src_pid: str, owner: str, name: str | None = None, once: bool = False, slot: int = 1) -> dict:
    """Copy a project (and its messages, versions, comments) into another workspace. Assets stay shared (read-only).
    once=True: the copy gets the deterministic clone_id for its slot and is created only if it doesn't exist yet (otherwise
    the existing copy is returned), so two parallel requests make one copy; subcollections are copied only by the request
    that created it."""
    src = await get_project(src_pid)
    if not src:
        raise KeyError(src_pid)
    pid = clone_id(owner, src_pid, slot) if once else new_id("p_")
    doc = _copy_doc(src, pid, owner, name)
    if once:
        try:
            await _p(pid).create(doc)
        except (AlreadyExists, Conflict):
            return await get_project(pid) or doc
    else:
        await _p(pid).set(doc)
    await _copy_subs(src_pid, pid)
    return doc


async def refresh_clone(pid: str, src: dict, owner: str, name: str | None = None) -> dict:
    """Replace an untouched copy's content with the current sample, in place (same id, same workspace)."""
    for sub in ("messages", "versions", "comments"):
        async for d in _p(pid).collection(sub).stream():
            await d.reference.delete()
    doc = _copy_doc(src, pid, owner, name)
    await _p(pid).set(doc)
    await _copy_subs(src["id"], pid)
    return doc


# --- researched rule packs (agents/research.py): one document per authority -------------------------------------------
async def get_rulepack(key: str) -> dict | None:
    snap = await fs().collection("rulepacks").document(key).get()
    return snap.to_dict() if snap.exists else None


async def save_rulepack(key: str, pack: dict) -> None:
    await fs().collection("rulepacks").document(key).set(pack)
