"""Photographs of the house as built, from several angles, and the check that the 3D model matches the chosen concept.

Photos: the browser captures the 3D model from fixed cameras (from the road, the street corner, above the garden, high
above) and the image model turns each capture into a photograph, keeping the geometry and the camera exactly and taking the
materials and colours from the chosen concept. Because each photo starts from the model, every angle shows the same house,
the one on the plan.

Match: Gemini 3.8 Flash compares the 3D model's front view with the concept image, feature by feature (the concept's
build specification). Features that are missing or wrong go back to Gemini 4 Argon, which rewrites only the facade sections
that should carry them; the browser rebuilds those sections and the check can run again.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from google.genai import types

from .. import config, llm
from ..store import blobs, db
from . import concepts

log = logging.getLogger("naqsha.views")

ANGLES = {
    "front": "from the road in front of the house, at eye level",
    "corner": "from the street, a three-quarter view",
    "garden": "from above the front garden, looking at the entrance",
    "aerial": "a high aerial view of the house and its plot",
    "interior": "inside the house",
}


def photo_prompt(angle: str, has_concept: bool) -> str:
    where = ANGLES.get(angle, "")
    return ("Turn this 3D architectural model view into a photorealistic photograph "
            f"({where}). This is an image-to-image edit of the FIRST image: the output must line up with it pixel for pixel. "
            "Keep the camera exactly where it is: the same height, angle, viewpoint, lens and framing, with the house in the "
            "same place and at the same size in the frame (an aerial view stays high and steep; a raised view stays raised). "
            "Keep EXACTLY the same building geometry, storeys, openings, balconies, porch and roof features: this is the real "
            "design and nothing may move, appear or disappear. "
            + ("Take the materials, colours, textures and detailing from the attached concept photograph of the same house. "
               if has_concept else "Upgrade materials to realistic ones of the same colours. ")
            + "Real-world lighting, soft shadows, realistic glass reflections, planting and sky. Neighbouring houses stay plain "
            "and muted. No people, no text, no numbers, no signs, no watermarks.")


async def _concept_image(project: dict) -> tuple[bytes, str] | None:
    cid = project.get("selected_concept_id")
    c = next((c for c in project.get("concepts") or [] if c["id"] == cid), None)
    if not c:
        return None
    return await blobs.get(c["url"].removeprefix("/api/assets/"))


async def photos(project: dict, version: dict, shots: list[dict]) -> AsyncIterator[tuple[str, dict]]:
    """shots: [{angle, image_data_url}] -> ("view", {index, view}) per photo, saved on the version as `views`."""
    pid, vid = project["id"], version["id"]
    ref = await _concept_image(project)
    sem = asyncio.Semaphore(4)

    async def one(i: int, shot: dict):
        async with sem:
            try:
                data, mime = blobs.decode_data_url(shot["image_data_url"])
                src = await blobs.put(f"projects/{pid}/views/{vid}-{shot['angle']}-model.jpg", data, mime)
                contents: list = ["3D model view (the geometry to keep):", types.Part.from_bytes(data=data, mime_type=mime)]
                if ref:
                    contents += ["Concept photograph of the same house (materials and colours):",
                                 types.Part.from_bytes(data=ref[0], mime_type=ref[1])]
                contents.append(photo_prompt(shot["angle"], bool(ref)))
                resp = await concepts._image_call(contents, aspect="16:9")
                got = concepts._image_bytes(resp)
                if not got:
                    raise RuntimeError("no image")
                url = await blobs.put(f"projects/{pid}/views/{vid}-{shot['angle']}-{db.new_id('')}.png", got[0], got[1])
                return i, {"angle": shot["angle"], "label": shot.get("label") or shot["angle"].title(), "url": url,
                           "model_url": src, "model": getattr(resp, "_naqsha_model", config.MODEL_IMAGE), "created_at": db.now()}, None
            except Exception as e:
                log.exception("photo %s failed", shot.get("angle"))
                return i, None, str(e)

    tasks = [asyncio.create_task(one(i, s)) for i, s in enumerate(shots)]
    made: list[dict] = []
    order = list(ANGLES)
    views: list[dict] = []
    for fut in asyncio.as_completed(tasks):
        i, view, err = await fut
        if view:
            made.append(view)
            # saved as each one lands, so a slow angle never costs the others
            fresh = await db.get_version(pid, vid) or version
            keep = [v for v in fresh.get("views") or [] if v["angle"] != view["angle"]]
            views = sorted(keep + [view], key=lambda v: order.index(v["angle"]) if v["angle"] in order else 99)
            await db.patch_version(pid, vid, views=views)
            yield "view", {"index": i, "view": view}
        else:
            yield "view.failed", {"index": i, "message": "This angle didn't come through. Try again in a moment."}
    style = (project.get("taste") or {}).get("style")
    front_view = next((v for v in made if v["angle"] in ("front", "corner")), None)
    if style and front_view:  # measured impact on the built house: the taste checklist against its photograph
        from . import taste as taste_agent
        got = await blobs.get(front_view["url"].removeprefix("/api/assets/"))
        f = await taste_agent.fit(got, style) if got else None
        if f:
            f["angle"] = front_view["angle"]
            await db.patch_version(pid, vid, taste_fit=f)
            await db.patch_project(pid, house_taste_fit={**f, "version_id": vid})
            yield "taste_fit", {"version_id": vid, "fit": f}
    if made:
        if not project.get("thumbnail_url") or project.get("thumbnail_url") == (await _first_concept_url(project)):
            front = next((v for v in views if v["angle"] == "front"), views[0])
            await db.update_project(pid, thumbnail_url=front["url"])
    yield "done", {"count": len(made)}


async def _first_concept_url(project: dict) -> str | None:
    cs = project.get("concepts") or []
    return cs[0]["url"] if cs else None


MATCH_ASK = """The first image is the exterior concept the family chose (a photograph-like render). The other images are the 3D
model built for them, from the road and from the street corner. The 3D model is a simplified real-time model with flat
materials: judge whether each element EXISTS in the right place with roughly the right material and colour, never its
photographic realism, texture detail or lighting. Look at every model image before calling anything missing; an element
seen in any of them counts. Ignore the neighbouring houses, the street and the sky in all images.
Check the 3D model against the concept, feature by feature, using this list of the concept's features:
{features}
For each feature say whether the 3D model has it: "present" (there, in about the right place, material and colour close),
"partial" (there but clearly different in place, size, material or colour) or "missing" (not in any model image).
Return JSON: {{"features": [{{"id": "F1", "status": "present" | "partial" | "missing", "note": "<what differs, one short
sentence>"}}], "summary": "<one sentence>"}}"""


async def match(project: dict, version: dict, capture: tuple[bytes, str], extra: list[tuple[bytes, str]] | None = None) -> dict:
    """Compare the 3D model's front view with the concept: {score, features: [{id, what, status, note}], summary}."""
    c = next((c for c in project.get("concepts") or [] if c["id"] == project.get("selected_concept_id")), None)
    if not c:
        return {"score": None, "features": [], "summary": "No concept was chosen for this house."}
    spec = await concepts.spec_of(project["id"], c)
    ref = await blobs.get(c["url"].removeprefix("/api/assets/"))
    if not spec or not ref:
        return {"score": None, "features": [], "summary": "The concept couldn't be read."}
    feats = spec.get("features") or []
    listing = "\n".join(f"- {f['id']}: {f['what']} ({f.get('where', '')}; {f.get('material', '')} {f.get('colour', '')})" for f in feats)
    shots = [capture] + list(extra or [])
    text = await llm.generate_text(config.MODEL_VISION, [types.Part.from_bytes(data=ref[0], mime_type=ref[1])]
                                   + [types.Part.from_bytes(data=d, mime_type=m) for d, m in shots]
                                   + [MATCH_ASK.format(features=listing)], max_tokens=4000, json_mode=True, thinking=False,
                                   temperature=0)
    out = llm.parse_json(text)
    by = {str(f.get("id")): f for f in out.get("features") or [] if isinstance(f, dict)}
    rows = []
    for f in feats:
        got = by.get(f["id"]) or {}
        st = got.get("status") if got.get("status") in ("present", "partial", "missing") else "partial"
        rows.append({"id": f["id"], "what": f["what"], "where": f.get("where"), "importance": f.get("importance", "medium"),
                     "status": st, "note": str(got.get("note") or "")[:200]})
    pts = sum(1.0 if r["status"] == "present" else 0.5 if r["status"] == "partial" else 0 for r in rows)
    score = round(100 * pts / len(rows)) if rows else None
    return {"score": score, "features": rows, "summary": str(out.get("summary") or ""), "checked_at": db.now(),
            "model": config.MODEL_VISION}


REFIT_SYSTEM = """You are Naqsha's 3D design engineer. The family's 3D model is missing features of the exterior concept they
chose. Rewrite ONLY the facade sections needed so the model shows every listed feature in its place, material and colour.
Output format: plain text, one or more sections, each exactly:
// @section <name> [facade]
<JavaScript statements using `s` (the HouseSDK) and `THREE`>
// @end
The rooms, storeys, porch, stair tower and roof come from the plan and are built by the structure section: never redraw
them here. Add what sits ON them: cladding, colour, fins, screens, railings, canopies, frames, lights, gate and wall
finishes. When you replace a section, keep everything in it that already matched and change only what the list names.
Reuse an existing section's name to replace it, or use a new facade_<part> name to add one. The first line of each section is
a comment naming the features it builds (e.g. `// builds F2, F5`). Only use APIs in the SDK reference. Keep each section under
about 60 lines. Never use fetch, XMLHttpRequest, WebSocket, import(), eval, Function, document, window or storage."""


async def refit(project: dict, version: dict, result: dict) -> list[dict]:
    """New facade sections for the features the match found missing or partial (Gemini 4 Argon). [] when nothing to do."""
    from .architect import CONTRACTS, SectionStream, _read
    todo = [f for f in result.get("features") or [] if f["status"] != "present" and f.get("importance") != "low"]
    if not todo:
        return []
    c = next((c for c in project.get("concepts") or [] if c["id"] == project.get("selected_concept_id")), None)
    spec = (c or {}).get("spec") or {}
    facade = [s for s in version.get("sections") or [] if s.get("layer") == "facade"]
    prompt = (f"HOUSE SDK REFERENCE:\n{_read(CONTRACTS / 'house-sdk.d.ts')}\n\n"
              f"ENGINE NOTES:\n{_read(CONTRACTS / 'engine-notes.md')}\n\n"
              f"THE PLAN (feet):\n{json.dumps(version['plan'])}\n\n"
              f"CONCEPT SPECIFICATION:\n{concepts.spec_text(spec)}\n\n"
              "CURRENT FACADE SECTIONS:\n" + "\n".join(f"// @section {s['name']} [facade]\n{s['code']}// @end" for s in facade)
              + "\n\nFEATURES TO FIX (from comparing the 3D model with the concept):\n"
              + "\n".join(f"- {f['id']} [{f['status']}] {f['what']} ({f.get('where') or ''}): {f['note']}" for f in todo)
              + "\n\nWrite the replacement and new facade sections now.")
    text = await llm.generate_text(config.MODEL_ARCHITECT, prompt, system=REFIT_SYSTEM, max_tokens=24000, thinking=True)
    p = SectionStream()
    p.feed(text or "")
    p.flush()
    return [{**s, "layer": "facade"} for s in p.done if s["code"].strip()]
