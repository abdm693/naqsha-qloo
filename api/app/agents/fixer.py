"""The plan fixer: Gemini (Argon) repairs a drafted plan with tools, against the rules engine, edit by edit.

Rewriting a whole 20k-token plan to fix three problems tends to break five others. Instead the fixer sees the checker's
failures (with fix hints) and the rooms involved, and proposes small edits (move or resize a room, move or add a door or
window, change a stair). Each edit is dry-run through the LDA and livability checks first (`check_edits`); `apply_edits`
keeps it only when the plan ends up with fewer failures (or as many, with fewer warnings). The plan can only get better, and
every kept edit is streamed to the family's screen as it lands.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator

from .. import config, llm
from ..compliance import lda, planning

log = logging.getLogger("naqsha.fixer")

FIX_SYSTEM = """You are a senior architect fixing a house plan so it passes every check of the plan checker. The plan is a
BuildingPlan in FEET: origin at the plot's front-left corner, +x along the road, +y into the plot (the road is at y < 0).
Rooms are axis-aligned rectangles {x, y, w, d}; rooms on the same level never overlap and neighbouring rooms share edges
exactly. An opening's `at` is a point ON the wall the two rooms in `between` share (or the room's own outside wall for
"exterior"). Windows go on outside walls or onto a same-level porch, balcony, terrace or open_space.

How to work:
1. Read the failures. Use get_elements to see the exact rooms, openings and stairs involved.
2. Propose a few edits that fix one failure (or a group with one cause), and dry-run them with check_edits. It tells you how
   many failures there would be and which new problems appear.
3. When the dry run is better (fewer failures), apply exactly those edits with apply_edits. If not, adjust and dry-run again.
4. Repeat until no failures remain, then call finish. Call finish too when the remaining failures can't be fixed without
   redesigning the whole floor.
Edits: {"op": "upsert", "collection": "rooms" | "openings" | "stairs", "item": {...the FULL object with its id...}},
{"op": "remove", "collection": ..., "id": "..."}, or {"op": "set", "path": "roof.mumty", "value": {...}}.
Moving a room usually means moving its neighbour's shared edge too (keep the floor tiled) and moving the openings on the walls
that moved. Keep every room the family asked for. Snap coordinates to 0.25 ft. Work fast: you have a limited number of steps, so fix
several failures in one apply_edits whenever they don't interfere (e.g. all the overlaps on one floor at once)."""

TOOLS = [
    {"type": "function", "function": {
        "name": "get_elements", "description": "The full objects for these ids: rooms (with the openings on their walls and their neighbours), openings or stairs.",
        "parameters": {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}}}, "required": ["ids"]}}},
    {"type": "function", "function": {
        "name": "check_edits", "description": "Dry-run edits against the plan checker without applying them.",
        "parameters": {"type": "object", "properties": {"edits": {"type": "array", "items": {"type": "object"}}}, "required": ["edits"]}}},
    {"type": "function", "function": {
        "name": "apply_edits", "description": "Apply edits; they are kept only if the plan ends up with fewer failures.",
        "parameters": {"type": "object", "properties": {"edits": {"type": "array", "items": {"type": "object"}}}, "required": ["edits"]}}},
    {"type": "function", "function": {
        "name": "finish", "description": "Stop fixing.", "parameters": {"type": "object", "properties": {"note": {"type": "string"}}}}},
]


def _score(rep: dict) -> tuple[int, int]:
    c = lda.counts(rep)
    return c["fail"], c["warn"]


def failures_text(rep: dict, limit: int = 14) -> str:
    fails = sorted([c for c in rep["checks"] if c["status"] == "fail"], key=lambda c: lda._group(c["id"]))
    return lda.violations_text({**rep, "checks": fails[:limit]}, warns=False) + (
        f"\n(and {len(fails) - limit} more)" if len(fails) > limit else "")


def compact(plan: dict) -> str:
    """The plan in a compact form: levels, rooms, openings, stairs, roof (the model reads ids from here)."""
    rooms = [{k: r.get(k) for k in ("id", "level", "name", "type", "rect")} for r in plan.get("rooms") or []]
    ops = [{k: o.get(k) for k in ("id", "level", "type", "at", "width_ft", "between")} for o in plan.get("openings") or []]
    return json.dumps({"plot": (plan.get("site") or {}).get("plot"), "setbacks_ft": (plan.get("site") or {}).get("setbacks_ft"),
                       "levels": [{k: lv.get(k) for k in ("id", "index", "elevation_ft", "height_ft")} for lv in plan.get("levels") or []],
                       "rooms": rooms, "openings": ops, "stairs": plan.get("stairs"), "roof": plan.get("roof")}, separators=(",", ":"))


async def fix(plan: dict, brief: dict, prepare, budget_s: float | None = None, max_steps: int = 40) -> AsyncIterator[tuple[str, dict]]:
    """Yields ("edit", {...}) for each kept edit, ("plan"/"compliance") with the new state, and finally
    ("_result", {"plan", "report", "steps", "kept"})."""
    from .reviser import apply_ops  # (reviser imports the architect, which imports this module)
    budget_s = budget_s or config.FIX_BUDGET_S
    rep = lda.check(plan, brief)
    state = {"plan": plan, "rep": rep, "kept": 0}
    t0 = time.monotonic()

    def check(edits: list[dict]) -> tuple[dict, dict]:
        cand, _ = prepare(apply_ops(state["plan"], edits), brief)
        return cand, lda.check(cand, brief)

    def get_elements(ids: list[str]) -> dict:
        ix = planning.PlanIndex(state["plan"])
        out = {}
        for i in ids or []:
            if i in ix.by_id:
                r = ix.by_id[i]
                out[i] = {"room": r, "openings": [o for o in state["plan"].get("openings") or [] if i in (o.get("between") or [])],
                          "neighbours": sorted(ix.adj.get(i, ()))}
            else:
                el = next((x for col in ("openings", "stairs") for x in state["plan"].get(col) or [] if x.get("id") == i), None)
                out[i] = el or {"error": "no such id"}
        return out

    msgs = [{"role": "system", "content": FIX_SYSTEM},
            {"role": "user", "content": f"THE PLAN:\n{compact(plan)}\n\nTHE FAMILY'S BRIEF: {json.dumps({k: brief.get(k) for k in ('storeys', 'bedrooms', 'floors', 'preferences') if brief.get(k)})}\n\n"
                                        f"FAILURES ({_score(rep)[0]}):\n{failures_text(rep)}\n\nFix them."}]
    steps = 0
    while steps < max_steps and time.monotonic() - t0 < budget_s and not state["rep"]["ok"]:
        steps += 1
        try:
            resp = await asyncio.wait_for(llm.chat(
                model=llm.model_id(config.MODEL_FIXER), messages=msgs, tools=TOOLS, tool_choice="auto", max_tokens=8192,
                reasoning_effort="high" if config.FIXER_THINK else "low"),
                timeout=min(150.0, max(20.0, budget_s - (time.monotonic() - t0))))
        except Exception as e:  # a slow or failed call: try again while there is time (three in a row ends the run)
            log.warning("fixer step %d failed: %r", steps, e)
            state["errors"] = state.get("errors", 0) + 1
            if state["errors"] >= 3:
                break
            continue
        state["errors"] = 0
        m = resp.choices[0].message
        calls = m.tool_calls or []
        msgs.append({"role": "assistant", "content": m.content or "",
                     "tool_calls": [c.model_dump(exclude_none=True) for c in calls]})  # as sent: Gemini's thought signatures ride along
        if not calls:
            msgs.append({"role": "user", "content": "Use the tools: check_edits, then apply_edits, or finish."})
            continue
        done = False
        for c in calls:
            try:
                args = json.loads(c.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            name = c.function.name
            if name == "get_elements":
                out = get_elements(args.get("ids") or [])
            elif name in ("check_edits", "apply_edits"):
                edits = [e for e in args.get("edits") or [] if isinstance(e, dict)]
                before = _score(state["rep"])
                try:
                    cand, crep = check(edits)
                except Exception as e:
                    out = {"error": f"those edits don't apply: {e}"}
                else:
                    after = _score(crep)
                    old_ids = {x["id"] for x in state["rep"]["checks"] if x["status"] == "fail"}
                    new = [x for x in crep["checks"] if x["status"] == "fail" and x["id"] not in old_ids]
                    fixed = [x for x in state["rep"]["checks"] if x["status"] == "fail" and x["id"] not in
                             {y["id"] for y in crep["checks"] if y["status"] == "fail"}]
                    better = after < before
                    out = {"failures_before": before[0], "failures_after": after[0], "better": better,
                           "fixed": [x["message"] for x in fixed][:8],
                           "new_problems": [f"{x['message']} Fix: {x.get('fix', '')}" for x in new][:8]}
                    if name == "apply_edits":
                        if better:
                            state.update(plan=cand, rep=crep, kept=state["kept"] + 1)
                            out["applied"] = True
                            out["remaining"] = failures_text(crep, 10) if not crep["ok"] else "none: call finish"
                            yield "edit", {"fixed": len(fixed), "failures": after[0], "summary": [x["title"] for x in fixed][:3]}
                            yield "plan", {"plan": cand}
                            yield "compliance", {"report": crep}
                        else:
                            out["applied"] = False
                            out["why"] = "the plan would not get better; adjust the edits"
            elif name == "finish":
                left = budget_s - (time.monotonic() - t0)
                if state["rep"]["ok"] or left < 60 or state.get("pushed", 0) >= 2:
                    out, done = {"ok": True}, True
                else:  # keep going while there is time: a different approach often works (move a neighbour, swap rooms)
                    state["pushed"] = state.get("pushed", 0) + 1
                    out = {"ok": False, "message": f"{_score(state['rep'])[0]} failures remain and there is time left. Try a "
                           "different approach: move or resize a neighbouring room, swap two rooms, or move the opening.",
                           "remaining": failures_text(state["rep"], 10)}
            else:
                out = {"error": "unknown tool"}
            log.debug("fixer %s %s -> %s", name, (c.function.arguments or "")[:300], json.dumps(out)[:300])
            msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(out)[:12000]})
        if done:
            break
    log.info("fixer: %d steps, %d edits kept, %d failures left, %.0fs", steps, state["kept"], _score(state["rep"])[0],
             time.monotonic() - t0)
    yield "_result", {"plan": state["plan"], "report": state["rep"], "steps": steps, "kept": state["kept"]}
