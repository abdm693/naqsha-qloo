"""The local home profile: what a family home is, in the place this one will stand.

Homes differ in kind from place to place: a detached shingle-roofed house with a garage, a brick semi on a narrow lot, a villa
behind a compound wall, a flat-roofed row house with a stair tower. Nothing in Naqsha assumes one of them. For any place,
Lahore included, this module reads the web (Tavily) and has Gemini Flash write one profile; concepts, the plan, the 3D build,
the photos and the brief's assumptions all read that. It is cached by place (the rule packs' collection, 90 days) and kept
on the project as `homes`; `brief.local` holds its digest (locale.digest).

Qloo knows taste, not houses: nothing here comes from nearby cafes and hotels.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

from .. import config, llm, locale
from ..compliance import lda
from ..store import db
from . import research

log = logging.getLogger("naqsha.homes")
PROFILE_TTL_S = 90 * 24 * 3600
PROFILE_TIMEOUT_S = 60.0  # research plus the model; a run never waits longer for it
SEARCH_TIMEOUT_S = 15.0
LOT_FALLBACK = {"width_ft": 40.0, "depth_ft": 80.0}  # only when research failed and the family named no plot

FORMS = {"detached", "semi-detached", "row", "compound", "townhouse"}
ROOFS = {"flat", "gable", "hip"}
RIDGES = {"parallel", "perpendicular"}
PARKING = {"garage", "carport", "laneway", "porch", "driveway", "street"}
UNITS = {"marla", "sqft", "sqm"}
BOUNDARY = {"wall", "fence", "hedge", "none"}
TANKS = {"none", "plastic", "concrete"}
SPACES = {"drawing", "tv_lounge", "dining", "kitchen", "dirty_kitchen", "servant_quarter", "lawn", "prayer", "store", "laundry",
          "study", "gym", "motorbike"}

SYSTEM = """You are an architect who knows how ordinary families build and live in one place. From the web pages given and your
own knowledge of that place, describe the family home that is normal there: the house on an ordinary residential street,
in the named neighbourhood when one is named, that a family's new home has to sit comfortably among. Describe the common
case, not the fashionable one: a custom modern infill is rarely the street's normal house. Not a mansion, not a flat.
Homes differ in kind between places, so describe this place on its own terms and carry nothing over from anywhere else.
Say what is true of most homes there, even when it is unglamorous. Use the local names for rooms and parts of the house.
form.type is about the side walls. "row": they stand on the lot lines and touch the neighbours, also on planned
housing-scheme plots where each house is built separately. "detached": a walkable side yard on both sides. "semi-detached":
a pair sharing one wall. "townhouse": a narrow multi-storey unit in a developer's row. "compound": a large villa with open
ground all round inside a high perimeter wall.
roof.form is what you would see from the street: pick "flat" only if most houses on ordinary streets there really have
flat roofs.

JSON only:
{"place": "<the place, with its country>", "country": "<country>",
 "summary": "<one plain line a family would recognise, naming the form, roof, walls and parking>",
 "authority": {"code": "<short code of the body that approves house plans there>", "name": "<its full name>"},
 "style": "<two to four words naming ONE look: the usual look of a home there, e.g. Texas Hill Country>",
 "form": {"type": "detached|semi-detached|row|compound|townhouse",
          "street_relation": "<one sentence: how a house meets the street and its neighbours>",
          "side_gap_ft": <clear distance from the house to each side lot line, 0 if the walls touch>,
          "front_setback_ft": <distance from the street to the house front>},
 "roof": {"form": "flat|gable|hip", "pitch_deg": <degrees, 0 for flat>, "material": "<e.g. charcoal asphalt shingles>",
          "ridge": "parallel|perpendicular" (to the street), "overhang_ft": <eaves>,
          "stair_tower": <true if a stair tower stands on the roof>, "tower_name": "<local word for it, or empty>"},
 "walls": ["<two or three usual wall finishes>"],
 "lot": {"width_ft": <typical>, "depth_ft": <typical>},
 "storeys": <typical storeys above ground, 1 to 3>, "bedrooms": <typical for a family>,
 "parking": {"type": "garage|carport|laneway|porch|driveway|street", "cars": <0 to 3>,
             "description": "<where the cars go, in a few words>"},
 "outdoor": {"front": "<what is in front of the house>", "back": "<what is behind it>", "porch": "<the entrance: a porch, stoop, veranda, or none>",
             "front_boundary": "wall|fence|hedge|none", "boundary": "<the boundary treatment in a few words>"},
 "rooms": {"living_room": "<what the main family room is called there>",
           "spaces": ["<which of these a typical home there has: drawing, tv_lounge, dining, kitchen, dirty_kitchen, servant_quarter, lawn, prayer, store, laundry, study, gym>"],
           "include": ["<rooms usual there, by their local names>"], "avoid": ["<rooms a foreign architect might add that homes there don't have>"],
           "planning": "<two sentences: how rooms are arranged there, what sits near the entrance, where the family gathers>",
           "touches": ["<fixtures and details homes there have>"]},
 "services": {"roof_tank": "none|plastic|concrete", "basement": <true if usual>, "heating": "<what, or none>", "cooling": "<what, or none>"},
 "climate": "<one sentence: the climate and how the house answers it>",
 "planting": "<trees and plants usual there>",
 "units": "marla|sqft|sqm",
 "sources": ["<ids of the pages you used, e.g. T1>"]}
units is how families there talk about plot size. Feet everywhere; convert metres (1 m = 3.28 ft). Plain words, no slogans."""


def key_of(brief: dict) -> str:
    """The cache key of a brief's place: its neighbourhood and city, not its country (which may arrive later)."""
    return "home-" + research.slug(", ".join(x for x in (brief.get("scheme"), locale._city(brief)) if x))


def _num(v, lo: float, hi: float):
    return research._num(v, lo, hi)


def _text(v, limit: int = 240) -> str:
    v = ", ".join(str(x) for x in v) if isinstance(v, list) else v
    return re.sub(r"\s+", " ", str(v or "")).strip()[:limit]


def _texts(v, n: int = 8, limit: int = 60) -> list[str]:
    return [t for t in (_text(x, limit) for x in (v if isinstance(v, list) else [])) if t][:n]


def _choice(v, allowed: set[str], default: str | None = None) -> str | None:
    s = str(v or "").strip().lower().replace("_", "-")
    return s if s in allowed else default


def clean(raw: dict, place: str) -> dict | None:
    """A profile with only sane values; None when the model didn't say what kind of house it is."""
    if not isinstance(raw, dict):
        return None
    f, r, lot = raw.get("form") or {}, raw.get("roof") or {}, raw.get("lot") or {}
    kind, roof = _choice(f.get("type"), FORMS), _choice(r.get("form"), ROOFS)
    if not kind or not roof:
        return None
    pitch = _num(r.get("pitch_deg"), 8, 60) if roof != "flat" else 0
    gap = _num(f.get("side_gap_ft"), 0, 60)
    park, out, rooms, svc = raw.get("parking") or {}, raw.get("outdoor") or {}, raw.get("rooms") or {}, raw.get("services") or {}
    w, d = _num(lot.get("width_ft"), 12, 400), _num(lot.get("depth_ft"), 20, 800)
    auth = raw.get("authority") or {}
    return {
        "place": _text(raw.get("place") or place, 120), "country": _text(raw.get("country"), 60), "summary": _text(raw.get("summary"), 200),
        "authority": {"code": _text(auth.get("code"), 12).upper(), "name": _text(auth.get("name"), 100)} if auth.get("code") else None,
        "style": _text(raw.get("style"), 40),
        "form": {"type": kind, "street_relation": _text(f.get("street_relation")), "side_gap_ft": 0.0 if kind in locale.ATTACHED else gap,
                 "front_setback_ft": _num(f.get("front_setback_ft"), 0, 100)},
        "roof": {"form": roof, "pitch_deg": pitch or (30 if roof != "flat" else 0), "material": _text(r.get("material"), 60),
                 "ridge": _choice(r.get("ridge"), RIDGES, "parallel"), "overhang_ft": _num(r.get("overhang_ft"), 0, 4),
                 "stair_tower": bool(r.get("stair_tower")) and roof == "flat", "tower_name": _text(r.get("tower_name"), 30)},
        "walls": _texts(raw.get("walls"), 3),
        "lot": {"width_ft": w, "depth_ft": d} if w and d else None,
        "storeys": int(_num(raw.get("storeys"), 1, 3) or 2), "bedrooms": int(_num(raw.get("bedrooms"), 1, 8) or 3),
        "parking": {"type": _choice(park.get("type"), PARKING, "driveway"), "cars": int(_num(park.get("cars"), 0, 3) or 0),
                    "description": _text(park.get("description"), 120)},
        "outdoor": {"front": _text(out.get("front"), 120), "back": _text(out.get("back"), 120), "porch": _text(out.get("porch"), 120),
                    "front_boundary": _choice(out.get("front_boundary"), BOUNDARY, "none"), "boundary": _text(out.get("boundary"), 120)},
        "rooms": {"living_room": _text(rooms.get("living_room"), 30), "spaces": [s for s in _texts(rooms.get("spaces"), 12, 20) if s in SPACES],
                  "include": _texts(rooms.get("include"), 10, 40), "avoid": _texts(rooms.get("avoid"), 6, 40),
                  "planning": _text(rooms.get("planning"), 400), "touches": _texts(rooms.get("touches"), 6, 50)},
        "services": {"roof_tank": _choice(svc.get("roof_tank"), TANKS, "none"), "basement": bool(svc.get("basement")),
                     "heating": _text(svc.get("heating"), 60), "cooling": _text(svc.get("cooling"), 60)},
        "climate": _text(raw.get("climate")), "planting": _text(raw.get("planting"), 160),
        "units": _choice(raw.get("units"), UNITS, "sqft"),
    }


def fallback(brief: dict) -> dict:
    """Research and the model both failed: the place's name and nothing invented. Prompts then ask for what is usual there."""
    return {"place": locale.place(brief), "summary": "", "lot": dict(LOT_FALLBACK), "researched": False}


async def _gather(place: str) -> tuple[list[dict], str]:
    """Three quick searches. Returns (pages, answers); ([], "") when search isn't available."""
    if not config.TAVILY_API_KEY:
        return [], ""
    queries = [f"typical family house on an ordinary street in {place}: detached, semi-detached or row, roof type, exterior walls",
               f"{place} typical residential lot width and depth, side setback, garage or parking, front yard and fence conventions",
               f"how family homes in {place} are laid out: rooms, floor plan conventions, climate design"]
    found = await asyncio.gather(*[asyncio.wait_for(research._tavily("search", {
        "query": q, "search_depth": "basic", "max_results": 4, "include_answer": "basic"}), SEARCH_TIMEOUT_S) for q in queries],
        return_exceptions=True)
    pages, answers, seen = [], [], set()
    for f in found:
        if isinstance(f, BaseException):
            log.warning("home search failed: %r", f)
            continue
        if f.get("answer"):
            answers.append(f["answer"])
        for r in f.get("results") or []:
            if r.get("url") and r["url"] not in seen:
                seen.add(r["url"])
                pages.append({"title": r.get("title") or r["url"], "url": r["url"], "content": (r.get("content") or "")[:1800]})
    return pages[:9], "\n".join(answers)


async def _write(place: str, pages: list[dict], answer: str) -> dict | None:
    text = "\n\n".join(f"SOURCE T{i} — {p['title']} ({p['url']})\n{p['content']}" for i, p in enumerate(pages, 1))
    prompt = (f"THE PLACE: {place}\n\n" + (f"SEARCH SUMMARY:\n{answer[:2500]}\n\nPAGES:\n{text}\n\n" if pages else
                                          "(No web pages this time: answer from what you know of the place.)\n\n")
              + "Write the profile now.")
    for attempt in (1, 2):  # the JSON can come back cut short; one more try before giving up
        try:
            out = await llm.generate_text(config.MODEL_INTAKE, prompt, system=SYSTEM, max_tokens=3500, json_mode=True, thinking=False)
            prof = clean(llm.parse_json(out), place)
            if prof:
                return prof
        except Exception as e:
            log.warning("home profile for %s, attempt %d: %r", place, attempt, e)
    return None


async def profile(brief: dict, force: bool = False) -> dict | None:
    """The home profile of the brief's place: cached, else researched now (about 10 to 20 seconds). None while the place is
    unknown; a thin fallback, not cached, when research and the model both fail. Never raises."""
    place = locale.place(brief)
    if not locale.known(brief):
        return None
    key = key_of(brief)
    if not force:
        try:
            got = await db.get_rulepack(key)
            if got and time.time() - got.get("_at", 0) < PROFILE_TTL_S:
                return {k: v for k, v in got.items() if k != "_at"}
        except Exception as e:
            log.warning("home profile cache read failed: %r", e)
    t0 = time.monotonic()
    try:
        pages, answer = await _gather(place)
    except Exception as e:
        log.warning("home research for %s failed: %r", place, e)
        pages, answer = [], ""
    prof = await _write(place, pages, answer)
    if not prof:
        log.warning("no home profile for %s", place)
        return {**fallback(brief), "key": key}
    prof.update(key=key, researched=bool(pages), seconds=round(time.monotonic() - t0, 1),
                sources=[{"title": p["title"], "url": p["url"]} for p in pages[:6]])
    try:
        await db.save_rulepack(key, {**prof, "_at": time.time()})
    except Exception as e:
        log.warning("home profile cache write failed: %r", e)
    log.info("home profile for %s in %.0fs: %s, %s roof", place, prof["seconds"], prof["form"]["type"], prof["roof"]["form"])
    return prof


# --- on the project ------------------------------------------------------------------------------------------------------------
_running: dict[tuple[str, str], asyncio.Task] = {}


def current(project: dict, brief: dict) -> dict | None:
    """The project's profile, if it is for the brief's place."""
    got = project.get("homes")
    return got if got and got.get("key") == key_of(brief) else None


async def _run(project: dict, brief: dict) -> dict | None:
    try:
        prof = await asyncio.wait_for(profile(brief), PROFILE_TIMEOUT_S)
    except Exception as e:
        log.warning("home profile run failed: %r", e)
        prof = {**fallback(brief), "key": key_of(brief)}
    if prof:
        project["homes"] = prof
        try:
            await db.patch_project(project["id"], homes=prof)
        except Exception:
            log.exception("saving the home profile failed")
    return prof


def start(project: dict, brief: dict) -> asyncio.Task | None:
    """Start reading the place in the background (one run per project and place). None when there is nothing to do: the
    place is unknown, or the project already has its profile. Safe to call from any turn; `ensure` joins the same run."""
    if not locale.known(brief) or current(project, brief):
        return None
    k = (project["id"], key_of(brief))
    task = _running.get(k)
    if task is None or task.done():
        task = _running[k] = asyncio.create_task(_run(project, brief))
    return task


async def ensure(project: dict, brief: dict | None = None) -> dict | None:
    """The profile for this project, waiting for it if it is still being read. Never raises."""
    b = brief if brief is not None else (project.get("brief") or {})
    task = start(project, b)
    if task is None:
        return current(project, b)
    return await asyncio.shield(task)


def stamp(brief: dict, prof: dict | None) -> dict:
    """The brief with the profile's digest. When the place changed, what Naqsha chose for the old place goes with it."""
    if not prof:
        return brief
    new = locale.digest(prof)
    out = dict(brief)
    if prof.get("country") and not out.get("country"):
        out["country"] = prof["country"]
    auth = (prof.get("authority") or {}).get("code")
    if auth and not out.get("authority"):
        out["authority"] = auth
    old = brief.get("local")
    if new == old:
        return out
    out["local"] = new
    if old:
        auto = set(out.get("auto_filled") or [])
        for k in ("plot", "storeys", "bedrooms", "bathrooms", "water_tank", "solar", "style", "home_form", "roof_form"):
            if k in auto:
                out[k] = None
                auto.discard(k)
        if "spaces" in auto:
            out["spaces"] = []
            auto -= {"spaces", "porch"}
        out["auto_filled"] = sorted(auto)
    return out


async def localised(project: dict) -> dict:
    """The project with its profile and the brief stamped from it, for a run about to design. Saves a changed brief."""
    brief = project.get("brief") or {}
    prof = await ensure(project, brief)
    if not prof:
        return project
    stamped = stamp(brief, prof)
    if stamped != brief:
        try:
            await db.patch_project(project["id"], brief=stamped)
        except Exception:
            log.exception("saving the stamped brief failed")
    return {**project, "brief": stamped, "homes": prof}


# --- the place's building rules ----------------------------------------------------------------------------------------------
def needs_rules(brief: dict) -> bool:
    """A place with no rule pack on the brief, outside the Lahore authorities Naqsha ships."""
    auth = str(brief.get("authority") or "").upper()
    return (locale.known(brief) and not brief.get("rules_pack") and locale._city(brief).lower() != "lahore"
            and auth not in lda.BUILTIN_AUTHORITIES and brief.get("rules_tried") != auth)


async def rules_for(brief: dict, prof: dict | None) -> tuple[dict, dict | None]:
    """Look up the authority's rules (research.research, cached 30 days). Returns (brief, the pack or None). Never raises."""
    if not needs_rules(brief):
        return brief, None
    auth = str(brief.get("authority") or ((prof or {}).get("authority") or {}).get("code") or "").upper()
    if not auth:
        return brief, None
    try:
        pack = await research.research(locale._city(brief), auth)
    except Exception:
        log.exception("rule research for %s failed", auth)
        return brief, None
    if not pack:
        return {**brief, "rules_tried": auth}, None  # looked once: no use asking on every turn
    return {**brief, "authority": auth,
            "rules_pack": {"authority": auth, "name": pack.get("authority_name"), "instrument": pack.get("instrument"),
                           "sources": [{"title": x.get("title"), "url": x.get("url"), "official": x.get("official")}
                                       for x in pack.get("sources") or []][:5],
                           "caveats": pack.get("caveats") or []}}, pack
