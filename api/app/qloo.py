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
               "urn:tag:lifestyle:qloo", "urn:tag:emotional_tone:qloo", "urn:tag:adjective:qloo", "urn:tag:customer_identity:qloo"]
# Tag types on places that describe how a place feels: the area's character is read from the places in it.
FEEL_TAGS = ["urn:tag:ambience:qloo", "urn:tag:decor:qloo", "urn:tag:setting:qloo", "urn:tag:neighborhood_characteristic:qloo",
             "urn:tag:good_for:qloo", "urn:tag:view:qloo"]
# Tags that say nothing about a home, or read badly in one ("Seductive", "Marriage"): dropped from Taste Analysis results.
UNHELPFUL = {"seductive", "sexy", "marriage", "motivated", "professional", "ethnicity", "elite", "authoritative", "vengeance",
             "industry professionals", "the justice seeker", "insightful", "beauty oriented", "romantically inclined"}
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


async def resolve(favourites: list[dict]) -> list[dict]:
    """[{kind, name, who?}] -> the same items with the matched Qloo entity (or None when Qloo doesn't know it)."""
    async def one(f: dict) -> dict:
        try:
            hits = await search(f["name"], f.get("kind"), take=1)
            if not hits and f.get("kind"):
                hits = await search(f["name"], None, take=1)
            return {**f, "entity": hits[0] if hits else None}
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
    seen, out = set(), []
    for t in _tags(data):
        k = (t["name"] or "").strip().lower()
        if k and k not in seen and k not in UNHELPFUL:
            seen.add(k)
            out.append(t)
    return out


async def area(location: str, take: int = 20) -> dict:
    """How an area feels, read from its places: the ambience, decor and setting tags that recur, and their own words."""
    data = await insights("urn:entity:place", take=take, filter__location__query=location)
    ents = [_entity(e) for e in (data.get("results") or {}).get("entities") or []]
    counts: dict[str, int] = {}
    for e in ents:
        for t in e["tags"]:
            if t.get("type") in FEEL_TAGS and t.get("name"):
                counts[t["name"]] = counts.get(t["name"], 0) + 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:12]
    n = max(1, len(ents))
    return {"tags": [{"id": f"area:{location}:{k}", "name": k, "type": "area", "affinity": round(v / n, 2)} for k, v in top],
            "places": ents[:8]}


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
                      take: int = 10) -> list[dict]:
    """Places in the area, ranked for the family's taste (and narrowed to some tags, e.g. furniture or decor shops)."""
    data = await insights("urn:entity:place", take=take, filter__location__query=location, filter__tags=tag_ids or None,
                          signal__interests__entities=entity_ids or None, feature__explainability="true" if entity_ids else None)
    return [_entity(e) for e in (data.get("results") or {}).get("entities") or []]


async def find_tags(query: str, tag_types: list[str] | None = None, take: int = 8) -> list[dict]:
    data = await get("/v2/tags", {"filter.query": query, "filter.tag.types": tag_types, "take": take,
                                  "feature.typo_tolerance": "true"})
    return [{"id": t.get("id") or t.get("tag_id"), "name": t.get("name"), "type": t.get("type") or t.get("subtype")}
            for t in (data.get("results") or {}).get("tags") or []]
