"""Start from the family's own drawing: an uploaded floor plan (a scan, a photo of a sketch, an architect's PDF page).

1. Gemini 3.8 Flash reads each sheet like an architect transcribing it: the floor, the plot outline, every room with
   its label, type, written size and its box on the sheet, the doors and the windows.
2. The boxes are turned into plot feet deterministically (road side down, origin at the plot's front-left corner), snapped
   to the written sizes where the drawing gives them.
3. The brief is derived from the reading (plot size, storeys, bedrooms and baths, rooms per floor) and the transcribed layout
   is kept on the project. The architect then plans FROM it: the same rooms in the same places, changed only where the
   regulations or a buildable plan need it, and every change is listed.
"""
from __future__ import annotations

import asyncio
import logging
import re

from google.genai import types

from .. import config, llm
from ..store import blobs, db

log = logging.getLogger("naqsha.importer")

READ_ASK = """This image is an architectural floor plan of a house (a drawing, a scan, a photo of a sketch or a PDF page). It
may show one floor or several floors side by side. Read it like an architect transcribing it.
Return JSON: {"sheets": [ one entry per floor shown:
 {"floor": "<basement|ground|first|second|third|roof>", "title": "<the sheet's own title, if any>",
  "plot": {"width_ft": <written plot width or null>, "depth_ft": <written plot depth or null>, "bbox": [x0,y0,x1,y1]},
  "road_side": "<bottom|top|left|right|unknown>",
  "rooms": [{"name": "<label as written>", "type": "<bedroom|master_bedroom|bath|powder|kitchen|dirty_kitchen|lounge|drawing|dining|study|prayer|store|laundry|dressing|servant_quarter|stair|lobby|passage|porch|balcony|terrace|lawn|driveway|open_space|other>",
             "bbox": [x0,y0,x1,y1], "w_ft": <written width or null>, "d_ft": <written depth or null>}],
  "doors": [{"between": ["<room name>", "<room name or exterior>"], "xy": [x,y]}],
  "windows": [{"room": "<room name>", "xy": [x,y]}]} ],
 "notes": "<anything an architect should know: north arrow, scale bar, unreadable parts>"}
Every bbox and xy is in image coordinates normalised to 0-1000 (x to the right, y down) over the WHOLE image. The plot bbox
is the outer site boundary of that floor's drawing (on upper floors, the same plot outline or the building outline if the plot
isn't drawn). Include outdoor areas (lawn, driveway, car porch, side and rear spaces) as rooms. Sizes: read feet-and-inches
labels (12'6" = 12.5) and convert metres (1 m = 3.281 ft)."""

FLOOR_ORDER = ["basement", "ground", "first", "second", "third", "roof"]
TYPE_MAP = {"master_bedroom": "bedroom", "powder": "bath", "porch": "porch", "lobby": "lobby", "passage": "passage",
            "dining": "dining", "lounge": "lounge", "drawing": "drawing", "stair": "stair", "other": "other"}
OUTDOOR = {"lawn", "driveway", "open_space", "courtyard"}


async def read_sheet(image: bytes, mime: str) -> dict:
    text = await llm.generate_text(config.MODEL_VISION, [types.Part.from_bytes(data=image, mime_type=mime), READ_ASK],
                                   max_tokens=12000, json_mode=True, thinking=False)
    out = llm.parse_json(text)
    if isinstance(out, dict) and "rooms" in out and "sheets" not in out:
        out = {"sheets": [out]}
    return out if isinstance(out, dict) else {"sheets": []}


def _snap(v: float, step: float = 0.5) -> float:
    return round(v / step) * step


def to_feet(sheet: dict, plot_w: float, plot_d: float) -> list[dict]:
    """Rooms of one sheet in plot feet: x along the road from the left, y from the road into the plot."""
    bb = (sheet.get("plot") or {}).get("bbox") or [0, 0, 1000, 1000]
    x0, y0, x1, y1 = [float(v) for v in bb[:4]]
    if x1 - x0 < 50 or y1 - y0 < 50:
        x0, y0, x1, y1 = 0, 0, 1000, 1000
    side = sheet.get("road_side") or "bottom"
    out = []
    for r in sheet.get("rooms") or []:
        b = r.get("bbox")
        if not (isinstance(b, list) and len(b) == 4):
            continue
        u0, v0, u1, v1 = [(float(b[0]) - x0) / (x1 - x0), (float(b[1]) - y0) / (y1 - y0),
                          (float(b[2]) - x0) / (x1 - x0), (float(b[3]) - y0) / (y1 - y0)]
        if side == "top":  # turn the sheet so the road is at the bottom
            u0, v0, u1, v1 = 1 - u1, 1 - v1, 1 - u0, 1 - v0
        elif side == "left":
            u0, v0, u1, v1 = 1 - v1, u0, 1 - v0, u1
        elif side == "right":
            u0, v0, u1, v1 = v0, 1 - u1, v1, 1 - u0
        x, w = u0 * plot_w, (u1 - u0) * plot_w
        y, d = (1 - v1) * plot_d, (v1 - v0) * plot_d
        # a written size wins over the measured one when they roughly agree (it is the architect's number)
        for key, cur in (("w_ft", "w"), ("d_ft", "d")):
            want = r.get(key)
            try:
                want = float(want)
            except (TypeError, ValueError):
                continue
            meas = w if cur == "w" else d
            if meas > 0 and 0.75 < want / meas < 1.33:
                if cur == "w":
                    w = want
                else:
                    d = want
        out.append({"name": str(r.get("name") or "Room")[:40], "type": str(r.get("type") or "other"),
                    "rect": {"x": _snap(max(0.0, x)), "y": _snap(max(0.0, y)), "w": _snap(max(1.0, w)), "d": _snap(max(1.0, d))},
                    "written": {"w_ft": r.get("w_ft"), "d_ft": r.get("d_ft")}})
    return out


def align_edges(rooms: list[dict], tol: float = 1.0, step: float = 0.5) -> list[dict]:
    """Room boxes read off a drawing are a little off; walls the rooms share must coincide. Edge coordinates within `tol`
    of each other (x edges with x edges, y edges with y edges) are merged to one line, snapped to `step`."""
    for axis, keys in (("x", ("x", "w")), ("y", ("y", "d"))):
        coords = sorted({v for r in rooms for v in (r["rect"][keys[0]], r["rect"][keys[0]] + r["rect"][keys[1]])})
        groups: list[list[float]] = []
        for v in coords:
            if groups and v - groups[-1][-1] <= tol:
                groups[-1].append(v)
            else:
                groups.append([v])
        line = {v: round(sum(g) / len(g) / step) * step for g in groups for v in g}
        for r in rooms:
            a, b = r["rect"][keys[0]], r["rect"][keys[0]] + r["rect"][keys[1]]
            a2, b2 = line.get(a, a), line.get(b, b)
            if b2 - a2 >= 1.0:
                r["rect"][keys[0]], r["rect"][keys[1]] = a2, round(b2 - a2, 2)
    return rooms


def _floor_key(f: str) -> str:
    f = str(f or "").lower()
    for k in FLOOR_ORDER:
        if k in f:
            return k
    if "1st" in f or "upper" in f:
        return "first"
    if "2nd" in f:
        return "second"
    return "ground"


def derive(sheets: list[dict], brief: dict) -> tuple[dict, dict]:
    """(layout, brief patch) from the readings: the plot, the storeys and each floor's rooms."""
    plot = dict(brief.get("plot") or {})
    for s in sheets:
        p = s.get("plot") or {}
        try:
            if p.get("width_ft") and p.get("depth_ft") and not plot.get("width_ft"):
                plot.update(width_ft=float(p["width_ft"]), depth_ft=float(p["depth_ft"]))
        except (TypeError, ValueError):
            pass
    if not plot.get("width_ft"):  # no written plot size: assume the common 10 marla 35 × 65 and say so
        plot.update(width_ft=35.0, depth_ft=65.0, assumed=True)
    plot["area_marla"] = round(plot["width_ft"] * plot["depth_ft"] / 225, 1)
    plot.setdefault("corner", False)
    floors: dict[str, list[dict]] = {}
    for s in sheets:
        k = _floor_key(s.get("floor"))
        while k in floors and k != "roof":  # two sheets read as the same floor: the next one up
            k = FLOOR_ORDER[min(FLOOR_ORDER.index(k) + 1, len(FLOOR_ORDER) - 1)]
        floors[k] = align_edges(to_feet(s, plot["width_ft"], plot["depth_ft"]))
    levels = [k for k in FLOOR_ORDER if k in floors]
    storeys = len([k for k in levels if k not in ("basement", "roof")]) or 1
    rooms = [r for k in levels for r in floors[k]]
    bedrooms = sum(1 for r in rooms if "bedroom" in r["type"] or re.search(r"\bbed(room)?\b", r["name"], re.I))
    baths = sum(1 for r in rooms if r["type"] in ("bath", "powder") or re.search(r"\b(bath|toilet|wc|powder)\b", r["name"], re.I))
    spec = []
    for k in levels:
        if k == "roof":
            continue
        counts: dict[str, int] = {}
        for r in floors[k]:
            t = r["type"]
            if t in OUTDOOR or t in ("stair", "lobby", "passage", "porch"):
                continue
            t = "bedroom" if "bedroom" in t else "bath" if t == "powder" else t
            counts[t] = counts.get(t, 0) + 1
        spec.append(f"{k}=" + ",".join(f"{t}:{n}" if n > 1 else t for t, n in counts.items()))
    spaces = sorted({s for k in levels for r in floors[k] for s in
                     (["car_porch:1"] if r["type"] == "porch" else ["lawn"] if r["type"] == "lawn" else
                      ["drawing"] if r["type"] == "drawing" else ["dirty_kitchen"] if r["type"] == "dirty_kitchen" else [])})
    patch = {"plot": plot, "storeys": min(3, storeys), "basement": "basement" in floors, "floors": spec, "spaces": spaces}
    if bedrooms:
        patch["bedrooms"] = bedrooms
    if baths:
        patch["bathrooms"] = baths
    return {"levels": levels, "floors": floors, "plot": plot}, patch


async def import_drawings(project: dict, images: list[tuple[bytes, str]]) -> dict:
    """Read the uploaded sheets, keep them, and return {layout, brief_patch, sheets} (also saved on the project)."""
    pid = project["id"]
    readings = await asyncio.gather(*[read_sheet(img, mime) for img, mime in images], return_exceptions=True)
    sheets, urls = [], []
    for i, ((img, mime), rd) in enumerate(zip(images, readings)):
        urls.append(await blobs.put(f"projects/{pid}/drawings/{db.new_id('d_')}.{'png' if 'png' in mime else 'jpg'}", img, mime))
        if isinstance(rd, Exception):
            log.warning("reading sheet %d failed: %s", i, rd)
            continue
        sheets += [s for s in rd.get("sheets") or [] if isinstance(s, dict) and s.get("rooms")]
    if not sheets:
        raise ValueError("I couldn't read any rooms from that drawing. Try a clearer image of the floor plan.")
    layout, patch = derive(sheets, project.get("brief") or {})
    imported = {"images": urls, "layout": layout, "rooms": sum(len(v) for v in layout["floors"].values()), "at": db.now(),
                "model": config.MODEL_VISION}
    return {"imported": imported, "brief_patch": patch}


def layout_text(imported: dict) -> str:
    """The transcribed drawing for the architect's prompt."""
    lay = imported.get("layout") or {}
    lines = []
    for k in lay.get("levels") or []:
        lines.append(f"{k.upper()} FLOOR:")
        for r in (lay.get("floors") or {}).get(k) or []:
            rc = r["rect"]
            lines.append(f"  - {r['name']} ({r['type']}): x {rc['x']:g}, y {rc['y']:g}, {rc['w']:g} × {rc['d']:g} ft")
    p = lay.get("plot") or {}
    head = f"PLOT {p.get('width_ft', 0):g} × {p.get('depth_ft', 0):g} ft" + (" (size assumed: none was written)" if p.get("assumed") else "")
    return head + "\n" + "\n".join(lines)
