"""Where the plot is: its point on the map and the places around it, for the pin on the Brief. Qloo knows places, not houses,
so nothing here shapes the design; agents/homes.py does that."""
from __future__ import annotations

import logging
import math

from .. import qloo
from ..store import db

log = logging.getLogger("naqsha.locality")

# Places that say little about how people live in an area (where they are is all they share with it).
SKIP = {"convention center", "meeting planning service", "housing cooperative", "housing development", "university", "hospital",
        "bank", "atm", "government office", "gas station", "parking lot", "airport", "car dealer", "corporate office",
        "office", "embassy", "school", "college"}

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

    return {"location": location, "center": center, "feel": feel, "places": places[:18], "at": db.now()}
