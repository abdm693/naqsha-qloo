"""Concept takes in plain British English and the mid-row image check (BE-F6). No model calls."""
import asyncio
import re

from app.agents import concepts

BANNED = re.compile(r"board-formed|louvers?|aluminum|vigas|corner", re.I)
MIDROW = {"plot": {"width_ft": 35, "depth_ft": 65, "corner": False}, "storeys": 2, "style": "Modern Contemporary",
          "spaces": ["car_porch:1"], "solar": "panels", "city": "Lahore"}
ROW = {"summary": "A flat-roofed row house", "form": {"type": "row", "side_gap_ft": 0}, "roof": {"form": "flat", "stair_tower": True}}


def test_takes_are_plain_and_short():
    t = concepts.plain_take({"title": "Corner Monolith", "direction": "A board-formed concrete corner mass with bronze aluminum "
                                                                      "louvers, exposed vigas and a cantilevered canopy over the porch."})
    assert not BANNED.search(t["title"] + " " + t["direction"]), t
    assert len(t["direction"].split()) <= concepts.DIRECTION_WORDS and "aluminium" in t["direction"]
    assert not t["direction"].endswith((" and", " with", ",", "."))
    for take in concepts.FALLBACK_TAKES:
        assert len(take["direction"].split()) <= 14 and not BANNED.search(take["direction"])
    system = concepts.TAKES_SYSTEM
    assert "British English" in system and "at most 14 words" in system
    for word in ("board-formed", "louvers", "aluminum", "vigas", "corner"):
        assert word in system


def test_takes_from_the_model_are_cleaned(monkeypatch):
    async def stream(model, contents, system, max_tokens=None, **k):
        yield "result", ({"takes": [{"title": f"Take {i}", "direction": "Board-formed concrete with aluminum louvers on the corner"}
                                    for i in range(4)]}, "")
    monkeypatch.setattr(concepts.llm, "stream_json", stream)
    takes = asyncio.run(concepts.design_takes(MIDROW))
    assert len(takes) == 4 and not any(BANNED.search(t["direction"]) for t in takes)


def test_panels_stand_on_a_raised_frame():
    assert "rows of solar panels on a raised steel frame" in concepts.concept_prompt(MIDROW)


def test_a_mid_row_prompt_says_so_first():
    p = concepts.concept_prompt(MIDROW, homes=ROW)
    assert p.index("continuous row of houses") < p.index("Style language") and "35mm lens" in p
    corner = concepts.concept_prompt({**MIDROW, "plot": {**MIDROW["plot"], "corner": True}}, homes=ROW)
    assert "It is a CORNER plot" in corner and "three-quarter view from the street corner" in corner


class _Resp:
    def __init__(self, tag):
        self.tag = tag


def test_a_mid_row_image_with_a_side_road_is_made_once_more(monkeypatch):
    calls, stored = [], []

    async def image_call(contents, aspect="16:9"):
        calls.append(contents[-1])
        return _Resp(len(calls))

    async def put(path, data, mime):
        stored.append(data)
        return f"/api/assets/{path}"
    answers = iter([True])

    async def beside(image):
        return next(answers, False)
    monkeypatch.setattr(concepts, "_image_call", image_call)
    monkeypatch.setattr(concepts, "_image_bytes", lambda r: (f"img{r.tag}".encode(), "image/png"))
    monkeypatch.setattr(concepts, "side_road", beside)
    monkeypatch.setattr(concepts.blobs, "put", put)
    site = concepts._site_sentence(MIDROW, ROW)
    c = asyncio.run(concepts._generate_one("p1", "PROMPT", None, site))
    # made once more as an edit of the day image (same house and camera), with the site sentence repeated
    assert len(calls) == 2 and calls[1].startswith(concepts.SIDE_ROAD_FIX) and "It is a MID-ROW plot" in calls[1]
    assert stored == [b"img2"] and c["midrow_check"]["side_road"] is True and c["midrow_check"]["regenerated"] is True
    # a clean image is kept as it is; a corner plot (site None) is never checked
    calls.clear(), stored.clear()
    c = asyncio.run(concepts._generate_one("p1", "PROMPT", None, site))
    assert len(calls) == 1 and c["midrow_check"] == {"side_road": False, "regenerated": False, "seconds": c["midrow_check"]["seconds"]}
    calls.clear()
    c = asyncio.run(concepts._generate_one("p1", "PROMPT", None, None))
    assert len(calls) == 1 and "midrow_check" not in c


def test_the_check_is_skipped_when_it_cannot_run(monkeypatch):
    class Boom:
        class aio:
            class models:
                @staticmethod
                async def generate_content(**k):
                    raise RuntimeError("429 RESOURCE_EXHAUSTED")
    monkeypatch.setattr(concepts, "client", lambda: Boom)
    assert asyncio.run(concepts.side_road((b"x", "image/png"))) is None
