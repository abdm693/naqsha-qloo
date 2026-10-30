"""Setup (intake): the conversation that fills the project Brief.

Free text goes to the conversational setup agent (setup_agent.py, Google ADK), which takes everything it can from one long
message and asks only what is missing. Widget answers (structured chips such as `plot:35x65`, `tank:concrete`,
`floor:ground=drawing,kitchen,bedroom:1`) are parsed deterministically and the next question is asked instantly from a fixed
bank, so one-tap answers never wait for a model. The LDA envelope is computed deterministically whenever the plot is known.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import AsyncIterator

from ..compliance import lda
from ..store import db

log = logging.getLogger("naqsha.intake")

PLOT_PRESETS = {  # typical Lahore scheme dimensions (docs/research/lda-regulations.md §1.2)
    3: (19, 35.5), 5: (25, 45), 7: (30, 52.5), 10: (35, 65), 20: (50, 90), 40: (75, 120),
}
AUTHORITIES = {"LDA", "DHA", "BAHRIA", "RDA", "FDA", "MDA", "GDA", "OTHER"}
STYLE_NAMES = ["Modern Contemporary", "Spanish", "Classic", "Minimalist", "Mediterranean", "Mughal Revival", "Industrial"]
FACINGS = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"}
FACING_WORDS = {"north": "N", "northeast": "NE", "north-east": "NE", "east": "E", "southeast": "SE", "south-east": "SE",
                "south": "S", "southwest": "SW", "south-west": "SW", "west": "W", "northwest": "NW", "north-west": "NW"}
SPACE_IDS = {"drawing", "tv_lounge", "dining", "kitchen", "dirty_kitchen", "servant_quarter", "lawn", "prayer", "store",
             "laundry", "roof_terrace", "study", "gym", "motorbike"}
BUDGETS = ["economy", "standard", "premium", "luxury"]
ESSENTIAL = ["authority", "plot", "storeys", "bedrooms", "bathrooms", "style"]
# The order questions are asked in. Optional ones (corner, facing, floors, water_tank, solar) are asked once, unless already
# known or skipped (a skipped field is recorded in auto_filled with Naqsha's choice).
ASK_ORDER = ["authority", "plot", "corner", "facing", "storeys", "bedrooms", "floors", "water_tank", "solar", "style"]
STOREY_LEVELS = ["ground", "first", "second", "third"]
AUTHORITY_NAME = {"LDA": "LDA", "DHA": "DHA", "BAHRIA": "Bahria Town", "OTHER": "LDA"}
DEFAULT_SPACES = ["drawing", "tv_lounge", "dining", "kitchen", "car_porch:1", "lawn", "store"]
LEVEL_NAMES = ["ground", "first", "second", "third", "basement", "roof"]


# --- brief model ---------------------------------------------------------------------------------------------------
def empty_brief() -> dict:
    return {"city": "Lahore", "authority": None, "plot": None, "storeys": None, "basement": False, "bedrooms": None,
            "bathrooms": None, "spaces": [], "style": None, "auto_filled": [], "preferences": []}


def _normalize_plot(plot: dict | None) -> dict | None:
    if not plot:
        return None
    w, d, m = plot.get("width_ft"), plot.get("depth_ft"), plot.get("area_marla")
    if (not w or not d) and m:
        key = min(PLOT_PRESETS, key=lambda k: abs(k - m))
        w, d = PLOT_PRESETS[key] if abs(key - m) < 0.6 else (round((m * 225) ** 0.5 * 0.7, 1), round((m * 225) ** 0.5 / 0.7, 1))
    if not w or not d:
        return None
    return {"width_ft": float(w), "depth_ft": float(d), "area_marla": round(w * d / lda.MARLA_SQFT, 1), "corner": bool(plot.get("corner"))}


def norm_tank(v) -> str | None:
    s = str(v or "").strip().lower()
    if not s:
        return None
    if any(t in s for t in ("concrete", "rcc", "cement", "masonry", "underground")):
        return "concrete"
    if any(t in s for t in ("plastic", "pvc", "blue", "fibre", "fiber", "poly")):
        return "plastic"
    return None


def norm_solar(v) -> str | None:
    s = str(v or "").strip().lower()
    if not s:
        return None
    if s in ("none", "no", "not now", "false", "off") or "no solar" in s or "not now" in s:
        return "none"
    if any(t in s for t in ("ready", "provision", "clear", "later", "future")):
        return "ready"
    if any(t in s for t in ("panel", "install", "yes", "now", "frame", "true", "kw")):
        return "panels"
    return None


def norm_facing(v) -> str | None:
    s = str(v or "").strip()
    if s.upper() in FACINGS:
        return s.upper()
    return FACING_WORDS.get(s.lower().replace(" ", ""))


def norm_style(v) -> str | None:
    s = str(v or "").strip()
    if not s or s.upper() in AUTHORITIES:
        return None
    for name in STYLE_NAMES:
        if s.lower() == name.lower() or s.lower() in (name.split()[0].lower(),):
            return name
    if "modern" in s.lower() or "contemporary" in s.lower():
        return "Modern Contemporary"
    return s[:60]


def parse_floor_spec(spec: str) -> dict | None:
    """"ground=drawing,kitchen,bedroom:1,bath:2" -> {"level": "ground", "rooms": [...]}."""
    level, _, rooms = str(spec).partition("=")
    level = level.strip().lower()
    if level in ("g", "gf", "ground floor"):
        level = "ground"
    if level in ("1", "1st", "f", "ff", "first floor", "upper"):
        level = "first"
    if level in ("2", "2nd", "second floor"):
        level = "second"
    if level not in LEVEL_NAMES:
        return None
    toks = [t.strip().lower().replace(" ", "_") for t in re.split(r"[,;]", rooms) if t.strip()]
    return {"level": level, "rooms": toks}


def merge_floors(cur: list | None, new: list | None) -> list:
    by = {f["level"]: f for f in cur or [] if isinstance(f, dict) and f.get("level")}
    for f in new or []:
        if isinstance(f, str):
            f = parse_floor_spec(f)
        if isinstance(f, dict) and f.get("level"):
            by[f["level"]] = {"level": f["level"], "rooms": list(f.get("rooms") or [])}
    order = {n: i for i, n in enumerate(["basement", "ground", "first", "second", "third", "roof"])}
    return sorted(by.values(), key=lambda f: order.get(f["level"], 9))


def _append_unique(cur: list, items) -> list:
    out = list(cur or [])
    seen = {str(x).strip().lower() for x in out}
    for it in items or []:
        t = str(it).strip()
        if t and t.lower() not in seen:
            out.append(t)
            seen.add(t.lower())
    return out


def _merge_spaces(cur: list, add: list, remove: list | None = None) -> list:
    out = [s for s in cur or [] if s not in set(remove or [])]
    for s in add or []:
        s = str(s).strip().lower().replace(" ", "_")
        if s.startswith("car_porch"):
            out = [x for x in out if not x.startswith("car_porch")]
        if s and s not in out:
            out.append(s)
    return out


def _drop_prefs(cur: list, remove: list) -> list:
    """Preferences minus the ones named (case-insensitive; "dirty kitchen" also drops "a separate dirty kitchen")."""
    gone = [str(r).strip().lower() for r in remove or [] if str(r).strip()]
    return [p for p in cur or [] if not any(g == str(p).strip().lower() or g in str(p).lower() or str(p).strip().lower() in g
                                            for g in gone)]


# Kept by the server from what was said (never taken from a patch): whether the family stated corner/mid-row, whether that
# question is still open, and the storeys they asked for before clamp_storeys capped them.
SERVER_KEYS = ("corner_stated", "corner_open", "storeys_asked")


def panel_patch(before: dict, sent: dict) -> dict:
    """The brief panel PATCHes the whole brief back. Only what changed counts as the family's word: an unchanged plot must
    not turn Naqsha's mid-row assumption into "You said: Mid-row", nor an unchanged storey count undo the authority cap.
    auto_filled is the panel's (it drops the marks of facts the family confirmed)."""
    out = {k: v for k, v in (sent or {}).items() if k not in SERVER_KEYS and (k == "auto_filled" or v != before.get(k))}
    if "auto_filled" in out:
        was, now = set(before.get("auto_filled") or []), set(out.get("auto_filled") or [])
        p0, p1 = before.get("plot") or {}, (sent or {}).get("plot") or {}
        if "corner" in was and "corner" not in now or "corner" in p1 and bool(p1.get("corner")) != bool(p0.get("corner")):
            out["plot"] = {**p0, **p1, "corner": bool(p1.get("corner", p0.get("corner")))}  # confirmed or changed: said
            out["auto_filled"] = sorted(now - {"corner"})
        elif "corner" in was:  # still Naqsha's assumption (a new plot size alone doesn't state it)
            out["auto_filled"] = sorted(now | {"corner"})
            if isinstance(out.get("plot"), dict):
                out["plot"] = {k: v for k, v in out["plot"].items() if k != "corner"}
        if "storeys" in was and "storeys" not in now and "storeys" not in out and before.get("storeys"):
            out["storeys"] = before["storeys"]  # confirmed: no longer Naqsha's change
        out["auto_filled"] = sorted(set(out["auto_filled"]) | ({"porch"} & was))
    return out


def merge_brief(brief: dict, patch: dict, auto: list[str] | None = None, spaces_mode: str = "replace",
                prefs_mode: str = "append") -> dict:
    """Merge a patch into the brief. notes are appended, never overwritten; preferences are appended (the agent adds what
    was said) or replaced (prefs_mode="replace": the brief panel sends the whole list, [] clears it); remove_preferences drops
    contradicted wishes; floors merge per level; spaces replace (widgets send the whole set) or union (the agent adds what
    was mentioned)."""
    out = {**(brief or empty_brief())}
    patch = {k: v for k, v in (patch or {}).items() if k not in SERVER_KEYS}
    if str(patch.get("style", "")).upper() in AUTHORITIES:  # model slip: an authority answer filed under style
        patch.setdefault("authority", str(patch.pop("style")).upper())
    if prefs_mode == "replace" and isinstance(patch.get("preferences"), list):
        out["preferences"] = _append_unique([], patch.pop("preferences"))
    if isinstance(patch.get("auto_filled"), list):  # the panel's marks first; the fields below then adjust them
        out["auto_filled"] = [str(a) for a in patch.pop("auto_filled")]
    for k, v in patch.items():
        if v in (None, "", [], {}):
            continue
        if k == "plot":
            if isinstance(v, dict) and "corner" in v and v["corner"] is not None:
                out["corner_stated"] = True  # the family said corner or mid-row
                out.pop("corner_open", None)
                auto = [a for a in auto or [] if a != "corner"]
                out["auto_filled"] = [a for a in out.get("auto_filled") or [] if a != "corner"]
            elif out.get("corner_stated") is not True:
                # Not said: mid-row is Naqsha's assumption (in auto_filled, so it never reads as "You said"), and
                # "Corner or mid-row?" stays open (corner_open) until they answer or skip it.
                out["corner_stated"] = False
                if "corner" not in (out.get("auto_filled") or []):
                    out["auto_filled"] = [*(out.get("auto_filled") or []), "corner"]
                    out["corner_open"] = True
            v = _normalize_plot({**(out.get("plot") or {}), **{a: b for a, b in v.items() if b is not None}})
            if not v:
                continue
        elif k == "authority":
            v = str(v).upper()
            if v not in AUTHORITIES:
                continue
        elif k == "storeys":
            v = max(1, min(3, int(v)))
            out.pop("storeys_asked", None)  # said again: clamp_storeys records it anew if it is still too many
        elif k in ("bedrooms", "bathrooms"):
            v = max(1, min(12, int(v)))
        elif k == "facing":
            v = norm_facing(v)
            if not v:
                continue
        elif k == "style":
            v = norm_style(v)
            if not v:
                continue
        elif k == "water_tank":
            v = norm_tank(v)
            if not v:
                continue
        elif k == "solar":
            v = norm_solar(v)
            if not v:
                continue
        elif k == "budget":
            v = str(v).lower()
            if v not in BUDGETS:
                continue
        elif k == "floors":
            v = merge_floors(out.get("floors"), v if isinstance(v, list) else [v])
        elif k == "spaces":
            # "porch" in auto_filled: the car porch is Naqsha's default, so it never reads as "You said: 2-car porch"
            porch_new = next((str(s) for s in v if str(s).startswith("car_porch")), None)
            porch_cur = next((str(s) for s in out.get("spaces") or [] if str(s).startswith("car_porch")), None)
            if "spaces" in (auto or []):
                if porch_new:
                    auto = [*(auto or []), "porch"]
            elif porch_new and (spaces_mode != "replace" or porch_new != porch_cur):  # the family named the porch
                out["auto_filled"] = [a for a in out.get("auto_filled") or [] if a != "porch"]
            v = list(v) if spaces_mode == "replace" else _merge_spaces(out.get("spaces") or [], v)
        elif k == "remove_spaces":
            out["spaces"] = _merge_spaces(out.get("spaces") or [], [], v)
            continue
        elif k == "remove_preferences":
            out["preferences"] = _drop_prefs(out.get("preferences") or [], v if isinstance(v, list) else [v])
            continue
        elif k == "preferences":
            v = _append_unique(out.get("preferences") or [], v if isinstance(v, list) else [v])
        elif k == "notes":
            prev = str(out.get("notes") or "").strip()
            add = str(v).strip()
            if add.lower() in prev.lower():
                continue
            v = f"{prev} {add}".strip() if prev else add
        out[k] = v
        if k in (out.get("auto_filled") or []) and k not in (auto or []):  # the family decided it now
            out["auto_filled"] = [x for x in out["auto_filled"] if x != k]
    if str(out.get("style") or "").upper() in AUTHORITIES:
        out["style"] = None
    if patch.get("floors"):
        _derive_from_floors(out, patch)
    out["auto_filled"] = sorted(set(out.get("auto_filled") or []) | set(auto or []))
    return out


FLOOR_SPACE = {"drawing": "drawing", "drawing_room": "drawing", "lounge": "tv_lounge", "tv_lounge": "tv_lounge",
               "family_lounge": "tv_lounge", "dining": "dining", "kitchen": "kitchen", "kitchenette": "kitchen",
               "dirty_kitchen": "dirty_kitchen", "prayer": "prayer", "prayer_room": "prayer", "study": "study", "office": "study",
               "store": "store", "laundry": "laundry", "servant": "servant_quarter", "servant_quarter": "servant_quarter",
               "terrace": "roof_terrace", "roof_terrace": "roof_terrace", "lawn": "lawn"}


def floor_space(level: str | None, token) -> str | None:
    """The brief space a per-floor room token stands for. A "terrace" is a roof terrace only on the roof: on the first or
    second floor it is a terrace on that floor (its own program), never a roof terrace."""
    name = str(token).split(":")[0].strip().lower()
    if name == "terrace" and str(level or "").lower() != "roof":
        return None
    return FLOOR_SPACE.get(name)


def _derive_from_floors(out: dict, patch: dict) -> None:
    """The per-floor program implies totals and spaces: keep them consistent unless the family gave totals themselves."""
    from ..compliance.planning import BED_KEYS, parse_program
    beds = baths = 0
    spaces = []
    for f in out.get("floors") or []:
        prog = parse_program(f.get("rooms") or [])
        beds += sum(n for k, n in prog.items() if k in BED_KEYS)
        baths += sum(n for k, n in prog.items() if k in ("bath", "bathroom", "baths", "powder", "powder_room"))
        for tok in f.get("rooms") or []:
            if (sp := floor_space(f.get("level"), tok)):
                spaces.append(sp)
    if beds and not patch.get("bedrooms"):
        out["bedrooms"] = beds
    if baths and not patch.get("bathrooms"):
        out["bathrooms"] = max(baths, int(out.get("bathrooms") or 0)) if "bathrooms" not in (out.get("auto_filled") or []) else baths
        out["auto_filled"] = [x for x in out.get("auto_filled") or [] if x != "bathrooms"]
    out["spaces"] = _merge_spaces(out.get("spaces") or [], spaces)


def parse_chips(chips: list[str] | None) -> tuple[dict, list[str]]:
    """Structured widget tokens → (brief patch, tokens not understood).
    plot:35x65 · corner:true · storeys:2 · bedrooms:4 · bathrooms:5 · coords:31.47,74.27 · facing:N (or N) · tank:concrete ·
    solar:ready · floor:ground=drawing,kitchen,bedroom:1 · floors:auto · style:Spanish (or a style name) · budget:premium ·
    authority (LDA, DHA, ...) · space ids and car_porch:N."""
    patch: dict = {}
    spaces: list[str] = []
    floors: list[dict] = []
    unknown: list[str] = []
    styles = {k.lower(): k for k in STYLE_NAMES}
    for raw in chips or []:
        c = str(raw).strip()
        key, _, val = c.partition(":")
        k = key.lower().strip()
        try:
            if k == "plot" and "x" in val.lower():
                w, d = (float(v) for v in val.lower().split("x", 1))
                patch.setdefault("plot", {}).update(width_ft=w, depth_ft=d)
            elif k == "marla":
                patch.setdefault("plot", {}).update(area_marla=float(val))
            elif k == "corner":
                patch.setdefault("plot", {})["corner"] = val.lower() in ("true", "yes", "1")
            elif k == "unset" and val.strip():  # "Don't assume": clear that field and ask it again
                patch.setdefault("_unset", []).append(val.strip().lower())
            elif k in ("storeys", "bedrooms", "bathrooms"):
                patch[k] = int(float(val))
            elif k == "basement":
                patch["basement"] = val.lower() in ("true", "yes", "1")
            elif k == "coords" and "," in val:
                lat, lng = (float(v) for v in val.split(",", 1))
                patch["coordinates"] = {"lat": lat, "lng": lng}
            elif k == "facing" and norm_facing(val):
                patch["facing"] = norm_facing(val)
            elif k == "tank" and norm_tank(val):
                patch["water_tank"] = norm_tank(val)
            elif k == "solar" and norm_solar(val):
                patch["solar"] = norm_solar(val)
            elif k == "floor" and parse_floor_spec(val):
                floors.append(parse_floor_spec(val))
            elif k == "floors" and val.lower() in ("auto", "decide", "skip"):
                patch["_floors_auto"] = True
            elif k == "style" and norm_style(val):
                patch["style"] = norm_style(val)
            elif k == "budget" and val.lower() in BUDGETS:
                patch["budget"] = val.lower()
            elif k == "authority" and val.upper() in AUTHORITIES:
                patch["authority"] = val.upper()
            elif k == "scheme" and val:
                patch["scheme"] = val.strip()
            elif k == "car_porch" or c in SPACE_IDS:
                spaces.append(c)
            elif c.lower() in styles:
                patch["style"] = styles[c.lower()]
            elif c.upper() in AUTHORITIES:
                patch["authority"] = c.upper()
            elif c.upper() in FACINGS:
                patch["facing"] = c.upper()
            elif c.lower() in BUDGETS:
                patch["budget"] = c.lower()
            else:
                unknown.append(c)
        except ValueError:
            unknown.append(c)
    if spaces:
        patch["spaces"] = spaces
    if floors:
        patch["floors"] = floors
    return patch, unknown


def defaults_for(brief: dict) -> tuple[dict, list[str]]:
    """Sensible defaults for anything missing (used by skip_all and before a design run)."""
    b, auto = {**brief}, []
    if str(b.get("style") or "").upper() in AUTHORITIES:
        b["style"] = None

    def put(k, v):
        if not b.get(k):
            b[k] = v
            auto.append(k)
    put("authority", "LDA")
    if not b.get("plot"):
        b["plot"] = _normalize_plot({"area_marla": 10})
        auto.append("plot")
    marla = b["plot"]["area_marla"]
    put("storeys", 1 if marla < 4 else 2)
    put("bedrooms", 2 if marla < 4 else 3 if marla < 7 else 4 if marla < 15 else 5)
    put("bathrooms", b["bedrooms"] + 1)
    spaces = list(DEFAULT_SPACES)
    if marla >= 10:
        spaces += ["dirty_kitchen", "laundry"]
    if marla >= 20:
        spaces += ["servant_quarter", "prayer", "roof_terrace"]
        spaces = [s if not s.startswith("car_porch") else "car_porch:2" for s in spaces]
    put("spaces", spaces)
    if "spaces" in auto:
        auto.append("porch")  # the car porch in the default spaces is Naqsha's choice too
    put("style", "Modern Contemporary")
    put("facing", "N")
    put("budget", "standard")
    put("water_tank", "concrete")
    put("solar", "ready")
    if not b.get("corner_stated"):
        if "corner" not in (b.get("auto_filled") or []):
            auto.append("corner")  # mid-row unless they said corner: shown under "I assumed"
        b.pop("corner_open", None)  # decided for them: no longer asked
    if floors_missing(b) and "floors" not in (b.get("auto_filled") or []):
        auto.append("floors")  # Naqsha places the rooms on the floors that have none yet
    b["auto_filled"] = sorted(set(b.get("auto_filled") or []) | set(auto))
    return b, auto


DEFAULT_FOR_FIELD = {"authority": "LDA", "facing": "N", "water_tank": "concrete", "solar": "ready",
                     "style": "Modern Contemporary", "budget": "standard"}


def skip_field(brief: dict, field: str | None) -> dict:
    """The family said "you decide" for one question: choose for them and remember it was our choice."""
    if not field:
        return brief
    if field == "floors":
        return merge_brief(brief, {}, ["floors"])
    if field == "corner":  # mid-row, the usual Lahore plot
        out = merge_brief({**brief, "plot": {**(brief.get("plot") or {}), "corner": False}}, {}, ["corner"])
        out.pop("corner_open", None)
        return out
    if field in DEFAULT_FOR_FIELD:
        return merge_brief(brief, {field: DEFAULT_FOR_FIELD[field]}, [field])
    filled, auto = defaults_for(brief)
    keep = {k: filled[k] for k in auto if k in (field, "plot", "storeys", "bedrooms", "bathrooms", "spaces") and
            (k == field or field in ("bedrooms", "rooms") and k in ("bathrooms", "spaces"))}
    out = merge_brief(brief, keep, list(keep))
    if field in ("bedrooms", "rooms") and (out.get("storeys") or 1) >= 2 and floors_missing(out, empty_too=True):
        out = merge_brief(out, {}, ["floors"])  # one "Decide for me" decides the rooms per floor too
    return out


def storeys_with_rooms(brief: dict) -> set[str]:
    return {f.get("level") for f in brief.get("floors") or [] if isinstance(f, dict) and f.get("rooms")}


def floors_missing(brief: dict, empty_too: bool = False) -> list[str]:
    """Storeys (ground, first, ...) with no rooms in brief.floors, once the family has started a per-floor program (or
    always, with empty_too). An added storey without rooms keeps the setup open."""
    if not brief.get("floors") and not empty_too:
        return []
    have = storeys_with_rooms(brief)
    n = max(1, min(len(STOREY_LEVELS), int(brief.get("storeys") or 1)))
    return [lv for lv in STOREY_LEVELS[:n] if lv not in have]


def missing(brief: dict) -> list[str]:
    out = [k for k in ESSENTIAL if not brief.get(k)]
    if "floors" not in (brief.get("auto_filled") or []) and floors_missing(brief):
        out.append("floors")
    return out


def to_ask(brief: dict) -> list[str]:
    """What to ask next, in order: missing essentials plus the optional questions not yet answered or skipped."""
    auto = set(brief.get("auto_filled") or [])
    out = []
    for k in ASK_ORDER:
        if k == "bedrooms":
            if not brief.get("bedrooms"):
                out.append(k)
        elif k == "floors":
            if "floors" in auto:
                continue
            if ((brief.get("storeys") or 1) >= 2 and not brief.get("floors")) or floors_missing(brief):
                out.append(k)
        elif k == "corner":  # not said: asked once (the assumption is still open), unless they skipped it
            if brief.get("plot") and brief.get("corner_stated") is False and ("corner" not in auto or brief.get("corner_open")):
                out.append(k)
        elif not brief.get(k) and k not in auto:
            out.append(k)
    return out


def _sum_tokens(tokens: list[str]) -> list[str]:
    """["bedroom:2", "lounge", "bedroom:2"] -> ["bedroom:4", "lounge"] (order kept)."""
    counts: dict[str, int] = {}
    for t in tokens:
        name, _, n = str(t).partition(":")
        try:
            k = int(float(n)) if n else 1
        except ValueError:
            k = 1
        counts[name] = counts.get(name, 0) + k
    return [f"{k}:{n}" if n != 1 else k for k, n in counts.items()]


def storey_cap(brief: dict) -> tuple[int, str]:
    """The most storeys the authority allows for this brief, and how to say so ("DHA allows ground + first, plus a
    basement")."""
    auth = str(brief.get("authority") or "LDA").upper()
    env = envelope_for(brief)
    cap = int(env["max_storeys"]) if env else int(lda._authority_overrides(auth)[0].get("max_storeys") or 3)
    who = AUTHORITY_NAME.get(auth, auth)
    words = {1: "a single storey", 2: "ground + first", 3: "ground + first + second"}.get(cap, f"{cap} storeys")
    return cap, f"{who} allows {words}, plus a basement"


def clamp_storeys(brief: dict) -> tuple[dict, str | None]:
    """Keep the brief within the authority's storeys (DHA: 2): never more storeys than allowed, and at the limit no enclosed
    room on the roof (the authority counts it as one more storey). Returns (brief, a sentence or two of pushback, or None)."""
    b, said = _cap_storeys(brief)
    b, moved = roof_rooms_down(b)
    return b, " ".join(x for x in (said, moved) if x) or None


# On the roof only the stair tower (mumty), the water tank, solar and open terraces are exempt from the storey count; any
# other room there is enclosed and counts as one more storey (lda.py counts every level with an enclosed room).
ROOF_OPEN = {"terrace", "roof_terrace", "balcony", "sitting", "sitting_area", "seating", "garden", "roof_garden", "lawn",
             "solar", "panels", "solar_panels", "tank", "water_tank", "mumty", "stair", "stairs", "stair_tower"}
ROOF_TO_GROUND = {"laundry", "store", "storage", "servant", "servant_quarter", "dirty_kitchen", "utility"}  # service rooms


def _room_phrase(tok: str) -> str:
    name, _, n = str(tok).partition(":")
    try:
        k = int(float(n)) if n else 1
    except ValueError:
        k = 1
    one, many = ROOM_WORD.get(name, (name.replace("_", " "), name.replace("_", " ") + "s"))
    return f"the {one}" if k == 1 else f"{k} {many}"


def roof_rooms_down(brief: dict) -> tuple[dict, str | None]:
    """A brief at its authority's storey limit keeps no enclosed room (laundry, store, servant, gym, kitchenette...) on the
    roof: every authority counts a roof room as a storey (only the mumty is excluded), so the design would fail "Number of
    storeys" and the per-floor rule would fight it in every fix round. Service rooms go down to the ground floor, the rest
    to the top floor. Returns (brief, one sentence saying so, or None). Under the limit the roof room stays."""
    s = brief.get("storeys")
    floors = [f for f in brief.get("floors") or [] if isinstance(f, dict)]
    roof = next((f for f in floors if f.get("level") == "roof"), None)
    if not s or not roof or not roof.get("rooms"):
        return brief, None
    cap, _ = storey_cap(brief)
    if int(s) < cap:
        return brief, None
    keep, down, up = [], [], []
    for tok in roof["rooms"]:
        name = str(tok).split(":")[0].strip().lower()
        (keep if name in ROOF_OPEN else down if name in ROOF_TO_GROUND else up).append(str(tok))
    if not down and not up:
        return brief, None
    top = STOREY_LEVELS[max(1, min(int(s), len(STOREY_LEVELS))) - 1]
    out = [dict(f) for f in floors if f.get("level") != "roof"]

    def add(level: str, toks: list[str]) -> None:
        tgt = next((f for f in out if f.get("level") == level), None)
        if tgt is None:
            tgt = {"level": level, "rooms": []}
            out.append(tgt)
        tgt["rooms"] = _sum_tokens(list(tgt.get("rooms") or []) + toks)
    if down:
        add("ground", down)
    if up:
        add(top, up)
    if keep:
        out.append({"level": "roof", "rooms": keep})
    auth = str(brief.get("authority") or "LDA").upper()
    ground = {str(t).split(":")[0] for f in out if f.get("level") == "ground" for t in f.get("rooms") or []}
    parts = []
    if down:
        what = _and_words([_room_phrase(t) for t in down])
        near = " by the dirty kitchen" if "dirty_kitchen" in ground and "dirty_kitchen" not in {t.split(":")[0] for t in down} \
            else " by the kitchen" if "kitchen" in ground else " on the ground floor"
        parts.append(f"put {what}{near}")
    if up:
        parts.append(f"put {_and_words([_room_phrase(t) for t in up])} on the {top} floor")
    said = f"{AUTHORITY_NAME.get(auth, auth)} counts a roof room as a storey, so I've {' and '.join(parts)}."
    return {**brief, "floors": merge_floors([], out)}, said


def _and_words(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + f" and {items[-1]}"


def _cap_storeys(brief: dict) -> tuple[dict, str | None]:
    """Keep the brief within the authority's storeys (DHA: 2). Rooms planned for a floor that isn't allowed move to the top
    allowed floor. Returns (brief, one sentence of pushback, or None)."""
    s = brief.get("storeys")
    if not s or not brief.get("authority") and not brief.get("plot"):
        return brief, None
    cap, said = storey_cap(brief)
    if int(s) <= cap:
        return brief, None
    # Naqsha changed it: recorded in auto_filled with what they asked for, so the card reads "Kept to 2 storeys: DHA's
    # limit" under "I assumed" and never "You said: 2 storeys".
    b = {**brief, "storeys": cap, "storeys_asked": int(s),
         "auto_filled": sorted(set(brief.get("auto_filled") or []) | {"storeys"})}
    keep = set(STOREY_LEVELS[:cap]) | {"basement", "roof"}
    floors = [dict(f) for f in brief.get("floors") or [] if isinstance(f, dict)]
    extra = [t for f in floors if f.get("level") not in keep for t in f.get("rooms") or []]
    floors = [f for f in floors if f.get("level") in keep]
    moved = ""
    if extra:
        top = STOREY_LEVELS[cap - 1]
        tgt = next((f for f in floors if f.get("level") == top), None)
        if tgt is None:
            tgt = {"level": top, "rooms": []}
            floors.append(tgt)
        tgt["rooms"] = _sum_tokens(list(tgt.get("rooms") or []) + extra)
        moved = f" I've put the rooms you planned higher up on the {top} floor; move them if you like."
    if brief.get("floors") is not None:
        b["floors"] = merge_floors([], floors)
    return b, f"{said}, so I've kept it to {cap} storey{'s' if cap != 1 else ''}.{moved}"


def envelope_for(brief: dict) -> dict | None:
    p = brief.get("plot")
    if not p:
        return None
    env = lda.envelope(p["width_ft"], p["depth_ft"], brief.get("authority") or "LDA", bool(p.get("corner")))
    env.pop("_band", None)
    return env


def lda_facts(brief: dict) -> str:
    """Plain facts the agent may quote (and nothing else) about the LDA envelope for this plot."""
    env = envelope_for(brief)
    if not env:
        return "Plot not known yet. LDA heights by band: under 10 marla 38 ft; 10 marla and above 45 ft; both measured to the top " \
               "of the parapet with the stair tower (mumty, up to 9'6\") excluded; max 3 storeys plus a basement."
    sb = env["setbacks_ft"]
    sides = env.get("side_space_note") or ""
    return (f"{env['band']} band. Open spaces: front {sb['front']:g} ft, rear {sb['rear']:g} ft; {sides.lower()}. "
            f"Ground coverage up to {env['max_coverage_pct']:g}% ({env['max_ground_coverage_sqft']:,.0f} sq ft). FAR up to "
            f"{env['max_far']:g}. Height up to {env['max_height_ft']:g} ft to the top of the parapet, stair tower (mumty, up to "
            f"9'6\") excluded. Max {env['max_storeys']} storeys plus a basement. " + " ".join(env["notes"][4:]))


# --- the question bank (instant, deterministic) ------------------------------------------------------------------------
def _solar_hint(brief: dict) -> str:
    env = envelope_for(brief)
    if not env:
        return "About 18 panels, ~10 kW"
    roof = env["max_ground_coverage_sqft"] * 0.55
    kw = max(2, round(roof / 70))
    return f"About {round(kw / 0.55)} panels, ~{kw} kW"


def question(field: str, brief: dict) -> dict:
    """The message for asking `field`, with its widget and one-tap chips."""
    if field == "authority":
        return {"text": "Where is the plot?", "field": "authority", "input": None, "allow_skip": True, "chips": [
            {"label": "Lahore · LDA scheme", "value": "LDA"}, {"label": "DHA Lahore", "value": "DHA"},
            {"label": "Bahria Town Lahore", "value": "BAHRIA"}, {"label": "Another Punjab city", "value": "OTHER"}]}
    if field == "plot":
        return {"text": "How big is the plot? Tap a size or enter the exact width and depth.", "field": "plot", "input": "plot",
                "allow_skip": True, "chips": [
                    {"label": "5 marla", "value": "plot:25x45", "hint": "25 × 45 ft"},
                    {"label": "7 marla", "value": "plot:30x52.5", "hint": "30 × 52.5 ft"},
                    {"label": "10 marla", "value": "plot:35x65", "hint": "35 × 65 ft · Most popular"},
                    {"label": "1 kanal", "value": "plot:50x90", "hint": "50 × 90 ft"},
                    {"label": "2 kanal", "value": "plot:75x120", "hint": "75 × 120 ft"}]}
    if field == "corner":
        return {"text": "Corner or mid-row?", "field": "corner", "input": None, "allow_skip": True, "chips": [
            {"label": "Mid-row", "value": "corner:false", "hint": "Neighbours on both sides"},
            {"label": "Corner plot", "value": "corner:true", "hint": "Roads on two sides"}]}
    if field == "facing":
        return {"text": "Which way does the front of the plot face?", "field": "facing", "input": "map", "allow_skip": True,
                "chips": [{"label": n, "value": f"facing:{c}"} for n, c in (("North", "N"), ("North-east", "NE"), ("East", "E"),
                                                                           ("South-east", "SE"), ("South", "S"), ("South-west", "SW"),
                                                                           ("West", "W"), ("North-west", "NW"))]}
    if field == "storeys":
        cap, said = storey_cap(brief)
        names = {1: "Single storey", 2: "Double storey", 3: "Triple storey"}
        chips = [{"label": names[n], "value": f"storeys:{n}"} for n in range(1, min(cap, 3) + 1)]
        chips[-1]["hint"] = said
        return {"text": "How many floors?", "field": "storeys", "input": None, "allow_skip": True, "chips": chips}
    if field == "bedrooms":
        return {"text": "How many bedrooms, and which rooms do you need?", "field": "bedrooms", "input": "rooms", "allow_skip": True,
                "chips": [{"label": f"{n} bedrooms", "value": f"bedrooms:{n}"} for n in (3, 4, 5, 6)]}
    if field == "floors":
        gaps = floors_missing(brief) if brief.get("floors") else []
        text = (f"What goes on the {' and '.join(gaps)} floor{'s' if len(gaps) > 1 else ''}? Add rooms there, or let me decide."
                if gaps else "What goes on each floor? Move rooms between floors, or let me decide.")
        return {"text": text, "field": "floors", "input": "floors", "allow_skip": True,
                "chips": [{"label": "Decide for me", "value": "floors:auto"}]}
    if field == "water_tank":
        return {"text": "Which water tank should the roof have?", "field": "water_tank", "input": None, "allow_skip": True, "chips": [
            {"label": "Concrete tank in the stair tower", "value": "tank:concrete", "hint": "Hidden, lasts decades · Recommended"},
            {"label": "Blue plastic tank", "value": "tank:plastic", "hint": "Cheaper, visible on the roof"}]}
    if field == "solar":
        return {"text": "Shall I keep the roof clear for solar panels?", "field": "solar", "input": None, "allow_skip": True, "chips": [
            {"label": "Keep the roof clear for solar", "value": "solar:ready", "hint": _solar_hint(brief)},
            {"label": "Add the solar frame now", "value": "solar:panels"},
            {"label": "Not now", "value": "solar:none"}]}
    if field == "style":
        return {"text": "Which style feels like home?", "field": "style", "input": "style", "allow_skip": True,
                "chips": [{"label": s, "value": s} for s in STYLE_NAMES[:6]]}
    return {"text": "Anything else I should know?", "field": field, "input": "text", "allow_skip": True, "chips": []}


SPACE_LABEL = {"drawing": "drawing room", "tv_lounge": "TV lounge", "dining": "dining", "kitchen": "kitchen",
               "dirty_kitchen": "dirty kitchen", "servant_quarter": "servant quarter", "lawn": "lawn", "prayer": "prayer room",
               "store": "store", "laundry": "laundry", "roof_terrace": "roof terrace", "study": "study", "gym": "gym",
               "motorbike": "space for a motorbike"}
TANK_LABEL = {"concrete": "Concrete water tank in the stair tower", "plastic": "Blue plastic water tank"}
SOLAR_LABEL = {"ready": "Roof kept clear for solar", "panels": "Solar frame on the roof", "none": "No solar for now"}
FIELD_LABEL = {"authority": "authority", "plot": "plot size", "facing": "facing", "storeys": "number of floors",
               "bedrooms": "bedrooms", "bathrooms": "bathrooms", "spaces": "rooms", "style": "style", "budget": "budget",
               "water_tank": "water tank", "solar": "solar", "floors": "rooms per floor"}


FACING_NAME = {"N": "north", "NE": "north-east", "E": "east", "SE": "south-east", "S": "south", "SW": "south-west",
               "W": "west", "NW": "north-west"}
ROOM_WORD = {"bedroom": ("bedroom", "bedrooms"), "master_bedroom": ("master bedroom", "master bedrooms"),
             "guest_bedroom": ("guest bedroom", "guest bedrooms"), "bath": ("bath", "baths"), "powder": ("powder room", "powder rooms"),
             "drawing": ("drawing room", "drawing rooms"), "lounge": ("lounge", "lounges"), "tv_lounge": ("TV lounge", "TV lounges"),
             "dining": ("dining", "dining"), "kitchen": ("kitchen", "kitchens"), "kitchenette": ("kitchenette", "kitchenettes"),
             "dirty_kitchen": ("dirty kitchen", "dirty kitchens"), "prayer": ("prayer room", "prayer rooms"), "study": ("study", "studies"),
             "store": ("store", "stores"), "laundry": ("laundry", "laundries"), "servant_quarter": ("servant quarter", "servant quarters"),
             "dressing": ("dressing", "dressings"), "terrace": ("terrace", "terraces"), "balcony": ("balcony", "balconies")}


def marla_label(m: float) -> str:
    if m >= 19.5 and abs(m / 20 - round(m / 20)) < 0.03:
        return f"{round(m / 20):g} kanal"
    return f"{round(m):g} marla" if abs(m - round(m)) < 0.2 else f"{m:g} marla"


def _floor_line(f: dict) -> str:
    from ..compliance.planning import parse_program
    parts = []
    for k, n in parse_program(f.get("rooms") or []).items():
        one, many = ROOM_WORD.get(k, (k.replace("_", " "), k.replace("_", " ") + "s"))
        parts.append(one if n == 1 else f"{n} {many}")
    return f"{f['level'].capitalize()} floor: " + ", ".join(parts)


def storeys_kept(brief: dict) -> str | None:
    """ "Kept to 2 storeys: DHA's limit" when Naqsha capped the storeys the family asked for (clamp_storeys), else None."""
    asked, s = brief.get("storeys_asked"), brief.get("storeys")
    if not asked or not s or int(asked) <= int(s) or "storeys" not in (brief.get("auto_filled") or []):
        return None
    auth = str(brief.get("authority") or "LDA").upper()
    return f"Kept to {s} storey{'s' if int(s) != 1 else ''}: {AUTHORITY_NAME.get(auth, auth)}'s limit"


def _fact_items(brief: dict) -> list[tuple[str, str]]:
    """(field, line) for every fact on the "Here's what I understood" card, in card order. One place builds these lines, so
    "Don't assume: <line>" maps back to its field exactly."""
    items: list[tuple[str, str]] = []
    p = brief.get("plot")
    if p:
        where = brief.get("scheme") or {"DHA": "DHA Lahore", "BAHRIA": "Bahria Town"}.get(brief.get("authority") or "", brief.get("city") or "")
        items.append(("plot", f"{marla_label(p['area_marla'])}, {p['width_ft']:g} × {p['depth_ft']:g} ft" + (f", {where}" if where else "")))
        items.append(("corner", "Corner plot" if p.get("corner") else "Mid-row plot, neighbours on both sides"))
    if brief.get("facing"):
        items.append(("facing", f"Front faces {FACING_NAME.get(brief['facing'], brief['facing'])}"))
    if brief.get("storeys"):
        items.append(("storeys", (storeys_kept(brief) or {1: "Single storey", 2: "Two storeys", 3: "Three storeys"}.get(
            brief["storeys"], f"{brief['storeys']} storeys")) + (" plus a basement" if brief.get("basement") else "")))
    if brief.get("bedrooms"):
        items.append(("bedrooms", f"{brief['bedrooms']} bedrooms"))
    if brief.get("bathrooms"):
        items.append(("bathrooms", f"{brief['bathrooms']} baths"))
    for f in brief.get("floors") or []:
        items.append(("floors", _floor_line(f)))
    on_floors = {floor_space(f.get("level"), t) for f in brief.get("floors") or [] for t in f.get("rooms") or []}
    sp = [SPACE_LABEL.get(s.split(":")[0], s.replace("_", " ")) if not s.startswith("car_porch") else
          f"{s.split(':')[1] if ':' in s else 1}-car porch" for s in brief.get("spaces") or [] if s not in on_floors]
    if sp:
        line = ", ".join(sp)
        items.append(("spaces", line[:1].upper() + line[1:]))
    if brief.get("water_tank") in TANK_LABEL:
        items.append(("water_tank", TANK_LABEL[brief["water_tank"]]))
    if brief.get("solar") in SOLAR_LABEL:
        items.append(("solar", SOLAR_LABEL[brief["solar"]]))
    if brief.get("style"):
        items.append(("style", f"{brief['style']} style"))
    if brief.get("budget"):
        items.append(("budget", f"{str(brief['budget']).capitalize()} budget"))
    return items


def understood(brief: dict, agent: dict | None = None) -> dict:
    """The "Here's what I understood" card. Guaranteed facts are computed (never model-written numbers); preferences are
    what the family said; assumptions are what Naqsha chose."""
    env = envelope_for(brief)
    g = []
    if env:
        sb = env["setbacks_ft"]
        side = env.get("side_space_note") or ""
        who = "LDA open spaces" if (brief.get("authority") or "LDA") in ("LDA", "OTHER") else "Open spaces"
        g.append(f"{who} kept: {sb['front']:g} ft front, {sb['rear']:g} ft rear" + (f", {side.lower()}" if "no side" not in side.lower() else ""))
        g.append(f"Height within {env['max_height_ft']:g} ft (stair tower excluded), at most {env['max_storeys']} storeys")
        g.append(f"Ground coverage within {env['max_coverage_pct']:g}% ({env['max_ground_coverage_sqft']:,.0f} sq ft)")
    g += ["Every bedroom opens onto a corridor or lounge, never another bedroom",
          "A stair reaches every floor and the roof, with the roof door at its landing",
          "Railings at every drop, and nothing blocks a door"]
    auto = set(brief.get("auto_filled") or [])
    prefs, assumed = [], []
    # corner/mid-row counts as said only when the family stated it (a chip or their words); otherwise it's an assumption
    corner_said = "corner" not in auto and brief.get("corner_stated") is True
    for field, line in _fact_items(brief):
        if field == "corner":
            (prefs if corner_said else assumed).append(line)
        elif field == "floors":
            prefs.append(line)
        elif field == "spaces" and "porch" in auto and "spaces" not in auto:  # their rooms, Naqsha's default porch
            parts = line.split(", ")
            porch = [x for x in parts if x.endswith("-car porch")]
            rest = [x for x in parts if x not in porch]
            if rest:
                prefs.append(rest[0][:1].upper() + ", ".join(rest)[1:])
            assumed += [x[:1].upper() + x[1:] for x in porch]
        else:
            (assumed if field in auto else prefs).append(line)
    prefs += [str(x)[:1].upper() + str(x)[1:] for x in brief.get("preferences") or []]
    if "floors" in auto:
        assumed.append("I'll place the rooms on each floor")
    if agent:  # the family's own words are already in brief.preferences; the agent adds only its own assumptions
        assumed = _append_unique(assumed, agent.get("assumptions") or [])
    return {"guaranteed": g, "preferences": _append_unique([], prefs), "assumptions": _append_unique([], assumed)}


def summary(b: dict) -> str:
    p = b.get("plot") or {}
    return (f"{marla_label(p.get('area_marla') or 10)} ({p.get('width_ft', '?'):g} × {p.get('depth_ft', '?'):g} ft), "
            f"{b.get('storeys')}-storey, {b.get('bedrooms')} bedrooms and {b.get('bathrooms')} baths, {b.get('style')}")


AUTO_NAME_RE = re.compile(r"^\d+(\.\d+)?\s+(marla|kanal)\s+(home|house)(,\s*.+)?$", re.I)


def auto_name(project: dict, brief: dict) -> str | None:
    """The name Naqsha gives a home ("12 marla home, Johar Town") while the family hasn't named it themselves: set on the
    first plot, and kept in step with the plot and scheme until they rename it. None when nothing should change."""
    name, flag = project.get("name"), project.get("auto_named")
    unnamed = name in (None, "", "Untitled home")
    if flag is False and not unnamed:  # the family named it (or it is a sample's copy)
        return None
    if not (flag is True or unnamed or AUTO_NAME_RE.match(str(name or ""))):  # older projects: our own pattern only
        return None
    p = brief.get("plot")
    if not p:
        return None
    m = p["area_marla"]
    size = marla_label(m)
    where = brief.get("scheme") or {"DHA": "DHA Lahore", "BAHRIA": "Bahria Town"}.get(brief.get("authority") or "", brief.get("city") or "Lahore")
    new = f"{size} home, {where}"
    return new if new != name else None


def next_stage(project: dict, complete: bool) -> str:
    """Never move a project backwards: editing the brief after a design keeps it at its design stage."""
    cur = project.get("stage") or "setup"
    if cur in ("planning", "building", "ready", "revising") or project.get("versions"):
        return cur if cur != "setup" else "ready"
    if cur == "concepts":
        return "concepts"
    return "concepts" if complete else "setup"


GREETING = "Tell me about the plot and who will live there. One message is enough."
START_NOTE = "Or tell me about the whole home in one message; that works too."
GREETING_SUGGESTIONS = [
    "10 marla in Johar Town, mid-row, facing north. Two storeys, 5 bedrooms with attached baths, my parents' room on the "
    "ground floor, open kitchen with a dirty kitchen, 2-car porch, solar panels and a concrete water tank. Modern style.",
    "A 50 by 120 ft lot in Travis Heights, Austin, two storeys, four bedrooms, a two-car garage",
    "A villa plot in Al Barsha, Dubai, 60 by 100 ft, five bedrooms, a majlis and a maid's room",
    "A 30 by 120 ft lot in Leslieville, Toronto, three bedrooms and a home studio",
]
COMPLETE_SUGGESTIONS = ["Show me concepts", "Add a prayer room", "Make the kitchen open"]
# Follow-ups offered once the brief is complete; each is left out when the brief already has it.
SUGGESTION_POOL = [("Show me concepts", ()), ("Add a prayer room", ("prayer",)),
                   ("Make the kitchen open", ("open kitchen", "open-plan kitchen", "open plan kitchen", "kitchen open")),
                   ("Add a study", ("study", "office")), ("Add a roof terrace", ("terrace",)),
                   ("Add a servant quarter", ("servant",)), ("Add a dirty kitchen", ("dirty_kitchen", "dirty kitchen"))]


# --- the turn ------------------------------------------------------------------------------------------------------------
async def _save(project: dict, brief: dict, complete: bool, before: dict | None) -> tuple[dict, dict | None, bool]:
    """Persist the brief + envelope + stage. Returns (brief, envelope, newly_complete)."""
    pid = project["id"]
    env = envelope_for(brief)
    was_complete = bool(project.get("intake_complete"))
    complete = complete and not missing(brief)
    fields = {"brief": brief, "envelope": env, "intake_complete": was_complete or complete,
              "stage": next_stage(project, was_complete or complete)}
    if project.get("versions") and before is not None and _design_fields(before) != _design_fields(brief):
        fields["brief_changed"] = True
    if (name := auto_name(project, brief)):
        fields.update(name=name, auto_named=True)
    project.update(await db.patch_project(pid, **fields))
    return brief, env, complete and not was_complete


def _design_fields(b: dict) -> dict:
    return {k: b.get(k) for k in ("plot", "storeys", "basement", "bedrooms", "bathrooms", "spaces", "floors", "water_tank",
                                  "solar", "preferences", "style", "facing")}


async def run_turn(project: dict, message: str | None, action: str | None, chips: list[str] | None) -> AsyncIterator[tuple[str, dict]]:
    pending: list[asyncio.Task] = []
    try:
        async for ev in _turn(project, message, action, chips, pending):
            yield ev
    finally:
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


# --- "Don't assume" ------------------------------------------------------------------------------------------------------------
DONT_ASSUME_RE = re.compile(r"^\s*don['’]?t\s+assume\s*[:,\-–]?\s*(.+?)\s*$", re.I | re.S)
UNSET_ALIAS = {"tank": "water_tank", "rooms": "bedrooms", "beds": "bedrooms", "baths": "bathrooms", "floors_per_level": "floors",
               "location": "authority", "mid_row": "corner", "midrow": "corner"}
UNSET_ASKS = {"bathrooms": "bedrooms", "spaces": "bedrooms"}  # the rooms widget answers these


def fact_field(brief: dict, text: str) -> str | None:
    """Which brief field a line of the "Here's what I understood" card is about ("Front faces north" -> facing)."""
    t = re.sub(r"[.\s]+$", "", str(text or "")).strip().lower()
    if not t:
        return None
    items = _fact_items(brief) + [("floors", "I'll place the rooms on each floor")]
    for field, s in items:
        if s.lower() == t:
            return field
    for field, s in items:
        s = s.lower()
        if len(t) >= 6 and (t in s or s in t):
            return field
    return None


def unset_fields(brief: dict, fields: list[str]) -> tuple[dict, list[str]]:
    """Clear fields Naqsha had assumed (or the family wants to answer again): the value goes and so does its auto_filled
    mark, so the question is asked again. Returns (brief, the fields cleared)."""
    b = {**brief}
    auto = set(b.get("auto_filled") or [])
    done = []
    for f in fields:
        f = UNSET_ALIAS.get(f, f)
        if f == "corner":  # asked again; meanwhile mid-row stays Naqsha's assumption
            b["corner_stated"] = False
            if b.get("plot"):
                b["plot"] = {**b["plot"], "corner": False}
                b["corner_open"] = True
                auto.add("corner")
                done.append(f)
                continue
        elif f in ("spaces", "floors"):
            b[f] = []
            if f == "spaces":
                auto.discard("porch")
        elif f in ("plot", "bedrooms", "bathrooms", "storeys", "facing", "water_tank", "solar", "style", "budget", "authority"):
            b[f] = None
            if f == "storeys":
                b.pop("storeys_asked", None)
        else:
            continue
        auto.discard(f)
        done.append(f)
    b["auto_filled"] = sorted(auto)
    return b, done


async def _turn(project: dict, message: str | None, action: str | None, chips: list[str] | None,
                pending: list) -> AsyncIterator[tuple[str, dict]]:
    pid = project["id"]
    brief = project.get("brief") or empty_brief()
    before = dict(brief)
    history = await db.list_messages(pid)
    last_q = next((m for m in reversed(history) if m["role"] == "assistant"), None)

    if action == "start":  # "Start with questions": the first question, with its widget; one long message is fine too
        if not history:
            q = question("plot", brief)
            yield "message", await db.add_message(pid, {"role": "assistant", "text": f"{q['text']} {START_NOTE}", "chips": q["chips"],
                                                        "input": q["input"], "field": q["field"], "allow_skip": q["allow_skip"],
                                                        "suggestions": GREETING_SUGGESTIONS, "multi": False})
        return

    user_text = (message or "").strip() or (", ".join(chips) if chips else "")
    if action == "skip_question":
        user_text = "You decide."
    elif action == "skip_all":
        user_text = "Skip setup and design it for me."
    if user_text and history and history[-1].get("role") == "user" and (history[-1].get("text") or "").strip() == user_text.strip():
        # "Try again" on a turn that never got a reply: answer the same message instead of storing it twice.
        yield "message", history[-1]
        history = history[:-1]
    elif user_text:  # shown at once; written while the turn runs
        um = db.make_message({"role": "user", "text": user_text})
        pending.append(asyncio.create_task(db.put_message(pid, um)))
        yield "message", um

    if action == "skip_all":
        brief, _ = defaults_for(brief)
        brief, _ = clamp_storeys(brief)
        brief, env, _ = await _save(project, brief, True, before)
        yield "brief", {"brief": brief, "envelope": env}
        text = (f"Here's a starting brief: {summary(brief)}. Tap anything to change it; when you tap Show me concepts, I'll "
                f"sketch four exteriors.")
        yield "message", await db.add_message(pid, {"role": "assistant", "text": text, "chips": [], "input": None,
                                                    "understood": understood(brief), "suggestions": _complete_suggestions(project, brief)})
        yield "intake.complete", {"brief": brief, "envelope": env}
        return

    structured, unknown = parse_chips(chips)
    floors_auto = structured.pop("_floors_auto", False)
    unset = structured.pop("_unset", [])
    m = DONT_ASSUME_RE.match(message or "") if not chips else None
    dropped_pref = None
    if m:  # the × on an assumed fact: deterministic, never up to the model
        f = fact_field(brief, m.group(1))
        if f:
            unset.append(f)
        else:
            gone = _drop_prefs(brief.get("preferences") or [], [m.group(1).strip().rstrip(".")])
            if len(gone) < len(brief.get("preferences") or []):
                dropped_pref = gone
    if unset or dropped_pref is not None:
        if dropped_pref is not None:
            brief = {**brief, "preferences": dropped_pref}
        brief, cleared = unset_fields(brief, unset)
        nxt = to_ask(brief)
        complete = not nxt and not missing(brief)
        brief, env, _ = await _save(project, brief, complete, before)
        yield "brief", {"brief": brief, "envelope": env}
        ask = next((UNSET_ASKS.get(f, f) for f in cleared if UNSET_ASKS.get(f, f) in ASK_ORDER), None) or (nxt[0] if nxt else None)
        if ask:
            q = question(ask, brief)
            msg = {"role": "assistant", "text": f"Okay, I won't assume that. {q['text']}", "chips": q["chips"], "input": q["input"],
                   "field": q["field"], "allow_skip": q["allow_skip"], "multi": False}
        else:
            msg = {"role": "assistant", "text": "Okay, I've taken that out.", "chips": [], "input": None, "allow_skip": False}
        yield "message", await db.add_message(pid, msg)
        return

    fast = action == "skip_question" or (bool(chips) and not unknown and (structured or floors_auto))
    if fast:  # widget answers: deterministic, instant
        if action == "skip_question":
            brief = skip_field(brief, (last_q or {}).get("field"))
        else:
            brief = merge_brief(brief, structured, ["floors"] if floors_auto else [], spaces_mode="replace")
            if structured.get("bedrooms") and not structured.get("bathrooms") and not brief.get("bathrooms"):
                brief = merge_brief(brief, {"bathrooms": structured["bedrooms"] + 1}, ["bathrooms"])
        brief, push = clamp_storeys(brief)
        nxt = to_ask(brief)
        complete = not nxt and not missing(brief)
        if complete and not brief.get("spaces"):
            brief = merge_brief(brief, {"spaces": defaults_for(brief)[0]["spaces"]}, ["spaces"])
        brief, env, newly = await _save(project, brief, complete, before)
        yield "brief", {"brief": brief, "envelope": env}
        if complete:
            msg = {"role": "assistant", "text": ((push + " ") if push else "") + _complete_text(project, brief), "chips": [],
                   "input": None, "understood": understood(brief), "suggestions": _complete_suggestions(project, brief)}
            yield "message", await db.add_message(pid, msg)
            if newly:
                yield "intake.complete", {"brief": brief, "envelope": env}
        else:
            q = question(nxt[0], brief)
            ack = push or (_ack(structured, brief) if action != "skip_question" else _ack_skip((last_q or {}).get("field"), brief))
            msg = {"role": "assistant", "text": (ack + " " + q["text"]).strip(), "chips": q["chips"], "input": q["input"],
                   "field": q["field"], "allow_skip": q["allow_skip"], "multi": False}
            yield "message", await db.add_message(pid, msg)
        return

    # free text (or chips the bank doesn't know): the conversational agent
    from .setup_agent import agent_turn
    async for ev in agent_turn(project, brief, before, history, user_text, structured):
        yield ev


def _complete_text(project: dict, brief: dict) -> str:
    if project.get("versions"):
        return ("Noted. Your current design was made before this change; revise it or design again to bring it in.")
    return ("Here's what I understood. Tap anything I got wrong; when you tap Show me concepts, I'll sketch four exteriors "
            "for you to choose from.")


def _complete_suggestions(project: dict, brief: dict | None = None) -> list[str]:
    """Next steps once the brief is complete, leaving out anything the brief already has."""
    if project.get("versions"):
        return []
    b = brief or project.get("brief") or {}
    have = " ".join([str(p) for p in b.get("preferences") or []] + [str(b.get("notes") or "")]
                    + [str(s) for s in b.get("spaces") or []]
                    + [str(t) for f in b.get("floors") or [] if isinstance(f, dict) for t in f.get("rooms") or []]).lower()
    return [label for label, keys in SUGGESTION_POOL if not any(k in have for k in keys)][:3]


def _roof_ack(brief: dict) -> str:
    tank = {"concrete": "a concrete tank hidden in the stair tower", "plastic": "a blue plastic tank on the stair tower"}.get(
        brief.get("water_tank") or "")
    solar = {"ready": "the roof kept clear for solar panels", "panels": "a solar frame on the roof",
             "none": "no solar for now"}.get(brief.get("solar") or "")
    line = ", with ".join(x for x in (tank, solar) if x) if tank and solar else (tank or solar or "")
    return (line[:1].upper() + line[1:] + ".") if line else "Noted."


def _ack(patch: dict, brief: dict) -> str:
    """A short read-back of a widget answer."""
    if "plot" in patch and brief.get("plot") and set(patch["plot"]) - {"corner"}:
        p = brief["plot"]
        env = envelope_for(brief)
        who = AUTHORITY_NAME.get(str(brief.get("authority") or "LDA").upper(), "LDA")
        extra = f" {who} needs {env['setbacks_ft']['front']:g} ft open at the front; I'll keep it." if env else ""
        return f"{marla_label(p['area_marla'])}, {p['width_ft']:g} × {p['depth_ft']:g} ft.{extra}"
    if "plot" in patch and "corner" in patch["plot"]:
        return "A corner plot, with roads on two sides." if brief.get("plot", {}).get("corner") else \
            "A mid-row plot, with neighbours on both sides."
    if "water_tank" in patch or "solar" in patch:
        return _roof_ack(brief)
    if "floors" in patch:
        return "Got the rooms for each floor."
    if "style" in patch:
        return f"{brief['style']}, lovely."
    if "bedrooms" in patch:
        return f"{brief['bedrooms']} bedrooms and {brief.get('bathrooms') or brief['bedrooms'] + 1} baths."
    if "storeys" in patch:
        return {1: "Single storey.", 2: "Two storeys.", 3: "Three storeys."}[brief["storeys"]]
    if "facing" in patch and brief.get("facing"):
        return f"Facing {FACING_NAME.get(brief['facing'], brief['facing'])}."
    if "authority" in patch:
        return {"LDA": "An LDA scheme.", "DHA": "DHA Lahore, with its own bylaws.", "BAHRIA": "Bahria Town, with its own rules."}.get(brief["authority"], "Noted.")
    return "Noted."


def _ack_skip(field: str | None, brief: dict) -> str:
    if field == "floors":
        return "I'll place the rooms on each floor."
    if field == "corner":
        return "I'll take it as a mid-row plot, with neighbours on both sides."
    if field in ("bedrooms", "rooms") and brief.get("bedrooms"):
        floors = " and I'll place the rooms on each floor" if "floors" in (brief.get("auto_filled") or []) else ""
        return f"I've chosen {brief['bedrooms']} bedrooms and {brief.get('bathrooms') or brief['bedrooms'] + 1} baths{floors}."
    if field in ("water_tank", "solar") and brief.get(field):
        return _roof_ack(brief)
    if field and brief.get(field) not in (None, "", []):
        v = brief[field]
        if field == "facing":
            label = FACING_NAME.get(str(v), str(v).lower())
        else:
            label = {"water_tank": TANK_LABEL, "solar": SOLAR_LABEL}.get(field, {}).get(v, v)
            label = str(label).lower() if isinstance(label, str) else label
        return f"I've chosen {label} for the {FIELD_LABEL.get(field, field)}."
    return "I'll decide that."
