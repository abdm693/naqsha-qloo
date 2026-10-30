"""The taste agent: the family's favourites and their neighbourhood -> Qloo's taste graph -> the family's style brief.

1. Gather (deterministic, in parallel): every favourite is matched to a Qloo entity; Qloo's Taste Analysis gives the tags
   each person's favourites point to, and the family's together; Qloo also returns destinations and brands people with that
   taste love, how the neighbourhood feels, and places there that suit the family.
2. Explore (Gemini 4 Argon with Qloo tools, a few steps): the agent looks further where the first pass is thin or
   surprising (a destination worth reading, a tag type it wants, local shops for the interiors).
3. Write: Argon turns the evidence into the style brief: exterior, interiors, a room for each person, landscape, the four
   concept directions and the decisions, every one citing the Qloo evidence behind it (`because`: evidence ids).

Qloo knows taste, not architecture: the agent's job is the translation, and the brief keeps the two apart (what Qloo
returned vs what Naqsha decided because of it).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator

from .. import config, llm, qloo

log = logging.getLogger("naqsha.taste")

TOOLS = [
    {"type": "function", "function": {"name": "qloo_taste", "description": "Qloo Taste Analysis: the tags a set of Qloo "
     "entities points to. Optionally restrict to tag types (e.g. urn:tag:ambience:qloo, urn:tag:decor:qloo, "
     "urn:tag:setting:qloo, urn:tag:genre:media, urn:tag:keyword:media, urn:tag:style:qloo).",
     "parameters": {"type": "object", "properties": {"entity_ids": {"type": "array", "items": {"type": "string"}},
                                                    "tag_types": {"type": "array", "items": {"type": "string"}}},
                    "required": ["entity_ids"]}}},
    {"type": "function", "function": {"name": "qloo_similar", "description": "Entities of one type that people with this "
     "taste love: destination, brand, place, movie, tv_show, artist, book.",
     "parameters": {"type": "object", "properties": {"type": {"type": "string"}, "entity_ids": {"type": "array", "items": {"type": "string"}}},
                    "required": ["type", "entity_ids"]}}},
    {"type": "function", "function": {"name": "qloo_places", "description": "Places in a locality ranked for the family's "
     "taste, optionally narrowed by a keyword that is first matched to Qloo tags (e.g. 'furniture store', 'home decor', "
     "'art gallery', 'garden centre', 'cafe').",
     "parameters": {"type": "object", "properties": {"location": {"type": "string"}, "keyword": {"type": "string"}},
                    "required": ["location"]}}},
    {"type": "function", "function": {"name": "qloo_search", "description": "Find a Qloo entity by name (and kind: film, "
     "show, artist, book, podcast, destination, restaurant, brand).",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "kind": {"type": "string"}}, "required": ["name"]}}},
    {"type": "function", "function": {"name": "done", "description": "Enough evidence: write the style brief next.",
     "parameters": {"type": "object", "properties": {}}}},
]

EXPLORE_SYSTEM = """You are Naqsha's taste researcher. A family is designing their home and told us what they love. You have
Qloo's taste graph as tools, and a first pass of evidence (each item has an id like E3 or T7). Look further only where it
will change the design: a place-feel reading of their favourite destinations, local shops for the interiors, a taste you
want confirmed. At most 4 tool calls in total, then call done. Never send personal data to the tools."""

WRITE_SYSTEM = """You are Naqsha's architect and interior designer. A family's home must feel like them: designed from their
taste, not a template. You get the brief (plot, city, rooms) and EVIDENCE from Qloo's taste graph: their favourites, the
taste tags those favourites point to (per person and together), destinations and brands people with that taste love, how
their neighbourhood feels, and places there. Every evidence item has an id (E… entity, T… tag, P… place).

Translate taste into architecture with judgment: Qloo knows taste, not buildings, so read the tags like a designer reads a
mood board (e.g. "cozy", "historic", "rustic" + Istanbul + Coke Studio -> warm brick, carved timber screens, a courtyard;
"minimalist", "serene" + Kyoto -> calm planes, timber, shadow gaps). Stay buildable on their plot and respectful of the
local climate and rules. Keep the family's own wishes from the brief. Be specific: name materials, finishes and colours.
Cite evidence ids in every `because` (2-4 ids, the ones that really drove the choice). Never invent evidence ids.

Write JSON only:
{
 "headline": "a short name for their style, 3-6 words",
 "story": "2-3 warm sentences: who this family is through their taste, and what their home will feel like",
 "family_tags": [{"name": "tag name as Qloo gave it", "id": "T…"}],            // 6-10 strongest shared tags
 "people": [{"label": "as given", "signature": "one line on their taste", "tags": ["…"], "room": "the room that follows them",
             "because": ["…"]}],
 "exterior": {"style": "e.g. Warm Modern with Mughal craft", "massing": "…", "materials": ["…"], "palette": [{"name": "…", "hex": "#…"}],
              "details": ["…"], "because": ["…"]},
 "interiors": {"mood": "…", "palette": [{"name": "…", "hex": "#…"}], "materials": ["…"], "lighting": "…", "furniture": "…",
               "objects": "art, textiles, books, music corner…", "because": ["…"]},
 "rooms": [{"room": "lounge | drawing | kitchen | master_bedroom | bedroom | kids_bedroom | parents_bedroom | study | terrace",
            "for": "person label or 'everyone'", "mood": "…", "palette": ["#…"], "ideas": ["…"], "because": ["…"]}],
 "landscape": {"idea": "…", "plants": ["…"], "because": ["…"]},
 "neighbourhood": {"reading": "how the area feels, from Qloo", "response": "how the house answers it", "because": ["…"]},
 "takes": [{"title": "2-4 words", "direction": "massing + materials + palette for one concept image", "why": "one line",
            "because": ["…"]}],                                                  // exactly 4: the family's shared taste,
                                                                                // the parents' (or first person's) taste,
                                                                                // a fit with the neighbourhood, a bolder
                                                                                // direction from an adjacent taste
 "decisions": [{"decision": "short, concrete", "reason": "one line in plain words", "because": ["…"]}],   // 6-10
 "shop": [{"id": "P…", "why": "one line"}]                                      // 0-6 local places for the interiors
}
Plain, warm, specific English. No emoji. No "not X but Y"."""


class Evidence:
    """Every Qloo result the agent may cite, with a short id (E entity, T tag, P place)."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self._by_key: dict[str, str] = {}
        self.n = {"E": 0, "T": 0, "P": 0}

    def add(self, prefix: str, item: dict, via: str) -> str:
        key = f"{prefix}:{item.get('id') or item.get('name')}"
        if key in self._by_key:
            eid = self._by_key[key]
            if via not in self.items[eid]["via"]:
                self.items[eid]["via"].append(via)
            return eid
        self.n[prefix] += 1
        eid = f"{prefix}{self.n[prefix]}"
        self._by_key[key] = eid
        self.items[eid] = {**{k: v for k, v in item.items() if v not in (None, "", [], {})}, "eid": eid, "via": [via]}
        return eid

    def by_qloo_id(self, qid: str) -> str | None:
        return next((k for k, v in self.items.items() if v.get("id") == qid), None)

    def compact(self) -> str:
        lines = []
        for eid, it in self.items.items():
            bits = [eid, it.get("name") or "", (it.get("type") or "").replace("urn:entity:", "").replace("urn:tag:", "")]
            if it.get("affinity") is not None:
                bits.append(f"affinity {round(float(it['affinity']), 2)}")
            if it.get("tags"):
                bits.append("tags: " + ", ".join(t["name"] for t in it["tags"][:10] if t.get("name")))
            if it.get("keywords"):
                bits.append("keywords: " + ", ".join(map(str, it["keywords"][:8])))
            if it.get("brand_adjectives"):
                bits.append(f"adjectives: {it['brand_adjectives']}")
            if it.get("address"):
                bits.append(str(it["address"])[:80])
            bits.append("via " + "; ".join(it["via"][:3]))
            if it.get("from"):
                bits.append("from " + ", ".join(it["from"][:4]))
            lines.append(" | ".join(b for b in bits if b))
        return "\n".join(lines)


def _people(taste: dict) -> list[dict]:
    return [p for p in taste.get("people") or [] if any((f.get("name") or "").strip() for f in p.get("favourites") or [])]


def _location(brief: dict, taste: dict) -> str | None:
    if taste.get("location"):
        return taste["location"]
    bits = [brief.get("scheme"), brief.get("city")]
    return ", ".join(b for b in bits if b) or None


async def gather(brief: dict, taste: dict, ev: Evidence) -> AsyncIterator[tuple[str, dict]]:
    people = _people(taste)
    loc = _location(brief, taste)
    yield "step", {"id": "resolve", "message": "Finding your favourites in Qloo's taste graph"}
    resolved = await asyncio.gather(*[qloo.resolve([{**f, "who": p.get("label") or "You"} for f in p.get("favourites") or []])
                                      for p in people])
    found, missing = [], []
    for p, items in zip(people, resolved):
        ids = []
        for it in items:
            if it.get("entity"):
                eid = ev.add("E", it["entity"], f"{it['who']}'s favourite")
                ids.append(it["entity"]["id"])
                found.append({"eid": eid, "who": it["who"], "asked": it["name"], "name": it["entity"]["name"],
                              "type": it["entity"].get("type"), "image": it["entity"].get("image")})
            else:
                missing.append({"who": it["who"], "asked": it["name"]})
        p["_ids"] = ids
    yield "favourites", {"found": found, "missing": missing}
    family_ids = list(dict.fromkeys(i for p in people for i in p["_ids"]))
    if not family_ids:
        return

    yield "step", {"id": "taste", "message": "Reading the taste behind them"}
    jobs = {"family": qloo.taste_tags(family_ids, take=30),
            "family_feel": qloo.taste_tags(family_ids, qloo.FEEL_TAGS, take=20),
            "destinations": qloo.affinities("urn:entity:destination", family_ids, take=8),
            "brands": qloo.affinities("urn:entity:brand", family_ids, take=10)}
    for i, p in enumerate(people):
        if p["_ids"]:
            jobs[f"person{i}"] = qloo.taste_tags(p["_ids"], take=16)
    if loc:
        jobs["area"] = qloo.area_tags(loc, family_ids, take=16)
        jobs["places"] = qloo.places_near(loc, family_ids, take=8)
    keys = list(jobs)
    out = dict(zip(keys, await asyncio.gather(*jobs.values(), return_exceptions=True)))
    for k, v in out.items():
        if isinstance(v, Exception):
            log.warning("qloo %s failed: %s", k, v)
            out[k] = []

    def cite_tags(tags, via):
        res = []
        for t in tags:
            frm = [ev.by_qloo_id(x["id"]) for x in t.get("explain") or []]
            eid = ev.add("T", {**t, "from": [f for f in frm if f]}, via)
            res.append({"eid": eid, "name": t["name"], "type": t.get("type"), "affinity": t.get("affinity"),
                        "from": [f for f in frm if f]})
        return res

    profile: dict = {"family": cite_tags(out["family"], "the family's taste"),
                     "feel": cite_tags(out["family_feel"], "how the family likes a place to feel"), "people": []}
    for i, p in enumerate(people):
        tags = out.get(f"person{i}") or []
        profile["people"].append({"label": p.get("label") or "You", "role": p.get("role"),
                                  "tags": cite_tags(tags, f"{p.get('label') or 'You'}'s taste")})
    profile["destinations"] = [{"eid": ev.add("E", d, "destinations people with this taste love"), "name": d["name"],
                                "image": d.get("image"), "affinity": d.get("affinity")} for d in out["destinations"]]
    profile["brands"] = [{"eid": ev.add("E", b, "brands people with this taste love"), "name": b["name"], "image": b.get("image"),
                          "adjectives": b.get("brand_adjectives")} for b in out["brands"]]
    if loc:
        profile["area"] = {"location": loc, "tags": cite_tags(out.get("area") or [], f"how {loc} feels"),
                           "places": [{"eid": ev.add("P", x, f"places in {loc} that suit the family"), "name": x["name"],
                                       "address": x.get("address"), "image": x.get("image"),
                                       "tags": [t["name"] for t in x.get("tags") or []][:5]} for x in out.get("places") or []]}
    yield "profile", profile


async def explore(brief: dict, taste: dict, ev: Evidence, max_steps: int = 5) -> AsyncIterator[tuple[str, dict]]:
    """A few Argon tool steps against Qloo; each call is shown to the family as it happens."""
    loc = _location(brief, taste)
    msgs = [{"role": "system", "content": EXPLORE_SYSTEM},
            {"role": "user", "content": f"THE HOME: {json.dumps({k: brief.get(k) for k in ('city', 'scheme', 'storeys', 'bedrooms', 'preferences', 'style') if brief.get(k)})}\n"
                                        f"LOCALITY: {loc or 'unknown'}\n\nEVIDENCE SO FAR:\n{ev.compact()}"}]
    t0, calls = time.monotonic(), 0
    for _ in range(max_steps):
        if time.monotonic() - t0 > 75 or calls >= 4:
            break
        try:
            resp = await asyncio.wait_for(llm.client().chat.completions.create(
                model=llm.model_id(config.MODEL_TASTE), messages=msgs, tools=TOOLS, tool_choice="auto", max_tokens=2048,
                reasoning_effort="low"), timeout=60)
        except Exception as e:
            log.warning("taste explore step failed: %r", e)
            break
        m = resp.choices[0].message
        tc = m.tool_calls or []
        msgs.append({"role": "assistant", "content": m.content or "",
                     "tool_calls": [{"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}} for c in tc]})
        if not tc:
            break
        stop = False
        for c in tc:
            try:
                a = json.loads(c.function.arguments or "{}")
            except json.JSONDecodeError:
                a = {}
            name, result = c.function.name, None
            if name == "done":
                stop = True
                result = {"ok": True}
            else:
                calls += 1
                try:
                    if name == "qloo_taste":
                        yield "step", {"id": f"x{calls}", "message": "Asking Qloo for more of the taste behind them", "tool": name}
                        tags = await qloo.taste_tags([i for i in a.get("entity_ids") or [] if isinstance(i, str)][:12],
                                                     a.get("tag_types") or None, take=12)
                        result = [{"eid": ev.add("T", t, "a closer look at the family's taste"), "name": t["name"], "type": t.get("type")} for t in tags]
                    elif name == "qloo_similar":
                        typ = str(a.get("type") or "destination").replace("urn:entity:", "")
                        yield "step", {"id": f"x{calls}", "message": f"Asking Qloo which {typ.replace('_', ' ')}s people with this taste love", "tool": name}
                        ents = await qloo.affinities(f"urn:entity:{typ}", [i for i in a.get("entity_ids") or [] if isinstance(i, str)][:12], take=6)
                        result = [{"eid": ev.add("E", e, f"{typ}s people with this taste love"), "name": e["name"],
                                   "tags": [t["name"] for t in e.get("tags") or []][:8]} for e in ents]
                    elif name == "qloo_places":
                        where = a.get("location") or loc
                        kw = (a.get("keyword") or "").strip()
                        yield "step", {"id": f"x{calls}", "message": f"Looking for {kw or 'places'} in {where} that suit the family", "tool": name}
                        tag_ids = [t["id"] for t in await qloo.find_tags(kw, take=3)] if kw else None
                        fam = [v["id"] for v in ev.items.values() if v["eid"].startswith("E") and any("favourite" in x for x in v["via"])]
                        ps = await qloo.places_near(where, fam[:12], tag_ids, take=6)
                        result = [{"eid": ev.add("P", x, f"{kw or 'places'} in {where}"), "name": x["name"], "address": x.get("address"),
                                   "tags": [t["name"] for t in x.get("tags") or []][:6]} for x in ps]
                    elif name == "qloo_search":
                        yield "step", {"id": f"x{calls}", "message": f"Looking up {a.get('name')} in Qloo", "tool": name}
                        hits = await qloo.search(a.get("name") or "", a.get("kind"), take=2)
                        result = [{"eid": ev.add("E", h, "looked up by the agent"), "id": h["id"], "name": h["name"],
                                   "tags": [t["name"] for t in h.get("tags") or []][:8]} for h in hits]
                except qloo.QlooError as e:
                    result = {"error": str(e)[:200]}
            msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(result, default=str)[:6000]})
        if stop:
            break


def _clean(sb: dict, ev: Evidence) -> dict:
    """Keep only real evidence ids; attach a small card for each cited id so the app can show 'because' chips."""
    def ok(ids):
        return [i for i in ids or [] if isinstance(i, str) and i in ev.items][:5]

    def walk(x):
        if isinstance(x, dict):
            return {k: (ok(v) if k == "because" else walk(v)) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x
    sb = walk(sb)
    sb["takes"] = [t for t in sb.get("takes") or [] if isinstance(t, dict) and t.get("title") and t.get("direction")][:4]
    sb["shop"] = [s for s in sb.get("shop") or [] if isinstance(s, dict) and s.get("id") in ev.items]
    cited = set()

    def collect(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k == "because":
                    cited.update(v)
                elif k == "id" and isinstance(v, str) and v in ev.items:
                    cited.add(v)
                else:
                    collect(v)
        elif isinstance(x, list):
            for v in x:
                collect(v)
    collect(sb)
    sb["evidence"] = {i: {k: ev.items[i].get(k) for k in ("eid", "name", "type", "image", "address", "via", "from", "affinity")
                          if ev.items[i].get(k) not in (None, "", [])} for i in sorted(cited)}
    return sb


async def write(brief: dict, taste: dict, ev: Evidence) -> dict:
    people = [{"label": p.get("label"), "role": p.get("role"), "favourites": [f.get("name") for f in p.get("favourites") or []]}
              for p in _people(taste)]
    home = {k: brief.get(k) for k in ("city", "scheme", "authority", "plot", "storeys", "bedrooms", "floors", "spaces",
                                      "preferences", "style", "style_notes") if brief.get(k) not in (None, "", [], {})}
    prompt = (f"THE HOME: {json.dumps(home)}\nTHE FAMILY: {json.dumps(people)}\nLOCALITY: {_location(brief, taste) or 'unknown'}\n"
              f"EXTRA WORDS FROM THE FAMILY: {taste.get('notes') or '-'}\n\nEVIDENCE (Qloo):\n{ev.compact()}\n\nWrite the style brief.")
    out = None
    async for kind, val in llm.stream_json(config.MODEL_TASTE, prompt, WRITE_SYSTEM, max_tokens=12000, attempts=2, thinking="LOW"):
        if kind == "result":
            out = val[0]
    return _clean(out or {}, ev)


async def run(brief: dict, taste: dict) -> AsyncIterator[tuple[str, dict]]:
    """The whole taste pass, as events for the app: step, favourites, profile, step…, brief."""
    ev = Evidence()
    profile = None
    async for e in gather(brief, taste, ev):
        if e[0] == "profile":
            profile = e[1]
        yield e
    if not profile:
        yield "error", {"message": "Qloo didn't recognise any of these favourites yet. Try a few more well-known ones: a film, "
                                   "an artist, a city you loved."}
        return
    yield "step", {"id": "explore", "message": "Following the threads that matter for your home"}
    async for e in explore(brief, taste, ev):
        yield e
    yield "step", {"id": "write", "message": "Turning your taste into architecture"}
    sb = await write(brief, taste, ev)
    yield "brief", {"profile": profile, "style": sb}
