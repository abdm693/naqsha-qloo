"""Concept images: four photoreal exterior concepts from the brief (in parallel), remixes, night versions and viewport renders.

The four are genuinely different design takes within the chosen style (massing and materials), all shot with the SAME camera
and light (straight-on front elevation at golden hour; a corner plot uses one fixed corner three-quarter view), so the family
compares houses, not photographs. Night versions are edits of each day image with the same camera.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from typing import AsyncIterator

from google.genai import types

from .. import busy, config, llm
from ..gemini import client
from ..store import blobs, db

log = logging.getLogger("naqsha.concepts")

CAMERA_MIDROW = ("Camera: straight-on front elevation from across the road at eye level, 35mm lens, the whole house and its "
                 "boundary wall in frame, centred, the neighbouring houses filling the left and right edges of the frame; no "
                 "street, lane or open ground visible beside the house; never a corner or three-quarter view. Light: golden hour, "
                 "low warm sun from the side, soft long shadows, clear sky.")
CAMERA_CORNER = ("Camera: three-quarter view from the street corner at eye level, 24mm lens, both road-facing facades in frame. "
                 "Light: golden hour, low warm sun, soft long shadows, clear sky.")

STYLE_HINTS = {
    "Modern Contemporary": "crisp white plaster volumes, grey stone cladding, vertical teak fins, black aluminium frames, cantilevered canopy",
    "Spanish": "white stucco walls, terracotta clay roof tiles, arched windows and porch arches, wrought-iron railings, wooden doors",
    "Classic": "symmetrical facade, cornices and mouldings, tall entrance columns, cream paint, balustrades",
    "Minimalist": "pure white cubic volumes, flush glazing, hidden frames, a single wood accent, very clean lines",
    "Mediterranean": "warm sand-coloured render, arched loggia, terracotta details, stone accents, bougainvillea",
    "Mughal Revival": "red sandstone-look cladding with white marble accents, cusped arches, jharokha balconies, jaali screens",
    "Industrial": "exposed brick, dark steel frames, concrete bands, large factory-style glazing",
}

# Fallback takes when the quick model call isn't available: four distinct directions per style family.
FALLBACK_TAKES = [
    {"title": "Stone and teak", "direction": "A white upper box floating over a grey stone base, with teak fins"},
    {"title": "Brick and jaali", "direction": "Warm exposed brick with a full-height brick jaali over the stair and balcony"},
    {"title": "Stepped terraces", "direction": "Stepped storeys with a planted terrace over the porch and slim black railings"},
    {"title": "Courtyard screen", "direction": "A perforated metal screen wraps the first floor over a recessed glass entrance"},
]

TAKES_SYSTEM = """You are a Lahore architect proposing four genuinely different exterior design directions for one house, all within
the family's chosen style. Vary the massing and the material palette (not the camera or the light): e.g. a floating upper box, a
brick-and-jaali screen, stepped terraces, a courtyard screen. Each must be buildable on the plot and respect the brief (storeys,
porch, roof). Never add minarets, domes, chhatris or cupolas unless the brief asks for them.
Write for a family, not an architect: plain words in British English (aluminium, colour, storey). The direction is ONE sentence
of at most 14 words. Avoid trade jargon and these words: "board-formed", "louvers" (say "slatted screens"), "aluminum" (say
"aluminium"), "vigas" (say "timber beams"), and "corner" (a mid-row house has no corner to design).
Return JSON: {"takes": [{"title": "<2-3 word name, e.g. Stone and teak>", "direction": "<one plain sentence, at most 14 words:
massing and materials>"}] } with exactly four takes."""

# Words families don't use (or a mid-row house doesn't have), replaced if a take still carries them.
PLAIN_WORDS = [(r"\bboard[- ]formed concrete\b", "textured concrete"), (r"\bboard[- ]formed\b", "textured"),
               (r"\blouv(?:er|re)s\b", "slatted screens"), (r"\blouv(?:er|re)d\b", "slatted"), (r"\blouv(?:er|re)\b", "slatted screen"),
               (r"\baluminum\b", "aluminium"), (r"\bvigas\b", "timber beams"), (r"\bviga\b", "timber beam"),
               (r"\bwrap-?around corner\b", "wide"), (r"\bcorner (mass|volume|block|tower)\b", r"end \1"),
               (r"\bcorner window(s?)\b", r"wide window\1"), (r"\bcorners?\b", "edge"), (r"\bcolor\b", "colour")]
DIRECTION_WORDS = 14


def plain_take(take: dict) -> dict:
    """A take in plain British English, its direction one sentence of at most 14 words."""
    def fix(text: str) -> str:
        for pat, rep in PLAIN_WORDS:
            text = re.sub(pat, rep, text, flags=re.I)
        return re.sub(r"\s+", " ", text).strip()
    words = fix(str(take.get("direction") or "")).rstrip(".").split(" ")
    if len(words) > DIRECTION_WORDS:
        # cut at the last clause break that keeps it whole ("…, " / " and " / " with "), else at 14 words
        breaks = [i for i in range(6, DIRECTION_WORDS + 1)
                  if words[i - 1].endswith((",", ";")) or (i < len(words) and words[i].lower() in ("and", "with", "under", "behind"))]
        words = words[:breaks[-1]] if breaks else words[:DIRECTION_WORDS]
        while words and words[-1].lower().strip(",;") in ("and", "with", "a", "an", "the", "of", "over", "in", "on", "to", "for"):
            words.pop()
    direction = " ".join(words).rstrip(",;:")
    return {**take, "title": fix(str(take.get("title") or "")), "direction": direction[:1].upper() + direction[1:]}


def _site_sentence(brief: dict) -> str:
    p = brief.get("plot") or {}
    if p.get("corner"):
        return ("It is a CORNER plot: two road-facing facades, both designed with care, a side road running along one side.")
    return ("It is a MID-ROW plot (NOT a corner): neighbouring houses stand directly against both side walls, there is no side "
            "street and no visible side facade; only the front facade faces the single road in front. Show the two neighbouring "
            "houses at the left and right edges of the frame, touching this house's side walls (plain, muted, no gap, no side "
            "lawn, no side road), so it clearly reads as a house in a row.")


def _roof_sentence(brief: dict) -> str:
    parts = ["Flat roof with a parapet and a compact stair tower (mumty)"]
    solar = brief.get("solar") or "ready"
    if solar == "panels":
        parts.append("rows of solar panels on a raised steel frame over the roof")
    else:
        parts.append("the roof otherwise clean and clear (no domes, minarets, chhatris or pergolas)")
    tank = brief.get("water_tank")
    if tank == "plastic":
        parts.append("a small blue plastic water tank on top of the stair tower")
    elif tank == "concrete":
        parts.append("no visible water tank")
    return ", ".join(parts) + "."


def taste_language(style: dict | None) -> str:
    """The family's exterior from their Qloo style brief, as image-model words (materials, palette, details)."""
    ext = (style or {}).get("exterior") or {}
    bits = [", ".join(ext.get("materials") or []), ", ".join(c.get("name", "") for c in ext.get("palette") or [] if isinstance(c, dict)),
            "; ".join(ext.get("details") or [])]
    return "; ".join(b for b in bits if b)


def concept_prompt(brief: dict, take: dict | None = None, instruction: str | None = None, taste: dict | None = None) -> str:
    p = brief.get("plot") or {}
    style = brief.get("style") or "Modern Contemporary"
    hints = taste_language(taste) or STYLE_HINTS.get(style, brief.get("style_notes") or "")
    storeys = {1: "single-storey", 2: "double-storey", 3: "triple-storey"}.get(brief.get("storeys") or 2, "double-storey")
    where = brief.get("scheme") or {"DHA": "DHA Lahore", "BAHRIA": "Bahria Town Lahore"}.get(brief.get("authority"), "a Lahore housing society")
    porch = next((s for s in brief.get("spaces", []) if s.startswith("car_porch")), "car_porch:1")
    cars = porch.split(":")[1] if ":" in porch else "1"
    direction = f" This design's direction: {take['direction']}." if take else ""
    extra = f" Additional direction: {instruction}." if instruction else ""
    camera = CAMERA_CORNER if p.get("corner") else CAMERA_MIDROW
    width = p.get("width_ft", 35)
    row = "" if p.get("corner") else ", one house in a continuous row of houses (a mid-row plot),"
    return (
        f"Photorealistic architectural photograph of a {style} {storeys} family house{row} on a {width:g} ft wide plot in {where}, "
        f"Pakistan. Style language: {hints}.{direction} Typical Lahore layout: boundary wall with a sliding gate, a "
        f"{cars}-car porch within the building line, a small front lawn. {_roof_sentence(brief)} {_site_sentence(brief)} "
        f"{camera} High-end real-estate photography, realistic materials and proportions. No people. Absolutely no text, "
        f"numbers, signs, house plaques or watermarks anywhere in the image.{extra}"
    )


async def design_takes(brief: dict, n: int = 4, instruction: str | None = None) -> list[dict]:
    """Four distinct design directions within the style (quick model call, with a fallback)."""
    ask = {k: brief.get(k) for k in ("style", "style_notes", "storeys", "plot", "spaces", "solar", "water_tank", "preferences", "budget")
           if brief.get(k) not in (None, "", [], {})}
    try:
        out = None
        async for kind, val in llm.stream_json(config.MODEL_INTAKE, f"BRIEF: {json.dumps(ask)}\n"
                                               + (f"FAMILY'S DIRECTION: {instruction}\n" if instruction else "")
                                               + "Propose the four directions.", TAKES_SYSTEM, max_tokens=1200, attempts=1,
                                               thinking="LOW"):
            if kind == "result":
                out = val[0]
        takes = [plain_take(t) for t in (out or {}).get("takes", []) if isinstance(t, dict) and t.get("title") and t.get("direction")]
        if len(takes) >= n:
            return takes[:n]
    except Exception:
        log.exception("design takes failed; using the fallback set")
    return FALLBACK_TAKES[:n]


IMAGE_MODELS = [m for m in dict.fromkeys([config.MODEL_IMAGE] + [x.strip() for x in config.MODEL_IMAGE_FALLBACKS.split(",") if x.strip()])]
IMAGE_TIMEOUT_S = 90.0  # a call that hangs moves on to the next model
_NO_RETRY = types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1))  # fail fast; we fall back to another model


async def _image_call(contents, aspect: str | None = "16:9"):
    """Image generation with a model fallback chain. A 429 on one model moves straight to the next (each has its own
    quota) instead of waiting out a long back-off; only when every model is busy do we back off and go round again."""
    last: Exception | None = None
    for rnd in range(4):
        for model in IMAGE_MODELS:
            try:
                cfg = types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"], http_options=_NO_RETRY,
                                                  image_config=types.ImageConfig(aspect_ratio=aspect) if aspect else None)
                resp = await asyncio.wait_for(client().aio.models.generate_content(model=model, contents=contents, config=cfg),
                                              timeout=IMAGE_TIMEOUT_S)
                resp._naqsha_model = model  # type: ignore[attr-defined]
                return resp
            except Exception as e:
                last = e
                if not isinstance(e, asyncio.TimeoutError) and not any(
                        t in str(e) for t in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE", "404", "NOT_FOUND")):
                    raise
        wait = 4 * 2 ** rnd + random.random() * 2
        busy.notify(wait, "429")
        await asyncio.sleep(wait)
    raise last or RuntimeError("image models unavailable")


def _image_bytes(resp) -> tuple[bytes, str] | None:
    for part in (resp.candidates[0].content.parts if resp and resp.candidates else []) or []:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data, part.inline_data.mime_type or "image/png"
    return None


SIDE_ROAD_ASK = ("This photo should show a house in a row: one road in front of it and neighbouring houses on both sides. Is "
                 "there clearly a SECOND road or street (a paved carriageway with a kerb) running along the left or right side "
                 "of this house, or the front road curving away round the side of its plot, so that it looks like a corner "
                 "plot? The road in front, pavements, the neighbours' walls, boundary walls and small gaps between buildings do "
                 "not count. Answer true only if such a side road is clearly visible. Return JSON: {\"side_road\": true | false}")
SIDE_ROAD_S = 25.0  # the check never holds a concept up longer than this; on a timeout or an error it is skipped
SIDE_ROAD_FIX = ("Edit this photograph: this house stands mid-row. Replace any road, street, lane, side lawn or open gap beside "
                 "the house (to its left or right) with the neighbouring houses, plain and muted, built right up against this "
                 "house's side walls. Keep this house, its boundary wall, the road in front, the camera, the light and the "
                 "framing exactly the same. Photorealistic. No people, no text, numbers or signs.")


async def side_road(image: tuple[bytes, str]) -> bool | None:
    """A quick look (the setup model, image in, yes/no out) at a mid-row day image: does a road or street run beside the
    house? None when the check couldn't run (the concept is kept as it is)."""
    try:
        text = await asyncio.wait_for(llm.generate_text(
            config.MODEL_VISION, [types.Part.from_bytes(data=image[0], mime_type=image[1]), SIDE_ROAD_ASK], max_tokens=600,
            json_mode=True, thinking=False), SIDE_ROAD_S)
        if (m := re.search(r'"side_road"\s*:\s*(true|false)', text)):
            return m.group(1) == "true"
        return bool(llm.parse_json(text).get("side_road"))
    except Exception as e:
        log.warning("mid-row check skipped: %s", e)
        return None


FROM_DESIGN = ("THE ATTACHED DRAWINGS ARE THIS HOUSE'S ACTUAL DESIGN. Draw exactly this house: the same number of storeys, the "
               "same footprint and width on the plot, the car porch on the same side, every front window and door where the "
               "elevation shows it (same count, sizes and positions), the balconies, the stair tower and tank where they are on "
               "the roof. Only the materials, colours and detailing come from the style direction. The drawings are "
               "references: never show the drawings, labels or dimension text in the photograph.")


async def design_refs(project: dict) -> list[tuple[str, bytes, str]]:
    """What the concepts are drawn FROM, when the house is already designed: the front elevation and ground floor drawn from
    the current version's plan, else the family's uploaded drawing. [(label, bytes, mime)]"""
    from . import drawing
    vid = project.get("current_version_id")
    if vid:
        try:
            v = await db.get_version(project["id"], vid)
            plan = (v or {}).get("plan")
            if plan:
                refs = [("Front elevation of the designed house (as seen from the road):", drawing.render_front_elevation(plan), "image/png")]
                ground = next(((lid, png) for lid, _, png in drawing.render_all(plan) if lid == "ground"), None)
                if ground:
                    refs.append(("Ground floor plan (road at the bottom):", ground[1], "image/png"))
                return refs
        except Exception:
            log.exception("drawing the design for the concepts failed")
    imp = project.get("imported") or {}
    refs = []
    for url in (imp.get("images") or [])[:2]:
        got = await blobs.get(url.removeprefix("/api/assets/"))
        if got:
            refs.append(("The family's own floor plan drawing:", got[0], got[1]))
    return refs


async def _generate_one(pid: str, prompt: str, ref: tuple[bytes, str] | None = None, site: str | None = None,
                        refs: list[tuple[str, bytes, str]] | None = None) -> dict:
    """One concept image. `site` (mid-row plots): after the day image a quick vision check asks whether a road runs beside
    the house; if it does, the image is made once more with the site sentence repeated (logged). `refs`: the design's
    drawings, so the photograph shows the house as designed."""
    contents: list = [prompt]
    if ref:
        contents = [types.Part.from_bytes(data=ref[0], mime_type=ref[1]), prompt]
    elif refs:
        contents = [x for label, data, mime in refs for x in (label, types.Part.from_bytes(data=data, mime_type=mime))]
        contents.append(f"{FROM_DESIGN}\n\n{prompt}")
    resp = await _image_call(contents)
    got = _image_bytes(resp)
    if not got:
        raise RuntimeError("The image model returned no image")
    check = None
    if site:
        t0 = time.monotonic()
        beside = await side_road(got)
        check = {"side_road": beside, "regenerated": False}
        if beside:  # made once more as an edit of this image (same house and camera), the site sentence repeated
            retry = await _image_call([types.Part.from_bytes(data=got[0], mime_type=got[1]), f"{SIDE_ROAD_FIX} {site}"],
                                      aspect=None)
            if (got2 := _image_bytes(retry)):
                resp, got = retry, got2
                check["regenerated"] = True
        check["seconds"] = round(time.monotonic() - t0, 1)
        log.info("mid-row check for %s: side road %s, regenerated %s, +%.1fs", pid, beside, check["regenerated"], check["seconds"])
    cid = db.new_id("c_")
    url = await blobs.put(f"projects/{pid}/concepts/{cid}.png", got[0], got[1])
    out = {"id": cid, "url": url, "prompt": prompt, "model": getattr(resp, "_naqsha_model", config.MODEL_IMAGE), "created_at": db.now()}
    if check:
        out["midrow_check"] = check
    return out


async def generate(project: dict, count: int = 4, instruction: str | None = None, base_id: str | None = None) -> AsyncIterator[tuple[str, dict]]:
    pid, brief = project["id"], project.get("brief") or {}
    base = next((c for c in project.get("concepts", []) if c["id"] == base_id), None) if base_id else None
    ref = None
    if base:
        got = await blobs.get(base["url"].removeprefix("/api/assets/"))
        ref = got if got else None
    jobs: list[tuple[str, dict | None]] = []
    if base:
        for i in range(count):
            jobs.append((f"Edit this house design photo: {instruction or 'refine it'}. Keep the same house, plot, camera, light and "
                         f"composition; change only what the instruction asks. Photorealistic. No text, numbers or signs. "
                         f"Variation {i + 1} of {count}: make it visibly different from the others.",
                         {"title": f"{base.get('title') or 'Remix'} · {i + 1}", "direction": instruction or ""}))
    else:
        style = (project.get("taste") or {}).get("style")
        takes = [plain_take(t) | {k: t.get(k) for k in ("why", "because")} for t in (style or {}).get("takes") or []]
        if instruction or len(takes) < count:  # a typed direction, or no taste pass yet: the generic takes
            takes = await design_takes(brief, count, instruction)
        for take in takes[:count]:
            jobs.append((concept_prompt(brief, take, instruction, style), take))
    refs = [] if base else await design_refs(project)
    for i, (pr, _) in enumerate(jobs):
        yield "concept.started", {"index": i, "prompt": pr, "from_design": bool(refs)}

    site = None if (brief.get("plot") or {}).get("corner") else _site_sentence(brief)

    async def one(i: int, pr: str, take: dict | None):
        try:
            c = await _generate_one(pid, pr, ref, site, refs)
            if refs:
                c["from_design"] = True
            if take:
                c.update(title=take["title"], summary=take.get("direction", ""))
                if take.get("why"):  # a direction from the family's taste: why it suits them, and the Qloo evidence
                    c.update(why=take["why"], because=take.get("because") or [], from_taste=True)
            if base:
                c.update(parent_id=base["id"], instruction=instruction)
            return i, c, None
        except Exception as e:  # keep the other concepts going
            log.exception("concept %d failed", i)
            return i, None, str(e)

    tasks = [asyncio.create_task(one(i, pr, take)) for i, (pr, take) in enumerate(jobs)]
    made = []
    for fut in asyncio.as_completed(tasks):
        i, c, err = await fut
        if c:
            made.append(c)
            yield "concept", {"index": i, "concept": c}
        else:
            yield "concept.failed", {"index": i, "message": "This one didn't come through. Try again in a moment."}
    fresh = await db.get_project(pid)
    concepts = (fresh.get("concepts") or []) + made
    fields = {"concepts": concepts}
    if fresh.get("stage") in (None, "setup", "concepts"):
        fields["stage"] = "concepts"  # never move a designed project backwards
    if not fresh.get("thumbnail_url") and made:
        fields["thumbnail_url"] = made[0]["url"]
    await db.update_project(pid, **fields)


NIGHT_EDIT = ("Turn this photograph into the same scene at night, about an hour after sunset (blue hour). Keep EXACTLY the same "
              "house, plot, camera position, lens, framing and composition, and every architectural detail. Deep blue sky, warm "
              "interior lights glowing in the windows, subtle facade uplights and garden lights, the street lamps on, soft "
              "reflections. Photorealistic. No people, no text, no numbers, no signs.")


async def night(project: dict, ids: list[str] | None = None) -> AsyncIterator[tuple[str, dict]]:
    """Night versions of the day concepts (same camera, an edit of the day image). Emits `concept {index, concept}` with
    night_url filled; concepts that already have one are returned straight away."""
    pid = project["id"]
    concepts = project.get("concepts") or []
    if ids:
        targets = [(i, c) for i, c in enumerate(concepts) if c["id"] in set(ids)]
    else:  # the latest four day concepts (or the selected one and its siblings)
        targets = list(enumerate(concepts))[-4:]
    sem = asyncio.Semaphore(4)

    async def one(i: int, c: dict):
        if c.get("night_url"):
            return i, c, None
        async with sem:
            try:
                got = await blobs.get(c["url"].removeprefix("/api/assets/"))
                if not got:
                    raise RuntimeError("day image missing")
                resp = await _image_call([types.Part.from_bytes(data=got[0], mime_type=got[1]), NIGHT_EDIT], aspect=None)
                img = _image_bytes(resp)
                if not img:
                    raise RuntimeError("no image")
                url = await blobs.put(f"projects/{pid}/concepts/{c['id']}-night.png", img[0], img[1])
                return i, {**c, "night_url": url}, None
            except Exception as e:
                log.exception("night %s failed", c.get("id"))
                return i, None, str(e)

    tasks = [asyncio.create_task(one(i, c)) for i, c in targets]
    done: dict[str, str] = {}
    for fut in asyncio.as_completed(tasks):
        i, c, err = await fut
        if c:
            done[c["id"]] = c["night_url"]
            yield "concept", {"index": i, "concept": c}
        else:
            yield "concept.failed", {"index": i, "message": "The night view didn't come through. Try again in a moment."}
    if done:
        fresh = await db.get_project(pid)
        merged = [{**c, "night_url": done.get(c["id"], c.get("night_url"))} if c["id"] in done else c for c in fresh.get("concepts") or []]
        await db.update_project(pid, concepts=merged)


async def render_view(pid: str, image: bytes, mime: str, prompt: str | None) -> str:
    """Viewport screenshot → photoreal render that keeps the exact geometry and camera."""
    instr = ("Turn this 3D architectural viewport render into a photorealistic photograph. Keep EXACTLY the same building geometry, "
             "openings, camera angle, framing and material choices; upgrade lighting, textures, reflections, vegetation and sky to "
             "real-world photo quality. The neighbouring houses stay plain, muted and simple, exactly as massed in the viewport: "
             "add nothing to them (no solar panels, water tanks, dishes or other roof equipment, no extra storeys or details), and "
             "add nothing to this house's roof that isn't in the viewport. No added objects or people, no text."
             + (f" {prompt}" if prompt else ""))
    got = _image_bytes(await _image_call([types.Part.from_bytes(data=image, mime_type=mime), instr], aspect=None))
    if not got:
        raise RuntimeError("The image model returned no image")
    return await blobs.put(f"projects/{pid}/renders/{db.new_id('r_')}.png", got[0], got[1])


# --- the concept as a build specification (what the 3D model must reproduce) -------------------------------------------
SPEC_ASK = """You are briefing a 3D modeller who must rebuild THIS house exterior exactly, feature by feature. Study the image
and list everything visible on the house and its plot, from the ground up. Be concrete and visual: where each thing is
(ground / first / second floor / roof; left / centre / right as seen from the road; front face or set back), its size relative
to the facade, its material and its colour as a hex code.
Cover: the massing of each storey (boxes, setbacks, cantilevers, projections); wall finishes by zone; window sizes, shapes
and frame colour; doors and the main entrance; balconies and railings; screens, fins, jaali or slats; canopies, chajjas and
slabs; the car porch and its columns; parapets and the roof (stair tower, water tank, solar); the boundary wall and gate;
lighting (wall lights, LED strips); planting and paving.
Return JSON: {"summary": "<two sentences: the overall look>", "palette": {"<name>": "#hex"},
"features": [{"id": "F1", "what": "<the element>", "where": "<floor and position>", "material": "<material>",
"colour": "#hex", "importance": "high" | "medium" | "low"}]}
Only THIS house and its own plot (its boundary wall, gate, porch, lawn and driveway): never the neighbouring houses, the
street, poles, wires, trees outside the plot, the sky or people.
List 12 to 20 features, the ones that define the look first."""


async def spec_of(pid: str, concept: dict) -> dict | None:
    """The concept image read as a build specification (Gemini 3.8 Flash). Cached on the concept."""
    if concept.get("spec"):
        return concept["spec"]
    got = await blobs.get(concept["url"].removeprefix("/api/assets/"))
    if not got:
        return None
    try:
        text = await llm.generate_text(config.MODEL_VISION, [types.Part.from_bytes(data=got[0], mime_type=got[1]), SPEC_ASK],
                                       max_tokens=4000, json_mode=True, thinking=False)
        spec = llm.parse_json(text)
    except Exception:
        log.exception("reading the concept as a spec failed")
        return None
    feats = [f for f in spec.get("features") or [] if isinstance(f, dict) and f.get("what")]
    for i, f in enumerate(feats, 1):
        f["id"] = f"F{i}"
    spec = {"summary": str(spec.get("summary") or ""), "palette": spec.get("palette") or {}, "features": feats[:20]}
    try:
        fresh = await db.get_project(pid)
        cs = [{**c, "spec": spec} if c["id"] == concept["id"] else c for c in fresh.get("concepts") or []]
        await db.update_project(pid, concepts=cs)
    except Exception:
        log.exception("saving the concept spec failed")
    return spec


def spec_text(spec: dict | None) -> str:
    if not spec:
        return ""
    lines = [f"LOOK: {spec.get('summary', '')}"]
    if spec.get("palette"):
        lines.append("PALETTE: " + ", ".join(f"{k} {v}" for k, v in spec["palette"].items()))
    for f in spec.get("features") or []:
        lines.append(f"- {f['id']} [{f.get('importance', 'medium')}] {f['what']} — {f.get('where', '')}; "
                     f"{f.get('material', '')} {f.get('colour', '')}".rstrip())
    return "\n".join(lines)
