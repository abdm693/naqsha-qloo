"""The architect: Gemini Argon designs the house in three steps.

1. Plan: a BuildingPlan JSON. Deterministic repairs (openings snapped onto their walls, code stairs fitted into their hall,
   the stair tower over the stair) run on every attempt; the LDA engine and Naqsha's planning rules check it and their
   failures, with fix hints, go back to Argon (up to PLAN_MAX_ATTEMPTS). The best attempt wins, not the last.
2. Self-review: each floor is drawn as an image (Pillow) and Argon critiques it like a senior architect, with a room table,
   the adjacency list and the brief. Real problems get a revision pass (plus one fix round), kept only if it breaks no rule and
   changes what a major issue is about; issues left open become livable warnings in the report. The review is skipped when
   planning already took long; the 3D build of the checked plan starts while it runs.
3. Build: Argon writes design.js, sections of code against the House SDK, streamed one section at a time.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import AsyncIterator

from google.genai import types

from .. import config, llm
from ..compliance import lda, planning
from ..gemini import client
from ..store import blobs, db
from . import concepts, drawing, fixer, importer, jsfix, research
from .intake import FACING_NAME

log = logging.getLogger("naqsha.architect")
ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
EXAMPLES = Path(__file__).with_name("examples")
EXAMPLE_PLAN = EXAMPLES / "plan-10-marla.json"
# Proven layouts (they pass every LDA check), by plot size: the planner adapts the nearest one instead of starting blank.
TEMPLATES = [(15.0, EXAMPLES / "plan-10-marla-4bed.json"), (999.0, EXAMPLES / "plan-1-kanal.json")]


def template_for(brief: dict) -> dict:
    marla = float((brief.get("plot") or {}).get("area_marla") or 10)
    path = next(p for cap, p in TEMPLATES if marla < cap)
    return json.loads(_read(path))


def _read(path: Path) -> str:
    return path.read_text() if path.exists() else ""


PLAN_SYSTEM = """You are a senior Lahore architect and a precise space planner. You design single-family houses that comply with
the LDA Building & Zoning Regulations 2019 (consolidated 2026) and that a family will love living in for decades.

Output ONE BuildingPlan JSON. Follow the conventions in the TypeScript reference exactly:
- FEET; origin at the plot's front-left corner; +x along the road, +y into the plot; the road is at y < 0.
- Rooms are axis-aligned rectangles. Rooms on the same level never overlap; neighbouring rooms share edges exactly. Snap
  coordinates to 0.5 ft (0.25 where needed). At ground level, tile the building envelope fully.
- Every building room (all types except lawn/driveway/open_space/courtyard) lies inside the setback lines, porches and
  balconies included. Add outdoor rooms for the open spaces: driveway and lawn in front, open_space for side and rear spaces.
- Openings: `at` is a point ON the wall the two rooms share (or on the room's own outside wall for "exterior"), on the same
  level. Windows go on outside walls or onto a same-level porch, balcony, terrace or open_space; never on a party wall (a
  plot edge with zero setback). Two openings on the same wall keep at least 0.5 ft of wall between them (a window beside the
  main door included), or the later one can't be built.
- LDA minimums: habitable rooms ≥ 100 sq ft and ≥ 8 ft wide; kitchen ≥ 50 sq ft and ≥ 6 ft wide; clear height ≥ 9.5 ft (11 ft
  floor-to-floor, 0.5 ft slab); windows ≥ 8% of the floor area for habitable rooms and kitchens; parapet 3.5 ft; mumty ≤ 9.5 ft;
  boundary walls ≤ 7 ft; height, storeys and ground coverage within the envelope.
- Every bath and powder room touches an outside wall (or a same-floor open_space or terrace) and gets a "ventilator" opening
  (about 2 × 1.5 ft, between [bath, "exterior"]) on that wall. A bath with no outside wall fails; never wedge one between rooms
  against a party wall.
- An open_space or courtyard that lights rooms stays open to the sky: nothing on any floor above covers it (no room, terrace or
  balcony; leave an open_space void with a railing over it).
- Car porch: a 9 × 18 ft bay per car in brief.spaces car_porch:N, plus a 3 ft 6 in walkway past the cars to the main door
  (2 cars side by side: at least 21.5 ft wide × 18 ft deep, or 18 ft wide × 21.5 ft deep). A bay may be as little as 14 ft
  deep only where the porch opens straight onto the driveway or the front open space (the car's tail stands out over it).
  When the brief mentions a motorbike (brief.spaces motorbike, or the preferences), add a 3 × 7 ft motorbike bay in the porch,
  clear of the cars and the walkway: the porch is 3 ft wider (or 3 ft deeper) than the cars and walkway need.
- Levels: ground (index 0, elevation = plinth 1.5), first, second as needed, then a final "roof" level whose height_ft equals
  the parapet height.
- Storeys: every level with an enclosed room counts as a storey, the roof included; only the stair tower (mumty) is
  excluded. When brief.storeys equals the envelope's max_storeys, the roof holds only the stair tower, the water tank, solar
  and open terraces: put the laundry, stores, servant rooms, gym and kitchenette on the floors below.

STAIRS (objective geometry, checked):
- For 11 ft floor-to-floor: 19 risers of 6.95 in, 10 in treads, 3.5 ft flights, so a dog-leg rect of 7.5 ft × 11 ft along `start`.
- A dog-leg STARTS and ARRIVES at its start edge (min-y edge for "+y", max-y for "-y", min-x for "+x", max-x for "-x"). On every
  floor the stair hall = the stair rect + 3.5 ft clear at that edge, across its full breadth (≥ 8 × 14.5 ft). That strip is the
  landing at the foot and at the top: connect it to the floor and keep door swings out of it. On the floor below a flight, no
  door opens under the flights or the mid-landing (there is no headroom there): doors into the stair hall sit on the landing
  strip.
- One stair per level transition INCLUDING the top storey to the roof, all stacked (same rect, kind and start).
- roof.mumty.rect = the top-floor stair hall; roof.mumty.door_side = the start-end side (front for "+y", back for "-y", left
  for "+x", right for "-x"). If that side is a party wall, use a long side and make the hall ≥ 3.6 ft longer than the stair there.

ARCHITECT'S COMMON SENSE: plan the way a thoughtful Lahore architect would. Every room has its own way in from circulation: a
bedroom opens onto a corridor, lobby, stair hall or the family lounge (plus its own bath, dressing or balcony), never through
another bedroom, a bath, the kitchen or the drawing room; a bath has exactly one door, and the master bath opens into the master
bedroom. A powder room or common bath never opens into the dining room (its door would face the dining table): open it off a
lobby, passage or the lounge. From the open main door guests must never look into a WC: a powder room or common bath door
never faces the main door across the lobby, lounge or drawing room it opens into, and never sits within about 30° of the main
door's line within 15 ft; put it on a side wall, round a corner. Keep the entrance lobby at least 5 ft deep when 4 or more
doors open off it. A dressing opens only into its own bedroom (or that bedroom's bath), never onto a lounge, and is
at least 5 ft across and 25 sq ft (a 2 ft wardrobe plus a 3 ft aisle); smaller than that, give the bedroom a wardrobe wall
instead. Two bedrooms never share a
balcony or terrace, and their balconies never touch (keep a room or a gap between them). Guests reach the drawing room from the
porch or lobby without seeing the family's rooms; the family reaches the lounge without crossing the drawing room. Doors sit near
room corners on walls the two rooms share; each bedroom keeps a solid wall for the bed and each lounge one for the TV. Rooms take
daylight from their own outside wall on their own floor. Stack baths over baths, the kitchen, stores or the porch; never over a
bedroom, the drawing room or the prayer room. Proportions stay livable; passages are at least 4 ft wide.

THE BRIEF: honour the per-floor program (brief.floors) and the family's preferences (brief.preferences, brief.notes) exactly:
the bedroom count, the rooms on each floor, attached baths, an open kitchen, parents downstairs. They are promises.

MASSING (how the house reads from the road): upper floors sit over the ground floor, front to back. The front line of every
enclosed upper floor is within about 2 ft of the ground floor's building line, so the house shows a full facade of every
storey to the road. Over the car porch put a room or a front balcony (a bedroom's or the lounge's). Habitable rooms (a
bedroom, the lounge) face the road on every floor; never put a bath, store or stair hall as the main thing on the front
face. Leave open roof or terraces at the back, not the front, unless the brief asks otherwise.

ROOF: solar-ready roofs stay clear: no minarets, domes or chhatris unless asked; the stair tower and tank sit in one corner.
roof.water_tank.material follows brief.water_tank ("plastic" sits on the stair tower, its rect inside roof.mumty.rect;
"concrete" sits on the roof slab beside it). roof.solar = {"mode": brief.solar} when it is "ready" or "panels".

Pakistani planning sense: the drawing room near the entrance (guests enter from the porch); a family TV lounge at the heart;
the kitchen beside the dining with a dirty kitchen or service access at the rear; a car porch at the front within the
building line; on larger plots the master bedroom upstairs at the front with a balcony and a servant quarter at the rear.
Style: palette (hex) and materials matching the brief and the chosen concept image.
notes: 3–6 short sentences explaining the key decisions and how the rules shaped the plan.
Write ids as <level-initial>_<name>, e.g. g_drawing, f_master, f_master_bath."""

BRIEF_KEYS = ("city", "authority", "scheme", "plot", "facing", "storeys", "basement", "bedrooms", "bathrooms", "spaces", "floors",
              "water_tank", "solar", "preferences", "style", "style_notes", "budget", "notes")


def _brief_for_prompt(brief: dict) -> dict:
    return {k: brief[k] for k in BRIEF_KEYS if brief.get(k) not in (None, "", [], {})}


def storey_limit_note(brief: dict, env: dict) -> str:
    """At the authority's storey limit a roof room would be one storey too many: say so outright."""
    try:
        at_cap = int(brief.get("storeys") or 0) >= int(env.get("max_storeys") or 99)
    except (TypeError, ValueError):
        at_cap = False
    return (f"STOREY LIMIT: this brief is at the authority's limit of {env['max_storeys']} storeys, so the roof holds only the "
            f"stair tower, the water tank, solar and open terraces (no laundry, store or other enclosed room up there).\n\n"
            if at_cap else "")


def _plan_prompt(brief: dict, env: dict, concept: str | None, imported: dict | None = None) -> str:
    tpl = template_for(brief)
    drawn = ""
    if imported:
        drawn = ("THE FAMILY'S OWN DRAWING (their uploaded floor plan, transcribed room by room in plot feet; road at y = 0):\n"
                 f"{importer.layout_text(imported)}\n"
                 "Design FROM this drawing: keep its rooms, their sizes and their places (within about a foot), its stair "
                 "position and its porch. Change only what the regulations, a buildable plan or the conventions above require "
                 "(tiling, setbacks, stair geometry, baths on an outside wall), and say in notes exactly what you changed and "
                 "why. Name rooms as the drawing names them.\n\n")
    return (
        drawn +
        f"BRIEF:\n{json.dumps(_brief_for_prompt(brief), indent=1)}\n\n"
        f"LDA ENVELOPE (deterministic, from the regulations):\n{json.dumps({k: v for k, v in env.items() if k != '_band'}, indent=1)}\n\n"
        + storey_limit_note(brief, env) +
        f"TYPESCRIPT REFERENCE for the plan (conventions + types):\n{_read(CONTRACTS / 'plan.ts')}\n\n"
        + ("" if imported else
           f"STARTING LAYOUT: a proven plan for a {tpl['site']['plot']['width_ft']:g} × {tpl['site']['plot']['depth_ft']:g} ft "
           f"plot that passes every check. Adapt it to THIS brief and plot: keep its zoning, its stair and its massing (front "
           f"rooms and balcony over the porch, rooms stacked floor over floor), resize rooms to the plot, and add, remove or "
           f"swap rooms to give the family exactly what the brief asks. Don't copy what the brief doesn't want.\n"
           f"{json.dumps(tpl, separators=(',', ':'))}\n\n")
        + (f"THE EXTERIOR CONCEPT THE FAMILY CHOSE (read from the image): match its massing (porch side, balconies, "
           f"roof features, window rhythm) where the rules allow.\n{concept}\n\n" if concept else "")
        + "Now produce the BuildingPlan JSON for this brief."
    )


def _selected(project: dict) -> dict | None:
    cid = project.get("selected_concept_id")
    return next((c for c in project.get("concepts", []) if c["id"] == cid), None)


async def _concept_spec(project: dict) -> dict | None:
    """The chosen concept read as a build specification (vision model), so the text-only architect can follow it."""
    c = _selected(project)
    return await concepts.spec_of(project["id"], c) if c else None


def _clean_plan(plan: dict, brief: dict) -> dict:
    """Deterministic fixes for small slips (schema tags, snapping, plot from the brief, roof services from the brief)."""
    plan["schema"], plan["units"] = "naqsha.plan/1", "ft"
    snap = lambda v: round(float(v) * 4) / 4  # noqa: E731
    for r in plan.get("rooms", []):
        if isinstance(r.get("rect"), dict) and all(k in r["rect"] for k in ("x", "y", "w", "d")):
            r["rect"] = {k: snap(r["rect"][k]) for k in ("x", "y", "w", "d")}
    for o in plan.get("openings", []):
        if isinstance(o.get("at"), list) and len(o["at"]) == 2:
            o["at"] = [snap(o["at"][0]), snap(o["at"][1])]
    site = plan.setdefault("site", {})
    p = site.setdefault("plot", {})
    if brief.get("plot"):
        p.update({k: brief["plot"][k] for k in ("width_ft", "depth_ft", "area_marla", "corner") if k in brief["plot"]})
    # where the house is comes from the brief, never from the model ("DHA / Johar Town")
    site["scheme"] = str(brief.get("scheme") or "").strip()
    site["authority"] = brief.get("authority") or site.get("authority") or "LDA"
    site["city"] = brief.get("city") or site.get("city") or "Lahore"
    if brief.get("facing"):
        site["facing"] = brief["facing"]
    if brief.get("coordinates"):
        plan["site"]["coordinates"] = brief["coordinates"]
    roof = plan.setdefault("roof", {"parapet_ft": 3.5})
    if roof.get("mumty"):
        roof["mumty"]["height_ft"] = min(float(roof["mumty"].get("height_ft") or 9), 9.5)
    if roof.get("water_tank") and brief.get("water_tank") in ("plastic", "concrete"):
        roof["water_tank"]["material"] = brief["water_tank"]
    if brief.get("solar") in ("ready", "panels"):
        roof["solar"] = {**(roof.get("solar") or {}), "mode": brief["solar"]}
    elif brief.get("solar") == "none":
        roof.pop("solar", None)
    return plan


def prepare(plan: dict, brief: dict) -> tuple[dict, list[str]]:
    """Clean and repair a plan deterministically. Returns (plan, what was repaired)."""
    plan = _clean_plan(plan, brief)
    repairs = []
    try:
        if (moved := planning.normalize(plan)):
            repairs.append(f"aligned {len(moved)} door{'s' if len(moved) > 1 else ''} and window{'s' if len(moved) > 1 else ''} with their walls")
        if (gone := planning.drop_open_edge_openings(plan)):
            repairs.append(f"removed {len(gone)} door{'s' if len(gone) > 1 else ''} on open-plan edges, which have no wall")
        if planning.repair_stairs(plan):
            repairs.append("fitted the stairs to code inside the stair hall")
        if planning.repair_mumty(plan):
            repairs.append("set the stair tower over the stair with its door at the top landing")
        if (doors := planning.repair_doors(plan)):
            repairs.append(f"added {len(doors)} door{'s' if len(doors) > 1 else ''} so every room has a way in")
        if (win := planning.add_missing_windows(plan)):
            repairs.append(f"added {len(win)} window{'s' if len(win) > 1 else ''} or ventilator{'s' if len(win) > 1 else ''} "
                           f"on free outside walls for daylight and air")
    except Exception:  # a repair must never sink the run
        log.exception("deterministic repair failed")
    return plan, repairs


def _score(report: dict) -> tuple[int, int]:
    c = lda.counts(report)
    return c["fail"], c["warn"]


MAX_FEEDBACK = 10


WET_OVER_DRY = "plan.structure.wet_over_dry"


def _if_you_can(report: dict) -> str:
    """Warnings worth fixing when it breaks nothing: a bath stacked over a bedroom, the drawing room or the prayer room."""
    soft = [c for c in report["checks"] if c["status"] == "warn" and c["id"].startswith(WET_OVER_DRY)]
    if not soft:
        return ""
    return ("\nFix these too if you can without breaking any rule (stack each bath over a bath, the kitchen, a store or the "
            "porch below):\n" + lda.violations_text({**report, "checks": soft}, warns=True))


def _feedback(report: dict, worse: int | None = None, first_round: bool = False) -> str:
    """The checker's findings for the next round: the most important FAILs first (at most MAX_FEEDBACK), WARNs only once the
    FAILs are few, so the planner fixes what matters without rewriting everything. The first round also asks, softly, for
    baths stacked over wet rooms."""
    fails = [c for c in report["checks"] if c["status"] == "fail"]
    warns = [c for c in report["checks"] if c["status"] == "warn" and not (first_round and c["id"].startswith(WET_OVER_DRY))]
    focus = {**report, "checks": sorted(fails, key=lambda c: lda._group(c["id"]))[:MAX_FEEDBACK]
             + (warns[:4] if len(fails) <= 3 else [])}
    more = f"\n(and {len(fails) - MAX_FEEDBACK} smaller problems you can leave for the next round)" if len(fails) > MAX_FEEDBACK else ""
    note = (f"Your last attempt made things worse ({worse} problems), so start again from THIS plan and change only what these "
            f"problems need.\n" if worse else "")
    return (note + "The plan checker found these problems. Fix every FAIL listed; change only the rooms and openings they "
            "involve, keep rooms tiling exactly (no overlaps, no gaps) and keep everything else unchanged.\n"
            + lda.violations_text(focus) + more + (_if_you_can(report) if first_round else "")
            + "\nReturn the corrected COMPLETE BuildingPlan JSON.")


async def _ask_plan(contents: list, thinking: str | None = None, attempts: int = 2) -> AsyncIterator[tuple[str, object]]:
    async for kind, val in llm.stream_json(config.MODEL_ARCHITECT, contents, PLAN_SYSTEM, max_tokens=65536, thinking=thinking,
                                           attempts=attempts):
        yield kind, val


def _model_turn(plan: dict) -> types.Content:
    return types.Content(role="model", parts=[types.Part.from_text(text=json.dumps(plan, separators=(",", ":")))])


def _user_turn(text: str) -> types.Content:
    return types.Content(role="user", parts=[types.Part.from_text(text=text)])


def _status(report: dict) -> str:
    """'A/B LDA · C/D livable · N architect's notes' (a warning is not a pass; review notes are counted on their own)."""
    return lda.status_line(report)


async def make_plan(project: dict) -> AsyncIterator[tuple[str, dict]]:
    brief = project["brief"]
    env = lda.envelope(brief["plot"]["width_ft"], brief["plot"]["depth_ft"], brief.get("authority") or "LDA",
                       bool(brief["plot"].get("corner")))
    await research.ensure(brief.get("authority"))
    spec = await _concept_spec(project)
    first = types.Content(role="user", parts=[types.Part.from_text(
        text=_plan_prompt(brief, env, concepts.spec_text(spec) or None, project.get("imported")))])
    contents = [first]
    history: list = []
    # 1. a quick full draft (Gemini 4 Argon, low reasoning: about half a minute)
    n = max(1, config.PLAN_DRAFTS)
    yield "stage", {"stage": "plan", "message": "Laying out the floors…" if n == 1 else f"Laying out the floors ({n} drafts in parallel)…"}

    async def draft() -> tuple[tuple[int, int], dict, list[str], dict] | None:
        obj = None
        try:
            async for kind, val in _ask_plan(contents, thinking=config.PLAN_THINKING, attempts=2):
                if kind == "result":
                    obj = val[0]
            pl, rp = prepare(obj, brief)
            rep = lda.check(pl, brief)
            return _score(rep), pl, rp, rep
        except Exception:
            log.exception("a plan draft failed")
            return None
    drafts = [d for d in await asyncio.gather(*[draft() for _ in range(n)]) if d]
    if not drafts:
        raise RuntimeError("the architect couldn't draft a plan")
    drafts.sort(key=lambda d: d[0])
    (_, plan, repairs, report) = drafts[0]
    if n > 1:
        log.info("plan drafts: %s failures; keeping the best", [d[0][0] for d in drafts])
    yield "plan", {"plan": plan, "attempt": 1}
    c = lda.counts(report)
    yield "stage", {"stage": "compliance", "message": f"Checking {c.get('lda', {}).get('total', 0)} LDA rules and "
                                                      f"{c.get('livable', {}).get('total', 0)} livability rules…"}
    fails, warns = _score(report)
    history.append({"attempt": 1, "pass": sum(1 for c in report["checks"] if c["status"] == "pass"), "warn": warns,
                    "fail": fails, "failed": [c["id"] for c in report["checks"] if c["status"] == "fail"], "repairs": repairs})
    yield "compliance", {"report": report, "attempt": 1}
    at = 1
    # 2. the fixer agent: Argon edits the draft with tools, each edit dry-run against the rules and kept only if it helps
    if not report["ok"]:
        yield "stage", {"stage": "fix", "message": f"Fixing {fails} problem{'s' if fails != 1 else ''}, one checked edit at a time…"}
        # a second fixer works on the runner-up draft at the same time; the better plan wins (the screen follows the first)
        rival = None
        if len(drafts) > 1 and config.PARALLEL_FIXERS > 1 and not drafts[1][3]["ok"]:
            async def run_rival():
                res = None
                async for ev2, d2 in fixer.fix(drafts[1][1], brief, prepare):
                    if ev2 == "_result":
                        res = d2
                return res
            rival = asyncio.create_task(run_rival())
        async for ev, d in fixer.fix(plan, brief, prepare):
            if ev == "edit":
                at += 1
                what = ", ".join(dict.fromkeys(d["summary"])) or "a problem"
                yield "stage", {"stage": "fix", "message": f"Fixed {what.lower()}; {d['failures']} to go…" if d["failures"]
                                else f"Fixed {what.lower()}; every check passes."}
            elif ev == "plan":
                yield "plan", {"plan": d["plan"], "attempt": at}
            elif ev == "compliance":
                r = d["report"]
                f2, w2 = _score(r)
                history.append({"attempt": at, "pass": sum(1 for x in r["checks"] if x["status"] == "pass"), "warn": w2,
                                "fail": f2, "failed": [x["id"] for x in r["checks"] if x["status"] == "fail"], "repairs": [],
                                "tool_edit": True})
                yield "compliance", {"report": r, "attempt": at}
            elif ev == "_result":
                plan, report = d["plan"], d["report"]
        if rival:
            try:
                other = await asyncio.wait_for(rival, timeout=60) if not report["ok"] else None
            except Exception:
                other = None
            if not rival.done():
                rival.cancel()
            if other and _score(other["report"]) < _score(report):
                at += 1
                plan, report = other["plan"], other["report"]
                f2, w2 = _score(report)
                log.info("the second fixer's plan won: %d failures", f2)
                yield "stage", {"stage": "fix", "message": "A second fixer working on another draft got further; using its plan."}
                yield "plan", {"plan": plan, "attempt": at}
                history.append({"attempt": at, "pass": sum(1 for x in report["checks"] if x["status"] == "pass"), "warn": w2,
                                "fail": f2, "failed": [x["id"] for x in report["checks"] if x["status"] == "fail"],
                                "repairs": [], "tool_edit": True})
                yield "compliance", {"report": report, "attempt": at}
    yield "_result", {"plan": plan, "report": report, "history": history, "first": first, "chosen_attempt": at}


# --- Step 2: the architect's self-review ------------------------------------------------------------------------------
REVIEW_SYSTEM = """You are a senior Lahore architect reviewing floor plans drawn by a junior before they go to the family. Software
has already checked the LDA regulations and the hard livability rules; your job is the judgement software can't make. Study the
drawings (road at the bottom of each sheet) with the room table and the adjacency list, and critique like an architect:
- circulation: natural routes, no rooms used as corridors, no wasted passages, the kitchen-dining-lounge relationship;
- privacy: guests vs family (purdah), bedrooms away from the entrance and the drawing room, baths not opening onto living areas;
- proportions: rooms too long and thin, too small for their use or oversized; awkward leftover spaces;
- daylight and air: rooms that will be dark or stuffy; cross-ventilation;
- the brief: anything the family asked for that is missing or misplaced;
- furniture: a bed with side tables and a wardrobe, a sofa set facing a TV, a dining table for six, each with 3 ft paths and doors
  that don't hit furniture;
- roof access: the stair reaches the roof under the stair tower, with its door beside the top landing.
Name sides as front, back, left and right: the road is the front, at the bottom of every sheet, and left and right are as seen
from the road. Never use compass points (north, south-east...) for a side of the house or a room.
Call an issue "major" only if the family would suffer from it every day; don't nitpick taste or ask for things outside the brief.
List at most four issues, the ones that matter most.
The software's own findings are listed with the plan and the family already sees them: never repeat one (the same rooms and
the same problem); add only what software can't judge.
Each fix must be concrete (which room, which wall, how many feet) and must keep the plan inside the setbacks.
Write for the family in plain British English: each problem is ONE short sentence (at most 25 words) naming rooms by their
names, never ids; the fix says what to change. Sizes in feet and inches (12′ × 6′6″), never decimal feet.
Return JSON: {"verdict": "approve" | "revise", "summary": "<one calm sentence for the family: what you would improve, or what
works>", "issues": [{"severity": "major" | "minor", "rooms": ["<room ids, the room the problem is about first>"],
"problem": "...", "fix": "..."}]}"""


def room_table(plan: dict) -> str:
    ix = planning.PlanIndex(plan)
    lines = ["id | name | type | floor | size | area | opens to"]
    for r in ix.rooms:
        x0, y0, x1, y1 = ix.R[r["id"]]
        nbs = sorted(ix.name(n) for n in ix.adj.get(r["id"], ()))
        lines.append(f"{r['id']} | {r.get('name')} | {r.get('type')} | {ix.lname(r.get('level'))} | {x1 - x0:g} x {y1 - y0:g} ft | "
                     f"{(x1 - x0) * (y1 - y0):.0f} sq ft | {', '.join(nbs) or '-'}")
    return "\n".join(lines)


def orientation(brief: dict, plan: dict) -> str:
    """How the drawings sit, for the review: the road is the front, and the plot's facing, which the critique must not turn
    into compass sides (Argon once said the roof door "opens south" on a north-facing plot)."""
    facing = (brief or {}).get("facing") or (plan.get("site") or {}).get("facing")
    faces = (f"the plot faces {FACING_NAME.get(str(facing), str(facing).lower())} (its road side)" if facing else
             "the plot's facing is not known")
    return (f"The road (front) is at the bottom of every sheet; {faces}. Say front/back/left/right (left and right as seen "
            f"from the road), never compass points.")


async def review(project: dict, plan: dict, report: dict) -> dict:
    """Argon looks at the drawn floors and critiques them. Returns {verdict, summary, issues}."""
    brief = project.get("brief") or {}
    parts: list = []
    for lid, lname, png in drawing.render_all(plan):
        parts += [types.Part.from_text(text=f"{lname} plan:"), types.Part.from_bytes(data=png, mime_type="image/png")]
    remaining = [f"- [{c['status'].upper()}] {c['message']}" + (f" (ids: {', '.join(c['element_ids'])})" if c.get("element_ids") else "")
                 for c in report["checks"] if c["status"] in ("fail", "warn") and not lda.is_review(c)]
    text = (f"ORIENTATION: {orientation(brief, plan)}\n\n"
            f"THE FAMILY'S BRIEF:\n{json.dumps(_brief_for_prompt(brief))}\n\nROOMS (feet):\n{room_table(plan)}\n\n"
            f"STAIRS: {json.dumps(plan.get('stairs'))}\nROOF: {json.dumps(plan.get('roof'))}\n\n"
            f"ISSUES THE SOFTWARE ALREADY REPORTS (the family sees these; don't repeat them):\n{chr(10).join(remaining) or '(none)'}"
            f"\n\nReview the plan now.")
    parts.append(types.Part.from_text(text=text))
    out = None
    async for kind, val in llm.stream_json(config.MODEL_REVIEW, [types.Content(role="user", parts=parts)], REVIEW_SYSTEM,
                                           max_tokens=6144, thinking="LOW"):
        if kind == "result":
            out = val[0]
    out = out if isinstance(out, dict) else {}
    issues = [i for i in out.get("issues") or [] if isinstance(i, dict) and i.get("problem")]
    # the few that matter most: majors first, at most REVIEW_MAX_ISSUES (a long list of small points buries the real ones)
    issues = sorted(issues, key=lambda i: i.get("severity") != "major")[:config.REVIEW_MAX_ISSUES]
    return {"verdict": "revise" if out.get("verdict") == "revise" and issues else "approve", "summary": str(out.get("summary") or ""),
            "issues": issues}


async def _plan_images(pid: str, run_id: str, plan: dict) -> list[dict]:
    out = []
    for lid, lname, png in drawing.render_all(plan):
        try:
            url = await blobs.put(f"projects/{pid}/plans/{run_id}-{lid}.png", png, "image/png")
            out.append({"level": lid, "name": lname, "url": url})
        except Exception:
            log.exception("plan image upload failed")
    return out


def changed_rooms(a: dict, b: dict) -> set[str]:
    """Rooms that differ between two plans: moved or resized, added or removed, or with an opening changed on their walls."""
    ra = {r.get("id"): r.get("rect") for r in a.get("rooms") or []}
    rb = {r.get("id"): r.get("rect") for r in b.get("rooms") or []}
    out = {k for k in set(ra) | set(rb) if k and ra.get(k) != rb.get(k)}
    oa = {o.get("id"): o for o in a.get("openings") or []}
    ob = {o.get("id"): o for o in b.get("openings") or []}

    def key(o: dict) -> tuple:
        return o.get("type"), tuple(o.get("at") or ()), o.get("width_ft"), tuple(o.get("between") or ())
    for k in set(oa) | set(ob):
        x, y = oa.get(k), ob.get(k)
        if x is None or y is None or key(x) != key(y):
            out |= {r for o in (x, y) if o for r in o.get("between") or [] if r != "exterior"}
    if json.dumps(a.get("stairs"), sort_keys=True) != json.dumps(b.get("stairs"), sort_keys=True):
        out |= {r.get("id") for r in b.get("rooms") or [] if r.get("type") == "stair"}
    return out


def addresses(issue: dict, changed: set[str]) -> bool:
    """Whether a revision touched what a review issue is about (its rooms; any change when it names none)."""
    rooms = [r for r in issue.get("rooms") or [] if isinstance(r, str)]
    return bool(changed) and (not rooms or any(r in changed for r in rooms))


NOTE_MAX = 160  # one sentence a family reads at a glance; the suggestion goes in `fix`
_NUM = r"(\d+(?:\.\d+)?)"
_FT = r"[\s-]*(?:ft|feet|foot)\b"
_FT_PAIR = re.compile(_NUM + r"(?:" + _FT + r")?\s*(?:x|×|X|by)\s*" + _NUM + _FT)
_FT_ONE = re.compile(_NUM + _FT)


def feet(v: float) -> str:
    """Feet and inches the way the app writes them: 15′3″, 12′, 6″."""
    f, i = int(v + 1e-9), round((v - int(v + 1e-9)) * 12)
    if i == 12:
        f, i = f + 1, 0
    return f"{f}′{i}″" if f and i else f"{f}′" if f else f"{i}″"


def feet_text(text: str) -> str:
    """'15.25 ft' -> 15′3″, '12 x 6.5 ft' -> 12′ × 6′6″ (square feet stay as they are)."""
    text = _FT_PAIR.sub(lambda m: f"{feet(float(m.group(1)))} × {feet(float(m.group(2)))}", text)
    return _FT_ONE.sub(lambda m: feet(float(m.group(1))), text)


def one_sentence(text: str, limit: int = NOTE_MAX) -> str:
    """The first sentence, cut at a clause break (or a word) to fit `limit` characters, ending with a full stop."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    m = re.search(r"(?<=[.!?])\s+(?=[A-Z0-9“\"'(])", text)
    s = (text[:m.start()] if m else text).strip()
    if len(s) > limit:
        cut = -1
        tiers = ((("; ", ": ", " — ", "—", " – "), 0.25), ((", ",), 0.35),  # the strongest break that leaves a real sentence
                 ((" and ", " so ", " which ", " where ", " meaning ", " because ", " while ", " but ", " with "), 0.4),
                 ((" ",), 0.0))
        for seps, least in tiers:
            cut = max(s.rfind(sep, 0, limit - 1) for sep in seps)
            if cut > 0 and cut >= least * limit:
                break
        s = s[:cut].rstrip(" ,;:—–") if cut > 0 else s[:limit - 1].rstrip()
    return s if s.endswith((".", "!", "?")) else s.rstrip(".") + "."


ROOM_WORDS = ("Room", "Rooms", "Bedroom", "Bedrooms", "Lounge", "Kitchen", "Bath", "Bathroom", "Hall", "Lobby", "Passage",
              "Corridor", "Quarter", "Dining", "Porch", "Veranda", "Terrace", "Balcony", "Store", "Laundry", "Dressing", "Study",
              "Yard", "Court", "Space", "Stair", "Stairs")
_ROOM_PHRASE = re.compile(r"\b((?:(?:[A-Z][a-z']+|[A-Z]{2,})\s+)*(?:" + "|".join(ROOM_WORDS) + r"))\b")


def sentence_case_rooms(text: str, names: list[str]) -> str:
    """Room names inside a sentence in sentence case ("the Drawing Room" -> "the drawing room", "TV Lounge" -> "TV
    lounge"), the plan's names first, then any title-case phrase ending in a room word; each sentence starts with a capital."""
    by_lower = {n.lower(): n for n in names}
    if names:
        name_re = re.compile(r"(?<![\w'])(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r")(?!\w)", re.I)
        text = name_re.sub(lambda m: planning.in_sentence(by_lower.get(m.group(0).lower(), m.group(0))), text)
    text = _ROOM_PHRASE.sub(lambda m: planning.in_sentence(m.group(0)), text)
    text = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)
    return text


# A note names the same rooms as a rule the software already reports, about the same thing: the rule's row is the one shown.
_TOPICS = (
    ("plan.structure.wet_over_dry", r"\b(over|above|below|pipes?|leak\w*|ceiling|plumbing|drains?)\b"),
    ("plan.room.", r"\b(narrow|long|tunnel|strip|wide|cramped|small|tight|size|proportion\w*|wasted?)\b"),
    ("room.size", r"\b(narrow|small|cramped|tight|size|wide)\b"),
    ("room.light", r"\b(window\w*|light|dark|daylight|gloomy)\b"),
    ("room.vent", r"\b(vent\w*|air|stuffy|window\w*)\b"),
    ("plan.circulation", r"\b(through|reach\w*|access\w*|way in|route|walk\w*|door\w*|enter\w*)\b"),
    ("plan.privacy", r"\b(through|privacy|private|opens?|door\w*|view)\b"),
)


def duplicates_rule(issue: dict, rules: list[dict], room_ids: set[str]) -> bool:
    """Whether a review issue repeats an open rule (warn or fail): the rule's rooms are among the issue's, the issue is
    mainly about one of them (its first room), and it is about the same thing (10 marla: "Bath 2 sits over the drawing
    room" and plan.structure.wet_over_dry:f_bath2)."""
    rooms = [r for r in issue.get("rooms") or [] if r in room_ids]
    if not rooms:
        return False
    text = f"{issue.get('problem') or ''} {issue.get('fix') or ''}".lower()
    for c in rules:
        own = {x for x in c.get("element_ids") or [] if x in room_ids}
        if not own or rooms[0] not in own or not own <= set(rooms):
            continue
        topic = next((pat for prefix, pat in _TOPICS if str(c.get("id", "")).startswith(prefix)), None)
        if topic is None or re.search(topic, text):
            return True
    return False


def review_checks(issues: list[dict], plan: dict, report: dict | None = None) -> list[dict]:
    """Open review issues as livable warnings for the compliance sheet and the dock: one plain sentence of at most 160
    characters (rooms by name in sentence case, feet and inches), the suggestion only in `fix`. A note that repeats a rule
    the report already shows open is left out (the rule's row says it)."""
    ix = planning.PlanIndex(plan)
    names = {r["id"]: r.get("name") or r["id"] for r in ix.rooms}
    names |= {o["id"]: ix.oname(o) for o in ix.openings} | {s["id"]: ix.sname(s).lower() for s in ix.stairs}
    room_names = [r["name"] for r in ix.rooms if r.get("name")]
    rules = [c for c in (report or {}).get("checks", []) if c.get("status") in ("warn", "fail") and not lda.is_review(c)]

    def plain(text: str) -> str:
        text = re.sub(r"\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b", lambda m: names.get(m.group(0), m.group(0).replace("_", " ")), str(text or ""))
        text = re.sub(r"\s+", " ", feet_text(text)).strip()
        return sentence_case_rooms(text, room_names)
    out = []
    for n, i in enumerate(issues, 1):
        problem, fix = plain(i.get("problem")), plain(i.get("fix"))
        if not problem or duplicates_rule(i, rules, set(ix.by_id)):
            continue
        major = i.get("severity") == "major"
        c = {"id": f"review.{n}", "title": "Architect's review" + (": needs a change" if major else ""), "status": "warn",
             "category": "livable", "message": one_sentence(problem), "rule_ref": "Naqsha architect's review of the drawings",
             "severity": "major" if major else "minor", "element_ids": [r for r in i.get("rooms") or [] if r in ix.by_id]}
        if fix:
            c["fix"] = fix if fix.endswith((".", "!", "?")) else fix + "."
        out.append(c)
    return out


def tidy_notes(rows: list[dict], plan: dict, report: dict) -> list[dict]:
    """Stored review rows (older ones read "<problem> Suggested: <fix>") in today's form, keeping their ids; a row that now
    repeats an open rule of `report` is dropped."""
    out = []
    for c in rows:
        issue = {"severity": c.get("severity"), "rooms": c.get("element_ids") or [],
                 "problem": str(c.get("message") or "").split(" Suggested: ")[0], "fix": c.get("fix")}
        got = review_checks([issue], plan, report)
        if got:
            out.append({**got[0], "id": c["id"]})
    return out


def with_review(report: dict, issues: list[dict], plan: dict) -> dict:
    """The report plus the review's open issues (as warnings), replacing any earlier review notes."""
    keep = [c for c in report.get("checks", []) if not lda.is_review(c)]
    return {**report, "checks": keep + review_checks(issues, plan, {"checks": keep})}


async def _critique(project: dict, plan: dict, report: dict) -> dict:
    """Argon's critique within its own timeout (REVIEW_CRITIQUE_S): {verdict, summary, issues}, or a skipped review (reason
    "timeout", or the error) so the run goes on without it."""
    try:
        return await asyncio.wait_for(review(project, plan, report), config.REVIEW_CRITIQUE_S)
    except asyncio.TimeoutError:
        log.warning("review critique over its %ss timeout; building the checked plan", config.REVIEW_CRITIQUE_S)
        return {"verdict": "skipped", "summary": "", "issues": [], "reason": "timeout"}
    except Exception as e:
        log.exception("review failed")
        return {"verdict": "skipped", "summary": "", "issues": [], "error": type(e).__name__}


def _reviewed(crit: dict, smaller: bool = False) -> str:
    n = len(crit["issues"])
    return (f"Reviewed the drawings: {n}{' smaller' if smaller else ''} point{'s' if n != 1 else ''} to look at, listed with "
            f"the checks." if n else
            f"Reviewed the drawings. {crit['summary'] or 'The circulation, privacy and daylight read well.'}")


async def critique_only(project: dict, plan: dict, report: dict) -> AsyncIterator[tuple[str, dict]]:
    """The review of a late run (planning used every attempt, or took long): Argon critiques the drawings while the 3D build
    of the checked plan runs, within its own timeout, and its open issues join the report as "Architect's review" rows. No
    revision is made (revision "skipped_time"): the plan stays the checked one."""
    yield "stage", {"stage": "review", "message": "Reviewing the drawings like an architect…"}
    crit = await _critique(project, plan, report)
    if crit["verdict"] == "skipped":
        yield "_result", {"report": report, "review": {**crit, "applied": False, "revision": "skipped_time"}}
        return
    yield "stage", {"stage": "review", "message": _reviewed(crit)}
    yield "_result", {"report": with_review(report, crit["issues"], plan),
                      "review": {**crit, "applied": False, "open_issues": len(crit["issues"]), "revision": "skipped_time"}}


async def self_review(project: dict, plan: dict, report: dict, first: types.Content, history: list) -> AsyncIterator[tuple[str, dict]]:
    """Critique the drawn plan; if there are real problems, revise (with one fix round when the revision breaks a rule) and
    keep the revision only if it breaks no rule and changes what a major issue is about. Whatever stays open is added to the
    report as livable warnings, so nothing the review found is silently dropped."""
    brief = project["brief"]
    yield "stage", {"stage": "review", "message": "Reviewing the drawings like an architect…"}
    crit = await _critique(project, plan, report)
    if crit["verdict"] == "skipped":
        yield "_result", {"plan": plan, "report": report, "review": crit}
        return
    issues = crit["issues"]
    majors = [i for i in issues if i.get("severity") == "major"]
    if crit["verdict"] != "revise" or not majors:
        n = len(issues)
        yield "stage", {"stage": "review", "message": _reviewed(crit, smaller=True)}
        yield "_result", {"plan": plan, "report": with_review(report, issues, plan),
                          "review": {**crit, "applied": False, "open_issues": n}}
        return
    yield "stage", {"stage": "review", "message": f"Improving the plan: {crit['summary'] or majors[0]['problem']}"}
    asks = "\n".join(f"- [{i.get('severity', 'minor').upper()}] {i['problem']} Fix: {i.get('fix', '')}"
                     + (f" (rooms: {', '.join(i.get('rooms') or [])})" if i.get("rooms") else "") for i in issues)
    still = ""
    if not report["ok"]:  # the checker's failures go with the critique: the architect often names their root cause
        fails = sorted([c for c in report["checks"] if c["status"] == "fail"], key=lambda c: lda._group(c["id"]))[:MAX_FEEDBACK]
        still = "\nThe plan checker also still reports these problems; fix them too:\n" + lda.violations_text(
            {**report, "checks": fails}, warns=False)
    still += _if_you_can(report)
    contents = [first, _model_turn(plan), _user_turn(
        "A senior architect reviewed your drawings and asks for these improvements:\n" + asks + still +
        "\nMake the MAJOR ones (and the minor ones where easy) while keeping everything that already works and every rule that "
        "already passes; keep rooms tiling exactly. Return the COMPLETE BuildingPlan JSON.")]
    base = _score(report)
    cand = cand_rep = None
    accepted = False
    why: list[str] = []

    async def ask_once(cts) -> dict:
        obj = None
        async for kind, val in llm.stream_json(config.MODEL_ARCHITECT, cts, PLAN_SYSTEM, max_tokens=32768, attempts=1,
                                               thinking=config.REVIEW_THINKING):
            if kind == "result":
                obj = val[0]
        return obj

    loop = asyncio.get_running_loop()
    deadline = loop.time() + config.REVIEW_BUDGET_S
    for round_ in (1, 2):  # the revision, then one fix round if it broke a rule or missed every major issue
        try:  # the improvement is optional: within its time budget, or we keep the checked plan
            left = deadline - loop.time()
            if left < 30:
                raise asyncio.TimeoutError
            obj = await asyncio.wait_for(ask_once(contents), timeout=left)
            cand, _ = prepare(obj, brief)
            cand_rep = lda.check(cand, brief)
        except asyncio.TimeoutError:
            log.warning("review revision over its %ss budget; keeping the checked plan", config.REVIEW_BUDGET_S)
            why = why or ["time"]
            break
        except Exception:
            log.exception("review revision failed")
            why = why or ["error"]
            break
        worse = _score(cand_rep)[0] > base[0]
        hit = any(addresses(i, changed_rooms(plan, cand)) for i in majors)
        if not worse and hit:
            accepted = True
            break
        why = [c["id"] for c in cand_rep["checks"] if c["status"] == "fail"] if worse else ["no major issue addressed"]
        if round_ == 2:
            break
        yield "stage", {"stage": "review", "message": "Re-checking the improved plan…"}
        ask = _feedback(cand_rep) if worse else ""
        if not hit:
            ask += ("\nThat version didn't change the rooms the architect named. Make these improvements:\n"
                    + "\n".join(f"- {i['problem']} Fix: {i.get('fix', '')}" for i in majors)
                    + "\nReturn the COMPLETE BuildingPlan JSON.")
        contents = [first, _model_turn(cand), _user_turn(ask.strip())]
    attempt = len(history) + 1
    if accepted:
        changed = changed_rooms(plan, cand)
        open_issues = [i for i in issues if not addresses(i, changed)]
        rep = with_review(cand_rep, open_issues, cand)
        history.append({"attempt": attempt, "review": True, "fail": _score(cand_rep)[0], "warn": _score(cand_rep)[1],
                        "failed": [c["id"] for c in cand_rep["checks"] if c["status"] == "fail"]})
        yield "plan", {"plan": cand, "attempt": attempt}
        yield "compliance", {"report": rep, "attempt": attempt}
        yield "stage", {"stage": "review", "message": f"Improved after review: {crit['summary'] or majors[0]['problem']}"
                        + (f" {len(open_issues)} smaller point{'s' if len(open_issues) != 1 else ''} stay open, listed with the "
                           f"checks." if open_issues else "")}
        yield "_result", {"plan": cand, "report": rep, "review": {**crit, "applied": True, "open_issues": len(open_issues)}}
    else:
        log.info("review revision kept out: %s", why or "no candidate")
        n = len(issues)
        msg = (f"The review found {n} thing{'s' if n != 1 else ''} to improve that I couldn't change without breaking a rule; "
               f"they're listed with the checks." if why and why[0] not in ("time", "error") else
               f"The review found {n} thing{'s' if n != 1 else ''} to improve; they're listed with the checks.")
        yield "stage", {"stage": "review", "message": msg}
        yield "_result", {"plan": plan, "report": with_review(report, issues, plan),
                          "review": {**crit, "applied": False, "open_issues": n, "rejected_because": why or ["time"]}}


# --- Step 3: design.js --------------------------------------------------------------------------------
BUILD_SYSTEM = """You are Naqsha's 3D design engineer. You write design.js: code that builds a high-fidelity, fully furnished 3D
model of a house with the House SDK (three.js underneath). The plan (structure) is already decided and checked; your job is
to make it look like a premium architectural visualization that matches the family's chosen concept, feature by feature.

OUTPUT FORMAT: plain text only, no markdown fences. A sequence of sections, each exactly:
// @section <name> [<layer>]
<JavaScript statements using `s` (the HouseSDK) and `THREE`>
// @end

Order and naming:
1. `structure [structure]`: exactly one call to s.structure({...}) with materials chosen for the style (floors per room type).
2. `facade_<part> [facade]`: several sections building the facade from the CONCEPT SPECIFICATION: cladding, fins, frames,
   canopies, screens, columns, wall lights and LED strips. Every feature in the specification (F1, F2, …) must be built,
   in its place, material and colour; the first line of each facade section is a comment naming the features it builds
   (e.g. `// builds F2, F5`). Use the palette's hex colours. Never skip a feature with a note: adapt it to the plan as
   built (slats or fins on whichever front wall the plan has, the glass railing on the balcony or terrace that faces the
   road, a canopy over the door that exists). The facade should read rich from the road: at least two wall finishes, framed
   windows, one strong feature element (fins, a screen or a projecting frame), a parapet trim, wall lights and a gate that
   match the concept. Use s.face(side, level) for facade math. Every element must stay
   inside the plot. Canopies and chajjas may project at most 3 ft beyond the building line into a 10 ft+ open space, or 1.5 ft otherwise.
3. `interior_<room or theme> [interior]`: accent walls, false ceilings with cove lights and downlights for the main rooms
   (drawing, lounges, master bedroom).
4. `furnish_<room_id> [furniture]`: ONE section per enclosed room (and the porch: a car). Place key pieces explicitly with
   `against`/`along_ft` or `at`/`rot_deg` in room-local feet, sized to the room. Use s.auto_furnish(room) only for minor rooms.
   Include Pakistani touches: ceiling fans, split ACs in bedrooms and lounges, a prayer mat if there's a prayer room.
   Never put a TV, painting, mirror, wardrobe or bookshelf across a door or window; keep 3 ft clear in front of every door and
   a 3 ft path through each room; the car sits in the porch bay, never in front of the main door.
5. `landscape [landscape]`: lawn, paving, planters, trees (ashoka, palm), and s.landscape.street({ neighbours: true, streetlights: true }).
6. `lighting [lighting]`: s.lights.sun({ hour: 17.5 }) and s.lights.interior().

Roof: keep it clear for solar unless the brief asks otherwise: no domes, cupolas, minarets, chhatris or pergolas; the water tank
and solar frame come from the plan.
Rules: Only use APIs that exist in the SDK reference. Coordinates are plan FEET (x along the road, y into the plot, h above the
road crown). Keep each section under about 60 lines. Sections share NOTHING: each runs on its own, so a material, colour or helper
used in a section must be declared in that same section (repeat the palette's few consts where needed; never rely on a
const from another section). Never use fetch, XMLHttpRequest,
WebSocket, import(), eval, Function, document, window or storage. Prefer clarity over cleverness. Add a brief comment at the top
of each section saying what it builds."""


def taste_text(style: dict | None) -> str:
    """The interiors and rooms from the family's Qloo style brief, for the 3D build (palette hexes, materials, moods)."""
    if not style:
        return ""
    keep = {"interiors": style.get("interiors"), "rooms": style.get("rooms"), "landscape": style.get("landscape"),
            "exterior_palette": (style.get("exterior") or {}).get("palette")}
    strip = lambda x: ({k: strip(v) for k, v in x.items() if k != "because"} if isinstance(x, dict)
                       else [strip(v) for v in x] if isinstance(x, list) else x)
    return json.dumps(strip({k: v for k, v in keep.items() if v}))


def _build_prompt(plan: dict, brief: dict, spec: dict | None = None, style: dict | None = None) -> str:
    example = _read(CONTRACTS / "fixtures" / "design-10-marla.js")
    engine_notes = _read(CONTRACTS / "engine-notes.md")
    keys = ("style", "style_notes", "budget", "notes", "spaces", "floors", "water_tank", "solar", "preferences")
    return (
        f"HOUSE SDK REFERENCE (TypeScript declarations; the API you can call):\n{_read(CONTRACTS / 'house-sdk.d.ts')}\n\n"
        + (f"ENGINE NOTES (behaviour details and gotchas):\n{engine_notes}\n\n" if engine_notes else "")
        + (f"EXAMPLE design.js for a different 10-marla plan (format and quality reference only):\n{example}\n\n" if example else "")
        + f"THE PLAN TO BUILD (BuildingPlan JSON, feet):\n{json.dumps(plan)}\n\n"
        f"FAMILY BRIEF: {json.dumps({k: brief.get(k) for k in keys if brief.get(k) not in (None, '', [], {})})}\n\n"
        + (f"CONCEPT SPECIFICATION (the exterior the family chose, read from its image; build every feature):\n"
           f"{concepts.spec_text(spec)}\n\n" if spec else "")
        + (f"THE FAMILY'S TASTE (from Qloo's taste graph): build the interiors from it. Use these palettes and materials in "
           f"structure floors, interior_* accent walls and ceilings, and furnish_* pieces and colours; give each room listed here "
           f"its own mood and palette (a person's room follows that person). Shelves of books, a record or music corner, art and "
           f"textiles where it says so. The landscape follows its idea and plants.\n{taste_text(style)}\n\n" if style else "")
        + "Write design.js now."
    )


SECTION_RE = re.compile(r"^\s*//\s*@section\s+([A-Za-z0-9_]+)\s*\[(\w+)\]\s*$")
END_RE = re.compile(r"^\s*//\s*@end\s*$")


class SectionStream:
    """Incremental parser: feed text chunks, get completed sections."""

    def __init__(self):
        self.buf, self.cur, self.done = "", None, []

    def feed(self, text: str) -> list[dict]:
        self.buf += text
        out = []
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            m = SECTION_RE.match(line)
            if m:
                if self.cur:
                    out.append(self.cur)
                self.cur = {"name": m.group(1), "layer": m.group(2), "code": ""}
            elif END_RE.match(line):
                if self.cur:
                    out.append(self.cur)
                self.cur = None
            elif self.cur is not None and not line.strip().startswith("```"):
                self.cur["code"] += line + "\n"
        self.done += out
        return out

    def flush(self) -> list[dict]:
        out = self.feed("\n")
        if self.cur and self.cur["code"].strip():
            out.append(self.cur)
            self.done.append(self.cur)
            self.cur = None
        return out


async def write_design(project: dict, plan: dict, extra_instruction: str | None = None) -> AsyncIterator[tuple[str, dict]]:
    spec = await _concept_spec(project)
    text = _build_prompt(plan, project.get("brief") or {}, spec, (project.get("taste") or {}).get("style")) + (f"\n\nADDITIONAL INSTRUCTIONS:\n{extra_instruction}" if extra_instruction else "")
    contents = [types.Content(role="user", parts=[types.Part.from_text(text=text)])]
    cfg = types.GenerateContentConfig(system_instruction=BUILD_SYSTEM, max_output_tokens=65536)
    yield "stage", {"stage": "build", "message": "Building the 3D model…"}
    parser, total = SectionStream(), 0
    try:
        async for chunk in llm.guarded_stream(config.MODEL_ARCHITECT, contents, cfg):
            if not chunk.text:
                continue
            total += len(chunk.text)
            for sec in parser.feed(chunk.text):
                for ev in _shared(parser.done):
                    yield ev
            if total // 3000 != (total - len(chunk.text)) // 3000:
                yield "progress", {"chars": total}
    except llm.Stalled:
        if not any(s["name"] == "structure" for s in parser.done):
            raise
        log.warning("build stream stalled after %d sections; keeping them", len(parser.done))
    for sec in parser.flush():
        for ev in _shared(parser.done):
            yield ev
    yield "_result", {"sections": parser.done}


def _shared(done: list[dict]) -> list[tuple[str, dict]]:
    """The newest section (and any earlier one that now gets a declaration it was missing), with declarations shared
    across sections copied in, as `section` events."""
    before = [s["code"] for s in done]
    fixed = jsfix.share_declarations(done)
    if fixed:
        log.info("shared declarations: %s", "; ".join(fixed))
    out = [("section", {"section": s, "index": i}) for i, s in enumerate(done[:-1]) if s["code"] != before[i]]
    return out + [("section", {"section": done[-1], "index": len(done) - 1})]


async def repair_section(project: dict, version: dict, name: str, error: str) -> dict:
    sec = next((s for s in version["sections"] if s["name"] == name), None)
    if not sec:
        raise ValueError(f"no section {name}")
    prompt = (f"HOUSE SDK REFERENCE:\n{_read(CONTRACTS / 'house-sdk.d.ts')}\n\nPLAN:\n{json.dumps(version['plan'])}\n\n"
              f"This design.js section failed in the browser with: {error}\n\n// @section {sec['name']} [{sec['layer']}]\n{sec['code']}// @end\n\n"
              "The section runs on its own: declare every material, colour and helper it uses inside it. Use only APIs and "
              "argument names that exist in the SDK reference. Return the corrected section only, in the same // @section … "
              "// @end format.")
    text = await llm.generate_text(config.MODEL_ARCHITECT, prompt, system=BUILD_SYSTEM, max_tokens=16384)
    p = SectionStream()
    p.feed(text or "")
    fixed = p.flush() or p.done
    return fixed[0] if fixed else sec


class Background:
    """An async event generator running in its own task, its events buffered until someone follows them. The 3D build
    starts on the checked plan while the optional review runs; it is cancelled and restarted only if the review changes the
    plan."""

    def __init__(self, gen: AsyncIterator[tuple[str, dict]]):
        self.q: asyncio.Queue = asyncio.Queue()
        self.task = asyncio.create_task(self._run(gen))

    async def _run(self, gen) -> None:
        try:
            async for ev in gen:
                await self.q.put(("ev", ev))
        except Exception as e:  # handed to the follower
            await self.q.put(("err", e))
        finally:
            await self.q.put(("end", None))

    async def follow(self) -> AsyncIterator[tuple[str, dict]]:
        while True:
            kind, val = await self.q.get()
            if kind == "end":
                return
            if kind == "err":
                raise val
            yield val

    def cancel(self) -> None:
        if not self.task.done():
            self.task.cancel()


def review_note_count(report: dict) -> int:
    return lda.counts(report)["review"]


async def design(project: dict) -> AsyncIterator[tuple[str, dict]]:
    """Full pipeline: plan (+ fix loop) → self-review (while the 3D build of the checked plan starts) → design.js → save."""
    pid = project["id"]
    run_id = db.new_id("r_")
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    await db.update_project(pid, stage="planning")
    plan = report = first = None
    history: list = []
    async for ev, data in make_plan(project):
        if ev == "_result":
            plan, report, history, first = data["plan"], data["report"], data["history"], data["first"]
            chosen = data.get("chosen_attempt") or len(history)
        else:
            yield ev, data
    rev: dict = {}
    build = Background(write_design(project, plan))
    try:
        late = loop.time() - t0 > config.REVIEW_SKIP_AFTER_S or len(history) >= config.PLAN_MAX_ATTEMPTS
        if config.SELF_REVIEW and late:  # a critique only, overlapping the build of the checked plan; no revision
            log.info("critique only: planning took %.0fs over %d attempts", loop.time() - t0, len(history))
            async for ev, data in critique_only(project, plan, report):
                if ev == "_result":
                    report, rev = data["report"], data["review"]
                else:
                    yield ev, data
            if review_note_count(report):  # the review rows join the checks shown while the build finishes
                yield "compliance", {"report": report, "attempt": chosen}
        elif config.SELF_REVIEW:
            async for ev, data in self_review(project, plan, report, first, history):
                if ev == "_result":
                    plan, report, rev = data["plan"], data["report"], data["review"]
                else:
                    yield ev, data
            if rev.get("applied"):  # the review changed the plan: build that one instead
                build.cancel()
                build = Background(write_design(project, plan))
            elif review_note_count(report):
                yield "compliance", {"report": report, "attempt": chosen}
        images = await _plan_images(pid, run_id, plan)
        await db.update_project(pid, stage="building")
        sections: list[dict] = []
        async for ev, data in build.follow():
            if ev == "_result":
                sections = data["sections"]
            else:
                yield ev, data
    finally:
        build.cancel()
    yield "stage", {"stage": "save", "message": "Saving the version…"}
    fresh = await db.get_project(pid)
    n = len(fresh.get("versions") or []) + 1
    parent = fresh.get("current_version_id")
    version = {"id": db.new_id("v_"), "n": n, "created_at": db.now(), "parent_id": parent,
               "plan": plan, "sections": sections, "compliance": report, "changes": [], "status": "ready",
               "fix_history": history, "review": rev, "plan_images": images, "brief_snapshot": fresh.get("brief"),
               "summary": _status(report)}  # the version rail's label, also on the `version` event
    summary = version["summary"]
    await db.save_version(pid, version)
    await db.update_project(pid, versions=(fresh.get("versions") or []) + [{"id": version["id"], "n": n, "created_at": version["created_at"],
                                                                           "status": "ready", "summary": summary}],
                            current_version_id=version["id"], stage="ready", brief_changed=False)
    if parent:  # comments still open on the version this replaces follow it, so they can still be applied
        try:
            await db.move_open_comments(pid, parent, version["id"])
        except Exception:
            log.exception("moving open comments to %s failed", version["id"])
    log.info("design %s: v%d in %.0fs (%d plan attempts, review %s)", pid, n, loop.time() - t0, len(history),
             rev.get("verdict") or "off")
    yield "version", {"version": version}
