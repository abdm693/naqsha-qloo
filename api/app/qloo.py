"""Qloo's taste graph (hackathon environment: https://hackathon.api.qloo.com, key in the X-Api-Key header).

What Naqsha asks Qloo:
- resolve: the family's favourites (films, shows, artists, books, podcasts, places they travelled, restaurants, brands) to Qloo
  entities (/search);
- taste: the tags a set of favourites points to (Taste Analysis: /v2/insights with filter.type=urn:tag), per person and for
  the family, with explainability so every tag can cite the favourites behind it;
- affinities: destinations and brands people with that taste love (/v2/insights, filter.type destination / brand);
- locality: the tags that describe the area the house is in, and the places there that match the family's taste
  (filter.location.query / signal.location.query).

Only favourites and a place name are ever sent: no names, emails or other personal data. Responses are cached in memory
(private caching is allowed by Qloo's hackathon terms; nothing is stored in the repository).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx

from . import config

log = logging.getLogger("naqsha.qloo")

KINDS = {  # what the family calls a favourite -> Qloo entity type
    "film": "urn:entity:movie", "movie": "urn:entity:movie", "show": "urn:entity:tv_show", "tv": "urn:entity:tv_show",
    "tv_show": "urn:entity:tv_show", "music": "urn:entity:artist", "artist": "urn:entity:artist", "book": "urn:entity:book",
    "podcast": "urn:entity:podcast", "place": "urn:entity:destination", "destination": "urn:entity:destination",
    "travel": "urn:entity:destination", "city": "urn:entity:destination", "restaurant": "urn:entity:place",
    "cafe": "urn:entity:place", "venue": "urn:entity:place", "brand": "urn:entity:brand", "game": "urn:entity:video_game",
    "video_game": "urn:entity:video_game", "person": "urn:entity:person",
}
# Taste Analysis tag types that describe a person's aesthetic (read from live results: "Modern Silhouettes", "Rich Textiles",
# "Traditional Craftsmanship", "Refined Elegance"…). Other types (payments, inclusivity, plot keywords) say nothing about a home.
DESIGN_TAGS = ["urn:tag:aesthetic_property:qloo", "urn:tag:personal_style:qloo", "urn:tag:cultural_relevance:qloo",
               "urn:tag:lifestyle:qloo", "urn:tag:emotional_tone:qloo", "urn:tag:adjective:qloo"]
# Tag types on places that describe how a place feels: the area's character is read from the places in it.
# What destinations carry instead (they have no aesthetic tags): their character, culture and scenery still say a lot
# about a home (Traditional, Laid Back, Traditional Crafts, Gardens).
PLACE_TAGS = ["urn:tag:characteristic:qloo", "urn:tag:culture:qloo", "urn:tag:scenery:qloo"]
FEEL_TAGS = ["urn:tag:ambience:qloo", "urn:tag:decor:qloo", "urn:tag:setting:qloo", "urn:tag:neighborhood_characteristic:qloo",
             "urn:tag:good_for:qloo", "urn:tag:view:qloo"]
# Tags that say nothing about a home, or read badly in one ("Seductive", "Marriage"): dropped from Taste Analysis results.
UNHELPFUL = {"seductive", "sexy", "marriage", "motivated", "professional", "ethnicity", "elite", "authoritative", "vengeance",
             "industry professionals", "the justice seeker", "insightful", "beauty oriented", "romantically inclined",
             "athletic", "athletes", "sporty", "weddings", "freedom", "dynamic", "ethnic", "ethnic diversity", "culturally aware",
             "affluent", "wealthy", "world traveler", "global perspective", "business travelers", "seasonal residents", "remote",
             "volcanoes", "coral reefs", "canyons", "scuba diving", "hot springs", "camping", "sensual", "developing", "volcanic landscapes",
             "geisha performances", "flamenco shows", "caves", "digital", "editorial", "informative", "utility"}
BRAND_GENRES = ["urn:tag:genre:brand:fashion", "urn:tag:genre:brand:retail"]   # textiles and objects, not cars
MAKER_TAGS = ["urn:tag:category:place:art_gallery", "urn:tag:category:place:furniture_store", "urn:tag:genre:place:furniture_store",
              "urn:tag:category:place:interior_designer", "urn:tag:category:place:home_goods_store", "urn:tag:category:place:handicraft"]


class QlooError(RuntimeError):
    pass


_cache: dict[str, tuple[float, Any]] = {}
CACHE_S = 6 * 3600
_client: httpx.AsyncClient | None = None
_sem = asyncio.Semaphore(6)


def enabled() -> bool:
    return bool(config.QLOO_API_KEY)


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=config.QLOO_BASE_URL, timeout=httpx.Timeout(20.0, connect=8.0),
                                    headers={"X-Api-Key": config.QLOO_API_KEY, "Accept": "application/json"})
    return _client


async def get(path: str, params: dict) -> dict:
    """One GET (query-string params, lists joined with commas), cached, with two retries on 429/5xx."""
    q = {k: (",".join(map(str, v)) if isinstance(v, (list, tuple)) else v) for k, v in params.items() if v not in (None, "", [])}
    key = path + "?" + json.dumps(q, sort_keys=True)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_S:
        return hit[1]
    if not enabled():
        raise QlooError("no Qloo key configured")
    last: Exception | None = None
    async with _sem:
        for attempt in range(3):
            try:
                r = await _http().get(path, params=q)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise QlooError(f"{r.status_code} {r.text[:160]}")
                if r.status_code >= 400:
                    raise QlooError(f"{r.status_code} {r.text[:300]}")
                data = r.json()
                _cache[key] = (time.monotonic(), data)
                return data
            except (httpx.HTTPError, QlooError) as e:
                last = e
                if isinstance(e, QlooError) and not str(e)[:3] in ("429", "500", "502", "503", "504"):
                    raise
                await asyncio.sleep(1.5 * (attempt + 1))
    raise QlooError(f"Qloo unavailable: {last}")


def _image(props: dict) -> str | None:
    if isinstance(props.get("image"), dict):
        return props["image"].get("url")
    imgs = props.get("images")
    if isinstance(imgs, list) and imgs:
        x = imgs[0]
        return x.get("url") if isinstance(x, dict) else x if isinstance(x, str) else None
    return None


def _entity(e: dict) -> dict:
    props = e.get("properties") or {}
    types = e.get("types") or []
    return {"id": e.get("entity_id") or e.get("id"), "name": e.get("name"),
            "type": e.get("type") or e.get("subtype") or (types[0] if types else None), "image": _image(props),
            "description": (props.get("short_description") or props.get("description") or "")[:240],
            "feel": " ".join(str(props.get(k) or "") for k in ("ambience_description", "physical_setting_description"))[:400],
            "address": props.get("address"), "popularity": e.get("popularity"),
            "lat": (e.get("location") or {}).get("lat"), "lon": (e.get("location") or {}).get("lon"),
            "category": next((t.get("name") for t in e.get("tags") or [] if t.get("type") == "urn:tag:category:place"), None),
            "affinity": (e.get("query") or {}).get("affinity"),
            "tags": [{"id": t.get("id") or t.get("tag_id"), "name": t.get("name"), "type": t.get("type")}
                     for t in (e.get("tags") or [])[:30]],
            "keywords": [x for x in (props.get("keywords") or [])][:12] if isinstance(props.get("keywords"), list) else [],
            "brand_adjectives": props.get("brand_adjectives"), "price_tier": props.get("price_tier"),
            "explain": _explain(e)}


def _explain(x: dict) -> list[dict]:
    ex = ((x.get("query") or {}).get("explainability") or {})
    out = []
    for k, v in ex.items() if isinstance(ex, dict) else []:
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict) and (item.get("entity_id") or item.get("id")):
                    out.append({"id": item.get("entity_id") or item.get("id"), "score": item.get("score")})
    return out[:6]


async def search(query: str, kind: str | None = None, take: int = 3) -> list[dict]:
    t = KINDS.get((kind or "").lower())
    data = await get("/search", {"query": query, "types": t, "take": take})
    return [_entity(e) for e in data.get("results") or []]


SUGGEST_TYPES = ["urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:destination", "urn:entity:brand",
                 "urn:entity:place", "urn:entity:book"]
SUGGEST_KIND = {"artist": "Music", "movie": "Film", "tv_show": "Show", "destination": "Place", "brand": "Brand", "place": "Spot",
                "book": "Book"}


async def suggest(query: str, take: int = 6) -> list[dict]:
    """What someone may mean as they type: real things with pictures, so they choose the Selena they mean. Venues are searched
    apart (there are so many that they would crowd out cities, artists and films), then exact and prefix matches come first."""
    q = query.strip().lower()
    if len(q) < 2:
        return []
    known, spots = await asyncio.gather(get("/search", {"query": query, "types": SUGGEST_TYPES[:5] + SUGGEST_TYPES[6:], "take": 12}),
                                        get("/search", {"query": query, "types": "urn:entity:place", "take": 4}))
    out, seen = [], set()
    for tier, data in enumerate((known, spots)):
        for e in data.get("results") or []:
            x = _entity(e)
            kind = str(((e.get("types") or [e.get("subtype") or ""])[0])).rsplit(":", 1)[-1]
            name = (x.get("name") or "").strip()
            if not name or kind not in SUGGEST_KIND or (name.lower(), kind) in seen:
                continue
            seen.add((name.lower(), kind))
            rank = 0 if name.lower() == q else 1 if name.lower().startswith(q) else 2
            out.append((rank, tier, -(x.get("popularity") or 0), {"id": x["id"], "name": name, "kind": kind, "label": SUGGEST_KIND[kind],
                                                                  "image": x.get("image"), "where": (x.get("address") or "")[:60] or None}))
    out.sort(key=lambda r: r[:3])
    return [r[3] for r in out[:take]]


async def resolve(favourites: list[dict]) -> list[dict]:
    """[{kind, name, who?, id?}] -> the same items with their Qloo entity (or None when Qloo doesn't know it). Something the
    person picked keeps the entity they picked; only bare names are searched."""
    def best(name: str, hits: list[dict]) -> dict | None:
        """The exact name if Qloo has it (Marrakech, not a venue called "Nass Marrakech"), else the most popular match."""
        q = name.strip().lower()
        exact = [h for h in hits if (h.get("name") or "").strip().lower() == q]
        pool = exact or hits
        return max(pool, key=lambda h: h.get("popularity") or 0) if exact else (pool[0] if pool else None)

    async def one(f: dict) -> dict:
        if f.get("id"):
            return {**f, "entity": {"id": f["id"], "name": f["name"], "type": f.get("kind"), "image": f.get("image"), "tags": []}}
        try:
            hits = await search(f["name"], f.get("kind"), take=6)
            if not hits and f.get("kind"):
                hits = await search(f["name"], None, take=6)
            return {**f, "entity": best(f["name"], hits)}
        except QlooError as e:
            log.warning("resolve %r failed: %s", f.get("name"), e)
            return {**f, "entity": None}
    return list(await asyncio.gather(*[one(f) for f in favourites if (f.get("name") or "").strip()]))


async def insights(ftype: str, take: int = 12, **params) -> dict:
    p = {"filter.type": ftype, "take": take, **{k.replace("__", "."): v for k, v in params.items()}}
    return await get("/v2/insights", p)


def _tags(data: dict) -> list[dict]:
    out = []
    for t in (data.get("results") or {}).get("tags") or []:
        q = t.get("query") or {}
        out.append({"id": t.get("tag_id") or t.get("id"), "name": t.get("name"), "type": t.get("subtype") or (t.get("types") or [None])[0],
                    "affinity": q.get("affinity"), "explain": _explain(t)})
    return out


async def taste_tags(entity_ids: list[str], tag_types: list[str] | None = None, take: int = 24, per_type: int = 4) -> list[dict]:
    """Taste Analysis: the tags these favourites point to, strongest first (a few per tag type, so one type can't crowd
    out the rest). Same-named tags from different types are merged."""
    if not entity_ids:
        return []
    data = await insights("urn:tag", take=take, signal__interests__entities=entity_ids, filter__tag__types=tag_types or DESIGN_TAGS,
                          diversify__by="subtype", diversify__take=per_type, feature__explainability="true")
    found = _tags(data)
    if not tag_types and len(found) < 6:  # mostly places: read them by their character, culture and scenery
        more = await insights("urn:tag", take=min(take, 16), signal__interests__entities=entity_ids, filter__tag__types=PLACE_TAGS,
                              diversify__by="subtype", diversify__take=max(per_type, 5), feature__explainability="true")
        found += _tags(more)
    seen, out = set(), []
    for t in found:
        k = (t["name"] or "").strip().lower()
        if k and k not in seen and k not in UNHELPFUL:
            seen.add(k)
            out.append(t)
    return out


async def locate(location: str) -> dict | None:
    """Where a neighbourhood is: Qloo's locality entity for it ({name, lat, lon, label}), or None."""
    data = await get("/search", {"query": location, "types": "urn:entity:locality", "take": 3})
    for r in data.get("results") or []:
        loc = r.get("location") or {}
        if loc.get("lat") is not None and loc.get("lon") is not None:
            return {"name": r.get("name"), "lat": loc["lat"], "lon": loc["lon"], "label": r.get("disambiguation") or r.get("name")}
    return None


def _near(location: str, center: dict | None, radius: int) -> dict:
    """Places around the neighbourhood's own point when it is known (a name alone returns the whole city's favourites)."""
    if center:
        return {"filter__location": f"POINT({center['lon']} {center['lat']})", "filter__location__radius": radius}
    return {"filter__location__query": location}


async def area(location: str, take: int = 20, center: dict | None = None, radius: int = 2500, keep: int = 8) -> dict:
    """How an area feels, read from its places: the ambience, decor and setting tags that recur, and their own words."""
    data = await insights("urn:entity:place", take=take, **_near(location, center, radius))
    ents = [_entity(e) for e in (data.get("results") or {}).get("entities") or []]
    counts: dict[str, int] = {}
    for e in ents:
        for t in e["tags"]:
            if t.get("type") in FEEL_TAGS and t.get("name"):
                counts[t["name"]] = counts.get(t["name"], 0) + 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:12]
    n = max(1, len(ents))
    return {"tags": [{"id": f"area:{location}:{k}", "name": k, "type": "area", "affinity": round(v / n, 2)} for k, v in top],
            "places": ents[:keep]}


async def affinities(ftype: str, entity_ids: list[str], take: int = 8, **extra) -> list[dict]:
    if ftype == "urn:entity:brand" and "filter__tags" not in extra:
        extra["filter__tags"] = BRAND_GENRES
    if ftype == "urn:entity:destination" and "filter__popularity__min" not in extra:
        extra["filter__popularity__min"] = 0.6
    if not entity_ids:
        return []
    data = await insights(ftype, take=take, signal__interests__entities=entity_ids, feature__explainability="true", **extra)
    return [_entity(e) for e in (data.get("results") or {}).get("entities") or []]


async def places_near(location: str, entity_ids: list[str] | None = None, tag_ids: list[str] | None = None,
                      take: int = 10, center: dict | None = None, radius: int = 5000) -> list[dict]:
    """Places in the area, ranked for the family's taste (and narrowed to some tags, e.g. furniture or decor shops)."""
    data = await insights("urn:entity:place", take=take, **_near(location, center, radius), filter__tags=tag_ids or None,
                          signal__interests__entities=entity_ids or None, feature__explainability="true" if entity_ids else None)
    return [_entity(e) for e in (data.get("results") or {}).get("entities") or []]


async def find_tags(query: str, tag_types: list[str] | None = None, take: int = 8) -> list[dict]:
    data = await get("/v2/tags", {"filter.query": query, "filter.tag.types": tag_types, "take": take,
                                  "feature.typo_tolerance": "true"})
    return [{"id": t.get("id") or t.get("tag_id"), "name": t.get("name"), "type": t.get("type") or t.get("subtype")}
            for t in (data.get("results") or {}).get("tags") or []]
