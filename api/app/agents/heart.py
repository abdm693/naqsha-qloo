"""The heart of the home: what a family shares, found in the real overlap between each person's taste.

Each person answers alone. Qloo's Taste Analysis reads each one separately; the heart is the words that appear in everyone's
reading, never a summary a model wrote. Gemini only chooses among those words and says what they mean for the house: which
room is the heart, and which room belongs to each person. With no word shared by all, the heart falls back to what most of
them share, then to how they read together, and says so (`level`), so the reveal never claims more than the data shows.
"""
from __future__ import annotations

import asyncio
import json
import logging
from itertools import combinations

from .. import config, llm, qloo
from ..store import db

log = logging.getLogger("naqsha.heart")

SYSTEM = """You are Naqsha's architect. A family answered separately about what they love, and you are shown the words their
tastes truly share. Choose what will become the heart of their home. JSON only:
{"words": ["one or two words, copied exactly from HEART WORDS, the ones that say most about how a family lives"],
 "line": "one warm sentence of at most 12 words about what those words mean for this family",
 "room": "the one room or place that should be the heart of this house (a kitchen, a courtyard, a long table, a porch...), natural for THE HOME",
 "people": [{"name": "exact name", "room": "their own room or corner, 2-4 words", "line": "one short sentence of at most 10 words, from their words"}],
 "between": [{"names": ["name", "name"], "space": "the place they share, 2-4 words"}]}
Plain, warm English. Use only words you are given for the heart. No slogans, no "not X but Y". Never mention data, tags or scores."""


async def _reading(ids: list[str]) -> dict[str, dict]:
    """Taste Analysis for a set of favourites: {lowercase word: {name, affinity}}."""
    data = await qloo.insights("urn:tag", take=50, signal__interests__entities=ids, filter__tag__types=qloo.DESIGN_TAGS + qloo.PLACE_TAGS,
                               diversify__by="subtype", diversify__take=12)
    out: dict[str, dict] = {}
    for t in qloo._tags(data):
        name = (t.get("name") or "").strip()
        if name and name.lower() not in qloo.UNHELPFUL and name.lower() not in out:
            out[name.lower()] = {"name": name, "affinity": t.get("affinity") or 0}
    return out


async def _threads(words: list[str], rows: list[dict]) -> list[dict]:
    """The proof of the reveal: for each word, the one thing of each person's that carries it, found by reading each favourite
    on its own. Someone whose word only appears across their favourites together simply isn't shown."""
    sem = asyncio.Semaphore(5)

    async def alone(i: str) -> tuple[str, dict]:
        async with sem:
            try:
                return i, await _reading([i])
            except qloo.QlooError as e:
                log.warning("reading %s failed: %s", i, e)
                return i, {}
    read = dict(await asyncio.gather(*[alone(i) for i in {i for r in rows for i in r["ids"]}]))
    out = []
    for w in words:
        k, hands = w.lower(), []
        for r in rows:
            best = max((i for i in r["ids"] if k in read.get(i, {})), key=lambda i: read[i][k]["affinity"], default=None)
            if best:
                hands.append({"person": r["name"], "name": r["loved"][best]["name"], "image": r["loved"][best].get("image")})
        if hands:
            out.append({"word": w, "hands": hands})
    return out


async def read(people: list[dict], home: dict) -> dict:
    """people: [{id, name, favourites: [{id?, name, kind?}]}]. Returns {words, line, room, level, people, between, at}."""
    resolved = await asyncio.gather(*[qloo.resolve([{**f, "who": p["name"]} for f in p.get("favourites") or []]) for p in people])
    rows = []
    for p, items in zip(people, resolved):
        loved = {r["entity"]["id"]: {"name": r["name"], "image": r.get("image") or r["entity"].get("image")} for r in items if r.get("entity")}
        rows.append({"id": p["id"], "name": p["name"], "ids": list(loved), "loved": loved, "named": [r["name"] for r in items], "words": {}})
    got = await asyncio.gather(*[_reading(r["ids"]) if r["ids"] else asyncio.sleep(0, {}) for r in rows], return_exceptions=True)
    for r, w in zip(rows, got):
        if isinstance(w, Exception):
            log.warning("reading %s failed: %s", r["name"], w)
            w = {}
        r["words"] = w
    rows = [r for r in rows if r["words"]] or rows
    if not any(r["words"] for r in rows):
        return {"words": [], "line": None, "room": None, "level": "none", "people": [], "between": [], "threads": [], "at": db.now()}

    keys = [set(r["words"]) for r in rows]
    shared, level = set.intersection(*keys), "all"
    pairs = [{"names": [a["name"], b["name"]], "words": sorted(a["words"][k]["name"] for k in set(a["words"]) & set(b["words"]))}
             for a, b in combinations(rows, 2)]
    if not shared and len(rows) > 2:  # the words most of them share
        counts: dict[str, int] = {}
        for k in keys:
            for w in k:
                counts[w] = counts.get(w, 0) + 1
        top = max(counts.values())
        if top >= 2:
            shared, level = {w for w, n in counts.items() if n == top}, "most"
    if not shared:  # nothing in common by name: how they read as one family
        together = await _reading(list(dict.fromkeys(i for r in rows for i in r["ids"])))
        shared, level = set(together), "together"
        for r in rows:
            r["words"] = {**together, **r["words"]}
    names = {k: next(r["words"][k]["name"] for r in rows if k in r["words"]) for k in shared}
    heart_words = sorted(names.values())
    own = []
    for i, r in enumerate(rows):
        others = set().union(*[k for j, k in enumerate(keys) if j != i]) if len(rows) > 1 else set()
        own.append({"name": r["name"], "only": sorted(r["words"][k]["name"] for k in set(r["words"]) - others)[:14], "loves": r["named"][:6]})
    prompt = (f"THE HOME: {json.dumps(home)}\nHEART WORDS: {', '.join(heart_words[:30])}\nWHAT EACH PERSON HAS OF THEIR OWN: {json.dumps(own)}\n"
              f"WHAT PAIRS SHARE: {json.dumps(pairs)[:1500]}")
    out: dict = {}
    try:
        text = await asyncio.wait_for(llm.generate_text(config.MODEL_INTAKE, prompt, system=SYSTEM, max_tokens=1500, json_mode=True, thinking=False), timeout=40)
        out = llm.parse_json(text)
    except Exception as e:
        log.warning("heart wording failed: %r", e)
    allowed = {w.lower(): w for w in heart_words}
    words = [allowed[str(w).strip().lower()] for w in out.get("words") or [] if str(w).strip().lower() in allowed][:2] or heart_words[:2]
    by = {str(p.get("name")): p for p in out.get("people") or [] if isinstance(p, dict)}
    return {"words": words, "line": str(out.get("line") or "")[:140] or None, "room": str(out.get("room") or "")[:40] or None, "level": level,
            "people": [{"id": r["id"], "name": r["name"], "room": str(by.get(r["name"], {}).get("room") or "")[:40] or None,
                        "line": str(by.get(r["name"], {}).get("line") or "")[:100] or None} for r in rows],
            "between": [{"names": b["names"], "space": str(b.get("space") or "")[:40]} for b in out.get("between") or []
                        if isinstance(b, dict) and b.get("names") and b.get("space")][:3],
            "threads": [], "shared": heart_words[:12], "at": db.now()}


async def trace(people: list[dict], words: list[str]) -> list[dict]:
    """Which of each person's favourites carries each heart word. Slower than the words, so it arrives just after them."""
    resolved = await asyncio.gather(*[qloo.resolve([{**f, "who": p["name"]} for f in p.get("favourites") or []]) for p in people])
    rows = [{"name": p["name"], "ids": [r["entity"]["id"] for r in items if r.get("entity")],
             "loved": {r["entity"]["id"]: {"name": r["name"], "image": r.get("image") or r["entity"].get("image")} for r in items if r.get("entity")}}
            for p, items in zip(people, resolved)]
    return await _threads(words, rows)


SKIP_NEAR = {"convention center", "meeting planning service", "hotel", "resort hotel", "tourist attraction", "lake", "park", "shopping mall",
             "state government office", "coffee store", "fast food restaurant"}


async def near_home(family: list[dict], location: str) -> list[dict]:
    """A little of where their hearts live, close to the new house. Shown only when it is real: a place counts if the heart
    pulled it up and it isn't simply what's popular there anyway, and with fewer than three there is nothing to say."""
    ids = [f["id"] for p in family for f in p.get("favourites") or [] if f.get("heart") and f.get("id")]
    if not ids or not location:
        return []
    try:
        center = await qloo.locate(location)
        places, usual = await asyncio.gather(qloo.places_near(location, ids, take=12, center=center, radius=8000),
                                             qloo.places_near(location, None, take=30, center=center, radius=8000))
    except qloo.QlooError as e:
        log.warning("near home failed: %s", e)
        return []
    popular = {x["name"] for x in usual}
    found = [{"name": x["name"], "image": x.get("image"), "category": x.get("category")} for x in places
             if x.get("category") and x["name"] not in popular and x["category"].lower() not in SKIP_NEAR]
    return found[:4] if len(found) >= 3 else []
