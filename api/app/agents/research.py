"""Bylaw research for places Naqsha has no rule pack for (Tavily web search + Gemini).

Naqsha ships one hand-verified rule pack: the LDA regulations for Lahore. For any other city or authority (CDA Islamabad,
SBCA Karachi, RDA Rawalpindi, FDA Faisalabad, Dubai Municipality…) the setup agent calls `research`:

1. Tavily searches the web for the authority's residential building regulations (setbacks, ground coverage, FAR, height and
   storeys by plot size) and extracts the most relevant pages, official ones first.
2. Gemini 4 Argon reads those pages and writes a rule pack: the same numbers the LDA pack holds for a house, band by plot
   size, each band citing the pages it came from. Anything the pages don't state stays on the LDA baseline and says so.
3. The pack is cached in Firestore (one document per authority) and registered with the rules engine, so the envelope,
   the plan checks and the fix loop use it like the LDA pack.

A researched pack is a draft for the family and their architect to confirm with the authority, and the app says so.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time

import httpx

from .. import config, llm
from ..compliance import lda
from ..store import db

log = logging.getLogger("naqsha.research")
TAVILY = "https://api.tavily.com"
OFFICIAL = re.compile(r"\.(gov|gop|gob|govt)\.|\.gov$|\.gov\.|municipality|authority|\.org\.pk|cda\.gov|sbca\.gos\.pk|dm\.gov\.ae", re.I)
PACK_TTL_S = 30 * 24 * 3600

PACK_SYSTEM = """You are a building-regulations researcher. From the web pages given, extract the residential (single-family
house) building rules of ONE authority, the way an architect would set up a rule pack before designing.
Use only what the pages say. Never invent a number: leave a field null when no page states it. Prefer official sources
(the authority's own site or gazette) over property portals and blogs, and say which you used.
Return JSON:
{"authority": "<short code, e.g. CDA>", "authority_name": "<full name>", "city": "<city>", "instrument": "<the regulations'
title and year if stated>",
 "bands": [{"label": "<plot size band as the source names it, e.g. 10 marla to 1 kanal>", "min_sqft": <number>, "max_sqft":
 <number or null for no upper limit>, "setbacks_ft": {"front": <ft>, "rear": <ft>, "side": <ft or 0>, "side_count": <0, 1 or
 2>}, "max_coverage_pct": <number or null>, "max_far": <number or null>, "max_height_ft": <number or null>, "max_storeys":
 <integer or null>, "sources": ["<source ids, e.g. T1>"]}],
 "sources": [{"id": "T1", "title": "...", "url": "...", "official": true | false}],
 "caveats": ["<one plain sentence each: what is uncertain or must be confirmed with the authority>"]}
Bands are ordered by plot size, cover the plot sizes the pages describe, and convert metres to feet (1 m = 3.281 ft) and
square metres or marla to square feet (1 m² = 10.764 sq ft; 1 marla = 225 sq ft in Punjab and Islamabad, 272.25 elsewhere
unless the page says otherwise)."""


def slug(authority: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(authority or "").lower()).strip("-")[:60] or "other"


async def _tavily(path: str, body: dict, timeout: float = 60) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{TAVILY}/{path}", json=body, headers={"Authorization": f"Bearer {config.TAVILY_API_KEY}"})
        r.raise_for_status()
        return r.json()


async def gather(city: str, authority: str) -> tuple[list[dict], str]:
    """Tavily: two searches (setbacks and coverage; height and storeys), then extract the best pages. Returns (pages, answer)."""
    who = f"{authority} {city}".strip()
    queries = [f"{who} residential building regulations setbacks ground coverage by plot size",
               f"{who} house building bylaws maximum height storeys FAR"]
    found = await asyncio.gather(*[_tavily("search", {"query": q, "search_depth": "advanced", "max_results": 6,
                                                       "include_answer": "advanced", "chunks_per_source": 3}) for q in queries],
                                 return_exceptions=True)
    results, answers = {}, []
    for f in found:
        if isinstance(f, Exception):
            log.warning("tavily search failed: %s", f)
            continue
        if f.get("answer"):
            answers.append(f["answer"])
        for r in f.get("results") or []:
            if r.get("url") and "instagram.com" not in r["url"] and "facebook.com" not in r["url"]:
                prev = results.get(r["url"])
                bonus = 0.25 if OFFICIAL.search(r["url"]) else 0
                if not prev or r.get("score", 0) + bonus > prev["rank"]:
                    results[r["url"]] = {**r, "rank": r.get("score", 0) + bonus, "official": bool(bonus)}
    ranked = sorted(results.values(), key=lambda r: r["rank"], reverse=True)
    pages = [{"title": r.get("title") or r["url"], "url": r["url"], "official": r["official"], "content": r.get("content") or ""}
             for r in ranked[:6]]
    if pages:
        try:
            ex = await _tavily("extract", {"urls": [p["url"] for p in pages[:4]], "extract_depth": "advanced",
                                           "query": "residential setbacks, ground coverage, FAR, height and storeys by plot size",
                                           "chunks_per_source": 5}, timeout=90)
            full = {e["url"]: e.get("raw_content") or "" for e in ex.get("results") or []}
            for p in pages:
                if full.get(p["url"]):
                    p["content"] = full[p["url"]][:9000]
        except Exception as e:
            log.warning("tavily extract failed: %s", e)
    return pages, "\n".join(answers)


def _num(v, lo: float, hi: float):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if lo <= f <= hi else None


def clean_pack(raw: dict, pages: list[dict]) -> dict | None:
    """Keep only bands with sane numbers; sources by id; None when nothing usable came back."""
    urls = {p["url"] for p in pages}
    sources = [s for s in raw.get("sources") or [] if isinstance(s, dict) and s.get("url")]
    for s in sources:
        s["official"] = bool(s.get("official")) or bool(OFFICIAL.search(s["url"]))
        s["fetched"] = s["url"] in urls
    bands = []
    for b in raw.get("bands") or []:
        if not isinstance(b, dict):
            continue
        sb = b.get("setbacks_ft") or {}
        front, rear = _num(sb.get("front"), 0, 80), _num(sb.get("rear"), 0, 80)
        lo = _num(b.get("min_sqft"), 0, 500000)
        if front is None or rear is None or lo is None:
            continue
        bands.append({"label": str(b.get("label") or "")[:60], "min_sqft": lo, "max_sqft": _num(b.get("max_sqft"), 1, 1e7),
                      "setbacks_ft": {"front": front, "rear": rear, "side": _num(sb.get("side"), 0, 40) or 0.0,
                                      "side_count": int(_num(sb.get("side_count"), 0, 2) or 0)},
                      "max_coverage_pct": _num(b.get("max_coverage_pct"), 20, 100), "max_far": _num(b.get("max_far"), 0.3, 10),
                      "max_height_ft": _num(b.get("max_height_ft"), 15, 200),
                      "max_storeys": int(_num(b.get("max_storeys"), 1, 12)) if _num(b.get("max_storeys"), 1, 12) else None,
                      "sources": [str(x) for x in b.get("sources") or []][:4]})
    if not bands:
        return None
    bands.sort(key=lambda b: b["min_sqft"])
    return {"authority": str(raw.get("authority") or "").strip()[:24], "authority_name": str(raw.get("authority_name") or "")[:120],
            "city": str(raw.get("city") or "")[:60], "instrument": str(raw.get("instrument") or "")[:200], "bands": bands,
            "sources": sources[:8], "caveats": [str(c)[:240] for c in raw.get("caveats") or []][:4]}


async def research(city: str, authority: str, force: bool = False) -> dict | None:
    """The rule pack for an authority: cached (30 days), else researched now (about 30 to 60 seconds). Registered with the
    rules engine under `authority`."""
    key = slug(authority or city)
    if not force:
        cached = await db.get_rulepack(key)
        if cached and time.time() - cached.get("_at", 0) < PACK_TTL_S:
            lda.register_pack(authority, cached)
            return cached
    if not config.TAVILY_API_KEY:
        return None
    t0 = time.monotonic()
    pages, answer = await gather(city, authority)
    if not pages:
        return None
    text = "\n\n".join(f"SOURCE T{i} — {p['title']} ({p['url']}){' [official]' if p['official'] else ''}\n{p['content']}"
                       for i, p in enumerate(pages, 1))
    prompt = (f"AUTHORITY: {authority}\nCITY: {city}\n\nSEARCH SUMMARY (unverified, for orientation only):\n{answer[:2000]}\n\n"
              f"PAGES:\n{text}\n\nWrite the rule pack now. Source ids are T1…T{len(pages)} as above.")
    raw = None
    async for kind, val in llm.stream_json(config.MODEL_INTAKE, prompt, PACK_SYSTEM, max_tokens=8192, attempts=2, thinking="LOW"):
        if kind == "result":
            raw = val[0]
    pack = clean_pack(raw or {}, pages)
    if not pack:
        log.warning("research for %s found no usable bands", authority)
        return None
    by_id = {f"T{i}": p for i, p in enumerate(pages, 1)}
    for s in pack["sources"]:  # the model's source list, re-tied to the pages actually read
        if s.get("id") in by_id:
            s["url"], s["fetched"] = by_id[s["id"]]["url"], True
    pack.update(key=key, requested={"city": city, "authority": authority}, seconds=round(time.monotonic() - t0, 1), _at=time.time(),
                researched_with="Tavily search + extract; Gemini 3.8 Flash on Vertex AI")
    await db.save_rulepack(key, pack)
    lda.register_pack(authority, pack)
    log.info("researched %s in %.0fs: %d bands, %d sources", authority, pack["seconds"], len(pack["bands"]), len(pack["sources"]))
    return pack


async def ensure(authority: str | None) -> None:
    """Load a researched pack into the rules engine before a run (any Cloud Run instance may serve it)."""
    if not authority or authority.upper() in lda.BUILTIN_AUTHORITIES or lda.has_pack(authority):
        return
    try:
        cached = await db.get_rulepack(slug(authority))
        if cached:
            lda.register_pack(authority, cached)
    except Exception:
        log.exception("loading rule pack %s failed", authority)


def summary(pack: dict) -> dict:
    """What the setup agent and the brief show: the bands and the sources, without the cache fields."""
    return {k: v for k, v in pack.items() if not k.startswith("_")}
