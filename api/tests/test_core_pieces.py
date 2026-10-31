"""Core pieces, without model calls: the chat message adapter, researched rule packs,
drawing import geometry, the daylight repair and the setup tool's argument cleaning."""
import copy
import json
from pathlib import Path

from google.genai import types

from app import config, llm
from app.agents import architect, importer, research
from app.agents.setup_agent import clean_args
from app.compliance import lda, planning

FIX = Path(__file__).parent / "fixtures"


def test_genai_contents_become_chat_messages():
    img = types.Part.from_bytes(data=b"\x89PNG", mime_type="image/png")
    msgs = llm.to_messages([types.Content(role="user", parts=[img, types.Part.from_text(text="look")]),
                            types.Content(role="model", parts=[types.Part.from_text(text="{}")]), "again"], "be brief")
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
    assert msgs[1]["content"][0]["type"] == "image_url" and msgs[3]["content"] == "again"
    assert llm.model_id(config.MODEL_ARGON) == "google/gemini-4-argon"


def test_json_is_read_past_reasoning_and_fences():
    assert llm.parse_json('<think>hmm</think>\n```json\n{"a": 1}\n```') == {"a": 1}


def test_a_researched_pack_keeps_sane_bands_and_drives_the_envelope():
    raw = {"authority": "CDA", "authority_name": "Capital Development Authority", "bands": [
        {"label": "10 marla", "min_sqft": 2000, "max_sqft": 4000, "setbacks_ft": {"front": 15, "rear": 7, "side": 0, "side_count": 0},
         "max_coverage_pct": 65, "max_height_ft": 38, "max_storeys": 2, "sources": ["T1"]},
        {"label": "nonsense", "min_sqft": "lots", "setbacks_ft": {"front": 999}}],
        "sources": [{"id": "T1", "title": "CDA regulations", "url": "https://www.cda.gov.pk/x.pdf"}]}
    pack = research.clean_pack(raw, [{"url": "https://www.cda.gov.pk/x.pdf"}])
    assert len(pack["bands"]) == 1 and pack["sources"][0]["official"]
    lda.register_pack("CDA", pack)
    env = lda.envelope(35, 65, "CDA")
    assert env["setbacks_ft"]["front"] == 15 and env["max_coverage_pct"] == 65 and env["max_storeys"] == 2
    assert any("cda.gov.pk" in n for n in env["notes"])
    plan = json.loads((FIX / "plan-sample-10-marla-r3.json").read_text())
    plan["site"]["authority"] = "CDA"
    assert any(c["id"] == "setback.envelope" for c in lda.check(plan)["checks"])
    lda.PACKS.pop("CDA")


def test_drawn_room_edges_are_merged_onto_shared_walls():
    rooms = [{"rect": {"x": 0, "y": 0, "w": 15.2, "d": 18.3}}, {"rect": {"x": 15.6, "y": 0.4, "w": 14.1, "d": 17.8}}]
    a, b = importer.align_edges(rooms)
    assert a["rect"]["x"] + a["rect"]["w"] == b["rect"]["x"] and a["rect"]["d"] == b["rect"]["d"]


def test_a_sheet_drawn_with_the_road_on_top_is_turned_round():
    sheet = {"plot": {"bbox": [0, 0, 1000, 1000]}, "road_side": "top",
             "rooms": [{"name": "Lawn", "type": "lawn", "bbox": [0, 0, 1000, 200]}]}
    (lawn,) = importer.to_feet(sheet, 35, 65)
    assert lawn["rect"]["y"] == 0 and lawn["rect"]["d"] == 13


def test_the_daylight_repair_adds_windows_once():
    brief = json.loads((FIX / "brief-sample-10-marla.json").read_text())
    plan = json.loads((FIX / "plan-sample-10-marla-r3.json").read_text())
    plan["openings"] = [o for o in plan["openings"] if o["id"] != "g_drawing_w1" and o.get("type") != "ventilator"]
    once, _ = architect.prepare(copy.deepcopy(plan), brief)
    twice, _ = architect.prepare(copy.deepcopy(once), brief)
    assert len(once["openings"]) == len(twice["openings"]) > len(plan["openings"])
    assert not [c for c in lda.check(twice, brief)["checks"] if c["status"] == "fail" and c["id"].startswith(("room.light", "room.vent"))]


def test_placeholder_tool_arguments_are_dropped():
    assert clean_args({"storeys": "None", "bedrooms": "4", "plot": {"width_ft": 35, "depth_ft": "null"}, "spaces": ["None"]}) == \
        {"bedrooms": 4, "plot": {"width_ft": 35}}


def test_the_front_elevation_draws():
    plan = json.loads((FIX / "plan-sample-10-marla-r3.json").read_text())
    from app.agents import drawing
    assert drawing.render_front_elevation(plan)[:4] == b"\x89PNG"


def test_a_const_from_another_section_is_copied_in():
    from app.agents.jsfix import share_declarations
    secs = [{"name": "structure", "code": "const stone = { preset: 'stone', color: '#888' };\nconst trim = { color: '#111', base: stone };\ns.structure({});\n"},
            {"name": "facade_front", "code": "s.facade.cladding({ material: trim });\n"},
            {"name": "landscape", "code": "const stone = { preset: 'gravel' };\ns.landscape.lawn({ material: stone });\n"}]
    fixed = share_declarations(secs)
    assert fixed == ["facade_front: stone, trim"]
    assert secs[1]["code"].index("const stone") < secs[1]["code"].index("const trim") < secs[1]["code"].index("s.facade")
    assert "preset: 'gravel'" in secs[2]["code"] and "preset: 'stone'" not in secs[2]["code"]


def test_a_declaration_in_a_loop_is_never_shared():
    from app.agents.jsfix import declarations, share_declarations

    loop = 'const glassMat = s.mat("glass_tinted");\n\nfor (const [wx, ww] of [[11, 5]]) {\n\n  const glass = new THREE.Mesh(new THREE.BoxGeometry(s.ft(ww), 1, 1), glassMat);\n  s.add(glass);\n}\n'
    assert set(declarations(loop)) == {"glassMat"}
    structure = {"name": "structure", "code": 's.structure({\n  glass: "glass_clear",\n  railing: "metal_bars",\n});\n'}
    secs = [structure, {"name": "facade", "code": loop}]
    assert share_declarations(secs) == []
    assert structure["code"].startswith("s.structure")


def test_names_in_strings_and_comments_are_not_uses():
    from app.agents.jsfix import _uses

    assert not _uses('s.mat("stone"); // stone here', "stone")
    assert not _uses('s.x({ a: 1, stone: 2 })', "stone")
    assert _uses("s.mat(stone)", "stone") and _uses("const a = b ? stone : c", "stone") and _uses("f({ a: stone })", "stone")
