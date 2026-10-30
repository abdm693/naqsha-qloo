import json
import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]
ROOT = API.parent
sys.path.insert(0, str(API))


def load(name: str) -> dict:
    for base in (API / "tests" / "fixtures", ROOT / "contracts" / "fixtures", API / "app" / "agents" / "examples"):
        p = base / name
        if p.exists():
            return json.loads(p.read_text())
    raise FileNotFoundError(name)


@pytest.fixture(autouse=True)
def no_research(monkeypatch):
    """Tests never go to the web or Firestore for a home profile: a test that wants one patches it in."""
    from app.agents import homes

    async def none(brief, force=False):
        return None
    monkeypatch.setattr(homes, "profile", none)


@pytest.fixture
def plans():
    return {
        "argon-v1": load("argon-v1-plan.json"),          # real Argon output (10 marla)
        "fixture": load("plan-10-marla.json") if (ROOT / "contracts/fixtures/plan-10-marla.json").exists() else None,
        "1-kanal": load("plan-1-kanal.json"),            # the house in the user's screenshots
        "audit-v1": load("plan-audit-v1.json"),          # journey audit v1: broken first floor
        "audit-v2": load("plan-audit-v2.json"),          # journey audit v2: 6 bedrooms for a brief of 5
        "example": json.loads((API / "app/agents/examples/plan-10-marla.json").read_text()),
    }
