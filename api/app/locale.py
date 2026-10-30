"""Where the home is, and what homes there are like. No place is the default here: everything local comes from the place's
home profile (agents/homes.py), Lahore's like anywhere else's. `brief.local` is the profile's digest, the few decided
facts deterministic code needs (the roof, how houses stand, units); prompts read the full profile.

The one thing known without research: LDA, DHA and Bahria are authorities in Lahore, so naming one names the place."""
from __future__ import annotations

import json

LAHORE_AUTHORITIES = {"LDA", "DHA", "BAHRIA"}
ATTACHED = {"row", "townhouse"}
PITCHED = {"gable", "hip"}
PARKING_WORD = {"garage": "garage", "carport": "carport", "laneway": "laneway garage", "porch": "porch",
                "driveway": "driveway", "street": "street parking"}


def _city(brief: dict) -> str:
    city = str(brief.get("city") or "").strip()
    if city:
        return city
    return "Lahore" if str(brief.get("authority") or "").upper() in LAHORE_AUTHORITIES else ""


def known(brief: dict) -> bool:
    """Whether the family has said where the home is: the one thing Naqsha must ask."""
    return bool(_city(brief) or str(brief.get("scheme") or "").strip())


def place(brief: dict) -> str:
    """'DHA Phase 6, Lahore, Pakistan' / 'Travis Heights, Austin, United States'; '' while unknown."""
    return ", ".join(x for x in (brief.get("scheme"), _city(brief), brief.get("country")) if x)


def named(brief: dict) -> str:
    """The place in a sentence: 'Austin'."""
    return _city(brief) or str(brief.get("scheme") or "") or "your city"


# --- the digest: what deterministic code reads ----------------------------------------------------------------------------
def digest(prof: dict | None) -> dict:
    """brief.local: the decided facts of a home profile."""
    p = prof or {}
    form, roof, lot, parking = p.get("form") or {}, p.get("roof") or {}, p.get("lot") or {}, p.get("parking") or {}
    outdoor, services = p.get("outdoor") or {}, p.get("services") or {}
    out = {"units": p.get("units"), "form": form.get("type"), "side_gap_ft": form.get("side_gap_ft"),
           "front_setback_ft": form.get("front_setback_ft"), "roof": {k: roof.get(k) for k in (
               "form", "pitch_deg", "ridge", "material", "overhang_ft")} if roof.get("form") else None,
           "stair_tower": bool(roof.get("stair_tower")), "parking": parking.get("type"), "cars": parking.get("cars"),
           "front_boundary": outdoor.get("front_boundary"), "roof_tank": services.get("roof_tank") or "none",
           "storeys": p.get("storeys"), "living_room": (p.get("rooms") or {}).get("living_room"),
           "walls": (p.get("walls") or [])[:3], "lot": {k: lot.get(k) for k in ("width_ft", "depth_ft")} if lot.get("width_ft") else None}
    return {k: v for k, v in out.items() if v not in (None, "", [], {})}


def local(brief: dict, homes: dict | None = None) -> dict:
    return digest(homes) if homes else (brief.get("local") or {})


def units(brief: dict, homes: dict | None = None) -> str:
    """How plot sizes are said here: what the family said it in, else what is usual there."""
    said = brief.get("units") or local(brief, homes).get("units")
    if said:
        return said
    return "marla" if str(brief.get("authority") or "").upper() in LAHORE_AUTHORITIES else "sqft"


def form(brief: dict, homes: dict | None = None) -> str | None:
    """detached, semi-detached, row, compound or townhouse; the family's word first."""
    return brief.get("home_form") or local(brief, homes).get("form")


def attached(brief: dict, homes: dict | None = None) -> bool:
    """Neighbours built against both side walls."""
    return form(brief, homes) in ATTACHED


def roof(brief: dict, homes: dict | None = None) -> dict:
    """The roof this home gets: {form, pitch_deg, ridge, material, overhang_ft}; the family's word first."""
    r = dict(local(brief, homes).get("roof") or {})
    said = brief.get("roof_form")
    if said and said != r.get("form"):
        r["form"] = said
        if said in PITCHED and not r.get("pitch_deg"):
            r["pitch_deg"] = 30
    return r


def pitched(brief: dict, homes: dict | None = None) -> bool:
    return roof(brief, homes).get("form") in PITCHED


def roof_tank_usual(brief: dict, homes: dict | None = None) -> bool:
    """Whether homes here carry a water tank on the roof. A pitched roof never does."""
    return local(brief, homes).get("roof_tank", "none") != "none" and not pitched(brief, homes)


def parking_word(brief: dict, homes: dict | None = None) -> str:
    return PARKING_WORD.get(local(brief, homes).get("parking") or "", "porch")


def street(brief: dict) -> dict:
    """plan.site.street: how the neighbouring houses stand, for the 3D street."""
    lo = local(brief)
    kind = form(brief)
    r = roof(brief)
    out = {"form": "row" if kind in ATTACHED else "semi-detached" if kind == "semi-detached" else "detached" if kind else None,
           "side_gap_ft": lo.get("side_gap_ft"), "setback_ft": lo.get("front_setback_ft"), "storeys": lo.get("storeys"),
           "front_wall": front_wall(brief), "roof_tank": lo.get("roof_tank", "none") != "none" and not pitched(brief),
           "walls": lo.get("walls"), "roof": {k: r.get(k) for k in ("form", "pitch_deg", "ridge")} if r.get("form") else None}
    return {k: v for k, v in out.items() if v not in (None, [], {})}


def front_wall(brief: dict) -> bool:
    """A solid wall and gate along the road, or an open front."""
    return local(brief).get("front_boundary", "wall") == "wall"


def attic_roof(brief: dict) -> dict | None:
    """plan.roof.pitched for a pitched home, None for a flat one."""
    r = roof(brief)
    if r.get("form") not in PITCHED:
        return None
    return {"form": r["form"], "pitch_deg": r.get("pitch_deg") or 30, "ridge": r.get("ridge") or "auto",
            "material": r.get("material") or "", "overhang_ft": r.get("overhang_ft") if r.get("overhang_ft") is not None else 1.5}


# --- sentences for prompts --------------------------------------------------------------------------------------------------
def home_line(homes: dict | None) -> str:
    """One line on the kind of home that is usual here."""
    return str((homes or {}).get("summary") or "").rstrip(".")


def form_phrase(brief: dict, homes: dict | None = None) -> str:
    """What kind of building this is, for the first line of an image prompt."""
    f = (homes or {}).get("form") or {}
    gap = f.get("side_gap_ft") or local(brief, homes).get("side_gap_ft")
    return {"row": "one house in a continuous row of houses", "townhouse": "a townhouse, one in a continuous row",
            "semi-detached": "one half of a semi-detached pair",
            "compound": "a villa behind a solid wall around its own compound",
            "detached": f"a detached house standing alone on its lot, with open side yards{f' about {gap:g} ft wide' if gap else ''}",
            }.get(form(brief, homes) or "", "a family house of the kind usually built there")


def walls_sentence(homes: dict | None) -> str:
    walls = (homes or {}).get("walls") or []
    return f"Walls in what homes there are built of: {', '.join(walls)}." if walls else ""


def street_context(brief: dict, homes: dict | None = None, cars: str = "1") -> str:
    """The site conventions for an exterior image."""
    p = homes or {}
    out, park = p.get("outdoor") or {}, p.get("parking") or {}
    if not p.get("form"):
        return (f"A family home as they are built in {place(brief) or 'this place'}: the street, front garden or yard, "
                f"parking and boundary treatment that homes there typically have, and a roof form and climate response "
                f"that suit the place.")
    bits = []
    if park.get("description"):
        bits.append(f"Parking: {park['description']}, room for {cars} car{'s' if str(cars) != '1' else ''}.")
    if out.get("front"):
        bits.append(f"In front: {out['front']}.")
    if out.get("porch"):
        bits.append(f"Entrance: {out['porch']}.")
    if out.get("boundary"):
        bits.append(f"Boundary: {out['boundary']}.")
    return " ".join(bits)


def local_touches(brief: dict, homes: dict | None = None) -> str:
    """Fixtures, furnishing and planting for the 3D build."""
    p = homes or {}
    s, r = p.get("services") or {}, p.get("rooms") or {}
    if not p.get("form"):
        return (f"Include what homes in {place(brief) or 'this place'} have: fixtures, heating or cooling, appliances and "
                f"furnishing typical there, and trees and planting native to the place.")
    bits = [f"Cooling: {s['cooling']}." if s.get("cooling") else "", f"Heating: {s['heating']}." if s.get("heating") else "",
            f"Details homes here have: {', '.join(r['touches'])}." if r.get("touches") else "",
            f"Planting: {str(p['planting']).rstrip('.')}." if p.get("planting") else "",
            "Use a ceiling fan or split AC only if listed here; the same goes for any other fixture."]
    return " ".join(b for b in bits if b)


def planning_sense(brief: dict, homes: dict | None = None) -> str:
    """How a home is planned here, for the plan prompt: the profile as an architect's notes."""
    where = place(brief) or "this place"
    p = homes or {}
    if not p.get("form"):
        return (f"THIS HOME IS IN {where.upper()}: plan it as a local architect there would, for how families there live, "
                f"with the room names and conventions usual there.")
    f, rm, out, park, s = p.get("form") or {}, p.get("rooms") or {}, p.get("outdoor") or {}, p.get("parking") or {}, p.get("services") or {}
    kind = form(brief, homes)
    gap = f.get("side_gap_ft")
    lines = [f"THIS HOME IS IN {where.upper()}. {home_line(p)}.",
             f"HOW IT STANDS: {kind}. {f.get('street_relation') or ''}".strip()]
    if kind in ATTACHED:
        lines.append("Both side walls stand on the plot edges; light comes from the front, the back and any court.")
    elif gap:
        lines.append(f"Keep at least {gap:g} ft open beside the house on each side that is not a party wall, even where the "
                     f"envelope would allow less, and put side windows on those walls.")
    if rm.get("planning"):
        lines.append(f"HOW FAMILIES PLAN HERE: {rm['planning']}")
    if rm.get("include"):
        lines.append(f"ROOMS USUAL HERE, by their local names: {', '.join(rm['include'])}. Name rooms that way in the plan.")
    if rm.get("avoid"):
        lines.append(f"LEAVE OUT unless the brief asks: {', '.join(rm['avoid'])}.")
    if park.get("description"):
        word = local(brief, homes).get("parking")
        how = (" Make it a `garage` room with a `garage_door` opening onto the driveway (the car bay rules below apply to it)."
               if word in ("garage", "laneway") else
               " Make it a `porch` room open to the driveway." if word in ("carport", "porch") else
               " Give it no covered room; a driveway room is enough." if word in ("driveway", "street") else "")
        lines.append(f"PARKING: {park['description']}.{how}")
    if out.get("front") or out.get("back"):
        lines.append(f"OUTDOORS: {'; '.join(x for x in (out.get('front'), out.get('back'), out.get('porch')) if x)}.")
    if s.get("basement"):
        lines.append("Basements are usual here; plan one only if the brief asks.")
    if p.get("climate"):
        lines.append(f"CLIMATE: {p['climate']}")
    return "\n".join(lines)


def roof_planning(brief: dict, homes: dict | None = None) -> str:
    """What the plan does about the roof, for the plan prompt."""
    r = roof(brief, homes)
    if r.get("form") in PITCHED:
        return (f"THE ROOF IS PITCHED ({r['form']}, about {r.get('pitch_deg') or 30:g}°): Naqsha builds it over the top storey, "
                f"so keep the plan's final roof level with parapet_ft 3.5 (it becomes the knee wall under the eaves) and "
                f"roof.mumty over the stair (it stays hidden in the attic). Put no room, terrace, water tank or solar on the roof "
                f"level. Give the top storey one simple rectangular outline, so a single roof covers it.")
    tower = local(brief, homes).get("stair_tower")
    tank = ("roof.water_tank follows brief.water_tank (\"plastic\" sits on the stair tower, its rect inside roof.mumty.rect; "
            "\"concrete\" sits on the roof slab beside it)." if roof_tank_usual(brief, homes) else "No water tank on the roof.")
    return (f"THE ROOF IS FLAT, with a parapet. {'The stair ends in a stair tower on the roof.' if tower else 'The stair tower is a light roof-access box.'} {tank}")


def roof_build(brief: dict, homes: dict | None = None) -> str:
    """The roof's line for the 3D build prompt."""
    r = attic_roof(brief)
    if r or roof(brief, homes).get("form") in PITCHED:
        r = r or {}
        spec = {"form": r.get("form") or roof(brief, homes).get("form"), "pitch_deg": r.get("pitch_deg") or 30, "ridge": r.get("ridge") or "auto",
                "material": r.get("material") or "", "overhang_ft": r.get("overhang_ft", 1.5)}
        return (f"ROOF: pitched. The plan already carries it (plan.roof.pitched), so s.structure() builds it; pass `roof` in "
                f"s.structure only to change its material or colour to match the concept, e.g. roof: {json.dumps(spec)}. "
                f"Parapet trim, roof terraces, solar frames and rooftop features don't exist on this house: end the facade at the "
                f"eaves.")
    return "ROOF: flat, with its parapet. Pass no `roof` option. Keep it clear: no domes, cupolas, minarets, chhatris or pergolas."
