"""Naqsha planning rules (Part A of docs/review/architecture-rules.md) against the audited houses.

The three audited plans must fail the rules that describe the defects the user reported; the corrected few-shot example
must pass every rule; and the deterministic repairs must clear what they claim to clear.
"""
import copy
import re

import pytest

from app.compliance import lda, planning
from conftest import load


def fails(plan, brief=None):
    return {c["id"] for c in lda.check(plan, brief)["checks"] if c["status"] == "fail"}


def any_fail(ids, prefix):
    return any(i.startswith(prefix) for i in ids)


# --- the user's screenshots (1 kanal villa) --------------------------------------------------------------------------
def test_1_kanal_fails_the_rules_for_every_reported_defect(plans):
    f = fails(plans["1-kanal"])
    assert "plan.opening.same_level:f_bed3_w" in f            # P-01: "terrace" slider into a roof-level room
    assert "plan.opening.same_level:f_bath3_v" in f
    pair = lambda a, b: {f"plan.privacy.bedroom_door:{a}:{b}", f"plan.privacy.bedroom_door:{b}:{a}"}  # noqa: E731
    assert len(pair("f_bed4", "f_bed3") & f) == 1             # P-05: bedrooms open into bedrooms (one finding a pair)
    assert len(pair("f_bed5", "f_bed3") & f) == 1
    assert "plan.circulation.reach_through_private:f_bed4" in f  # P-08: reached only through Bedroom 3
    assert "plan.circulation.reach_through_private:f_bed5" in f
    assert "plan.circulation.family_route" in f               # P-10: family must cross the drawing room
    assert "plan.open_to:g_lobby:g_lounge" in f               # P-04: open_to between rooms that don't touch
    assert any_fail(f, "plan.roof.mumty")                     # P-23: roof door away from the stair arrival
    assert "room.light:f_bed3" in f                           # cross-level "daylight" no longer counts (A.0)


def test_1_kanal_door_wider_than_its_wall(plans):
    f = fails(plans["1-kanal"])
    assert "plan.opening.on_edge:f_master_d" in f             # 3.5 ft door on a 3 ft shared wall


# --- Argon v1 (real Argon output) ------------------------------------------------------------------------------------
def test_argon_v1_master_bath_and_mumty(plans):
    f = fails(plans["argon-v1"])
    assert "plan.privacy.master_bath:f_master_bath" in f      # P-06: master bath opens onto the passage
    assert any_fail(f, "plan.roof.mumty")                     # P-23: stair tower doesn't cover the stair + landing
    assert any_fail(f, "plan.stair.landing:stair_g_f")        # P-21: 0.5 ft at the foot


# --- the hand-made fixture (and old few-shot) -----------------------------------------------------------------------------
def test_contract_fixture_fails_landing_and_mumty(plans):
    if plans["fixture"] is None:
        pytest.skip("contract fixture missing")
    f = fails(plans["fixture"])
    assert any_fail(f, "plan.stair.landing")                  # P-21: 0.5 ft foot strip
    assert any_fail(f, "plan.roof.mumty")                     # P-23


# --- the journey audit's broken first floor (user's "bedrooms open into washrooms") ------------------------------------
def test_audit_v1_bedroom_through_baths_and_from_terrace(plans):
    f = fails(plans["audit-v1"])
    assert "plan.circulation.reach_through_private:f_bed3" in f   # D-1: Bedroom 3 only through baths
    assert "plan.privacy.bedroom_access:f_bed4" in f              # D-2: Bedroom 4 only from the open terrace
    assert "plan.privacy.bath_door:f_bath3" in f                  # D-3: bath with two doors (lounge + bedroom)
    assert "plan.privacy.bath_door:f_master_bath" in f            # master bath shared with Bedroom 3
    assert "plan.opening.on_edge:f_master_door" in f              # D-4: 3 ft door on a 2 ft wall
    assert "plan.opening.on_edge:g_guest_door" in f


def test_audit_v2_honours_the_brief(plans):
    brief = load("brief-audit.json")
    f = fails(plans["audit-v2"], brief)
    assert "plan.program.bedrooms" in f                          # D-9: 6 bedrooms for a brief of 5
    brief2 = {**brief, "floors": [{"level": "ground", "rooms": ["bedroom:2", "drawing"]},
                                  {"level": "first", "rooms": ["bedroom:3", "lounge", "kitchenette"]}]}
    f2 = fails(plans["audit-v2"], brief2)
    assert "plan.program.floor:first" in f2                      # 4 bedrooms upstairs instead of 3


def test_live_run_attached_baths_from_floor_program_and_bath_size():
    """A real Argon plan that passed every earlier rule; the architect's review flagged a 6×4 ft master bath and Bedroom 2
    without its own bath ("three bedrooms with attached baths upstairs" became first=bedroom:3,bath:3)."""
    f = fails(load("plan-live-run.json"), load("brief-live-run.json"))
    assert "plan.room.bath_size:f_master_bath" in f
    assert "plan.program.attached_bath:f_bed2" in f
    assert "plan.program.attached_bath:f_bed3" not in f


# --- the corrected example passes everything ------------------------------------------------------------------------------
def test_example_plan_is_clean(plans):
    rep = lda.check(plans["example"], {"bedrooms": 4, "bathrooms": 4, "solar": "ready", "water_tank": "plastic",
                                       "spaces": ["drawing", "tv_lounge", "dining", "kitchen", "car_porch:1"],
                                       "preferences": ["attached baths"]})
    bad = [c for c in rep["checks"] if c["status"] == "fail"]
    assert rep["ok"], bad
    ids = {c["id"] for c in rep["checks"] if c["status"] == "pass"}
    for rule in ("plan.rule.independence", "plan.rule.circulation", "plan.rule.stairs", "plan.rule.roof_door",
                 "plan.rule.openings", "plan.rule.brief", "plan.roof.solar"):
        assert rule in ids


# --- individual rules ------------------------------------------------------------------------------------------------------
def test_bedroom_into_kitchen_and_bath_into_kitchen(plans):
    p = copy.deepcopy(plans["example"])
    p["openings"].append({"id": "x_bad", "level": "ground", "type": "door", "at": [12, 50], "width_ft": 3, "height_ft": 7,
                          "between": ["g_guest", "g_kitchen"]})
    assert "plan.privacy.bedroom_door:g_guest:g_kitchen" in fails(p)


def test_stair_continuity_requires_roof_stair(plans):
    p = copy.deepcopy(plans["example"])
    p["stairs"] = [s for s in p["stairs"] if s["to_level"] != "roof"]
    f = fails(p)
    assert "plan.stair.continuity:first:roof" in f


def test_mumty_door_must_face_the_landing(plans):
    p = copy.deepcopy(plans["example"])
    p["roof"]["mumty"]["door_side"] = "back"   # the far (mid-landing) end
    assert "plan.roof.mumty_door" in fails(p)


def test_repair_mumty_fixes_cover_and_door(plans):
    for name in ("argon-v1", "fixture"):
        p = copy.deepcopy(plans[name])
        if p is None:
            continue
        changed = planning.repair_mumty(p)
        assert changed
        f = fails(p)
        assert not any_fail(f, "plan.roof.mumty"), (name, sorted(x for x in f if "mumty" in x), p["roof"]["mumty"])


def test_repair_stairs_fits_code_flights_in_a_big_enough_hall(plans):
    p = copy.deepcopy(plans["argon-v1"])
    assert planning.repair_stairs(p) == ["stair_g_f", "stair_f_r"]
    planning.repair_mumty(p)
    f = fails(p)
    assert not any_fail(f, "plan.stair") and not any_fail(f, "plan.roof.mumty"), sorted(f)
    # a hall that is too short is left for the planner
    q = copy.deepcopy(plans["fixture"] or plans["1-kanal"])
    planning.repair_stairs(q)
    assert any_fail(fails(q), "plan.stair.landing")


def test_normalize_slides_door_into_its_wall(plans):
    p = copy.deepcopy(plans["example"])
    door = next(o for o in p["openings"] if o["id"] == "g_guest_door")
    door["at"] = [12.6, 42.9]    # off the wall line and tight to the corner
    changed = planning.normalize(p)
    assert "g_guest_door" in changed
    assert door["at"][1] == 42.75 and door["at"][0] >= 12 + 0.3 + 1.5
    assert not any_fail(fails(p), "plan.opening")


def test_prayer_room_is_not_habitable(plans):
    p = copy.deepcopy(plans["example"])
    # carve a 6 x 6 prayer room out of the first-floor terrace, opening off the lounge
    p["rooms"] = [r for r in p["rooms"] if r["id"] != "f_terrace"]
    p["rooms"] += [{"id": "f_prayer", "level": "first", "name": "Prayer Room", "type": "prayer", "rect": {"x": 6, "y": 42.75, "w": 6, "d": 6}},
                   {"id": "f_terrace", "level": "first", "name": "Rear Terrace", "type": "terrace", "rect": {"x": 0, "y": 48.75, "w": 12, "d": 9.25}}]
    p["openings"] = [o for o in p["openings"] if o["id"] != "f_terrace_slide"]
    p["openings"].append({"id": "f_prayer_door", "level": "first", "type": "door", "at": [10, 42.75], "width_ft": 3, "height_ft": 7,
                          "between": ["f_prayer", "f_lounge"]})
    rep = lda.check(p)
    assert not [c for c in rep["checks"] if c["id"].endswith(":f_prayer") and c["id"].startswith(("room.size", "room.light"))]


def test_every_check_has_a_category_and_lda_units(plans):
    rep = lda.check(plans["1-kanal"])
    assert all(c.get("category") in ("lda", "livable") for c in rep["checks"])
    by = {c["id"]: c for c in rep["checks"]}
    assert by["setback.front"]["unit"] == "ft"
    assert by["coverage"]["unit"] == "%"
    assert by["setback.side"]["unit"] == "sides"


def test_failing_dimension_is_reported():
    plan = copy.deepcopy(load("plan-10-marla.json"))
    plan["rooms"].append({"id": "f_kit2", "level": "first", "name": "Kitchenette", "type": "kitchen", "rect": {"x": 30, "y": 50, "w": 5, "d": 10}})
    c = next(c for c in lda.check(plan)["checks"] if c["id"] == "room.size:f_kit2")
    assert c["status"] == "fail" and "wide" in c["message"] and c["unit"] == "ft" and c["value"] == 5


def test_violations_text_puts_safety_first_with_hints(plans):
    txt = lda.violations_text(lda.check(plans["1-kanal"]))
    assert txt.splitlines()[0].startswith("SAFETY")
    assert "Fix:" in txt


def test_brief_floor_tokens():
    assert planning.parse_program(["drawing", "bedroom:2", "bed_bath:1", "bath:2"]) == {"drawing": 1, "bedroom": 3, "bath": 3}


def test_malformed_plan_does_not_crash():
    out = planning.check({"rooms": [{"id": "x"}], "openings": [{"id": "o", "at": None}], "levels": []})
    assert isinstance(out, list)


# --- round 1 review fixes (architect-e2e p_cc0da837ae56 v1 and the villa sample v2) ------------------------------------------
def checks(plan, brief=None):
    return {c["id"]: c for c in lda.check(plan, brief)["checks"]}


def test_floor_program_counts_master_with_bedrooms():
    """BE-01: first=[master_bedroom:1, bedroom:2] is three bedrooms; a plan with a master and two bedrooms there passes."""
    plan = load("plan-e2e-10-marla-v1.json")
    brief = load("brief-e2e-10-marla.json")
    by = checks(plan, brief)
    assert "plan.program.floor:first" not in by
    assert by["plan.rule.brief"]["status"] == "pass"
    f = fails(plan, {"floors": [{"level": "first", "rooms": ["master_bedroom:1", "bedroom:2"]}]})
    assert not any_fail(f, "plan.program.floor")
    # a real mismatch is still caught: two masters asked for, or a fourth bedroom
    assert "plan.program.floor:first" in fails(plan, {"floors": [{"level": "first", "rooms": ["master_bedroom:2", "bedroom:1"]}]})
    assert "plan.program.floor:first" in fails(plan, {"floors": [{"level": "first", "rooms": ["master_bedroom:1", "bedroom:3"]}]})


def test_landlocked_bath_fails_and_small_vent_warns(plans):
    """BE-02: 0 sq ft of opening is a fail; under 2 sq ft a warning."""
    rep = lda.check(load("plan-e2e-10-marla-v1.json"))
    c = next(c for c in rep["checks"] if c["id"] == "room.vent:f_bath2")
    assert c["status"] == "fail" and "ventilator" in c["message"] and "ventilator" in c["fix"]
    assert "room.vent:f_bath2" in lda.violations_text(rep)
    p = copy.deepcopy(plans["example"])
    v = next(o for o in p["openings"] if o["id"] == "f_bath2_v")
    v["width_ft"], v["height_ft"] = 1.0, 1.0
    assert checks(p)["room.vent:f_bath2"]["status"] == "warn"


def test_door_under_the_mid_landing_fails():
    """BE-03: the powder-room door sits under the dog-leg's mid-landing (5.5 ft headroom)."""
    by = checks(load("plan-e2e-10-marla-v1.json"))
    c = by["plan.stair.door_under_flight:g_powder_door"]
    assert c["status"] == "fail" and "g_powder_door" in c["element_ids"]
    assert "plan.rule.stairs" not in by   # the stair family no longer shows as a pass


def test_door_on_the_foot_landing_is_fine(plans):
    p = copy.deepcopy(plans["example"])
    # a door from the stair hall's foot landing (y 28 to 31.5) into the lounge is how you reach the stair
    p["openings"].append({"id": "g_hall_door", "level": "ground", "type": "door", "at": [8, 30], "width_ft": 3, "height_ft": 7,
                          "between": ["g_stair", "g_lounge"]})
    assert not any_fail(fails(p), "plan.stair.door_under_flight")
    # the same door further along, beside the flights, opens under the stair
    p["openings"][-1]["at"] = [8, 38]
    assert "plan.stair.door_under_flight:g_hall_door" in fails(p)


def test_openings_too_close_on_one_wall():
    """BE-04: the main door 0.2 ft from the lounge window on the porch wall (the engine skipped the door)."""
    c = checks(load("plan-e2e-10-marla-v1.json"))["plan.opening.clash:g_main_door"]
    assert c["status"] == "fail" and set(c["element_ids"]) == {"g_main_door", "g_lounge_w"}


def test_two_windows_too_close_only_warn(plans):
    p = copy.deepcopy(plans["example"])
    w = next(o for o in p["openings"] if o["id"] == "g_drawing_w1")
    p["openings"].append({**w, "id": "g_drawing_w3", "at": [w["at"][0] + 4.6, w["at"][1]], "width_ft": 0.5})
    assert checks(p)["plan.opening.clash:g_drawing_w3"]["status"] == "warn"


def test_porch_sized_for_the_briefed_cars():
    """BE-05: a 16 x 18 ft porch parks one of the two briefed cars; an 18 x 18 porch leaves no walkway past two cars."""
    by = checks(load("plan-e2e-10-marla-v1.json"), load("brief-e2e-10-marla.json"))
    assert by["plan.circulation.porch:g_porch"]["status"] == "fail" and by["plan.circulation.porch:g_porch"]["value"] == 1
    v = checks(load("plan-villa-v2.json"), load("brief-villa.json"))
    assert v["plan.circulation.porch_walkway:g_porch"]["status"] == "fail"
    assert "plan.circulation.porch:g_porch" not in v
    assert planning.bays(12, 12) == 0 and planning.bays(18, 18) == 2 and planning.bays(9, 36) == 2
    assert planning.brief_cars({"spaces": ["drawing", "car_porch:2"]}) == 2


def test_porch_path_must_reach_the_main_door(plans):
    """A 13 ft porch fits a car and a walkway, but not when the main door is in the middle of its back wall (the engine then
    leaves the car out to keep the path to the door clear)."""
    brief = {"spaces": ["car_porch:1"]}
    assert not any_fail(fails(copy.deepcopy(plans["example"]), brief), "plan.circulation.porch")
    p = load("plan-porch-door-middle.json")      # 13 x 18 ft porch, 4 ft main door at its middle
    c = checks(p, brief)["plan.circulation.porch_walkway:g_porch"]
    assert c["status"] == "fail" and "g_main_door" in c["element_ids"] and "g_main_door" not in c["message"]
    next(o for o in p["openings"] if o["id"] == "g_main_door")["at"] = [27.5, 28]   # to the porch's end
    assert not any_fail(fails(p, brief), "plan.circulation.porch")


def test_doors_on_open_plan_edges_are_dropped(plans):
    p = copy.deepcopy(plans["example"])
    p["openings"].append({"id": "g_stair_arch", "level": "ground", "type": "arch", "at": [8, 33], "width_ft": 4, "height_ft": 7,
                          "between": ["g_stair", "g_lounge"]})
    assert planning.drop_open_edge_openings(p) == ["g_stair_arch"]
    assert not any(o["id"] == "g_stair_arch" for o in p["openings"])


def test_villa_dressing_off_the_lounge_and_joined_balconies():
    """BE-06: the master dressing opens only to the upper lounge; three front decks touch and join Bedroom 3 to the master."""
    f = fails(load("plan-villa-v2.json"), load("brief-villa.json"))
    assert "plan.privacy.dressing:f_master_dress" in f
    assert any_fail(f, "plan.circulation.balcony_links_bedrooms")


def test_covered_patio_gives_no_daylight():
    """BE-07: the Kitchen Patio sits under the first-floor Roof Terrace, so the kitchen gets no daylight from it."""
    by = checks(load("plan-villa-v2.json"), load("brief-villa.json"))
    assert by["plan.open_space.covered:g_patio"]["status"] == "fail"
    assert by["room.light:g_kitchen"]["status"] == "fail"
    # open the patio to the sky (cut the terrace back, leave a void over the patio) and the kitchen is lit again
    p = load("plan-villa-v2.json")
    t = next(r for r in p["rooms"] if r["id"] == "f_roof_terrace")
    t["rect"] = {"x": 17, "y": 44, "w": 7, "d": 30}
    p["rooms"].append({"id": "f_void", "level": "first", "name": "Patio Void", "type": "open_space",
                       "rect": {"x": 0, "y": 44, "w": 17, "d": 30}})
    by2 = checks(p, load("brief-villa.json"))
    assert "plan.open_space.covered:g_patio" not in by2 and by2["room.light:g_kitchen"]["status"] == "pass"


def test_messages_carry_names_not_ids():
    """BE-23: no check title or message shows a raw element id; stair checks are named by their floors."""
    idre = re.compile(r"\b[gfrs]_[a-z0-9_]+")
    for name, brief in (("plan-e2e-10-marla-v1.json", "brief-e2e-10-marla.json"), ("plan-villa-v2.json", "brief-villa.json"),
                        ("plan-1-kanal.json", None), ("plan-audit-v1.json", None), ("argon-v1-plan.json", None)):
        rep = lda.check(load(name), load(brief) if brief else None)
        for c in rep["checks"]:
            assert not idre.search(c["title"] + " " + c["message"]), (name, c["id"], c["title"], c["message"])
    by = checks(load("plan-e2e-10-marla-v1.json"), load("brief-e2e-10-marla.json"))
    assert by["stair:stair_g_f"]["title"] == "Ground → first stair"
    assert by["stair:stair_f_r"]["title"] == "First → roof stair"
    assert by["stair:stair_g_f"]["message"].startswith("19 risers of 6.95 in, 3′6″ wide")
    solar = by["plan.roof.solar"]
    assert solar["unit"] == "%" and "% kept clear (min 55%)" in solar["message"]


def test_wet_over_dry_ignores_the_kitchen_and_baths(plans):
    assert "plan.structure.wet_over_dry:f_bath3" not in checks(copy.deepcopy(plans["example"]))


# --- round 2 (architect-e2e p_13230dfcc54c: powder room onto the dining table, a walk-in dressing too small to furnish) -----
def test_powder_room_into_the_dining_fails():
    """BE2-06: the powder room's only door framed the dining table (the architect's review flagged it, then was discarded)."""
    by = checks(load("plan-e2e-4bed-v1.json"), load("brief-e2e-4bed.json"))
    c = by["plan.privacy.wc_into_dining:g_powder"]
    assert c["status"] == "fail" and set(c["element_ids"]) == {"g_powder", "g_dining"}
    assert "lobby" in c["fix"] and "lounge" in c["fix"]
    assert not re.search(r"\b[gf]_[a-z]", c["message"] + c["fix"])
    assert "plan.rule.independence" not in by     # the family no longer shows as a pass


def test_bath_into_the_dining_fails_and_off_the_lounge_passes(plans):
    p = copy.deepcopy(plans["example"])
    assert next(o for o in p["openings"] if o["id"] == "g_powder_door")["between"] == ["g_powder", "g_lounge"]
    assert "plan.privacy.wc_into_dining:g_powder" not in fails(p)
    next(r for r in p["rooms"] if r["id"] == "g_lounge")["type"] = "dining"   # the same door, now onto a dining room
    assert "plan.privacy.wc_into_dining:g_powder" in fails(p)
    next(r for r in p["rooms"] if r["id"] == "g_powder")["type"] = "bath"     # a common bath too
    assert "plan.privacy.wc_into_dining:g_powder" in fails(p)


def test_dressing_too_small_to_furnish():
    """BE2-06: a 5'6" x 4'6" walk-in dressing has no room for a 2 ft wardrobe and a 3 ft aisle."""
    c = checks(load("plan-e2e-4bed-v1.json"))["plan.room.dressing_size:f_master_dress"]
    assert c["status"] == "fail" and c["value"] == 4.5 and c["limit"] == 5.0 and c["unit"] == "ft"
    assert "4′6″ wide" in c["message"] and "f_master_dress" not in c["message"]


def test_dressing_size_thresholds(plans):
    p = copy.deepcopy(plans["example"])
    d = next(r for r in p["rooms"] if r["id"] == "f_master_dress")   # 6 x 5 ft: passes
    assert "plan.room.dressing_size:f_master_dress" not in checks(p)
    d["rect"]["w"], d["rect"]["d"] = 5.0, 5.25                         # the 10 marla sample's size: still passes
    assert "plan.room.dressing_size:f_master_dress" not in checks(p)
    d["rect"]["w"], d["rect"]["d"] = 6.0, 4.75                         # 28.5 sq ft but only 4'9" across
    c = checks(p)["plan.room.dressing_size:f_master_dress"]
    assert c["status"] == "fail" and c["unit"] == "ft" and c["limit"] == 5.0 and c["value"] == 4.75
    d["rect"]["w"], d["rect"]["d"] = 4.5, 8.0                          # 36 sq ft, still only 4'6" across
    assert checks(p)["plan.room.dressing_size:f_master_dress"]["status"] == "fail"


def test_plan_prompt_states_the_dining_and_dressing_rules():
    from app.agents import architect
    s = " ".join(architect.PLAN_SYSTEM.split())
    assert "never opens into the dining room" in s
    assert "at least 5 ft across and 25 sq ft" in s


# --- round 3: a WC in view of the main door (architect-e2e p_cc2b1126c4d1 v_57f77f161634), the porch as the engine parks it ----
def entry_plan(powder: tuple, door: tuple) -> dict:
    """A 10 ft wide lobby behind a porch, the main door in the middle of its front wall at (5, 6), and a powder room at
    `powder` (x, y, w, d) whose door is at `door`."""
    x, y, w, d = powder
    return {"site": {"plot": {"width_ft": 30, "depth_ft": 40}},
            "levels": [{"id": "ground", "index": 0, "elevation_ft": 1.5, "height_ft": 11, "name": "Ground Floor"},
                       {"id": "roof", "index": 1, "elevation_ft": 12.5, "height_ft": 3.5, "name": "Roof"}],
            "rooms": [{"id": "g_porch", "level": "ground", "type": "porch", "name": "Porch", "rect": {"x": 0, "y": 0, "w": 10, "d": 6}},
                      {"id": "g_lobby", "level": "ground", "type": "lobby", "name": "Entrance Lobby",
                       "rect": {"x": 0, "y": 6, "w": 10, "d": 12}},
                      {"id": "g_powder", "level": "ground", "type": "powder", "name": "Powder Room",
                       "rect": {"x": x, "y": y, "w": w, "d": d}}],
            "openings": [{"id": "g_main_door", "level": "ground", "type": "main_door", "between": ["g_lobby", "g_porch"],
                          "at": [5, 6], "width_ft": 3.5, "height_ft": 7.5},
                         {"id": "g_powder_door", "level": "ground", "type": "door", "between": ["g_powder", "g_lobby"],
                          "at": list(door), "width_ft": 2.5, "height_ft": 7}]}


def wc_check(plan):
    return next((c for c in planning.check(plan) if c["id"] == "plan.privacy.wc_on_entry:g_powder"), None)


def test_wc_on_entry_fails_when_the_powder_door_faces_the_main_door():
    """BE3-05: the main door (13, 25.75) and the Powder Room door (24, 25.75) share one axis across an 11 ft x 4'6" lobby."""
    by = checks(load("plan-e2e-powder-entry.json"), load("brief-e2e-powder-entry.json"))
    c = by["plan.privacy.wc_on_entry:g_powder"]
    assert c["status"] == "fail" and c["message"].startswith("From the main door you look straight into the Powder Room")
    assert "faces the main door across the Entrance Lobby" in c["message"] and "side wall" in c["fix"]
    assert not re.search(r"\b[gfr]_[a-z]", c["message"] + c["fix"] + c["title"])
    assert {"g_powder", "g_powder_door", "g_main_door"} <= set(c["element_ids"])
    assert "plan.rule.independence" not in by
    lobby = by["plan.circulation.lobby_crowded:g_lobby"]   # 4'6" deep with four doors
    assert lobby["status"] == "warn" and "4′6″ deep" in lobby["message"]
    # the staged samples and the 4-bed fixture: no WC in view of the main door
    for plan, brief in (("plan-sample-10-marla-r2.json", "brief-sample-10-marla.json"),
                        ("plan-sample-villa-r2.json", "brief-sample-villa.json"),
                        ("plan-e2e-4bed-v1.json", "brief-e2e-4bed.json"), ("plan-e2e-10-marla-v1.json", "brief-e2e-10-marla.json"),
                        ("plan-villa-v2.json", "brief-villa.json")):
        ids = {c["id"] for c in lda.check(load(plan), load(brief) if brief else None)["checks"]}
        assert not any(i.startswith(("plan.privacy.wc_on_entry", "plan.circulation.lobby_crowded")) for i in ids), plan


def test_the_few_shot_example_keeps_the_wc_out_of_view(plans):
    """The plan every design starts from: its powder room opens off the lounge 48° off the main door's line, 22 ft away."""
    assert not any(c["id"].startswith("plan.privacy.wc_on_entry") for c in planning.check(plans["example"]))


def test_wc_on_entry_geometry():
    across = wc_check(entry_plan((3, 18, 5, 5), (5.5, 18)))          # on the back wall, the spans overlap
    assert across and "faces the main door" in across["message"]
    off = wc_check(entry_plan((6, 18, 4, 5), (8.75, 18)))             # back wall, out of the door's span but 17° off its line
    assert off and "almost in line" in off["message"]
    cone = wc_check(entry_plan((10, 13, 5, 5), (10, 16.5)))           # a side wall 10.5 ft in: 25° off the main door's line
    assert cone and "almost in line" in cone["message"]
    assert wc_check(entry_plan((10, 6, 5, 5), (10, 8))) is None       # a side wall by the door: 68° off, out of sight
    assert wc_check(entry_plan((10, 10, 5, 5), (10, 13.5))) is None   # a side wall 7.5 ft in: 34° off its line
    far = entry_plan((10, 13, 5, 5), (10, 16.5))                      # beyond 15 ft along a deeper lobby: out of the cone
    next(r for r in far["rooms"] if r["id"] == "g_lobby")["rect"]["d"] = 30
    next(r for r in far["rooms"] if r["id"] == "g_powder")["rect"]["y"] = 28
    next(o for o in far["openings"] if o["id"] == "g_powder_door")["at"] = [10, 30]
    assert wc_check(far) is None
    attached = entry_plan((3, 18, 5, 5), (5.5, 18))                   # a bath off a bedroom, not off the lobby: not this rule
    next(r for r in attached["rooms"] if r["id"] == "g_lobby")["type"] = "corridor"
    assert wc_check(attached)                                         # still the room behind the main door


def test_plan_prompt_states_the_wc_and_motorbike_rules():
    from app.agents import architect
    s = " ".join(architect.PLAN_SYSTEM.split())
    assert "guests must never look into a WC" in s and "within about 30° of the main door's line within 15 ft" in s
    assert "3 × 7 ft motorbike bay" in s and "14 ft deep only where the porch opens straight onto the driveway" in s


def test_porch_counts_bays_as_the_engine_parks_them(plans):
    """BE3-06: the engine lets a car's tail stand up to 4 ft out over the porch's open drive-in edge, so a 17' x 16' porch parks
    one car (p_13230dfcc54c v1, whose as-built note says 1 of 2), not none."""
    c = checks(load("plan-e2e-4bed-v1.json"), load("brief-e2e-4bed.json"))["plan.circulation.porch:g_porch"]
    assert c["status"] == "fail" and c["value"] == 1 and c["limit"] == 2
    assert "parks 1 of the 2 cars" in c["message"] and "14′ deep where its tail can stand out over the driveway" in c["message"]
    assert planning.edge_bays(17, 16, 4) == 1 and planning.edge_bays(17, 16) == 0 and planning.edge_bays(18, 14, 4) == 2
    assert planning.edge_bays(18, 13.5, 4) == 0 and planning.edge_bays(9, 36) == 2 and planning.edge_bays(8.5, 20) == 0
    ix = planning.PlanIndex(plans["example"])
    assert planning.car_edge(ix, "g_porch") == ("front", 4.0, "driveway")
    # a porch whose front is only 2 ft from the road: the tail can't stand out 4 ft, so 15 ft deep parks nothing (16 ft would)
    p = copy.deepcopy(plans["example"])
    next(r for r in p["rooms"] if r["id"] == "g_porch")["rect"].update(y=2.3, d=15)
    next(r for r in p["rooms"] if r["id"] == "g_driveway")["rect"].update(d=2.3)
    ix = planning.PlanIndex(p)
    assert planning.car_edge(ix, "g_porch")[1] == pytest.approx(2.0)
    assert checks(p, {"spaces": ["car_porch:1"]})["plan.circulation.porch:g_porch"]["value"] == 0


def test_porch_needs_a_motorbike_bay_when_the_brief_has_one(plans):
    by = checks(load("plan-e2e-powder-entry.json"), load("brief-e2e-powder-entry.json"))   # "porch for 1 car plus motorbike"
    c = by["plan.circulation.porch_bike:g_porch"]
    assert c["status"] == "warn" and "no 3 × 7 ft space left for the motorbike" in c["message"]
    assert not re.search(r"\b[gfr]_[a-z]", c["message"] + c["fix"])
    assert planning.brief_bike({"preferences": ["porch for 1 car plus a motorbike"]})
    assert planning.brief_bike({"spaces": ["car_porch:1", "motorbike"]}) and not planning.brief_bike({"spaces": ["car_porch:2"]})
    p = copy.deepcopy(plans["example"])                               # 13' x 18' porch, 1 car: no room for the bike
    assert "plan.circulation.porch_bike:g_porch" in checks(p, {"spaces": ["car_porch:1", "motorbike"]})
    assert "plan.circulation.porch_bike:g_porch" not in checks(p, {"spaces": ["car_porch:1"]})
    next(r for r in p["rooms"] if r["id"] == "g_porch")["rect"]["w"] = 16   # 3 ft wider: the bike sits beside the walkway
    assert "plan.circulation.porch_bike:g_porch" not in checks(p, {"spaces": ["car_porch:1", "motorbike"]})


# --- round 4: one honest report ------------------------------------------------------------------------------------------
def test_an_upper_open_space_over_a_court_is_a_void_not_a_room(plans):
    """BE-F4: the villa's first-floor Light Court Void sits over the ground-floor patio: a hole in the floor with a railing,
    so it needs no way in (the engine's definition, EN-F3)."""
    plan, brief = load("plan-sample-villa-r3.json"), load("brief-sample-villa-r3.json")
    ix = planning.PlanIndex(plan)
    assert planning.is_void(ix, "f_patio_void")
    assert not planning.is_void(ix, "g_patio") and not planning.is_void(ix, "g_side")    # ground courts are courts
    assert "plan.circulation.unreachable:f_patio_void" not in checks(plan, brief)
    # an upper open space over a room (not over a court) is still a floor that needs a way in
    p = copy.deepcopy(plan)
    next(r for r in p["rooms"] if r["id"] == "g_patio")["type"] = "store"
    assert not planning.is_void(planning.PlanIndex(p), "f_patio_void")


def test_the_server_reports_the_livable_rows_the_app_promises(plans):
    """BE-F4: livable.railings, livable.doors and livable.paths (web/src/app/plan/compliance.ts, same ids and titles) are in
    every report, so the server and the app count the same rows."""
    rep = lda.check(load("plan-sample-10-marla-r3.json"), load("brief-sample-10-marla-r3.json"))
    by = {c["id"]: c for c in rep["checks"]}
    assert by["livable.railings"]["title"] == "Every stair edge and void has a railing" and by["livable.railings"]["status"] == "pass"
    assert by["livable.doors"]["title"] == "Doors are clear of furniture" and by["livable.doors"]["status"] == "pass"
    assert by["livable.paths"]["title"] == "A clear 3 ft path to every door" and by["livable.paths"]["status"] == "pass"
    assert all(by[k]["category"] == "livable" for k in ("livable.railings", "livable.doors", "livable.paths"))
    p = copy.deepcopy(plans["example"])
    corr = next(r for r in p["rooms"] if r.get("type") in ("corridor", "lobby"))
    corr["rect"]["w" if corr["rect"]["w"] < corr["rect"]["d"] else "d"] = 2.5
    c = checks(p)["livable.paths"]
    assert c["status"] == "fail" and c["message"].endswith("is 2′6″ wide (needs 3 ft).")


def test_counts_never_take_a_warning_for_a_pass():
    """BE-F4: one status definition: a warning is not a pass, and review notes are counted on their own."""
    rep = {"checks": [{"id": "coverage", "category": "lda", "status": "pass"},
                      {"id": "parapet", "category": "lda", "status": "warn"},
                      {"id": "livable.doors", "category": "livable", "status": "pass"},
                      {"id": "plan.structure.wet_over_dry:f_bath2", "category": "livable", "status": "warn"},
                      {"id": "review.1", "category": "livable", "status": "warn"},
                      {"id": "review.2", "category": "livable", "status": "warn"}]}
    c = lda.counts(rep)
    assert c["lda"] == {"pass": 1, "total": 2} and c["livable"] == {"pass": 1, "total": 2} and c["review"] == 2
    assert c["warn"] == 2 and c["fail"] == 0
    assert lda.status_line(rep) == "1/2 LDA · 1/2 livable · 2 architect's notes"
    assert lda.status_line({"checks": rep["checks"][:4]}) == "1/2 LDA · 1/2 livable"


def test_a_plan_outside_lahore_is_not_held_to_lahore_rules(plans):
    p = copy.deepcopy(plans["example"])
    p["site"]["authority"] = "COA"
    rep = lda.check(p, {"bedrooms": 4, "bathrooms": 4})
    assert not any(c["id"] == "services.water_tank" for c in rep["checks"])
    words = " ".join(f"{c['message']} {c['rule_ref']}" for c in rep["checks"])
    assert "LDA" not in words and "marla" not in words
