"""Floor plans as images, for the architect's self-review (and for anyone who wants to see what was checked).

Each level of a BuildingPlan is drawn the way an architect's sketch reads: the plot and setback line, rooms with names and
sizes, walls, doors with their swings, windows, stairs with treads and an UP arrow, the stair tower and tank on the roof.
The road is at the bottom of the sheet. Pure Pillow, no I/O.
"""
from __future__ import annotations

import io
import math
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

from ..compliance.planning import CIRC, DOORS, HINGED, OPEN, PRIVATE, SERVICE, WET, PlanIndex, rect_of, roof_free_area, sides

INK = (29, 29, 31)
INK2 = (90, 90, 96)
INK3 = (150, 150, 156)
WALL = (40, 40, 44)
PAPER = (255, 255, 255)
ACCENT = (196, 92, 52)
GLASS = (60, 130, 200)
FILL = {
    "private": (232, 238, 250), "wet": (222, 242, 246), "circ": (246, 243, 236), "living": (250, 241, 228),
    "service": (238, 244, 232), "open": (241, 247, 238), "other": (244, 244, 246),
}


@lru_cache(maxsize=8)
def _font(size: int, bold: bool = False):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def _cls(t: str) -> str:
    if t in PRIVATE:
        return "private"
    if t in WET:
        return "wet"
    if t in CIRC:
        return "circ"
    if t in SERVICE:
        return "service"
    if t in OPEN:
        return "open"
    if t in {"lounge", "dining", "drawing", "prayer", "study", "dressing"}:
        return "living"
    return "other"


def _fmt(v: float) -> str:
    feet = int(v + 1e-9)
    inch = round((v - feet) * 12)
    if inch == 12:
        feet, inch = feet + 1, 0
    return f"{feet}'{inch}\"" if inch else f"{feet}'"


def render_level(plan: dict, level_id: str, px_per_ft: float | None = None) -> bytes:
    ix = PlanIndex(plan)
    W, D = ix.W or 35, ix.D or 65
    s = px_per_ft or max(10.0, min(20.0, 1150.0 / max(W, D)))
    m, top, bottom = 56, 70, 70
    img = Image.new("RGB", (int(W * s + 2 * m), int(D * s + top + bottom)), PAPER)
    dr = ImageDraw.Draw(img)

    def P(x, y):
        return (m + x * s, top + (D - y) * s)

    def box(r):
        x0, y0, x1, y1 = r
        a, b = P(x0, y1), P(x1, y0)
        return [a[0], a[1], b[0], b[1]]

    lv = ix.lv.get(level_id, {})
    is_roof = level_id == ix.roof_id
    f_title, f_room, f_small = _font(22), _font(max(12, int(s * 0.8))), _font(max(10, int(s * 0.62)))
    title = f"{lv.get('name') or level_id}  ·  plot {W:g} x {D:g} ft  ·  road at the bottom"
    dr.text((m, 20), title, fill=INK, font=f_title)

    # plot, setback line, road
    dr.rectangle(box((0, 0, W, D)), outline=INK3, width=1)
    sb = ix.sb
    _dashed_rect(dr, box((sb["left"], sb["front"], W - sb["right"], D - sb["rear"])), ACCENT, 6, 5)
    dr.text((m, top + D * s + 12), "ROAD", fill=INK2, font=f_small)

    # a faint ghost of the floor below helps read what sits over what
    order = [x["id"] for x in ix.levels]
    if level_id in order and order.index(level_id) > 0:
        below = order[order.index(level_id) - 1]
        for r in ix.level_rooms(below):
            if r.get("type") not in OPEN:
                dr.rectangle(box(ix.R[r["id"]]), outline=(225, 225, 230), width=1)

    rooms = ix.level_rooms(level_id)
    for r in sorted(rooms, key=lambda r: r.get("type") not in OPEN):
        rr = ix.R[r["id"]]
        dr.rectangle(box(rr), fill=FILL[_cls(r.get("type", ""))])
    # walls: enclosed room edges in ink, open-air edges dashed
    for r in rooms:
        rr = ix.R[r["id"]]
        if r.get("type") in OPEN:
            _dashed_rect(dr, box(rr), INK3, 5, 4)
        else:
            dr.rectangle(box(rr), outline=WALL, width=max(2, int(s * 0.28)))
    # open_to edges: erase the wall and dash it
    for (a, b), res in ix.open_pairs.items():
        e = res.get("edge")
        if not e or ix.by_id.get(a, {}).get("level") != level_id:
            continue
        axis, c, lo, hi = e
        p0, p1 = (P(lo, c), P(hi, c)) if axis == "x" else (P(c, lo), P(c, hi))
        dr.line([p0, p1], fill=FILL["living"], width=max(3, int(s * 0.35)))
        _dashed_line(dr, p0, p1, INK3 if res["valid"] else ACCENT, 4, 4, 1)

    # roof: the slab outline and the stair tower go under the stair drawing
    if is_roof:
        if ix.top:
            for r in ix.level_rooms(ix.top):
                if r.get("type") not in OPEN:
                    dr.rectangle(box(ix.R[r["id"]]), outline=(200, 200, 206), width=1)
        if ix.mumty:
            dr.rectangle(box(ix.mumty), fill=(236, 232, 224), outline=WALL, width=max(2, int(s * 0.28)))

    # stairs
    departing = [st for st in ix.stairs if st.get("from_level") == level_id]
    for st in departing or [st for st in ix.stairs if st.get("to_level") == level_id][:1]:
        _draw_stair(dr, P, s, ix.stair_geo(st), up=bool(departing), font=f_small)

    if is_roof:
        t = ix.roof.get("water_tank")
        if t and t.get("rect"):
            tr = rect_of(t)
            dr.rectangle(box(tr), outline=GLASS, width=2)
            _label(dr, P((tr[0] + tr[2]) / 2, (tr[1] + tr[3]) / 2), [f"Tank ({t.get('material') or 'tank'})"], f_small, GLASS)
        if ix.mumty:
            ds = (ix.roof.get("mumty") or {}).get("door_side")
            if ds:
                axis, c, lo, hi, n = sides(ix.mumty)[ds]
                mid = (lo + hi) / 2
                p0, p1 = (P(mid - 1.5, c), P(mid + 1.5, c)) if axis == "x" else (P(c, mid - 1.5), P(c, mid + 1.5))
                dr.line([p0, p1], fill=ACCENT, width=max(4, int(s * 0.4)))
                lx, ly = (mid, c + n[1] * 1.6) if axis == "x" else (c + n[0] * 3.2, mid)  # just outside the door
                _label(dr, P(lx, ly), ["Roof door"], f_small, ACCENT)
        free, fp = roof_free_area(ix)
        if fp:
            dr.text((m, 48), f"About {free:,.0f} sq ft of roof kept clear ({100 * free / fp:.0f}%)", fill=INK2, font=f_small)

    # openings
    for o in ix.openings:
        if o.get("level") != level_id:
            continue
        _draw_opening(dr, P, s, ix, o)

    # labels last so nothing covers them
    for r in rooms:
        rr = ix.R[r["id"]]
        w, d = rr[2] - rr[0], rr[3] - rr[1]
        cx, cy = (rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2
        lines = [r.get("name") or r["id"], f"{_fmt(w)} x {_fmt(d)}"]
        if r.get("type") not in OPEN and w * d >= 30:
            lines.append(f"{w * d:.0f} sq ft")
        _label(dr, P(cx, cy), lines, f_room if min(w, d) * s >= 70 else f_small, INK2 if r.get("type") in OPEN else INK)

    # north arrow from the facing
    _north(dr, (img.width - m - 10, 34), plan.get("site", {}).get("facing") or "N", f_small)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def render_all(plan: dict) -> list[tuple[str, str, bytes]]:
    """[(level_id, level_name, png)] for every level that has rooms, stairs or roof furniture."""
    ix = PlanIndex(plan)
    out = []
    for lv in ix.levels:
        lid = lv["id"]
        if ix.level_rooms(lid) or lid == ix.roof_id or any(s.get("from_level") == lid for s in ix.stairs):
            out.append((lid, lv.get("name") or lid, render_level(plan, lid)))
    return out


# --- primitives ---------------------------------------------------------------------------------------------------------
def _label(dr, xy, lines, font, color):
    x, y = xy
    hs = [dr.textbbox((0, 0), t, font=font) for t in lines]
    total = sum(b[3] - b[1] + 3 for b in hs)
    cy = y - total / 2
    for t, b in zip(lines, hs):
        tw = b[2] - b[0]
        dr.text((x - tw / 2, cy), t, fill=color, font=font)
        cy += b[3] - b[1] + 3


def _dashed_line(dr, p0, p1, color, dash, gap, width=1):
    x0, y0 = p0
    x1, y1 = p1
    L = math.hypot(x1 - x0, y1 - y0)
    if L < 1:
        return
    ux, uy = (x1 - x0) / L, (y1 - y0) / L
    t = 0.0
    while t < L:
        e = min(L, t + dash)
        dr.line([(x0 + ux * t, y0 + uy * t), (x0 + ux * e, y0 + uy * e)], fill=color, width=width)
        t = e + gap


def _dashed_rect(dr, b, color, dash, gap):
    x0, y0, x1, y1 = b
    for p, q in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        _dashed_line(dr, p, q, color, dash, gap, 1)


def _draw_opening(dr, P, s, ix: PlanIndex, o: dict):
    inf = ix.info.get(o["id"]) or {}
    x, y = float(o["at"][0]), float(o["at"][1])
    w = float(o.get("width_ft") or 3)
    axis = None
    if inf.get("edge"):
        axis = inf["edge"][0]
    elif inf.get("side"):
        axis = "x" if inf["side"] in ("front", "back") else "y"
    else:
        axis = "x"
    a0, a1 = ((x - w / 2, y), (x + w / 2, y)) if axis == "x" else ((x, y - w / 2), (x, y + w / 2))
    p0, p1 = P(*a0), P(*a1)
    t = o.get("type")
    bad = not inf.get("valid", False)
    if t in DOORS:
        dr.line([p0, p1], fill=PAPER, width=max(4, int(s * 0.36)))  # the gap in the wall
        if t in HINGED:
            # swing into between[0] (or out of it), quarter circle from the hinge
            into = o["between"][0] if o.get("swing") != "out" else o["between"][1]
            r = ix.R.get(into)
            sign = 1
            if r:
                if axis == "x":
                    sign = 1 if (r[1] + r[3]) / 2 > y else -1
                else:
                    sign = 1 if (r[0] + r[2]) / 2 > x else -1
            hinge = a0
            leaf_end = (hinge[0], hinge[1] + sign * w) if axis == "x" else (hinge[0] + sign * w, hinge[1])
            col = ACCENT if bad else (ACCENT if t == "main_door" else INK)
            dr.line([P(*hinge), P(*leaf_end)], fill=col, width=2)
            steps = 10
            pts = []
            for k in range(steps + 1):
                ang = (math.pi / 2) * k / steps
                if axis == "x":
                    pts.append(P(hinge[0] + w * math.cos(ang), hinge[1] + sign * w * math.sin(ang)))
                else:
                    pts.append(P(hinge[0] + sign * w * math.sin(ang), hinge[1] + w * math.cos(ang)))
            dr.line(pts, fill=col, width=1)
        else:  # arch, sliding or garage: a dashed gap
            _dashed_line(dr, p0, p1, ACCENT if bad else INK2, 3, 3, 2)
    else:  # windows and ventilators: a double glass line
        col = ACCENT if bad else GLASS
        off = max(2, int(s * 0.12))
        if axis == "x":
            dr.line([(p0[0], p0[1] - off), (p1[0], p1[1] - off)], fill=col, width=2)
            dr.line([(p0[0], p0[1] + off), (p1[0], p1[1] + off)], fill=col, width=2)
        else:
            dr.line([(p0[0] - off, p0[1]), (p1[0] - off, p1[1])], fill=col, width=2)
            dr.line([(p0[0] + off, p0[1]), (p1[0] + off, p1[1])], fill=col, width=2)


def _draw_stair(dr, P, s, g: dict, up: bool, font):
    x0, y0, x1, y1 = g["rect"]
    a, b = P(x0, y1), P(x1, y0)
    dr.rectangle([a[0], a[1], b[0], b[1]], outline=INK, width=1)
    along_y = g["start"] in ("+y", "-y")
    T = g["T"]
    n1 = max(1, math.ceil(g["N"] / 2)) if g["kind"] == "dogleg" else g["N"]
    # tread lines over the flight length (the far end of a dog-leg is the mid-landing)
    flight_len = (n1 - 1) * T
    start_edge = {"+y": y0, "-y": y1, "+x": x0, "-x": x1}[g["start"]]
    sign = 1 if g["start"] in ("+y", "+x") else -1
    half = (x0 + x1) / 2 if along_y else (y0 + y1) / 2
    for k in range(n1):
        c = start_edge + sign * k * T
        if along_y:
            dr.line([P(x0, c), P(x1 if g["kind"] != "dogleg" else x1, c)], fill=INK3, width=1)
        else:
            dr.line([P(c, y0), P(c, y1)], fill=INK3, width=1)
    if g["kind"] == "dogleg":  # the well between the two flights
        if along_y:
            dr.line([P(half, start_edge), P(half, start_edge + sign * flight_len)], fill=INK, width=2)
        else:
            dr.line([P(start_edge, half), P(start_edge + sign * flight_len, half)], fill=INK, width=2)
    # UP arrow on the first flight
    q = (x0 + half) / 2 if along_y else (y0 + half) / 2
    if along_y:
        p_from, p_to = P(q, start_edge + sign * 0.6), P(q, start_edge + sign * min(flight_len, 6))
    else:
        p_from, p_to = P(start_edge + sign * 0.6, q), P(start_edge + sign * min(flight_len, 6), q)
    dr.line([p_from, p_to], fill=ACCENT, width=2)
    ang = math.atan2(p_to[1] - p_from[1], p_to[0] - p_from[0])
    for d in (2.6, -2.6):
        dr.line([p_to, (p_to[0] - 9 * math.cos(ang + d / 2.2), p_to[1] - 9 * math.sin(ang + d / 2.2))], fill=ACCENT, width=2)
    dr.text((p_from[0] + 4, p_from[1] + 2), "UP" if up else "DN", fill=ACCENT, font=font)


def _north(dr, xy, facing: str, font):
    """Arrow pointing to true north given that the road side (bottom of the sheet) faces `facing`."""
    deg = {"N": 0, "NE": 45, "E": 90, "SE": 135, "S": 180, "SW": 225, "W": 270, "NW": 315}.get(facing, 0)
    # the road (bottom of the sheet, screen +y) faces `facing`; north is `deg` degrees anticlockwise from it... rotate
    ang = math.radians(90 - deg)  # screen angle of north: down when the front faces north, right when it faces east
    cx, cy = xy
    L = 16
    tip = (cx + L * math.cos(ang), cy + L * math.sin(ang))
    tail = (cx - L * math.cos(ang), cy - L * math.sin(ang))
    dr.line([tail, tip], fill=INK, width=2)
    dr.ellipse([tip[0] - 3, tip[1] - 3, tip[0] + 3, tip[1] + 3], fill=INK)
    dr.text((tip[0] + 5, tip[1] - 6), "N", fill=INK, font=font)


# --- front elevation (for the image model: the house as designed, seen from the road) ----------------------------------
FACADE_OPEN = {"porch", "balcony", "terrace", "lawn", "driveway", "courtyard", "open_space"}


def render_front_elevation(plan: dict, px_per_ft: float = 14.0) -> bytes:
    """The front of the house as an architect's elevation: storeys, the front wall of every room with its depth from the road
    (shaded: nearer is darker), front-facing doors and windows, the porch bay and balconies, the roof (a pitched roof's
    outline, or the parapet, stair tower and tank), the boundary wall and gate. Road crown at the bottom; feet."""
    ix = PlanIndex(plan)
    W = ix.W or 35
    levels = sorted([lv for lv in ix.levels], key=lambda lv: lv.get("index", 0))
    top_ft = max((lv.get("elevation_ft", 0) + lv.get("height_ft", 0) for lv in levels), default=30)
    pitched = (plan.get("roof") or {}).get("pitched")
    mumty = None if pitched else (plan.get("roof") or {}).get("mumty")
    roof_lv = next((lv for lv in levels if lv["id"] == ix.roof_id), None)
    if mumty and roof_lv:
        top_ft = max(top_ft, roof_lv.get("elevation_ft", 0) + float(mumty.get("height_ft") or 9))
    top_ft += 18 if pitched else 5  # room for the ridge, or the tank on the stair tower
    s, m, head, foot = px_per_ft, 60, 70, 60
    Hpx = int(top_ft * s + head + foot + 20)
    img = Image.new("RGB", (int(W * s + 2 * m), Hpx), PAPER)
    dr = ImageDraw.Draw(img)
    base = Hpx - foot

    def P(x, h):
        return (m + x * s, base - h * s)

    f_title, f_small = _font(22), _font(13)
    dr.text((m, 24), f"Front elevation  ·  plot {W:g} ft wide  ·  seen from the road", fill=INK, font=f_title)
    dr.line([P(-3, 0), P(W + 3, 0)], fill=INK, width=2)
    rooms_by_level = {lv["id"]: [r for r in ix.level_rooms(lv["id"])] for lv in levels}
    depth_max = max((ix.R[r["id"]][3] for lv in levels for r in rooms_by_level[lv["id"]]), default=60) or 60
    for lv in levels:
        if lv["id"] == ix.roof_id:
            continue
        e, h = float(lv.get("elevation_ft", 0)), float(lv.get("height_ft", 11))
        rs = sorted(rooms_by_level[lv["id"]], key=lambda r: -ix.R[r["id"]][1])  # back first, front painted last
        for r in rs:
            x0, y0, x1, y1 = ix.R[r["id"]]
            t = r.get("type")
            if t in ("lawn", "driveway", "courtyard", "open_space"):
                continue
            shade = int(150 + 80 * min(1.0, y0 / depth_max))
            a, b = P(x0, e + h), P(x1, e)
            if t in FACADE_OPEN:
                if t == "porch":  # an open bay: columns and the slab over it
                    dr.rectangle([a[0], a[1], b[0], a[1] + 0.6 * s], fill=(120, 120, 126))
                    for cx in (x0, x1):
                        q = P(cx, e)
                        dr.rectangle([q[0] - 0.5 * s, a[1], q[0] + 0.5 * s, q[1]], fill=(140, 140, 146))
                    dr.text((P((x0 + x1) / 2, e + h / 2)[0] - 22, P(0, e + h / 2)[1]), "PORCH", fill=INK2, font=f_small)
                else:  # balcony / terrace: a railing at the floor
                    dr.rectangle([a[0], P(0, e + 3.5)[1], b[0], b[1]], outline=INK2, width=2)
                    for k in range(int(x1 - x0)):
                        q = P(x0 + k + 0.5, e)
                        dr.line([q, (q[0], P(0, e + 3.5)[1])], fill=INK3, width=1)
                continue
            dr.rectangle([a[0], a[1], b[0], b[1]], fill=(shade, shade - 4, shade - 10), outline=WALL, width=2)
        # front-facing openings: on an exterior or porch/balcony edge, at the front-most wall of their room
        for o in ix.openings:
            if o.get("level") != lv["id"]:
                continue
            between = o.get("between") or []
            room = next((ix.by_id.get(b) for b in between if b in ix.by_id and ix.by_id[b].get("type") not in FACADE_OPEN), None)
            if not room:
                continue
            other = next((b for b in between if b != room["id"]), "exterior")
            if other != "exterior" and (ix.by_id.get(other) or {}).get("type") not in FACADE_OPEN:
                continue
            x0, y0, x1, y1 = ix.R[room["id"]]
            ax, ay = (o.get("at") or [0, 0])[:2]
            if abs(ay - y0) > 1.0:
                continue
            wdt = float(o.get("width_ft") or 4)
            sill = float(o.get("sill_ft") if o.get("sill_ft") is not None else (0 if o.get("type") in DOORS else 3))
            ht = float(o.get("height_ft") or (7 if o.get("type") in DOORS else 4.5))
            a, b = P(ax - wdt / 2, e + sill + ht), P(ax + wdt / 2, e + sill)
            kind = str(o.get("type") or "")
            door = kind in DOORS and not any(k in kind for k in ("sliding", "french", "glass"))
            dr.rectangle([a[0], a[1], b[0], b[1]], fill=(70, 62, 52) if door else (150, 190, 225), outline=INK, width=2)
            if not door:
                mx = (a[0] + b[0]) / 2
                dr.line([(mx, a[1]), (mx, b[1])], fill=INK, width=1)
    if roof_lv:
        e = float(roof_lv.get("elevation_ft", 0))
        enclosed = [ix.R[r["id"]] for lv in levels if lv["id"] != ix.roof_id for r in rooms_by_level[lv["id"]]
                    if r.get("type") not in FACADE_OPEN | {"lawn", "driveway"}]
        if enclosed:
            x0, x1 = min(r[0] for r in enclosed), max(r[2] for r in enclosed)
            par = float((plan.get("roof") or {}).get("parapet_ft") or 3.5)
            a, b = P(x0, e + par), P(x1, e)
            dr.rectangle([a[0], a[1], b[0], b[1]], fill=(205, 203, 198), outline=WALL, width=2)
            if pitched:
                rise = min(15.0, (x1 - x0) / 2 * math.tan(math.radians(float(pitched.get("pitch_deg") or 30))))
                dr.polygon([P(x0 - 1, e + par), P((x0 + x1) / 2, e + par + rise), P(x1 + 1, e + par)], fill=(150, 148, 144), outline=WALL)
                dr.text(P((x0 + x1) / 2 - 8, e + par + rise / 2), f"{pitched.get('form')} roof", fill=PAPER, font=f_small)
        if mumty and isinstance(mumty.get("rect"), dict):
            r = mumty["rect"]
            a, b = P(r["x"], e + float(mumty.get("height_ft") or 9)), P(r["x"] + r["w"], e)
            dr.rectangle([a[0], a[1], b[0], b[1]], fill=(185, 183, 178), outline=WALL, width=2)
            dr.text((a[0] + 4, a[1] + 4), "stair tower", fill=INK2, font=f_small)
            tank = (plan.get("roof") or {}).get("water_tank")
            if tank and isinstance(tank.get("rect"), dict) and tank.get("material") == "plastic":
                t = tank["rect"]
                h0 = e + float(mumty.get("height_ft") or 9)
                a2, b2 = P(t["x"], h0 + float(tank.get("height_ft") or 4)), P(t["x"] + t["w"], h0)
                dr.rectangle([a2[0], a2[1], b2[0], b2[1]], fill=(60, 110, 190), outline=INK, width=1)
    # the boundary wall in front, with the gate
    gates = (plan.get("site") or {}).get("gates") or plan.get("gates") or []
    open_front = ((plan.get("site") or {}).get("boundary_wall") or {}).get("front_height_ft") == 0
    a, b = P(0, 6), P(W, 0)
    if not open_front:
        dr.rectangle([a[0], a[1], b[0], b[1]], outline=INK2, width=2)
    for g in () if open_front else gates:
        gx, gw = (g.get("at") or [W / 2, 0])[0], float(g.get("width_ft") or 12)
        ga, gb = P(gx - gw / 2, 6), P(gx + gw / 2, 0)
        dr.rectangle([ga[0], ga[1], gb[0], gb[1]], fill=(110, 110, 116), outline=INK, width=2)
    dr.text((m, base + 14), "ROAD (the camera stands here)", fill=INK2, font=f_small)
    dr.text((m + W * s - 150, base + 14), f"height {top_ft:.0f} ft", fill=INK2, font=f_small)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()
