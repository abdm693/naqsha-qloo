"""LDA compliance engine: envelope lookup and BuildingPlan checks.

Rules come from lda_rules.json, extracted from docs/research/lda-regulations.md (LDA Building & Zoning
Regulations 2019, consolidated text of 09-02-2026). All geometry is in plan feet, using the conventions
in contracts/plan.ts.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

from . import planning

MARLA_SQFT = 225.0  # Lahore District (LDA)
REF = "LDA B&ZR 2019 (consolidated 09-02-2026)"

OUTDOOR = {"lawn", "driveway", "open_space", "courtyard"}
OPEN_AIR = OUTDOOR | {"porch", "balcony", "terrace"}  # spaces that count as "outside" for windows
# A prayer room is not a habitable room under the B&ZR (it is used briefly, like a store or utility), so the 100 sq ft /
# 8 ft minimum and the 8% glazing rule don't apply to it.
HABITABLE = {"drawing", "lounge", "dining", "bedroom", "master_bedroom", "guest_bedroom", "study", "servant"}
KITCHENS = {"kitchen", "dirty_kitchen"}
WETS = {"bath", "powder"}
NOT_FAR = OUTDOOR | {"porch", "garage", "balcony", "terrace"}  # FAR excludes covered parking and open-to-sky areas
GLAZED = {"window", "corner_window", "sliding_door", "ventilator"}
EPS = 0.05


@lru_cache(maxsize=1)
def rules() -> dict:
    return json.loads((Path(__file__).with_name("lda_rules.json")).read_text())


def find_band(area_marla: float, zone: str = "approved_scheme") -> dict:
    bands = rules()["zones"][zone]["bands"]
    for b in bands:
        pb = b["plot_band"]
        lo_ok = area_marla >= pb["min_marla"] if pb.get("min_inclusive", True) else area_marla > pb["min_marla"]
        hi = pb.get("max_marla")
        hi_ok = True if hi is None else (area_marla <= hi if pb.get("max_inclusive") else area_marla < hi)
        if lo_ok and hi_ok:
            return b
    return bands[-1]


BUILTIN_AUTHORITIES = {"LDA", "DHA", "BAHRIA", "OTHER"}
# Rule packs researched on the web (agents/research.py), by authority code. Each holds bands by plot area in sq ft.
PACKS: dict[str, dict] = {}


def register_pack(authority: str, pack: dict) -> None:
    PACKS[str(authority or "").upper()] = pack


def has_pack(authority: str | None) -> bool:
    return str(authority or "").upper() in PACKS


def pack_band(authority: str, area_sqft: float) -> tuple[dict | None, dict | None]:
    """(pack, band) for a researched authority and plot area, or (None, None)."""
    pack = PACKS.get(str(authority or "").upper())
    if not pack:
        return None, None
    bands = pack.get("bands") or []
    for b in bands:
        hi = b.get("max_sqft")
        if area_sqft >= (b.get("min_sqft") or 0) and (hi is None or area_sqft < hi):
            return pack, b
    return pack, (bands[-1] if bands and area_sqft >= (bands[-1].get("min_sqft") or 0) else bands[0] if bands else None)


def _pack_overrides(authority: str, area_sqft: float) -> tuple[dict, list[str]]:
    """A researched pack's numbers for this plot (setbacks, coverage, FAR, height, storeys), and notes naming the sources."""
    pack, b = pack_band(authority, area_sqft)
    if not b:
        return {}, []
    over = {k: b[k] for k in ("max_coverage_pct", "max_far", "max_height_ft", "max_storeys") if b.get(k) is not None}
    over["setbacks_ft"] = b["setbacks_ft"]
    name0 = pack.get("authority") or authority
    over["label"] = f"{name0} {b['label']}".strip() if b.get("label") else name0
    ids = set(b.get("sources") or [])
    srcs = [s for s in pack.get("sources") or [] if s.get("id") in ids] or (pack.get("sources") or [])[:2]
    name = pack.get("authority_name") or pack.get("authority") or authority
    missing = [w for k, w in (("max_coverage_pct", "coverage"), ("max_far", "FAR"), ("max_height_ft", "height"),
                              ("max_storeys", "storeys")) if b.get(k) is None]
    notes = [f"{name} rules researched on the web for a {b['label'] or 'plot of this size'}: "
             + "; ".join(f"{s.get('title') or s['url']} ({s['url']})" for s in srcs[:3]) + "."]
    if missing:
        notes.append(f"The sources don't state the {', '.join(missing)}: the LDA baseline is used for those.")
    notes.append("A researched rule pack is a draft: confirm it with the authority before you build.")
    return over, notes


def _authority_overrides(authority: str) -> tuple[dict, list[str]]:
    """Other regulators: LDA bands as the baseline, plus known caps and a caveat."""
    if authority == "DHA":
        return {"max_height_ft": 39, "max_storeys": 2}, [
            "DHA Lahore applies its own construction bylaws (Aug 2026): max height 39 ft, basement + ground + first floor. "
            "Setbacks shown use the LDA baseline; confirm with DHA's approval branch."]
    if authority == "BAHRIA":
        return {}, ["Bahria Town Lahore uses its own SOPs (not published online). LDA baseline shown; confirm with the Bahria Design Wing."]
    if authority not in ("LDA", "OTHER"):
        return {}, [f"{authority}: no rule pack yet, so LDA's current rules are shown as the baseline."]
    return {}, []


def corner_splay_ft(band: dict, marla: float) -> float:
    """The corner splay for a band. Most bands give a number; the 10 marla band splits it: exactly 10 marla → 5 ft,
    above 10 marla → 10 ft (lda_rules.json)."""
    v = band.get("corner_splay_ft")
    if isinstance(v, dict):
        exact, above = v.get("plot_exactly_10_marla"), v.get("plot_above_10_marla")
        # 35×65 (≈10.1 marla) is the standard 10 marla plot; the plan canvas uses the same 10.15 cut-off.
        v = above if (above is not None and marla > 10.15) else exact if exact is not None else above
    try:
        return float(v) if v is not None else 5.0
    except (TypeError, ValueError):
        return 5.0


def envelope(width_ft: float, depth_ft: float, authority: str = "LDA", corner: bool = False, side_on: str = "right") -> dict:
    area = width_ft * depth_ft
    marla = area / MARLA_SQFT
    b = find_band(marla)
    over, notes = _pack_overrides(authority, area) if has_pack(authority) else _authority_overrides(authority)
    if over:  # the band as this authority sets it (room minimums and the rest stay on the LDA baseline)
        b = {**b, **{k: v for k, v in over.items() if k in ("setbacks_ft", "max_coverage_pct", "max_far", "label")}}
    sb = b["setbacks_ft"]
    side, count = float(sb.get("side") or 0), int(sb.get("side_count") or 0)
    left = side if count == 2 or (count == 1 and side_on == "left") else 0.0
    right = side if count == 2 or (count == 1 and side_on != "left") else 0.0
    setbacks = {"front": float(sb["front"]), "rear": float(sb["rear"]), "left": left, "right": right}
    cov = float(b["max_coverage_pct"])
    buildable = {"x": left, "y": setbacks["front"], "w": max(0.0, width_ft - left - right),
                 "d": max(0.0, depth_ft - setbacks["front"] - setbacks["rear"])}
    lahore = str(authority or "").upper() in BUILTIN_AUTHORITIES
    side_note = {0: "No side space required", 1: f"{side:g} ft side space on one side", 2: f"{side:g} ft side space on both sides"}[min(count, 2)]
    max_h = over.get("max_height_ft", b["max_height_ft"])
    max_st = over.get("max_storeys", b["max_storeys"])
    notes = [
        f"Plot {width_ft:g}×{depth_ft:g} ft = {area:,.0f} sq ft" + (f" ≈ {marla:.1f} marla ({b['label']})." if lahore else "."),
        f"Setbacks: front {setbacks['front']:g} ft, rear {setbacks['rear']:g} ft; {side_note.lower()}.",
        f"Ground coverage up to {cov:g}% ({area * cov / 100:,.0f} sq ft); FAR 1:{b['max_far']:g} (basement counts).",
        f"Height up to {max_h:g} ft to top of parapet (mumty ≤ 9′6″ excluded); max {max_st} storeys + basement.",
    ] + notes
    if corner and lahore:
        notes.append(f"Corner plot: keep a {corner_splay_ft(b, marla):g} ft splay at the corner boundary wall.")
    return {
        "authority": authority, "band": b["label"], "setbacks_ft": setbacks, "side_space_note": side_note,
        "max_coverage_pct": cov, "max_far": float(b["max_far"]), "max_height_ft": float(max_h), "max_storeys": int(max_st),
        "buildable_rect": buildable, "max_ground_coverage_sqft": round(area * cov / 100, 1), "notes": notes,
        "_band": b,
    }


# ---------------------------------------------------------------------------------------------------
def _union_area(rects: list[dict]) -> float:
    """Exact area of a union of axis-aligned rects (coordinate compression)."""
    if not rects:
        return 0.0
    xs = sorted({r["x"] for r in rects} | {r["x"] + r["w"] for r in rects})
    ys = sorted({r["y"] for r in rects} | {r["y"] + r["d"] for r in rects})
    area = 0.0
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            cx, cy = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
            if any(r["x"] <= cx <= r["x"] + r["w"] and r["y"] <= cy <= r["y"] + r["d"] for r in rects):
                area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
    return area


def _on_edge(pt, rect, tol=0.75) -> bool:
    x, y = pt
    x0, y0, x1, y1 = rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["d"]
    on_v = (abs(x - x0) <= tol or abs(x - x1) <= tol) and y0 - tol <= y <= y1 + tol
    on_h = (abs(y - y0) <= tol or abs(y - y1) <= tol) and x0 - tol <= x <= x1 + tol
    return on_v or on_h


def _overlap(a, b) -> bool:
    return a["x"] < b["x"] + b["w"] - EPS and b["x"] < a["x"] + a["w"] - EPS and a["y"] < b["y"] + b["d"] - EPS and b["y"] < a["y"] + a["d"] - EPS


def _fmt_ft(v: float) -> str:
    feet = int(v)
    inches = round((v - feet) * 12)
    if inches == 12:
        feet, inches = feet + 1, 0
    return f"{feet}′{inches}″" if inches else f"{feet}′"


def _voice(authority: str) -> tuple[str, str]:
    """Who a rule is said in the name of, and its reference. Outside Lahore, a number that isn't the place's own is Naqsha's."""
    if str(authority or "").upper() in BUILTIN_AUTHORITIES:
        return "LDA", REF
    pack = PACKS.get(str(authority or "").upper()) or {}
    return "Naqsha", str(pack.get("instrument") or pack.get("authority_name") or "Naqsha's baseline")


def check(plan: dict, brief: dict | None = None) -> dict:
    """LDA regulation checks (category "lda") plus Naqsha's planning rules (category "livable", see planning.py)."""
    site = plan.get("site", {})
    plot = site.get("plot", {})
    W, D = float(plot.get("width_ft", 0)), float(plot.get("depth_ft", 0))
    authority = site.get("authority", "LDA")
    applied = {**{"front": 0, "rear": 0, "left": 0, "right": 0}, **(site.get("setbacks_ft") or {})}
    side_on = "left" if applied.get("left", 0) > applied.get("right", 0) else "right"
    env = envelope(W, D, authority, bool(plot.get("corner")), side_on)
    band = env.pop("_band")
    plot_area = W * D
    who, base_ref = _voice(authority)

    levels = {lv["id"]: lv for lv in plan.get("levels", [])}
    rooms = plan.get("rooms", [])
    checks: list[dict] = []
    ix = planning.PlanIndex(plan)

    def add(cid, title, ok, message, value=None, limit=None, ref=None, ids=None, warn=False, unit=None, category="lda", fix=None):
        c = {"id": cid, "title": title, "status": "pass" if ok else ("warn" if warn else "fail"), "message": message,
             "value": value, "limit": limit, "rule_ref": ref or base_ref, "element_ids": ids or [], "category": category}
        if unit:
            c["unit"] = unit
        if fix and not ok:
            c["fix"] = fix
        checks.append(c)

    # --- Plan integrity -------------------------------------------------------------------------
    for lv in levels:
        lr = [r for r in rooms if r.get("level") == lv]
        for i, a in enumerate(lr):
            for b2 in lr[i + 1:]:
                if _overlap(a["rect"], b2["rect"]):
                    add(f"plan.overlap:{a['id']}:{b2['id']}", "Rooms overlap", False,
                        f"{a['name']} and {b2['name']} overlap on the {levels[lv]['name']}.", ids=[a["id"], b2["id"]],
                        category="livable", ref="Naqsha planning rule", fix="Rooms on one floor share edges exactly; they never overlap.")

    # --- Setbacks (required minimums vs. applied, and every building room inside the envelope) ------
    req = env["setbacks_ft"]
    sb_req = band["setbacks_ft"]
    side_needed, side_count = float(sb_req.get("side") or 0), int(sb_req.get("side_count") or 0)
    add("setback.front", "Front setback (building line)", applied["front"] + EPS >= req["front"],
        f"Front open space {_fmt_ft(applied['front'])} (minimum {_fmt_ft(req['front'])}).", applied["front"], req["front"], unit="ft",
        fix=f"Keep every room at least {req['front']:g} ft back from the front boundary.")
    add("setback.rear", "Rear setback", applied["rear"] + EPS >= req["rear"],
        f"Rear open space {_fmt_ft(applied['rear'])} (minimum {_fmt_ft(req['rear'])}).", applied["rear"], req["rear"], unit="ft",
        fix=f"Keep every room at least {req['rear']:g} ft from the rear boundary.")
    if side_count:
        sides_ok = sum(1 for s in ("left", "right") if applied[s] + EPS >= side_needed)
        need_txt = "one side" if side_count == 1 else "both sides"
        add("setback.side", "Side space", sides_ok >= side_count,
            f"A {_fmt_ft(side_needed)} side space is required on {need_txt}; {sides_ok} side{'s' if sides_ok != 1 else ''} provided.",
            sides_ok, side_count, unit="sides", fix=f"Leave {side_needed:g} ft open on {need_txt}.")

    bx0, by0 = applied["left"], applied["front"]
    bx1, by1 = W - applied["right"], D - applied["rear"]
    outside = [r for r in rooms if r.get("type") not in OUTDOOR and (
        r["rect"]["x"] < bx0 - EPS or r["rect"]["y"] < by0 - EPS or
        r["rect"]["x"] + r["rect"]["w"] > bx1 + EPS or r["rect"]["y"] + r["rect"]["d"] > by1 + EPS)]
    add("setback.envelope", "Building within setbacks", not outside,
        "All rooms, porches and balconies sit inside the building line." if not outside else
        "Inside the mandatory open space: " + ", ".join(r["name"] for r in outside) +
        ". Rooms, porches and balconies can't project into mandatory open spaces.",
        ids=[r["id"] for r in outside], fix="Pull these rooms back inside the setback lines (porches and balconies too).")

    # --- Coverage & FAR ----------------------------------------------------------------------------
    ground = [lv for lv in levels.values() if lv.get("index") == 0]
    gid = ground[0]["id"] if ground else "ground"
    covered = _union_area([r["rect"] for r in rooms if r.get("level") == gid and r.get("type") not in OUTDOOR])
    cov_pct = 100 * covered / plot_area if plot_area else 0
    add("coverage", "Ground coverage", cov_pct <= env["max_coverage_pct"] + 0.05,
        f"Covered {covered:,.0f} sq ft = {cov_pct:.1f}% of the plot (max {env['max_coverage_pct']:g}%).",
        round(cov_pct, 1), env["max_coverage_pct"], ids=[], unit="%",
        fix=f"Reduce the ground-floor covered area to {env['max_coverage_pct']:g}% of the plot or less.")

    storey_levels = [lv for lv in levels.values() if lv.get("index", 0) >= 0 and any(
        r.get("level") == lv["id"] and r.get("type") not in OPEN_AIR for r in rooms)]
    floor_area = 0.0
    for lv in levels.values():
        floor_area += _union_area([r["rect"] for r in rooms if r.get("level") == lv["id"] and r.get("type") not in NOT_FAR])
    far = floor_area / plot_area if plot_area else 0
    add("far", "Floor area ratio", far <= env["max_far"] + 0.01,
        f"Total floor area {floor_area:,.0f} sq ft gives an FAR of {far:.2f} (max {env['max_far']:g}).", round(far, 2), env["max_far"],
        fix="Reduce the total covered floor area.")

    # --- Height & storeys -------------------------------------------------------------------------
    top = max((lv["elevation_ft"] + lv["height_ft"] for lv in levels.values()), default=0)
    add("height", "Building height", top <= env["max_height_ft"] + EPS,
        f"Top of parapet at {_fmt_ft(top)} above road crown (max {_fmt_ft(env['max_height_ft'])}, stair tower excluded).",
        round(top, 2), env["max_height_ft"], unit="ft", fix="Lower the floor-to-floor heights or the parapet.")
    n_storeys = len([lv for lv in storey_levels if lv.get("index", 0) >= 0])
    add("storeys", "Number of storeys", n_storeys <= env["max_storeys"],
        f"{n_storeys} storey{'s' if n_storeys != 1 else ''} above ground (max {env['max_storeys']}, basement excluded).", n_storeys,
        env["max_storeys"], ref=f"{base_ref} §2.7.1(a)" if who == "LDA" else None, unit="storeys")
    mumty = (plan.get("roof") or {}).get("mumty")
    if mumty:
        mh = float(mumty.get("height_ft", 0))
        add("mumty", "Mumty (stair tower) height", mh <= (band.get("mumty_max_height_ft") or 9.5) + EPS,
            f"Stair tower (mumty) {_fmt_ft(mh)} (max 9′6″, excluded from building height).", mh, 9.5, unit="ft",
            fix="Keep roof.mumty.height_ft at 9.5 or less.")
    parapet = float((plan.get("roof") or {}).get("parapet_ft", 0))
    pmin = (band.get("parapet_height_ft") or {}).get("min") or 2.75
    add("parapet", "Roof parapet", parapet + EPS >= pmin, f"Parapet {_fmt_ft(parapet)} (minimum {_fmt_ft(pmin)} for safety).",
        parapet, pmin, warn=True, unit="ft")
    bw = site.get("boundary_wall") or {}
    bw_max = max(float(bw.get(k, 0)) for k in ("front_height_ft", "side_height_ft", "rear_height_ft")) if bw else 0
    add("boundary_wall", "Boundary wall height", bw_max <= 7 + EPS, f"Tallest boundary wall {_fmt_ft(bw_max)} (max 7′ above plinth).",
        bw_max, 7, unit="ft")

    # --- Rooms: sizes, clear height, light & ventilation ---------------------------------------------
    min_sizes = band.get("min_room_sizes") or {}
    hab = min_sizes.get("habitable_room") or {"min_area_sqft": 100, "min_width_ft": 8}
    kit = min_sizes.get("kitchen") or {"min_area_sqft": 50, "min_width_ft": 6}
    ceil_min = float(band.get("ceiling_height_ft_min") or 9.5)
    win_pct = float(band.get("window_area_pct_min") or 8)

    def glazing(room_id: str) -> float:
        # Only openings that really exist count: same level, on the room's own wall, to the outside (not a party wall) or to
        # a same-level porch, balcony, terrace or open space (planning rules P-01, P-02, P-03, P-16).
        return planning.valid_glazing(ix, room_id)

    for r in rooms:
        t, rect = r.get("type"), r["rect"]
        area, width = rect["w"] * rect["d"], min(rect["w"], rect["d"])
        lv = levels.get(r.get("level"), {})
        for kind_set, mins in ((HABITABLE, hab), (KITCHENS, kit)):
            if t not in kind_set:
                continue
            a_ok, w_ok = area + EPS >= mins["min_area_sqft"], width + EPS >= mins["min_width_ft"]
            dims = f"{_fmt_ft(rect['w'])} × {_fmt_ft(rect['d'])}"
            if a_ok and w_ok:
                add(f"room.size:{r['id']}", f"{r['name']} size", True,
                    f"{r['name']} is {dims} = {area:.0f} sq ft (min {mins['min_area_sqft']} sq ft and {_fmt_ft(mins['min_width_ft'])} wide).",
                    round(area), mins["min_area_sqft"], ids=[r["id"]], unit="sq ft")
            elif not w_ok:  # report the dimension that actually fails
                add(f"room.size:{r['id']}", f"{r['name']} width", False,
                    f"{r['name']} is only {_fmt_ft(width)} wide (min {_fmt_ft(mins['min_width_ft'])}); it is {dims}.",
                    round(width, 2), mins["min_width_ft"], ids=[r["id"]], unit="ft",
                    fix=f"Make {r['name']} at least {mins['min_width_ft']:g} ft wide.")
            else:
                add(f"room.size:{r['id']}", f"{r['name']} size", False,
                    f"{r['name']} is {area:.0f} sq ft ({dims}); the minimum is {mins['min_area_sqft']} sq ft.",
                    round(area), mins["min_area_sqft"], ids=[r["id"]], unit="sq ft",
                    fix=f"Make {r['name']} at least {mins['min_area_sqft']} sq ft.")
        if t in HABITABLE | KITCHENS:
            clear = float(r.get("ceiling_height_ft") or (lv.get("height_ft", 0) - lv.get("slab_ft", 0.5)))
            if clear + EPS < ceil_min:
                add(f"room.ceiling:{r['id']}", f"{r['name']} clear height", False,
                    f"Clear height {_fmt_ft(clear)} is below {_fmt_ft(ceil_min)}.", round(clear, 2), ceil_min, ids=[r["id"]], unit="ft",
                    fix="Use 11 ft floor-to-floor with a 0.5 ft slab.")
            g = glazing(r["id"])
            need = area * win_pct / 100
            add(f"room.light:{r['id']}", f"{r['name']} daylight", g + EPS >= need,
                f"{g:.0f} sq ft of windows for {need:.0f} sq ft needed ({win_pct:g}% of the floor area)." if g + EPS >= need else
                f"{r['name']} has {g:.0f} sq ft of windows to the outside; {who} needs {need:.0f} sq ft ({win_pct:g}% of the floor area).",
                round(g, 1), round(need, 1), ids=[r["id"]], unit="sq ft",
                fix=f"Give {r['name']} windows on its OWN outside wall on the same floor (or onto a same-floor porch, balcony, "
                    f"terrace or open space): at least {need:.0f} sq ft. A window onto another room or another floor doesn't count.")
        if t in WETS:
            # No opening at all is a fail (a landlocked bath can't be aired); a small one is a warning.
            g = glazing(r["id"])
            add(f"room.vent:{r['id']}", f"{r['name']} ventilation", g + EPS >= 2,
                f"Has {g:.1f} sq ft of opening to the outside (min 2 sq ft)." if g + EPS >= 2 else
                f"{r['name']} has only {g:.1f} sq ft open to the outside; {who} asks for at least 2 sq ft." if g > EPS else
                f"{r['name']} has no opening to the outside: it needs a ventilator on an outside wall, or a duct ({who}: at least "
                f"2 sq ft).",
                round(g, 1), 2, ids=[r["id"]], warn=g > EPS, unit="sq ft",
                fix=f"Give {r['id']} a 'ventilator' opening (about 2 × 1.5 ft, between [\"{r['id']}\", \"exterior\"]) on its OWN "
                    f"outside wall, or onto a same-floor open space or terrace that is open to the sky. If {r['name']} has no "
                    f"outside wall, move it (or swap it with a neighbour) so it touches one.")

    # --- Stairs -----------------------------------------------------------------------------------
    for st in plan.get("stairs", []):
        frm, to = levels.get(st.get("from_level")), levels.get(st.get("to_level"))
        rise_ft = (to["elevation_ft"] - frm["elevation_ft"]) if frm and to else 11
        riser = float(st.get("riser_in", 7))
        n_risers = math.ceil(rise_ft * 12 / riser - 1e-6) if riser else 0
        flights = 2 if st.get("kind") in ("dogleg", "l_shape") else 1
        per_flight = math.ceil(n_risers / flights) if flights else n_risers
        width, tread = float(st.get("width_ft", 0) or 0), float(st.get("tread_in", 0) or 0)
        ok = width + EPS >= 3.5 and riser <= 7.5 + EPS and tread + EPS >= 10 and per_flight <= 15
        actual = rise_ft * 12 / n_risers if n_risers else riser
        wrong = [w for w, bad in (("width at least 3′6″", width + EPS < 3.5), ("risers at most 7½ in", riser > 7.5 + EPS),
                                  ("treads at least 10 in", tread + EPS < 10), ("at most 15 risers per flight", per_flight > 15)) if bad]
        add(f"stair:{st['id']}", ix.sname(st), ok,
            f"{n_risers} risers of {actual:.2f} in, {_fmt_ft(width)} wide, {tread:g} in treads, {flights} flight{'s' if flights > 1 else ''}"
            + (f" of up to {per_flight} risers." if flights > 1 else ".") + (f" {who} needs {', '.join(wrong)}." if wrong else ""),
            per_flight, 15, ids=[st["id"]], unit="risers per flight",
            fix="Flights 3.5 ft wide, risers 6.95 in, treads 10 in, a dog-leg with a mid-landing.")

    # --- Services ---------------------------------------------------------------------------------
    marla = plot_area / MARLA_SQFT
    if marla >= 3 and who == "LDA":
        has_tank = bool((plan.get("roof") or {}).get("water_tank"))
        add("services.water_tank", "Overhead water tank", has_tank,
            "Overhead water tank on the roof." if has_tank else "Plots of 3 marla and above need overhead and underground water tanks.",
            warn=True, fix="Add roof.water_tank.")

    checks += planning.check(plan, brief)
    fails = [c for c in checks if c["status"] == "fail"]
    return {
        "authority": authority, "band": band["label"], "ok": not fails, "checks": checks,
        "envelope": {"setbacks_ft": env["setbacks_ft"], "max_coverage_pct": env["max_coverage_pct"],
                     "max_height_ft": env["max_height_ft"], "max_storeys": env["max_storeys"], "buildable_rect": env["buildable_rect"]},
        "metrics": {"plot_area_sqft": round(plot_area, 1), "covered_area_sqft": round(covered, 1), "coverage_pct": round(cov_pct, 1),
                    "total_floor_area_sqft": round(floor_area, 1), "far": round(far, 2), "height_ft": round(top, 2), "storeys": n_storeys},
    }


GROUPS = [  # fix-loop order: life safety first, then privacy and circulation, then the regulations, then rooms and brief
    ("SAFETY (stairs, roof, openings)", ("plan.stair", "plan.roof.mumty", "plan.opening.door_to_drop")),
    ("PRIVACY & CIRCULATION", ("plan.privacy", "plan.circulation", "plan.open_to", "plan.opening", "plan.overlap")),
    ("LDA REGULATIONS", ("setback", "coverage", "far", "height", "storeys", "mumty", "parapet", "boundary_wall", "stair:")),
    ("ROOMS", ("room.", "plan.room", "plan.structure", "plan.open_space", "services")),
    ("THE FAMILY'S BRIEF", ("plan.program", "plan.roof")),
]


def _group(cid: str) -> int:
    for i, (_, prefixes) in enumerate(GROUPS):
        if cid.startswith(prefixes):
            return i
    return len(GROUPS)


def violations_text(report: dict, warns: bool = True) -> str:
    """Grouped, actionable list of failing (and warning) checks for the planner: `[FAIL] id: message Fix: hint (ids: ...)`."""
    items = [c for c in report["checks"] if c["status"] == "fail" or (warns and c["status"] == "warn")]
    items.sort(key=lambda c: (_group(c["id"]), c["status"] != "fail"))
    out, cur = [], None
    for c in items:
        g = _group(c["id"])
        if g != cur:
            cur = g
            out.append(GROUPS[g][0] + ":" if g < len(GROUPS) else "OTHER:")
        line = f"- [{c['status'].upper()}] {c['id']}: {c['message']}"
        if c.get("fix"):
            line += f" Fix: {c['fix']}"
        if c.get("element_ids"):
            line += f" (ids: {', '.join(c['element_ids'])})"
        out.append(line)
    return "\n".join(out) or "(none)"


def is_review(c: dict) -> bool:
    """An architect's review note (review.<n>), kept apart from the rules in every count."""
    return str(c.get("id", "")).startswith("review.")


def counts(report: dict) -> dict:
    """{"fail": n, "warn": n, "lda": {"pass": n, "total": n}, "livable": {...}, "review": n} for scoring attempts and status
    lines, with the app's one definition (web/src/app/plan/compliance.ts summarize): a warning is not a pass, and the
    architect's review notes are not rules: they are counted on their own (`review`, the open ones), never in livable."""
    out: dict = {"fail": 0, "warn": 0, "lda": {"pass": 0, "total": 0}, "livable": {"pass": 0, "total": 0}, "review": 0}
    for c in report.get("checks", []):
        if is_review(c):
            out["review"] += c.get("status") != "pass"
            continue
        d = out.setdefault(c.get("category", "lda"), {"pass": 0, "total": 0})
        d["total"] += 1
        d["pass"] += c["status"] == "pass"
        if c["status"] in ("fail", "warn"):
            out[c["status"]] += 1
    return out


def status_line(report: dict) -> str:
    """"36/36 LDA · 10/12 livable · 2 architect's notes": the version rail, the samples and the landing all quote this."""
    c = counts(report)
    auth = str(report.get("authority") or "LDA").upper()
    label = "LDA" if auth in ("LDA", "DHA", "BAHRIA", "OTHER") else "local rules"  # researched packs: the city's own rules
    line = f"{c['lda']['pass']}/{c['lda']['total']} {label} · {c['livable']['pass']}/{c['livable']['total']} livable"
    if c["review"]:
        line += f" · {c['review']} architect's note{'s' if c['review'] != 1 else ''}"
    return line


def check_asbuilt(plan: dict, summary: dict) -> dict:
    """As-built checks on the 3D result: nothing built may project into a mandatory open space beyond what LDA allows
    for sunshades/chajjas (3 ft where that open space is ≥ 10 ft, otherwise 1.5 ft; 0 against a party wall).
    Light fixtures and glows are ignored; a 0.5 ft tolerance covers exterior wall thickness and finishes."""
    site = plan.get("site", {})
    W, D = site["plot"]["width_ft"], site["plot"]["depth_ft"]
    sb = {**{"front": 0, "rear": 0, "left": 0, "right": 0}, **(site.get("setbacks_ft") or {})}
    env = envelope(W, D, site.get("authority", "LDA"))
    who, base_ref = _voice(site.get("authority", "LDA"))
    band = env.pop("_band")

    def allow(space: float) -> float:
        return 0.0 if space <= 0 else (3.0 if space >= 10 else 1.5)

    tol = 0.5
    lim = {k: allow(v) + tol for k, v in sb.items()}
    x0, y0, x1, y1 = sb["left"], sb["front"], W - sb["right"], D - sb["rear"]
    skip = ("site", "boundary", "gate", "light", "glow", "facade:wall_light", "facade:led_strip", "lamp", "fixture", "street", "tree")
    checks = []
    for o in summary.get("objects", []):
        kind = (o.get("kind") or "").lower()
        if o.get("layer") not in ("facade", "structure", "custom") or kind.startswith(skip) or any(t in kind for t in ("light", "glow")):
            continue
        mn, mx = o["bbox_ft"]["min"], o["bbox_ft"]["max"]
        if mx[2] < 3:  # at ground level (plinth, paving), not a projection
            continue
        over = {"front": y0 - mn[1], "rear": mx[1] - y1, "left": x0 - mn[0], "right": mx[0] - x1}
        side, amount = max(over.items(), key=lambda kv: kv[1] - lim[kv[0]])
        if amount > lim[side]:
            what = (o.get("kind") or o.get("id") or "element").split(":")[-1].replace("_", " ")
            checks.append({"id": f"asbuilt.projection:{o['id']}", "title": "Projection into open space", "status": "fail", "category": "lda",
                           "message": f"The {what} project{'' if what.endswith('s') else 's'} {amount:.1f} ft into the {side} open space ({who} allows "
                                      f"{allow(sb[side]):g} ft for sunshades there).",
                           "rule_ref": f"{base_ref} §2.7 (projections)" if who == "LDA" else base_ref, "element_ids": [o["id"]]})
    if not checks:
        checks.append({"id": "asbuilt.ok", "title": "As-built projections", "status": "pass", "category": "lda",
                       "message": f"Nothing projects into the mandatory open spaces beyond {who}'s sunshade allowance.", "element_ids": []})
    for e in summary.get("section_errors", []):
        checks.append({"id": f"asbuilt.section:{e['section']}", "title": "3D section error", "status": "warn", "category": "livable",
                       "message": f"Section {e['section']} failed: {e['error'][:200]}", "element_ids": []})
    # What the engine repaired or could not repair while building (stair fit, roof door, guards, openings, furniture,
    # walking paths, parking): livable checks on the house as built.
    for c in summary.get("checks") or []:
        if not isinstance(c, dict) or not c.get("id"):
            continue
        status = c.get("status") if c.get("status") in ("pass", "warn", "fail") else "warn"
        checks.append({"id": f"asbuilt.engine:{c['id']}", "title": str(c.get("title") or "As built")[:120], "status": status,
                       "category": "livable", "message": str(c.get("message") or "")[:400],
                       "element_ids": [str(x) for x in (c.get("element_ids") or [])][:20]})
    return {"authority": site.get("authority", "LDA"), "band": band["label"], "ok": not any(c["status"] == "fail" for c in checks),
            "checks": checks, "envelope": {}, "metrics": {}}
