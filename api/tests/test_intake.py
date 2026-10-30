"""The setup conversation's deterministic parts: the question bank, widget answers, "Don't assume", storeys within the
authority, rooms on every floor, preferences that can be removed, and the auto name. The model is never called here."""
import asyncio

import pytest

from app.agents import intake
from app.store import db


def run(coro):
    return asyncio.run(coro)


class Msgs:
    """messages + project patching, in memory."""

    def __init__(self, monkeypatch):
        self.msgs, self.patched = [], {}
        monkeypatch.setattr(db, "list_messages", self.list_messages)
        monkeypatch.setattr(db, "add_message", self.add_message)
        monkeypatch.setattr(db, "put_message", self.put_message)
        monkeypatch.setattr(db, "patch_project", self.patch_project)

    async def list_messages(self, pid):
        return list(self.msgs)

    async def add_message(self, pid, m):
        m = db.make_message(m)
        self.msgs.append(m)
        return m

    async def put_message(self, pid, m):
        self.msgs.append(m)
        return m

    async def patch_project(self, pid, **f):
        self.patched.update(f)
        return f


def turn(project, message=None, action=None, chips=None):
    async def go():
        return [ev async for ev in intake.run_turn(project, message, action, chips)]
    return run(go())


def last_msg(evs):
    return [d for e, d in evs if e == "message" and d.get("role") == "assistant"][-1]


def brief_of(evs):
    return [d for e, d in evs if e == "brief"][-1]["brief"]


def full_brief(**kw):
    b = intake.empty_brief()
    b.update(authority="LDA", plot={"width_ft": 35, "depth_ft": 65, "area_marla": 10.1, "corner": False}, corner_stated=True,
             facing="N", storeys=2, bedrooms=4, bathrooms=5, spaces=["drawing", "kitchen"], style="Modern Contemporary",
             water_tank="concrete", solar="ready", floors=[{"level": "ground", "rooms": ["drawing", "kitchen"]},
                                                           {"level": "first", "rooms": ["bedroom:3", "bath:3"]}])
    b.update(kw)
    return b


# --- BE-12: storeys within the authority ------------------------------------------------------------------------------------------
def test_dha_storeys_are_capped_with_a_reason():
    q = intake.question("storeys", {"authority": "DHA"})
    assert [c["value"] for c in q["chips"]] == ["storeys:1", "storeys:2"]
    assert q["chips"][-1]["hint"] == "DHA allows ground + first, plus a basement"
    lq = intake.question("storeys", {"authority": "LDA", "plot": {"width_ft": 35, "depth_ft": 65, "area_marla": 10.1}})
    assert [c["value"] for c in lq["chips"]][-1] == "storeys:3" and "LDA" in lq["chips"][-1]["hint"]
    b, said = intake.clamp_storeys({"authority": "DHA", "storeys": 3, "floors": [
        {"level": "ground", "rooms": ["drawing"]}, {"level": "first", "rooms": ["bedroom:2"]}, {"level": "second", "rooms": ["bedroom:1"]}]})
    assert b["storeys"] == 2 and said.startswith("DHA allows ground + first, plus a basement, so I've kept it to 2 storeys.")
    assert [f["level"] for f in b["floors"]] == ["ground", "first"] and b["floors"][1]["rooms"] == ["bedroom:3"]
    assert intake.clamp_storeys({"authority": "LDA", "storeys": 3, "plot": {"width_ft": 35, "depth_ft": 65, "area_marla": 10.1}})[1] is None


def test_dha_storeys_chip_is_clamped_in_the_turn(monkeypatch):
    m = Msgs(monkeypatch)
    p = {"id": "p1", "name": "Untitled home", "brief": {**intake.empty_brief(), "authority": "DHA",
                                                        "plot": {"width_ft": 35, "depth_ft": 65, "area_marla": 10.1, "corner": False}}}
    evs = turn(p, chips=["storeys:3"])
    assert brief_of(evs)["storeys"] == 2
    assert last_msg(evs)["text"].startswith("DHA allows ground + first")
    assert m.patched["brief"]["storeys"] == 2


# --- BE-13: an added storey needs its rooms -----------------------------------------------------------------------------------------
def test_new_storey_without_rooms_keeps_setup_open():
    b = full_brief(storeys=3)
    assert intake.floors_missing(b) == ["second"]
    assert "floors" in intake.missing(b)                       # a design needs them, so Naqsha places those rooms
    q = intake.question("floors", b)
    assert q["text"].startswith("What goes on the second floor?") and q["input"] == "floors"
    assert "floors" not in intake.missing({**b, "auto_filled": ["floors"]})
    assert "floors" in intake.defaults_for(b)[0]["auto_filled"]
    assert not intake.floors_missing(full_brief()) and not intake.to_ask(full_brief())


# --- BE-14: preferences can be removed ---------------------------------------------------------------------------------------------
def test_patch_replaces_preferences_and_agent_can_drop_one():
    b = {**intake.empty_brief(), "preferences": ["open kitchen", "a separate dirty kitchen", "parents downstairs"]}
    assert intake.merge_brief(b, {"preferences": ["open kitchen"]}, prefs_mode="replace")["preferences"] == ["open kitchen"]
    assert intake.merge_brief(b, {"preferences": []}, prefs_mode="replace")["preferences"] == []
    assert intake.merge_brief(b, {"preferences": ["x"]})["preferences"][-1] == "x"          # the agent still appends
    out = intake.merge_brief(b, {"remove_preferences": ["dirty kitchen"]})
    assert out["preferences"] == ["open kitchen", "parents downstairs"]


# --- BE-15: "Don't assume" clears the field and asks again -----------------------------------------------------------------------------
def test_dont_assume_clears_and_asks(monkeypatch):
    Msgs(monkeypatch)
    b = full_brief(auto_filled=["facing"])
    assert intake.fact_field(b, "front faces north.") == "facing"
    evs = turn({"id": "p1", "name": "x", "brief": b, "intake_complete": True}, message="Don't assume: front faces north.")
    nb = brief_of(evs)
    assert nb["facing"] is None and "facing" not in nb["auto_filled"]
    m = last_msg(evs)
    assert m["field"] == "facing" and "Which way does the front" in m["text"] and m["chips"]
    # the chip form does the same
    evs = turn({"id": "p1", "name": "x", "brief": b, "intake_complete": True}, chips=["unset:facing"])
    assert brief_of(evs)["facing"] is None and last_msg(evs)["field"] == "facing"


# --- BE-16: corner or mid-row ----------------------------------------------------------------------------------------------------
def test_corner_is_assumed_unless_stated():
    b = intake.merge_brief(intake.empty_brief(), {"plot": {"width_ft": 35, "depth_ft": 65}})
    assert b["corner_stated"] is False and intake.to_ask(b) == ["place"]    # the place is all that is asked
    q = intake.question("corner", b)                                        # reopened by the family ("Don't assume")
    assert q["text"] == "Is it a corner plot?" and {c["value"] for c in q["chips"]} == {"corner:true", "corner:false"}
    assert intake.question("corner", {**b, "home_form": "row"})["text"] == "Corner or mid-row?"
    said = intake.merge_brief(b, {"plot": {"corner": False}})
    assert said["corner_stated"] is True
    assert "Mid-row plot, neighbours on both sides" in intake.understood(said)["preferences"]
    skipped = intake.skip_field(b, "corner")
    assert "corner" in skipped["auto_filled"] and not skipped.get("corner_open")
    assert "Mid-row plot, neighbours on both sides" in intake.understood(skipped)["assumptions"]
    d, _ = intake.defaults_for(b)
    assert "corner" in d["auto_filled"]


# --- BE-17: copy -------------------------------------------------------------------------------------------------------------------
def test_skip_ack_and_roof_ack_and_suggestions():
    b = full_brief(facing="N")
    assert intake._ack_skip("facing", b) == "I've chosen north for the facing."
    ack = intake._ack({"solar": "ready"}, b)
    assert "concrete tank" in ack and "solar" in ack
    s = intake._complete_suggestions({}, full_brief(spaces=["prayer"], preferences=["open kitchen"]))
    assert "Add a prayer room" not in s and "Make the kitchen open" not in s and s[0] == "Show me concepts"
    assert "Here's what I understood" in intake._complete_text({}, b) and "Show me concepts" in intake._complete_text({}, b)


# --- BE-19: one "Decide for me" on the rooms question -----------------------------------------------------------------------------------
def test_skip_rooms_decides_floors_too(monkeypatch):
    Msgs(monkeypatch)
    b = full_brief(bedrooms=None, bathrooms=None, floors=[], spaces=[], water_tank=None, solar=None, facing=None)
    p = {"id": "p1", "name": "x", "brief": b}
    m = Msgs(monkeypatch)
    m.msgs.append(db.make_message({"role": "assistant", "text": "How many bedrooms?", "field": "bedrooms"}))
    evs = turn(p, action="skip_question")
    nb = brief_of(evs)
    assert nb["bedrooms"] and "floors" in nb["auto_filled"]
    assert nb["facing"] and "facing" in nb["auto_filled"]           # no more questions: the rest is assumed
    msg = last_msg(evs)
    assert not msg.get("field") and "I'll place the rooms on each floor" in msg["understood"]["assumptions"]


# --- BE-20: Start with questions ------------------------------------------------------------------------------------------------
def test_start_asks_where_and_nothing_else(monkeypatch):
    Msgs(monkeypatch)
    evs = turn({"id": "p1", "name": "Untitled home", "brief": None}, action="start")
    m = last_msg(evs)
    assert m["text"].startswith("Where will the home be?") and "any order" in m["text"]
    assert m["field"] == "place" and not m.get("chips") and not m.get("input")


# --- BE-27: the auto name follows the plot ---------------------------------------------------------------------------------------------
def test_auto_name_follows_plot_until_renamed():
    b12 = {"plot": {"width_ft": 40, "depth_ft": 68, "area_marla": 12.1}, "scheme": "Johar Town", "units": "marla"}
    assert intake.auto_name({"name": "10 marla home, Johar Town", "auto_named": True}, b12) == "12 marla home, Johar Town"
    assert intake.auto_name({"name": "10 marla house, Johar Town"}, b12) == "12 marla home, Johar Town"   # older auto names
    assert intake.auto_name({"name": "Our home", "auto_named": False}, b12) is None
    assert intake.auto_name({"name": "Sample · 10 marla modern home, Johar Town", "auto_named": False}, b12) is None
    assert intake.auto_name({"name": "12 marla home, Johar Town", "auto_named": True}, b12) is None


@pytest.mark.parametrize("text,field", [("Two storeys", "storeys"), ("4 bedrooms", "bedrooms"), ("Concrete water tank in the stair tower", "water_tank"),
                                        ("Mid-row plot, neighbours on both sides", "corner"), ("I'll place the rooms on each floor", "floors")])
def test_fact_field_maps_card_lines(text, field):
    assert intake.fact_field(full_brief(), text) == field


# --- BE2-04: "You said" lists only what the family said ------------------------------------------------------------------------
def you_said(b):
    """The app's "You said" tokens (web/src/app/setup/Understood.tsx saidFacts), both as shipped (it hides a fact whose key
    is in auto_filled) and as hinted for round 2 (corner needs corner_stated === true, the porch checks "spaces")."""
    auto = set(b.get("auto_filled") or [])
    porch = next((s for s in b.get("spaces") or [] if s.startswith("car_porch")), None)
    shipped, hinted = set(), set()
    if b.get("plot") and "plot" not in auto:
        if "corner" not in auto:
            shipped.add("corner")
        if b.get("corner_stated") is True:
            hinted.add("corner")
    if b.get("storeys") and "storeys" not in auto:
        shipped.add("storeys")
        hinted.add("storeys")
    if porch and "porch" not in auto:
        shipped.add("porch")
    if porch and "spaces" not in auto and "porch" not in auto:
        hinted.add("porch")
    return shipped, hinted


def test_dha_three_storeys_mid_row_and_default_porch_are_not_you_said():
    """'1 kanal plot in DHA Phase 6 Lahore, 3 storeys, 5 bedrooms': no corner said, storeys capped, porch defaulted."""
    b = intake.merge_brief(intake.empty_brief(), {"authority": "DHA", "scheme": "DHA Phase 6", "plot": {"width_ft": 50, "depth_ft": 90},
                                                  "storeys": 3, "bedrooms": 5}, spaces_mode="union")
    b, push = intake.clamp_storeys(b)
    assert push and b["storeys"] == 2 and b["storeys_asked"] == 3
    assert {"corner", "storeys"} <= set(b["auto_filled"]) and b["corner_stated"] is False
    for said in you_said(b):
        assert not said & {"corner", "storeys"}
    card = intake.understood(b)
    assert "Kept to 2 storeys: DHA's limit" in card["assumptions"]
    assert "Mid-row plot, neighbours on both sides" in card["assumptions"]
    assert not any("storey" in p.lower() or "mid-row" in p.lower() for p in card["preferences"])
    assert not intake.to_ask(b)                                  # an assumption: never asked
    # completion fills the default spaces: the 2-car porch is Naqsha's choice
    d, _ = intake.defaults_for(b)
    done = intake.merge_brief(b, {"spaces": d["spaces"]}, ["spaces"])
    assert "car_porch:2" in done["spaces"] and {"spaces", "porch"} <= set(done["auto_filled"])
    for said in you_said(done):
        assert "porch" not in said
    card = intake.understood(done)
    assert not any("porch" in p for p in card["preferences"]) and any("2-car porch" in a for a in card["assumptions"])
    # "Don't assume: Kept to 2 storeys: DHA's limit" asks the storeys again
    assert intake.fact_field(done, "Kept to 2 storeys: DHA's limit") == "storeys"
    cleared, _ = intake.unset_fields(done, ["storeys"])
    assert cleared["storeys"] is None and "storeys_asked" not in cleared and "storeys" not in cleared["auto_filled"]


def test_corner_said_skipped_and_reasked():
    b = intake.merge_brief(intake.empty_brief(), {"plot": {"width_ft": 35, "depth_ft": 65}})
    assert "corner" in b["auto_filled"] and b["corner_open"]
    said = intake.merge_brief(b, {"plot": {"corner": False}})          # the "Mid-row" chip
    assert said["corner_stated"] is True and "corner" not in said["auto_filled"] and "corner_open" not in said
    assert all("corner" in s for s in you_said(said))
    corner = intake.merge_brief(b, {"plot": {"corner": True}})
    assert "Corner plot" in intake.understood(corner)["preferences"]
    skipped = intake.skip_field(b, "corner")
    assert not any("corner" in s for s in you_said(skipped))
    resized = intake.merge_brief(skipped, {"plot": {"width_ft": 40, "depth_ft": 70}})   # a new size: not asked again
    assert not resized.get("corner_open") and resized["corner_stated"] is False
    again, _ = intake.unset_fields(said, ["corner"])                   # "Don't assume: Mid-row plot"
    assert again["corner_open"] and "corner" in again["auto_filled"]
    assert "Mid-row plot, neighbours on both sides" in intake.understood({**full_brief(), "corner_stated": None})["assumptions"]


def test_corner_chip_in_the_turn_is_said(monkeypatch):
    Msgs(monkeypatch)
    b = intake.merge_brief(intake.empty_brief(), {"authority": "LDA", "plot": {"width_ft": 35, "depth_ft": 65}})
    evs = turn({"id": "p1", "name": "x", "brief": b}, chips=["corner:false"])
    nb = brief_of(evs)
    assert nb["corner_stated"] is True and "corner" not in nb["auto_filled"]
    assert not last_msg(evs).get("field") and last_msg(evs)["understood"]          # no next question: the card


def test_brief_panel_round_trip_keeps_assumptions():
    """The panel PATCHes the whole brief back: an unchanged plot is not 'You said: Mid-row', an unchanged storey count keeps
    the cap, and a confirmed fact becomes said."""
    b = intake.merge_brief(intake.empty_brief(), {"authority": "DHA", "plot": {"width_ft": 50, "depth_ft": 90}, "storeys": 3,
                                                  "bedrooms": 5, "style": "Spanish"})
    b, _ = intake.clamp_storeys(b)
    d, _ = intake.defaults_for(b)
    b = intake.merge_brief(b, {"spaces": d["spaces"]}, ["spaces"])
    sent = {**b, "style": "Classic"}                                    # the style changed, nothing else
    out = intake.merge_brief(b, intake.panel_patch(b, sent), [], spaces_mode="replace", prefs_mode="replace")
    out, _ = intake.clamp_storeys(out)
    assert out["style"] == "Classic" and out["corner_stated"] is False
    assert {"corner", "storeys", "porch", "spaces"} <= set(out["auto_filled"]) and intake.storeys_kept(out)
    # the family confirms "Mid-row" and "2 storeys" in the panel (their marks leave auto_filled)
    sent = {**b, "auto_filled": [a for a in b["auto_filled"] if a not in ("corner", "storeys")]}
    out = intake.merge_brief(b, intake.panel_patch(b, sent), [], spaces_mode="replace", prefs_mode="replace")
    out, _ = intake.clamp_storeys(out)
    assert out["corner_stated"] is True and "corner" not in out["auto_filled"]
    assert out["storeys"] == 2 and "storeys" not in out["auto_filled"] and not intake.storeys_kept(out)
    # a corner the panel changes is said
    sent = {**b, "plot": {**b["plot"], "corner": True}}
    out = intake.merge_brief(b, intake.panel_patch(b, sent), [], spaces_mode="replace", prefs_mode="replace")
    assert out["plot"]["corner"] is True and out["corner_stated"] is True and "corner" not in out["auto_filled"]
    # server-kept marks never come from a patch
    assert "corner_stated" not in intake.merge_brief(intake.empty_brief(), {"corner_stated": True})


# --- BE3-03: at the authority's storey limit, no enclosed room on the roof ------------------------------------------------------
DHA_FLOORS = ["floor:ground=drawing,dining,kitchen,dirty_kitchen,lounge,store,bed", "floor:first=master,bed:3,lounge,balcony",
              "floor:roof=laundry"]


def dha_brief():
    """'1 kanal DHA Phase 6, 3 storeys': kept to DHA's 2."""
    b = intake.merge_brief(intake.empty_brief(), {"authority": "DHA", "scheme": "DHA Phase 6", "plot": {"width_ft": 50, "depth_ft": 90},
                                                  "storeys": 3, "bedrooms": 5}, spaces_mode="union")
    return intake.clamp_storeys(b)[0]


def test_roof_laundry_moves_down_at_the_storey_cap():
    patch, _ = intake.parse_chips(DHA_FLOORS)
    b = intake.merge_brief(dha_brief(), patch, spaces_mode="replace")
    out, said = intake.clamp_storeys(b)
    assert said == "DHA counts a roof room as a storey, so I've put the laundry by the dirty kitchen."
    levels = {f["level"]: f["rooms"] for f in out["floors"]}
    assert "laundry" in levels["ground"] and "roof" not in levels
    assert intake.clamp_storeys(out) == (out, None)                     # idempotent: said once
    # open things stay on the roof; a gym or kitchenette goes to the top floor, a store or servant room downstairs
    b2 = intake.merge_brief(dha_brief(), {"floors": ["ground=drawing,kitchen,lounge", "first=bedroom:3",
                                                     "roof=terrace,gym,store,kitchenette"]}, spaces_mode="replace")
    out2, said2 = intake.clamp_storeys(b2)
    lv = {f["level"]: f["rooms"] for f in out2["floors"]}
    assert lv["roof"] == ["terrace"] and "store" in lv["ground"] and {"gym", "kitchenette"} <= set(lv["first"])
    assert said2 == ("DHA counts a roof room as a storey, so I've put the store by the kitchen and put the gym and the "
                     "kitchenette on the first floor.")


def test_roof_laundry_stays_under_the_storey_cap():
    """LDA 10 marla allows 3 storeys: a 2-storey house keeps its roof laundry (it is the third storey, within the limit)."""
    b = full_brief(floors=[{"level": "ground", "rooms": ["drawing", "kitchen"]}, {"level": "first", "rooms": ["bedroom:3", "bath:3"]},
                           {"level": "roof", "rooms": ["laundry"]}])
    out, said = intake.clamp_storeys(b)
    assert said is None and out["floors"][-1] == {"level": "roof", "rooms": ["laundry"]}
    # the same house at LDA's limit of 3 storeys: the laundry comes down
    b3 = {**b, "storeys": 3, "floors": b["floors"][:2] + [{"level": "second", "rooms": ["bedroom:1"]}, b["floors"][2]]}
    out3, said3 = intake.clamp_storeys(b3)
    assert said3.startswith("LDA counts a roof room as a storey") and "roof" not in {f["level"] for f in out3["floors"]}


def test_dha_repro_use_these_floors_then_decide_everything(monkeypatch):
    """Retest #4: '1 kanal DHA Phase 6, 3 storeys' -> 'Use these floors' -> 'Decide everything for me' leaves no roof room."""
    Msgs(monkeypatch)
    p = {"id": "p1", "name": "x", "brief": dha_brief()}
    evs = turn(p, chips=DHA_FLOORS)
    b = brief_of(evs)
    assert "DHA counts a roof room as a storey, so I've put the laundry by the dirty kitchen." in last_msg(evs)["text"]
    p["brief"] = b
    evs = turn(p, action="skip_all")
    b = brief_of(evs)
    assert b["storeys"] == 2 and not [f for f in b["floors"] if f["level"] == "roof" and f["rooms"]]
    assert any("laundry" in f["rooms"] for f in b["floors"] if f["level"] == "ground")


def test_plan_prompt_says_the_roof_is_open_at_the_cap():
    from app.agents import architect
    from app.compliance import lda
    s = " ".join(architect.PLAN_SYSTEM.split())
    assert "the roof holds only the stair tower, the water tank, solar and open terraces" in s
    assert architect.storey_limit_note({"storeys": 2}, lda.envelope(50, 90, "DHA", False)).startswith("STOREY LIMIT")
    assert architect.storey_limit_note({"storeys": 2}, lda.envelope(35, 65, "LDA", False)) == ""


# --- BE3-07: a stair to the roof is not a roof terrace ---------------------------------------------------------------------------
def test_floor_terrace_is_a_terrace_on_that_floor():
    b = intake.merge_brief(intake.empty_brief(), {"floors": ["ground=drawing,kitchen", "first=bedroom:3,terrace"]})
    assert "roof_terrace" not in b["spaces"]
    assert {f["level"]: f["rooms"] for f in b["floors"]}["first"] == ["bedroom:3", "terrace"]
    r = intake.merge_brief(intake.empty_brief(), {"floors": ["ground=drawing", "roof=terrace"]})
    assert "roof_terrace" in r["spaces"]


def test_setup_agent_records_no_roof_terrace_for_a_stair_to_the_roof():
    from app.agents import setup_agent
    said = "10 marla, 2 storeys, a stair going all the way up to the roof with a mumty"
    assert not setup_agent.terrace_said(said)
    t = setup_agent.Turn(intake.empty_brief(), intake.empty_brief(), said)
    update_brief = t.tools()[0]
    update_brief(spaces=["drawing", "roof_terrace"], floors=["ground=drawing,kitchen", "roof=terrace"])
    assert "roof_terrace" not in t.brief["spaces"] and "drawing" in t.brief["spaces"]
    assert not [f for f in t.brief.get("floors") or [] if f["level"] == "roof"]
    # asked for: a sitting area on the roof
    asked = "and a terrace on the roof where we can sit in the evening"
    assert setup_agent.terrace_said(asked)
    t2 = setup_agent.Turn(intake.empty_brief(), intake.empty_brief(), asked)
    t2.tools()[0](spaces=["roof_terrace"])
    assert "roof_terrace" in t2.brief["spaces"]


def test_bedrooms_said_reads_what_the_family_typed():
    from app.agents import setup_agent

    assert setup_agent.bedrooms_said("Two storeys, four bedrooms, somewhere to cook outside.") == 4
    assert setup_agent.bedrooms_said("a 5-bed villa") == 5
    assert setup_agent.bedrooms_said("3 bedrooms upstairs and 2 bedrooms down") == 3
    assert setup_agent.bedrooms_said("one bedroom downstairs for my mother") is None
    assert setup_agent.bedrooms_said("a family of four") is None
