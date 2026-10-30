"""The local home profile: research output cleaned, what it fills in, and that it, not a country, decides what is built. No
model or web calls."""
import asyncio

import pytest

from app import locale
from app.agents import architect, concepts, homes, intake, views
from app.store import db


def profile(**kw):
    p = homes.clean({
        "place": "Austin, United States", "country": "United States", "summary": "A two-storey house with a shingle gable roof and a garage.",
        "authority": {"code": "DSD", "name": "Development Services"}, "style": "Texas Hill Country",
        "form": {"type": "detached", "street_relation": "Set back behind a lawn.", "side_gap_ft": 6, "front_setback_ft": 25},
        "roof": {"form": "gable", "pitch_deg": 32, "material": "charcoal asphalt shingles", "ridge": "parallel", "overhang_ft": 2},
        "walls": ["limestone veneer", "painted siding"], "lot": {"width_ft": 55, "depth_ft": 120}, "storeys": 2, "bedrooms": 4,
        "parking": {"type": "garage", "cars": 2, "description": "attached two-car garage facing the street"},
        "outdoor": {"front": "an open lawn", "back": "a fenced yard", "porch": "a covered porch", "front_boundary": "none", "boundary": "no front fence"},
        "rooms": {"living_room": "family room", "spaces": ["dining", "kitchen", "laundry", "study", "drawing_room"],
                  "include": ["family room", "mudroom"], "avoid": ["drawing room", "dirty kitchen"], "planning": "The kitchen opens to the family room."},
        "services": {"roof_tank": "none", "basement": False, "heating": "gas furnace", "cooling": "central air"},
        "climate": "Hot summers, so deep eaves.", "planting": "live oak", "units": "sqft"}, "Austin")
    return {**p, **kw, "key": kw.get("key", "home-austin")}


def lahore():
    return {**homes.clean({
        "place": "Lahore, Pakistan", "summary": "A flat-roofed row house behind a boundary wall with a car porch.",
        "form": {"type": "row", "street_relation": "Side walls on the plot lines.", "side_gap_ft": 0, "front_setback_ft": 10},
        "roof": {"form": "flat", "stair_tower": True, "tower_name": "mumty"}, "walls": ["cement plaster"],
        "lot": {"width_ft": 35, "depth_ft": 65}, "storeys": 2, "bedrooms": 5,
        "parking": {"type": "porch", "cars": 1, "description": "a car porch inside the gate"},
        "outdoor": {"front": "a small lawn", "front_boundary": "wall", "boundary": "a boundary wall with a sliding gate"},
        "rooms": {"living_room": "TV lounge", "spaces": ["drawing", "tv_lounge", "dining", "kitchen", "dirty_kitchen", "lawn", "store"],
                  "planning": "The drawing room is near the entrance."},
        "services": {"roof_tank": "concrete"}, "units": "marla"}, "Lahore"), "key": "home-lahore"}


AUSTIN = {**intake.empty_brief(), "city": "Austin", "country": "United States"}
LAHORE = {**intake.empty_brief(), "city": "Lahore", "authority": "LDA"}


# --- research output --------------------------------------------------------------------------------------------------------
def test_clean_keeps_sane_values_only():
    p = homes.clean({"form": {"type": "Semi_Detached", "side_gap_ft": 900}, "roof": {"form": "GABLE", "pitch_deg": 300},
                     "storeys": 40, "units": "acres", "services": {"roof_tank": "gold"}, "rooms": {"spaces": ["kitchen", "dungeon"]}}, "X")
    assert p["form"]["type"] == "semi-detached" and p["form"]["side_gap_ft"] is None
    assert p["roof"]["form"] == "gable" and p["roof"]["pitch_deg"] == 30 and not p["roof"]["stair_tower"]
    assert p["storeys"] == 2 and p["units"] == "sqft" and p["services"]["roof_tank"] == "none" and p["rooms"]["spaces"] == ["kitchen"]
    assert homes.clean({"form": {"type": "yurt"}, "roof": {"form": "flat"}}, "X") is None     # it must say what kind of house
    row = homes.clean({"form": {"type": "row", "side_gap_ft": 8}, "roof": {"form": "flat"}}, "X")
    assert row["form"]["side_gap_ft"] == 0


def test_the_place_is_all_that_is_required():
    b = intake.empty_brief()
    assert b["city"] is None and intake.to_ask(b) == ["place"] and not locale.known(b)
    assert locale.place(b) == ""                                             # nowhere is the default
    assert intake.to_ask({**b, "city": "Nairobi"}) == []
    assert intake.to_ask({**b, "authority": "DHA"}) == [] and locale.place({**b, "authority": "DHA"}) == "Lahore"
    assert intake.to_ask({**b, "plot": {"width_ft": 40, "depth_ft": 80}}) == ["place"]


def test_unknown_place_quotes_no_rule_numbers():
    b = {**intake.merge_brief(AUSTIN, {"plot": {"width_ft": 50, "depth_ft": 100}}), "authority": None}
    assert "quote no numbers" in intake.lda_facts(b)
    assert not any("LDA" in g or "ft front" in g for g in intake.understood(b)["guaranteed"])
    assert intake.storey_cap(b)[0] == 3 and "LDA" not in intake.storey_cap(b)[1]


# --- filling the brief --------------------------------------------------------------------------------------------------------
def test_defaults_come_from_the_profile():
    b, auto = intake.defaults_for(AUSTIN, profile())
    assert b["plot"]["width_ft"] == 55 and b["plot"]["depth_ft"] == 120 and b["storeys"] == 2 and b["bedrooms"] == 4 and b["bathrooms"] == 5
    assert b["style"] == "Texas Hill Country" and "car_porch:2" in b["spaces"] and "drawing" not in b["spaces"]
    assert not b.get("water_tank") and not b.get("solar") and b["local"]["roof"]["form"] == "gable"
    assert {"plot", "storeys", "bedrooms", "spaces", "style", "home_form", "roof_form"} <= set(b["auto_filled"])
    card = intake.understood(b)
    joined = " ".join(card["assumptions"])
    assert "sq ft" in joined and "marla" not in joined and "2-car garage" in joined and "Detached house" in joined and "Gable roof" in joined
    assert "Mid-row" not in joined and "Inside lot" in joined and "Family room" in joined
    assert b["authority"] == "DSD" and b["country"] == "United States"


def test_lahore_is_a_profile_like_anywhere_else():
    b, _ = intake.defaults_for(LAHORE, lahore())
    assert b["plot"]["width_ft"] == 35 and b["water_tank"] == "concrete" and b["solar"] == "ready" and "drawing" in b["spaces"]
    joined = " ".join(intake.understood(b)["assumptions"])
    assert "10.1 marla" in joined or "10 marla" in joined
    assert "Flat roof with a stair tower" in joined and "Row house" in joined and "Mid-row plot" in joined and "1-car porch" in joined
    assert "LDA" in " ".join(intake.understood(b)["guaranteed"])


def test_without_a_profile_nothing_local_is_invented():
    b, _ = intake.defaults_for({**intake.empty_brief(), "city": "Nairobi"}, None)
    assert b["plot"]["width_ft"] == homes.LOT_FALLBACK["width_ft"] and "drawing" not in b["spaces"] and not b.get("water_tank")
    assert not intake.form_line(b) and not intake.roof_line(b) and locale.units(b) == "sqft"


def test_the_familys_words_beat_the_profile():
    b = intake.merge_brief(AUSTIN, {"roof_form": "a flat roof please"})
    b, _ = intake.defaults_for(b, profile())
    assert b["roof_form"] == "flat" and not locale.pitched(b) and "roof_form" not in b["auto_filled"]
    assert locale.attic_roof(b) is None and b["solar"] == "ready"
    marla = intake.merge_brief(AUSTIN, {"units": "marla", "plot": {"area_marla": 10}})
    assert locale.units(marla, profile()) == "marla"


def test_a_new_place_drops_what_was_assumed_for_the_old_one():
    old, _ = intake.defaults_for(LAHORE, lahore())
    moved = {**old, "city": "Austin", "authority": None, "bedrooms": 6, "auto_filled": [a for a in old["auto_filled"] if a != "bedrooms"]}
    b, _ = intake.defaults_for(moved, profile())
    assert b["plot"]["width_ft"] == 55 and not b.get("water_tank") and b["bedrooms"] == 6 and "drawing" not in b["spaces"]


def test_no_tank_widget_where_it_does_not_apply():
    b, _ = intake.defaults_for(AUSTIN, profile())
    assert intake.question("water_tank", b)["input"] == "text" and not intake.question("water_tank", b)["chips"]
    assert intake.question("solar", b)["input"] == "text"
    l, _ = intake.defaults_for(LAHORE, lahore())
    assert intake.question("water_tank", l)["chips"]


# --- the turn ----------------------------------------------------------------------------------------------------------------
class Mem:
    def __init__(self, monkeypatch):
        self.msgs, self.patched = [], {}
        monkeypatch.setattr(db, "list_messages", self.list_messages)
        monkeypatch.setattr(db, "add_message", self.add_message)
        monkeypatch.setattr(db, "put_message", self.add_message)
        monkeypatch.setattr(db, "patch_project", self.patch_project)

    async def list_messages(self, pid):
        return list(self.msgs)

    async def add_message(self, pid, m):
        m = db.make_message(m) if "id" not in m else m
        self.msgs.append(m)
        return m

    async def patch_project(self, pid, **f):
        self.patched.update(f)
        return f


def turn(project, *a, **k):
    async def go():
        return [ev async for ev in intake.run_turn(project, *a, **k)]
    return asyncio.run(go())


def said(evs):
    return [d for e, d in evs if e == "message" and d.get("role") == "assistant"]


def test_decide_for_me_still_needs_the_place(monkeypatch):
    Mem(monkeypatch)
    evs = turn({"id": "p1", "name": "x", "brief": None}, None, "skip_all", None)
    m = said(evs)[-1]
    assert m["field"] == "place" and "Where will the home be?" in m["text"]
    assert not any(e == "intake.complete" for e, _ in evs)


def test_a_slow_profile_never_holds_the_reply(monkeypatch):
    Mem(monkeypatch)
    monkeypatch.setattr(intake, "QUICK_S", 0.01)
    gate = {}

    async def slow(brief, force=False):
        gate["e"] = asyncio.Event()
        await gate["e"].wait()
        return profile(key=homes.key_of(brief))
    monkeypatch.setattr(homes, "profile", slow)

    async def go():
        out = []
        async for ev in intake.run_turn({"id": "p1", "name": "x", "brief": {**AUSTIN}}, None, None, ["bedrooms:3"]):
            out.append(ev)
            if ev[0] == "message" and "how homes are built in Austin" in ev[1].get("text", ""):
                assert not any(e == "intake.complete" for e, _ in out)     # the reply came first
                gate["e"].set()
        return out
    evs = asyncio.run(go())
    card = said(evs)[-1]
    assert card["understood"] and any("Gable roof" in a for a in card["understood"]["assumptions"])
    assert [e for e, _ in evs].count("intake.complete") == 1
    assert [d for e, d in evs if e == "brief"][-1]["brief"]["bedrooms"] == 3


def test_a_cached_profile_comes_with_the_reply(monkeypatch):
    m = Mem(monkeypatch)

    async def quick(brief, force=False):
        return profile(key=homes.key_of(brief))
    monkeypatch.setattr(homes, "profile", quick)
    evs = turn({"id": "p1", "name": "x", "brief": {**AUSTIN}}, None, None, ["bedrooms:3"])
    assert len(said(evs)) == 1 and said(evs)[0]["understood"] and m.patched["homes"]["form"]["type"] == "detached"


# --- everything reads it ---------------------------------------------------------------------------------------------------
def bits(brief, prof):
    b, _ = intake.defaults_for(brief, prof)
    return b, concepts.concept_prompt(b, {"direction": "a stone base"}, homes=prof)


def test_concepts_differ_in_kind():
    a, ap = bits(AUSTIN, profile())
    l, lp = bits(LAHORE, lahore())
    assert "detached house standing alone" in ap and "gable roof" in ap and "no parapet" in ap and "continuous row" not in ap
    assert "open side yards" in ap and "with open air on both sides" in ap and "neighbouring houses stand directly" not in ap
    assert "continuous row of houses" in lp and "Flat roof with a parapet and a compact mumty" in lp
    assert "boundary wall" in lp and "car porch" in lp
    assert "marla" not in ap and "mumty" not in ap


def test_street_language_no_longer_feeds_the_concepts():
    assert not hasattr(concepts, "street_language")


def test_plan_prompt_reads_the_profile():
    prof = profile()
    b, _ = intake.defaults_for(AUSTIN, prof)
    env = {"max_storeys": 3}
    text = architect._plan_prompt(b, env, None, None, prof)
    assert "THIS HOME IS IN AUSTIN" in text and "family room" in text and "`garage` room" in text and "drawing room" in text
    assert "THE ROOF IS PITCHED" in text and "another kind of house" in text
    assert "Pakistani" not in architect.PLAN_SYSTEM and "Lahore" not in architect.PLAN_SYSTEM
    l, _ = intake.defaults_for(LAHORE, lahore())
    text = architect._plan_prompt(l, env, None, None, lahore())
    assert "THE ROOF IS FLAT" in text and "keep its zoning" in text


def test_the_plan_carries_the_roof_and_the_street():
    b, _ = intake.defaults_for(AUSTIN, profile())
    plan = {"roof": {"parapet_ft": 3.5, "mumty": {"height_ft": 9}, "water_tank": {"rect": {}}, "solar": {"mode": "ready"}}, "site": {"plot": {}}}
    out = architect._clean_plan(plan, b)
    assert out["roof"]["pitched"]["form"] == "gable" and out["roof"]["pitched"]["pitch_deg"] == 32
    assert "water_tank" not in out["roof"] and "solar" not in out["roof"]
    assert out["site"]["street"]["form"] == "detached" and out["site"]["street"]["roof"]["form"] == "gable"
    assert out["site"]["boundary_wall"]["front_height_ft"] == 0 and out["site"]["city"] == "Austin"
    l, _ = intake.defaults_for(LAHORE, lahore())
    out = architect._clean_plan({"roof": {"parapet_ft": 3.5, "water_tank": {"rect": {}}}, "site": {"plot": {}, "boundary_wall": {"front_height_ft": 5}}}, l)
    assert "pitched" not in out["roof"] and "water_tank" in out["roof"] and out["site"]["street"]["form"] == "row"
    assert out["site"]["boundary_wall"]["front_height_ft"] == 5 and out["site"]["street"]["roof_tank"]


def test_build_and_photo_prompts_read_it(monkeypatch):
    b, _ = intake.defaults_for(AUSTIN, profile())
    text = architect._build_prompt({"rooms": []}, b, None, None, profile())
    assert "ROOF: pitched" in text and "central air" in text and "ceiling fan or split AC only if listed" in text
    photo = views.photo_prompt("front", False, b, profile())
    assert "Austin" in photo and "shingle gable roof" in photo and "power lines" not in photo


@pytest.mark.parametrize("kind,attached", [("row", True), ("townhouse", True), ("detached", False), ("semi-detached", False), (None, False)])
def test_only_a_row_gets_the_side_road_check(kind, attached):
    assert locale.attached({"home_form": kind}) is attached
