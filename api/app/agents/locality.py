"""The neighbourhood, read as soon as Naqsha knows where the plot is: where it is on the map, how the area feels (from the
places people love around it, through Qloo), and what a house there could take from them. It is quick (Qloo calls in
parallel and one Flash call), so the family gets recommendations before they have shared a single favourite, and the
first concepts already belong to the street they will stand on."""
from __future__ import annotations

import asyncio
import json
import logging
import math

from .. import config, llm, qloo
from ..store import db

log = logging.getLogger("naqsha.locality")

# Places that say little about how people live in an area (where they are is all they share with it).
SKIP = {"convention center", "meeting planning service", "housing cooperative", "housing development", "university", "hospital",
        "bank", "atm", "government office", "gas station", "parking lot", "airport", "car dealer", "corporate office",
        "office", "embassy", "school", "college"}

SYSTEM = """You are Naqsha's architect. Before designing a family home you walk the neighbourhood. You get the place and
the places people love around it, each with how it feels (ambience, decor, setting). Say what a house here could take
from them: concrete, buildable ideas that suit the local climate, building custom and what homes there look like.

JSON only:
{"reading": "one or two short sentences on how the area feels and lives, in plain words",
 "ideas": [{"title": "3-6 words", "line": "one sentence: what the house does, concretely (a material, colour, space or planting)",
            "where": "facade | inside | garden | living", "from": ["names of the places, exactly as given, that suggest it"]}],
 "suggestions": ["three short requests the family could tap, in their own voice, each under 7 words"]}

Four ideas: one each for the facade, inside, the garden and how the family will live. Warm, plain English, no slogans,
no "not X but Y". Name only places you are given, and never name a data source or "tags"."""


def _km(a: dict, b: dict) -> float:
    dlat, dlon = math.radians(b["lat"] - a["lat"]), math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a["lat"])) * math.cos(math.radians(b["lat"])) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


async def read(location: str, brief: dict) -> dict:
    """{location, center, feel, places, reading, ideas, suggestions, at}. Empty lists when Qloo knows nothing there."""
    try:
        center = await qloo.locate(location)
    except qloo.QlooError as e:
        log.warning("locate %r failed: %s", location, e)
        center = None
    try:
        ar = await qloo.area(location, take=40, center=center, radius=2000, keep=40)
    except qloo.QlooError as e:
        log.warning("area %r failed: %s", location, e)
        ar = {"tags": [], "places": []}

    places = []
    for x in ar.get("places") or []:
        if x.get("lat") is None or x.get("lon") is None or (x.get("category") or "").lower() in SKIP:
            continue
        feel = list(dict.fromkeys(t["name"] for t in x.get("tags") or [] if t.get("type") in qloo.FEEL_TAGS and t.get("name")))
        places.append({"id": x["id"], "name": x["name"], "lat": x["lat"], "lon": x["lon"], "image": x.get("image"),
                       "address": x.get("address"), "category": x.get("category"), "feel": feel[:5]})
    if not center and places:  # no locality entity: the middle of its places
        lats, lons = sorted(p["lat"] for p in places), sorted(p["lon"] for p in places)
        center = {"name": location, "lat": lats[len(lats) // 2], "lon": lons[len(lons) // 2], "label": location}
    if center:
        places = [p for p in places if _km(center, p) <= 6]
    feel = [{"name": t["name"], "share": t.get("affinity")} for t in ar.get("tags") or []]

    out = {"location": location, "center": center, "feel": feel, "places": places[:18], "reading": None, "ideas": [],
           "suggestions": [], "at": db.now()}
    if not places:
        return out
    home = {k: brief.get(k) for k in ("city", "scheme", "country", "plot", "storeys", "bedrooms", "facing") if brief.get(k)}
    lines = [f"- {p['name']} ({p.get('category') or 'place'}): {', '.join(p['feel']) or 'no feel tags'}" for p in places[:16]]
    prompt = (f"THE NEIGHBOURHOOD: {center.get('label') if center else location}\nTHE HOME: {json.dumps(home)}\n"
              f"HOW THE AREA FEELS (share of places): {', '.join(f['name'] for f in feel[:10])}\n"
              f"PLACES PEOPLE LOVE AROUND IT:\n" + "\n".join(lines))
    try:
        text = await asyncio.wait_for(llm.generate_text(config.MODEL_INTAKE, prompt, system=SYSTEM, max_tokens=2000, json_mode=True,
                                                        thinking=False), timeout=45)
        got = llm.parse_json(text)
    except Exception as e:
        log.warning("locality ideas failed: %r", e)
        return out
    names = {p["name"] for p in places}
    out["reading"] = str(got.get("reading") or "")[:400] or None
    out["ideas"] = [{"title": str(i.get("title") or "")[:60], "line": str(i.get("line") or "")[:240], "where": i.get("where"),
                     "from": [n for n in i.get("from") or [] if n in names][:3]}
                    for i in got.get("ideas") or [] if isinstance(i, dict) and i.get("title")][:4]
    out["suggestions"] = [str(s)[:60] for s in got.get("suggestions") or [] if isinstance(s, str)][:3]
    return out
