"""Revision agent on Google ADK: a tool-using architect that turns walkthrough comments (or a typed request such as "make the
kitchen bigger") into a new version.

The agent starts lean (the comments, the room list and the LDA envelope) and reads only what it needs: the rooms the comments
point at, the code sections it may change, and the SDK reference only when it writes code. Layout edits are dry-run against
the LDA engine AND Naqsha's planning rules; an edit that adds any failure the version didn't already have is refused, so a
revision can't reintroduce a bedroom opening into a bedroom or a roof door away from the stair. Tool calls stream to the
browser as plain-language progress. If ADK fails, the caller falls back to the single-shot reviser.
"""
from __future__ import annotations

import asyncio
import copy
import json
from typing import AsyncIterator, Optional

from google.adk import Agent, Runner

from google.adk.sessions import InMemorySessionService
from google.genai import types

from .. import config, llm, qloo
from ..compliance import lda
from ..gemini import RETRY
from ..store import db
from .architect import BUILD_SYSTEM, CONTRACTS, _read, prepare, taste_text
from .reviser import (ANSWER_RULES, apply_ops, comment_brief, context_text, finalize, merge_sections, new_failures, reading_line,
                      snapshot_parts, solar_text)

APP = "naqsha-reviser"

INSTRUCTION = """You are Naqsha's architect revising a house the family has walked through. Comments are pinned to a spot in
the model (room, element, level) and may come with a snapshot; a REQUEST is a change they typed without a pin
(comment_id "request").

Work quickly and in as few steps as possible, calling independent tools together in ONE step:
1. Look first: get_rooms for every room the notes point at, and read_sections for the sections you may change, together.
2. Layout changes (room sizes or positions, doors, windows, new rooms) go through check_plan_ops: a dry run against the LDA
   regulations and the livability rules (bedrooms open onto circulation, one door per bath, stairs with landings to the roof).
   Iterate until it reports ok, then apply_plan_ops. If no rule-abiding version exists, don't change the layout: resolve it as
   "rejected" or "partial", say which rule in plain words, and offer an alternative.
3. Visual changes (materials, colours, furniture, facade, lighting) use write_section with the FULL new code; call
   sdk_reference once before writing code. If a room changed size, rewrite its furnish_<room_id> section too.
   When a note asks for a feel or names something they love ("more like Istanbul", "cosier, like our favourite cafe"), call
   qloo_taste first and design that change from the tags it returns. THE FAMILY'S TASTE (when given) is their Qloo style
   brief: keep every change in that language unless the note asks otherwise.
4. Finish with ONE finish call: the list of changes and one friendly resolution (one or two sentences) per comment.
Make the smallest change that satisfies each note and keep everything else identical. The `structure` section rebuilds walls,
openings, stairs and slabs from the plan automatically; only rewrite it to change structural materials.
EARLIER ANSWERS (when listed) are what earlier comments and requests already got: keep them unless the new request conflicts;
if it does, say which one and why in the resolution. A window or room an earlier answer changed is put back automatically if
you shrink it without being asked.
""" + ANSWER_RULES + """

design.js section rules (for write_section): """ + BUILD_SYSTEM.split("Rules:")[-1]


class Workspace:
    """Mutable working copy of the version that the agent's tools operate on."""

    def __init__(self, version: dict, comments: list[dict], brief: dict):
        self.brief = brief
        self.plan = copy.deepcopy(version["plan"])
        self.sections = copy.deepcopy(version["sections"])
        self.base_report = lda.check(self.plan, brief)  # today's rules, so old versions are judged fairly
        self.report = self.base_report
        self.comments = {c["id"]: c for c in comments}
        self.resolutions: dict[str, dict] = {}
        self.changes: list[dict] = []
        self.plan_changed = False
        self.finished = False
        self.qloo: list[dict] = []  # what the taste tool looked up, shown with the revision
        self.events: list[tuple[str, dict]] = []  # SSE events produced by tools, drained by the runner loop

    def room_name(self, rid: str) -> str:
        return next((r.get("name") for r in self.plan.get("rooms", []) if r["id"] == rid), rid)

    def section_label(self, name: str) -> str:
        if name.startswith("furnish_"):
            return f"the furniture in {self.room_name(name[len('furnish_'):])}"
        if name.startswith("facade"):
            return "the facade"
        if name.startswith("interior"):
            return "the interiors"
        return {"landscape": "the garden", "lighting": "the lighting", "structure": "the structure"}.get(name, "the design")

    def _check(self, ops: list[dict]) -> tuple[dict, dict, list[dict]]:
        cand, _ = prepare(apply_ops(self.plan, ops), self.brief)
        rep = lda.check(cand, self.brief)
        return cand, rep, new_failures(self.base_report, rep)

    def tools(self):
        ws = self

        def get_rooms(room_ids: list[str]) -> dict:
            """Rooms from the plan (feet), each with the openings on its walls and its level.

            Args:
              room_ids: Room ids, e.g. ["f_master", "g_lounge"].
            """
            out = {}
            for rid in room_ids or []:
                r = next((r for r in ws.plan["rooms"] if r["id"] == rid), None)
                if not r:
                    out[rid] = {"error": "no such room"}
                    continue
                out[rid] = {"room": r, "openings": [o for o in ws.plan["openings"] if rid in o.get("between", [])]}
            names = ", ".join(ws.room_name(r) for r in room_ids or [])
            ws.events.append(("stage", {"stage": "changes", "message": f"Looking at {names}…" if names else "Looking at the plan…"}))
            return {"rooms": out, "all_room_ids": [r["id"] for r in ws.plan["rooms"]]}

        def list_sections() -> list[dict]:
            """List the design.js sections (name, layer, number of lines)."""
            return [{"name": s["name"], "layer": s["layer"], "lines": s["code"].count("\n")} for s in ws.sections]

        def read_sections(names: list[str]) -> dict:
            """Read the full code of design.js sections.

            Args:
              names: Section names, e.g. ["furnish_f_master", "facade_front"].
            """
            out = {}
            for n in names or []:
                s = next((s for s in ws.sections if s["name"] == n), None)
                out[n] = {"layer": s["layer"], "code": s["code"]} if s else {"error": "no such section"}
            return out

        def sdk_reference() -> dict:
            """The House SDK reference and engine notes. Read it once before writing any code."""
            return {"sdk": _read(CONTRACTS / "house-sdk.d.ts"), "engine_notes": _read(CONTRACTS / "engine-notes.md")}

        def check_plan_ops(ops: list[dict]) -> dict:
            """Dry-run plan edits against the LDA regulations and the livability rules, without applying them.

            Args:
              ops: Operations: {"op": "upsert", "collection": "rooms"|"openings"|"stairs"|"levels", "item": {...full object with id}},
                   {"op": "remove", "collection": ..., "id": "..."} or {"op": "set", "path": "roof.parapet_ft", "value": ...}.
            """
            ws.events.append(("stage", {"stage": "compliance", "message": "Checking the change against the bylaws and livability rules…"}))
            _, rep, broken = ws._check(ops)
            had = {c["id"] for c in ws.base_report["checks"] if c["status"] != "pass"}
            softer = [c for c in rep["checks"] if c["status"] == "warn" and c["id"] not in had]
            return {"ok": not broken, "new_problems": [f"{c['message']} Fix: {c.get('fix', '')}" for c in broken],
                    # allowed, but tell the family (or fix them): e.g. a dressing left with no wall for the wardrobe
                    "new_warnings": [f"{c['message']} Fix: {c.get('fix', '')}" for c in softer],
                    "already_there_before": len([c for c in rep["checks"] if c["status"] == "fail"]) - len(broken)}

        def apply_plan_ops(ops: list[dict]) -> dict:
            """Apply plan edits (only after check_plan_ops says ok). Same format as check_plan_ops.

            Args:
              ops: The operations to apply.
            """
            cand, rep, broken = ws._check(ops)
            if broken:
                return {"applied": False, "new_problems": [c["message"] for c in broken]}
            ws.plan, ws.report, ws.plan_changed = cand, rep, True
            ws.events += [("plan", {"plan": cand, "attempt": 1}), ("compliance", {"report": rep, "attempt": 1})]
            return {"applied": True}

        def write_section(name: str, layer: str, code: str) -> dict:
            """Add or replace a design.js section with its FULL new code.

            Args:
              name: Section name (existing to replace, or new).
              layer: One of structure, facade, interior, furniture, landscape, lighting, custom.
              code: The complete JavaScript body of the section (no // @section header).
            """
            sec = {"name": name, "layer": layer, "code": code if code.endswith("\n") else code + "\n"}
            ws.sections = merge_sections(ws.sections, [sec], [])
            idx = next(i for i, s in enumerate(ws.sections) if s["name"] == name)
            ws.events += [("stage", {"stage": "changes", "message": f"Updating {ws.section_label(name)}…"}),
                          ("section", {"section": sec, "index": idx})]
            return {"ok": True}

        def remove_section(name: str) -> dict:
            """Remove a design.js section.

            Args:
              name: Section name.
            """
            ws.sections = [s for s in ws.sections if s["name"] != name]
            return {"ok": True}

        def finish(changes: list[dict], resolutions: list[dict]) -> dict:
            """Finish the revision: the changes made and one resolution per comment (and for the request).

            Args:
              changes: [{"summary": "Enlarged the master bedroom window to 10 ft", "kind": "plan"|"section",
                         "targets": ["f_master_w1"], "comment_ids": ["..."]}]
              resolutions: [{"comment_id": "...", "status": "resolved"|"partial"|"rejected",
                             "resolution": "One or two friendly sentences for the family."}]
            """
            ws.changes = [{"id": f"ch{i + 1}", "summary": c.get("summary", ""), "kind": c.get("kind", "section"),
                           "targets": c.get("targets") or [], "comment_ids": c.get("comment_ids") or []}
                          for i, c in enumerate(changes or [])]
            for r in resolutions or []:
                if r.get("comment_id"):
                    ws.resolutions[r["comment_id"]] = {"status": r.get("status") if r.get("status") in ("resolved", "partial", "rejected")
                                                       else "partial", "resolution": r.get("resolution") or ""}
            missing = [c for c in ws.comments if c not in ws.resolutions]
            if missing:
                return {"ok": False, "resolve_these_too": missing}
            ws.finished = True
            return {"ok": True}

        async def qloo_taste(name: str, kind: Optional[str] = None) -> dict:
            """Ask Qloo's taste graph what something the family names feels like, when a note asks for a feel ("more like
            Istanbul", "like a Wes Anderson film", "cosier, like our favourite cafe"). Use the tags it returns as the
            design language for that change, and mention them in the resolution.

            Args:
              name: What they named: a place, film, show, artist, restaurant or brand.
              kind: film, show, artist, book, destination, restaurant or brand, if clear.
            """
            try:
                hits = await qloo.search(name, kind, take=1)
                if not hits:
                    return {"found": False}
                e = hits[0]
                feel = await qloo.taste_tags([e["id"]], qloo.FEEL_TAGS, take=10)
                tags = await qloo.taste_tags([e["id"]], take=10)
                ws.qloo.append({"name": e["name"], "tags": [t["name"] for t in feel + tags][:12]})
                return {"found": True, "name": e["name"], "type": e.get("type"), "own_tags": [t["name"] for t in e.get("tags") or []][:12],
                        "feel_tags": [t["name"] for t in feel], "taste_tags": [t["name"] for t in tags]}
            except qloo.QlooError as err:
                return {"found": False, "error": str(err)[:160]}

        return [get_rooms, list_sections, read_sections, sdk_reference, check_plan_ops, apply_plan_ops, write_section,
                remove_section, qloo_taste, finish]


STALL_S = 600.0  # one agent step (a model call plus its tools) that takes longer than this has stalled


async def stall_guard(events, stall_s: float = STALL_S):
    """Yield from an async iterator, raising TimeoutError when a single step takes longer than stall_s: a model call that never
    answers would otherwise leave the revision "Checking the change…" forever (seen: a revise waiting 30 min on one call).
    The caller then falls back to the single-shot reviser."""
    it = events.__aiter__()
    try:
        while True:
            try:
                ev = await asyncio.wait_for(it.__anext__(), stall_s)
            except StopAsyncIteration:
                return
            yield ev
    finally:
        try:
            await it.aclose()
        except Exception:  # already closed, or still unwinding the cancelled step
            pass


async def revise(project: dict, version: dict, comments: list[dict], instruction: str | None = None) -> AsyncIterator[tuple[str, dict]]:
    pid = project["id"]
    brief = project.get("brief") or {}
    await db.update_project(pid, stage="revising")
    yield "stage", {"stage": "changes", "message": reading_line(comments, instruction)}
    targets = list(comments) + ([{"id": "request", "text": instruction, "anchor": {}}] if instruction else [])
    ws = Workspace(version, targets, brief)
    agent = Agent(name="reviser", model=llm.adk_model(config.MODEL_ARCHITECT), instruction=INSTRUCTION,
                  tools=ws.tools(), generate_content_config=types.GenerateContentConfig(max_output_tokens=32768))
    sessions = InMemorySessionService()
    runner = Runner(app_name=APP, agent=agent, session_service=sessions)
    session = await sessions.create_session(app_name=APP, user_id=pid)

    parts = await snapshot_parts(comments)
    env = lda.envelope(brief["plot"]["width_ft"], brief["plot"]["depth_ft"], brief.get("authority") or "LDA") if brief.get("plot") else {}
    env.pop("_band", None)
    auth = brief.get("authority") or "LDA"
    name = (brief.get("rules_pack") or {}).get("name") or auth
    text = (f"THE BYLAWS HERE ARE {name}'s ({auth}); when a rule blocks a request, name {auth}, never another authority.\n"
            f"{auth} ENVELOPE: {json.dumps({k: env.get(k) for k in ('setbacks_ft', 'max_coverage_pct', 'max_height_ft', 'max_storeys', 'buildable_rect')})}\n"
            f"BRIEF: {json.dumps({k: brief.get(k) for k in ('storeys', 'bedrooms', 'floors', 'preferences', 'style', 'water_tank', 'solar') if brief.get(k)})}\n"
            + (f"THE FAMILY'S TASTE (Qloo style brief): {taste_text((project.get('taste') or {}).get('style'))}\n"
               if (project.get("taste") or {}).get("style") else "")
            + f"ROOMS: {json.dumps([{k: r[k] for k in ('id', 'name', 'type', 'level', 'rect')} for r in ws.plan['rooms']], separators=(',', ':'))}\n"
            f"SECTIONS: {', '.join(s['name'] for s in ws.sections)}\n"
            + solar_text(ws.plan) + "\n" + await context_text(pid, version)
            + (f"WALKTHROUGH COMMENTS:\n{json.dumps(comment_brief(comments), indent=1)}\n\n" if comments else "")
            + (f"REQUEST (comment_id \"request\"): {instruction}\n\n" if instruction else "")
            + "Revise the design now.")
    seen = await llm.describe_images(parts, "These are snapshots the family took in the 3D walkthrough, one per comment, in "
                                     "order. For each, say in one or two sentences what part of the house it shows.")
    if seen:
        text = f"WHAT THE COMMENT SNAPSHOTS SHOW:\n{seen}\n\n" + text
    msg = types.Content(role="user", parts=[types.Part.from_text(text=text)])

    async for event in stall_guard(runner.run_async(user_id=pid, session_id=session.id, new_message=msg)):
        while ws.events:
            yield ws.events.pop(0)
        if ws.finished:
            break
    while ws.events:
        yield ws.events.pop(0)
    if not ws.finished and not ws.changes and not ws.resolutions:
        raise RuntimeError("the revision agent stopped without finishing")
    report = ws.report if ws.plan_changed else ws.base_report
    async for ev in finalize(project, version, ws.plan, ws.sections, report, ws.changes, ws.resolutions, comments, instruction, "adk"):
        yield ev
