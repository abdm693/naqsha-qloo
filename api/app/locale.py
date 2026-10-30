"""Where the home is, for prompts that used to assume Lahore: the place in words, the street and site conventions, the
fixtures and planting that homes there have. Naqsha started in Pakistan (marla, LDA, a car porch behind a boundary wall);
everywhere else the house follows what is usual locally."""
from __future__ import annotations

PK_CITIES = {"lahore", "islamabad", "karachi", "rawalpindi", "faisalabad", "multan", "gujranwala", "peshawar", "quetta",
             "hyderabad", "sialkot", "bahawalpur", "sargodha", "abbottabad", "murree"}
PK_AUTHORITIES = {"LDA", "DHA", "BAHRIA", "OTHER", "CDA", "SBCA", "RDA", "FDA", "MDA", "GDA", "PDA", "QDA", "HDA", "SDA"}
COUNTRY = {"dubai": "United Arab Emirates", "abu dhabi": "United Arab Emirates", "sharjah": "United Arab Emirates",
           "austin": "United States", "houston": "United States", "dallas": "United States", "los angeles": "United States",
           "new york": "United States", "toronto": "Canada", "vancouver": "Canada", "london": "United Kingdom",
           "melbourne": "Australia", "sydney": "Australia", "riyadh": "Saudi Arabia", "jeddah": "Saudi Arabia"}


def is_pakistan(brief: dict) -> bool:
    city = str(brief.get("city") or "").strip().lower()
    if city:
        return city in PK_CITIES
    return str(brief.get("authority") or "LDA").upper() in PK_AUTHORITIES


def place(brief: dict) -> str:
    """'DHA Phase 6, Lahore, Pakistan' / 'Travis Heights, Austin, United States'."""
    city = brief.get("city") or ("Lahore" if is_pakistan(brief) else "")
    country = brief.get("country") or ("Pakistan" if is_pakistan(brief) else COUNTRY.get(str(city).lower(), ""))
    return ", ".join(x for x in (brief.get("scheme"), city, country) if x) or "the family's city"


def street_context(brief: dict, cars: str = "1") -> str:
    """The site conventions for an exterior image."""
    if is_pakistan(brief):
        return (f"Typical Lahore layout: boundary wall with a sliding gate, a {cars}-car porch within the building line, a small "
                f"front lawn.")
    return (f"A family home as they are built in {place(brief)}: the street, front garden or yard, driveway or garage and boundary "
            f"treatment that homes there typically have, and a roof form and climate response that suit the place.")


def local_touches(brief: dict) -> str:
    """Fixtures, furnishing and planting for the 3D build."""
    if is_pakistan(brief):
        return ("Include Pakistani touches: ceiling fans, split ACs in bedrooms and lounges, a prayer mat if there's a prayer room. "
                "Trees: ashoka and palm.")
    return (f"Include what homes in {place(brief)} have: fixtures, heating or cooling, appliances and furnishing typical there "
            f"(no ceiling fans or split ACs unless that is usual locally), and trees and planting native to the place.")


def planning_sense(brief: dict) -> str:
    """How rooms are arranged locally, for the plan prompt."""
    if is_pakistan(brief):
        return ""
    return (f"THIS HOME IS IN {place(brief).upper()}: plan it as a local architect there would, for how families there live. "
            f"Use the room names and conventions usual there (e.g. in North America a family room, mudroom, laundry and a garage; "
            f"in the Gulf a majlis near the entrance and a maid's room). Add no drawing room, dirty kitchen or servant quarter "
            f"unless the brief asks for one.")
