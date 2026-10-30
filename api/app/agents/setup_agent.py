"""The conversational setup agent (Google ADK, Gemini 3.8 Flash on Vertex AI).

The family says whatever they want, in any order: the agent records everything it heard with update_brief (deterministic
merge: notes and preferences are appended, never overwritten) and answers any direct question from the rule facts it is given.
The only thing it must ask is where the home is. Everything else comes from the place's home profile (agents/homes.py) and is
shown as assumptions, so it wraps up (complete_setup) as soon as the place is known, unless one follow-up truly matters (ask,
in plain words). A turn is at most two short model steps; the tool that replies ends the turn without another model call
(skip_summarization).

History is replayed from the project's messages collection on every turn, so any Cloud Run instance can serve the next turn.
"""
from __future__ import annotations

import json
import re
import logging
import time
from typing import AsyncIterator, Optional

from google.adk import Agent, Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from .. import config, llm, locale
from ..compliance import lda
from ..gemini import RETRY
from ..store import db
from . import homes, intake

log = logging.getLogger("naqsha.setup")
APP = "naqsha-setup"
MAX_FOLLOWUPS = 1  # one judgment question before the setup goes ahead; everything else is an assumption they can change

INSTRUCTION = """You are Naqsha, a calm, experienced architect setting up a new home with a family, anywhere in the world.
You speak like a warm professional: brief, second person, in the units the family uses. Plots are recorded in feet (width ×
depth); convert metres yourself. One to three short sentences. Never say Argon, agent, AI, model or SDK. No emoji, no
exclamation marks.

The family tells you whatever they want, in any order. The one thing you must know is where the home will be. Everything else
Naqsha fills in from how homes are built in that place, and the family sees it as assumptions they can change. So never walk
them through a list of questions.

Every turn:
1. If the user told you anything about the home, record ALL of it with ONE update_brief call: location, plot (marla or width ×
   depth, corner or not, facing), floors, rooms per floor, bedroom and bath totals, spaces, water tank, solar, style, budget,
   a roof or house form they named, and every soft wish as a short preference in the family's own words ("parents' bedroom on
   the ground floor", "open kitchen", "double-height lounge"). Never invent what they didn't say.
   Rooms per floor go in `floors` as "level=room,room:count", e.g. ["ground=lounge,kitchen,bedroom:1,bath:2",
   "first=bedroom:3,bath:3"]. Use bedroom (or master_bedroom / guest_bedroom), bath, powder, drawing, lounge, dining,
   kitchen, kitchenette, dirty_kitchen, prayer, study, store, laundry, servant_quarter, dressing, terrace, balcony.
   A stair up to the roof is never a terrace or a roof terrace. Record roof_terrace only when they ask for a terrace or a
   sitting area on the roof.
   "Attached baths" means one bath per bedroom: set bathrooms accordingly (plus a powder room if they mention one).
   If they take a wish back or contradict one ("remove the dirty kitchen", "no open kitchen after all"), drop it with
   remove_preferences (and remove_spaces for a room), in the same update_brief call.
2. If they asked a question, answer it first, using ONLY the RULE FACTS you are given (never other numbers). Push back gently on
   choices with a real trade-off (a double-height lounge costs first-floor area; more storeys than the rules allow aren't
   possible).
3. In the SAME step, reply:
   - If STILL NEEDED lists place, call ask(field="place") with a short acknowledgement of what they told you and the
     question of where the home will be, in plain words.
   - Otherwise call complete_setup. Say briefly that you have what you need; the app shows the card of what you heard and what
     you assumed, so don't repeat the brief back, and say nothing about the rest of the steps.
   - Only if something they said leaves a real fork you can't resolve and a wrong guess would change the house (not a detail
     you can assume and they can correct), you may instead call ask(field="other") with ONE question in plain words. At most
     one such question in a setup. Never ask about the budget, and never ask for the plot, floors, rooms, tank, solar or
     style just because they weren't mentioned.
   Put your whole reply in that call's text; write nothing else. Never say "initial", "layout concepts" or "recorded".
   Call present_understanding() only to list assumptions you made yourself (e.g. a plot size you inferred).
Call update_brief together with ask or complete_setup in ONE step."""


class Turn:
    """Per-turn state the tools write into."""

    def __init__(self, brief: dict, before: dict, said: str = ""):
        self.brief = brief
        self.before = before
        self.said = said  # everything the family has typed (this turn and before): what a roof terrace must come from
        self.reply: dict | None = None
        self.understood: dict | None = None
        self.complete = False
        self.updated = False
        self.patch_fields: set[str] = set()

    def tools(self):
        t = self

        def update_brief(city: Optional[str] = None, country: Optional[str] = None, authority: Optional[str] = None,
                         scheme: Optional[str] = None,
                         plot_marla: Optional[float] = None, plot_width_ft: Optional[float] = None,
                         plot_depth_ft: Optional[float] = None, corner: Optional[bool] = None, facing: Optional[str] = None,
                         storeys: Optional[int] = None, basement: Optional[bool] = None, bedrooms: Optional[int] = None,
                         bathrooms: Optional[int] = None, spaces: Optional[list[str]] = None,
                         remove_spaces: Optional[list[str]] = None, floors: Optional[list[str]] = None,
                         water_tank: Optional[str] = None, solar: Optional[str] = None, style: Optional[str] = None,
                         style_notes: Optional[str] = None, budget: Optional[str] = None,
                         preferences: Optional[list[str]] = None, remove_preferences: Optional[list[str]] = None,
                         note: Optional[str] = None, decided_for_them: Optional[list[str]] = None,
                         roof_form: Optional[str] = None, home_form: Optional[str] = None) -> dict:
            """Record what the family told you in the design brief. Pass only what they said (or what you decided because they
            asked you to, listed in decided_for_them).

            Args:
              city: City or town, e.g. "Austin", "Nairobi", "Lahore".
              country: The country, when you know it (you usually do from the city).
              authority: LDA, DHA or BAHRIA in Lahore (LDA for ordinary Lahore schemes such as Johar Town). Leave it out
                elsewhere: Naqsha works out the local authority.
              scheme: Neighbourhood, housing scheme or society, e.g. "Johar Town", "Travis Heights".
              plot_marla: Plot area in marla (1 kanal = 20 marla).
              plot_width_ft: Plot frontage in feet, if given.
              plot_depth_ft: Plot depth in feet, if given.
              corner: True for a corner plot, False if they say it isn't one.
              facing: Which way the front faces: N, NE, E, SE, S, SW, W or NW.
              storeys: Floors above ground, 1 to 3.
              basement: True if they want a basement.
              bedrooms: Total bedrooms (servant quarters excluded).
              bathrooms: Total baths including any powder room.
              spaces: Spaces to add: drawing, tv_lounge, dining, kitchen, dirty_kitchen, servant_quarter, car_porch:N (N cars),
                motorbike (a motorbike parked in the porch), lawn, prayer, store, laundry, roof_terrace, study, gym.
                Reaching the roof by stair is standard (never a terrace): add roof_terrace only when they ask for a terrace
                or a sitting area on the roof.
              remove_spaces: Spaces they no longer want.
              floors: Rooms per floor, each "level=room,room:count", e.g. "ground=drawing,kitchen,bedroom:1,bath:2". A
                terrace on the first or second floor is a terrace on that floor; "roof=terrace" only for a roof terrace.
              water_tank: "plastic" or "concrete".
              solar: "none", "ready" (roof kept clear for panels later) or "panels" (panels now).
              style: Modern Contemporary, Spanish, Classic, Minimalist, Mediterranean, Mughal Revival, Industrial or free text.
              roof_form: Only if they asked for a kind of roof: flat, gable or hip.
              home_form: Only if they said how the house stands: detached, semi-detached, row, townhouse or compound.
              style_notes: Extra style direction in their words.
              budget: economy, standard, premium or luxury.
              preferences: Soft wishes in their own words, each short.
              remove_preferences: Wishes they took back or contradicted, as recorded (e.g. "dirty kitchen").
              note: Anything else worth remembering, one sentence.
              decided_for_them: Fields you chose yourself because they asked you to decide.
            """
            patch: dict = {}
            cur = t.brief.get("plot") or {}
            plot: dict = {}
            if plot_width_ft and plot_depth_ft:
                plot = {"width_ft": plot_width_ft, "depth_ft": plot_depth_ft}
            elif plot_marla and not (cur and abs((cur.get("area_marla") or 0) - plot_marla) < 0.6):
                plot = {"area_marla": plot_marla}
                # a new size: don't keep the old width and depth (but keep corner / mid-row, and whether it was said)
                t.brief = {**t.brief, "plot": {"corner": cur["corner"]} if "corner" in cur else None}
            if corner is not None:  # only when they said it: otherwise Naqsha asks "Corner or mid-row?"
                plot["corner"] = bool(corner)
            if plot:
                patch["plot"] = plot
            if plot_marla:
                patch["units"] = "marla"  # they speak in marla: the app does too
            for k, v in (("city", city), ("country", country), ("authority", authority), ("scheme", scheme), ("facing", facing),
                         ("roof_form", roof_form), ("home_form", home_form),
                         ("storeys", storeys), ("basement", basement), ("bedrooms", bedrooms), ("bathrooms", bathrooms),
                         ("spaces", spaces), ("remove_spaces", remove_spaces), ("floors", floors), ("water_tank", water_tank),
                         ("solar", solar), ("style", style), ("style_notes", style_notes), ("budget", budget),
                         ("preferences", preferences), ("remove_preferences", remove_preferences), ("notes", note)):
                if v not in (None, "", []):
                    patch[k] = v
            patch = clean_args(patch)
            if not terrace_said(t.said):  # "a stair all the way up to the roof" is not a roof terrace
                patch = drop_roof_terrace(patch)
            if patch.get("bedrooms") and not patch.get("bathrooms") and not t.brief.get("bathrooms"):
                patch["bathrooms"] = int(patch["bedrooms"]) + 1
                decided_for_them = list(decided_for_them or []) + ["bathrooms"]
            t.brief = intake.merge_brief(t.brief, patch, list(decided_for_them or []), spaces_mode="union")
            t.updated = True
            t.patch_fields |= set(patch)
            return {"ok": True, "still_needed": intake.to_ask(t.brief) or ["nothing: call complete_setup"],
                    "rule_facts": intake.lda_facts(t.brief), "brief": _compact(t.brief)}

        def get_lda_envelope(width_ft: float, depth_ft: float, corner: bool = False, authority: str = "LDA") -> dict:
            """Rule facts for any plot size (for "what if" questions about another plot).

            Args:
              width_ft: Plot width in feet.
              depth_ft: Plot depth in feet.
              corner: Corner plot.
              authority: LDA, DHA, BAHRIA or OTHER.
            """
            if not intake.has_rules(t.brief):
                return {"note": "This place's building rules are still being looked up: quote no numbers."}
            env = lda.envelope(width_ft, depth_ft, str(t.brief.get("authority") or authority).upper(), corner)
            env.pop("_band", None)
            return {k: env[k] for k in ("band", "setbacks_ft", "max_coverage_pct", "max_far", "max_height_ft", "max_storeys", "notes")}

        def ask(question: str, field: str, tool_context: ToolContext, suggestions: Optional[list[str]] = None) -> dict:
            """Send your reply and ask ONE question in plain words. Ends your turn.

            Args:
              question: Your whole reply: a short acknowledgement or answer, then the question.
              field: "place" when you are asking where the home will be, "other" for anything else.
              suggestions: Optional follow-up prompts the family might send next.
            """
            t.reply = {"text": question, "field": "place" if field == "place" else "other", "chips": [], "input": None,
                       "multi": False, "allow_skip": field != "place", "suggestions": suggestions or []}
            tool_context.actions.skip_summarization = True
            return {"ok": True}

        def present_understanding(preferences: list[str], assumptions: list[str], guaranteed: Optional[list[str]] = None) -> dict:
            """Show the "Here's what I understood" card with your reply.

            Args:
              preferences: What the family asked for, short and in their words.
              assumptions: What you chose yourself and they can change.
              guaranteed: Optional; the app adds the LDA and livability guarantees itself.
            """
            t.understood = {"preferences": preferences or [], "assumptions": assumptions or [], "guaranteed": guaranteed or []}
            return {"ok": True}

        def complete_setup(message: str, tool_context: ToolContext, suggestions: Optional[list[str]] = None) -> dict:
            """Wrap up the setup when nothing is missing. Ends your turn.

            Args:
              message: Your reply: one short sentence.
              suggestions: Optional follow-up prompts.
            """
            # update_brief may run after this in the same step, so the app decides after the turn whether anything is missing
            t.complete = True
            t.reply = {"text": message, "field": None, "chips": [], "input": None, "multi": False, "allow_skip": False,
                       "suggestions": suggestions or [], "complete": True}
            tool_context.actions.skip_summarization = True
            return {"ok": True}

        return [update_brief, get_lda_envelope, ask, present_understanding, complete_setup]


def strip_reasoning(text: str) -> str:
    """Drop reasoning a model let slip into its reply ("…</think> Thanks…", "<think>…</think>")."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    if "</think>" in text:
        text = text.split("</think>")[-1]
    return text.strip()


NULLISH = {"none", "null", "nil", "n/a", "na", "unknown", "", "undefined"}


def clean_args(patch: dict) -> dict:
    """Drop placeholder values a model sometimes sends for an empty field ("None", "null", [] of those), and turn numeric
    strings into numbers."""
    out: dict = {}
    for k, v in patch.items():
        if isinstance(v, str) and v.strip().lower() in NULLISH:
            continue
        if isinstance(v, list):
            v = [x for x in v if not (isinstance(x, str) and x.strip().lower() in NULLISH)]
            if not v:
                continue
        if isinstance(v, dict):
            v = clean_args(v)
            if not v:
                continue
        if k in ("storeys", "bedrooms", "bathrooms") and isinstance(v, str):
            try:
                v = int(float(v))
            except ValueError:
                continue
        out[k] = v
    return out


TERRACE_RE = re.compile(r"terrace|\bsit(ting)?\b|seating|roof\s*-?\s*(top\s*)?(garden|lounge|deck|party|gathering)|"
                        r"barbe?cue|\bbbq\b", re.I)


def terrace_said(text: str) -> bool:
    """Whether the family asked for a terrace or a sitting area (on the roof or anywhere), in their own words."""
    return bool(TERRACE_RE.search(text or ""))


def drop_roof_terrace(patch: dict) -> dict:
    """The patch without a roof terrace the family never asked for: roof_terrace in spaces, and a terrace on the roof's
    per-floor program (a roof level left empty is dropped, so it never clears what was recorded before)."""
    out = dict(patch)
    if out.get("spaces"):
        out["spaces"] = [s for s in out["spaces"] if str(s).strip().lower().replace(" ", "_") != "roof_terrace"]
        if not out["spaces"]:
            out.pop("spaces")
    floors = []
    for f in out.get("floors") or []:
        spec = intake.parse_floor_spec(f) if isinstance(f, str) else f
        if isinstance(spec, dict) and spec.get("level") == "roof":
            rooms = [r for r in spec.get("rooms") or [] if str(r).split(":")[0] not in ("terrace", "roof_terrace")]
            if not rooms:
                continue
            f = {"level": "roof", "rooms": rooms}
        floors.append(f)
    if "floors" in out:
        if floors:
            out["floors"] = floors
        else:
            out.pop("floors")
    return out


def _compact(b: dict) -> dict:
    return {k: v for k, v in b.items() if v not in (None, "", [], {}, False) and k != "auto_filled"} | (
        {"decided_by_naqsha": b["auto_filled"]} if b.get("auto_filled") else {})


def _context(project: dict, brief: dict, history: list[dict], user_text: str, widget_patch: dict) -> str:
    convo = []
    for m in history[-8:]:
        who = "FAMILY" if m["role"] == "user" else "NAQSHA"
        convo.append(f"{who}: {str(m.get('text', ''))[:600]}")
    last_q = next((m for m in reversed(history) if m["role"] == "assistant"), None)
    design = ""
    if project.get("imported"):
        design += ("\nTHE FAMILY UPLOADED THEIR OWN FLOOR PLAN DRAWING: the plot, storeys and rooms per floor in the brief come "
                   "from it. Don't ask for those again; ask only what a drawing can't show.")
    if project.get("versions"):
        design = (f"\nA DESIGN ALREADY EXISTS (version {len(project['versions'])}). Record changes as usual, then tell them the "
                  f"change applies when they revise the design or design again; don't restart the setup.")
    return (f"BRIEF NOW: {json.dumps(_compact(brief))}\n"
            + (f"THE APP ALREADY APPLIED FROM THE WIDGET: {json.dumps(widget_patch)}\n" if widget_patch else "")
            + f"STILL NEEDED: {intake.to_ask(brief) or 'nothing'}\n"
            f"RULE FACTS: {intake.lda_facts(brief)}\n"
            f"LAST QUESTION ASKED: {(last_q or {}).get('field') or 'none'}{design}\n"
            f"CONVERSATION SO FAR:\n" + ("\n".join(convo[:-1] if convo and convo[-1].startswith('FAMILY') else convo) or "(none)")
            + f"\n\nTHE FAMILY NOW SAYS: {user_text}")


async def agent_turn(project: dict, brief: dict, before: dict, history: list[dict], user_text: str,
                     widget_patch: dict) -> AsyncIterator[tuple[str, dict]]:
    pid = project["id"]
    t0 = time.monotonic()
    if widget_patch:
        brief = intake.merge_brief(brief, widget_patch, [], spaces_mode="replace")
    said = " ".join([str(m.get("text") or "") for m in history if m.get("role") == "user"] + [user_text or ""])
    turn = Turn(brief, before, said)
    agent = Agent(name="naqsha_setup", model=llm.adk_model(config.MODEL_SETUP), instruction=INSTRUCTION,
                  tools=turn.tools(), generate_content_config=types.GenerateContentConfig(
                      temperature=0.4, max_output_tokens=2048,
                      thinking_config=types.ThinkingConfig(thinking_level="LOW")))
    sessions = InMemorySessionService()
    runner = Runner(app_name=APP, agent=agent, session_service=sessions)
    session = await sessions.create_session(app_name=APP, user_id=pid)
    msg = types.Content(role="user", parts=[types.Part.from_text(text=_context(project, brief, history, user_text, widget_patch))])
    final_text = ""
    steps = 0
    try:
        async for event in runner.run_async(user_id=pid, session_id=session.id, new_message=msg):
            if event.get_function_calls():
                steps += 1
            if event.content and event.content.parts and not event.get_function_calls() and not event.get_function_responses():
                final_text += "".join(p.text or "" for p in event.content.parts if not getattr(p, "thought", False))
            if turn.reply or steps > 4:
                break
    except Exception:
        log.exception("setup agent failed; falling back to the question bank")
    if turn.reply and turn.reply.get("text"):
        turn.reply["text"] = strip_reasoning(turn.reply["text"])
    final_text = strip_reasoning(final_text)
    brief, push = intake.clamp_storeys(turn.brief)  # never more storeys than the rules allow (DHA: 2)
    if push:
        turn.patch_fields.add("storeys")
    said = (turn.reply or {}).get("text") or final_text.strip()
    if push:  # one sentence of pushback, and no sentence that still promises the storeys that aren't allowed
        kept = [s for s in re.split(r"(?<=[.!?])\s+", said)
                if not re.search(r"\b(three|four|3|4|triple)[\s-]*(storey|story|stories|storeys|floor)", s, re.I)]
        said = (push + " " + " ".join(kept)).strip()

    if not locale.known(brief):  # the one thing that must be asked
        q = intake.question("place", brief)
        text = said if (turn.reply or {}).get("field") == "place" and said else (_strip_question(said) + " " + q["text"]).strip()
        brief, env, _ = await intake._save(project, brief, False, before)
        yield "brief", {"brief": brief, "envelope": env}
        yield "message", await db.add_message(pid, {"role": "assistant", "text": text, "chips": [], "input": None, "field": "place",
                                                    "allow_skip": False, "multi": False})
        log.info("setup turn %s: %.1fs, %d steps, fields %s", pid, time.monotonic() - t0, steps, sorted(turn.patch_fields))
        return

    asked = bool(turn.reply) and not turn.complete and turn.reply.get("field") != "place"
    before_done = bool(project.get("intake_complete"))
    if asked and not before_done and _followups(history) < MAX_FOLLOWUPS:  # a real fork: ask it, reading the place meanwhile
        homes.start(project, brief)
        brief, env, _ = await intake._save(project, brief, False, before)
        yield "brief", {"brief": brief, "envelope": env}
        yield "message", await db.add_message(pid, {"role": "assistant", "text": said, "chips": [], "input": None, "field": "other",
                                                    "allow_skip": True, "multi": False})
        log.info("setup turn %s: %.1fs, %d steps, fields %s", pid, time.monotonic() - t0, steps, sorted(turn.patch_fields))
        return

    # the place is known: go ahead. The card goes with a turn that changed the brief, the first completion, or the agent's own
    # assumptions; a question asked after setup gets a plain answer.
    changed = bool(turn.patch_fields - {"notes"})
    card = bool(turn.understood) or changed or not before_done
    lead = _strip_question(said) if asked else said
    if not project.get("versions"):
        lead = " ".join(s for s in re.split(r"(?<=[.!?])\s+", lead) if "what i understood" not in s.lower() and "show me concepts" not in s.lower())
    async for ev in intake.conclude(project, brief, before, lead=lead, card=card, agent=turn.understood):
        yield ev
    log.info("setup turn %s: %.1fs, %d steps, fields %s", pid, time.monotonic() - t0, steps, sorted(turn.patch_fields))


def _followups(history: list[dict]) -> int:
    """Judgment questions Naqsha has asked in this setup so far."""
    return sum(1 for m in history if m.get("role") == "assistant" and m.get("field") == "other")


def _strip_question(text: str) -> str:
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    while parts and parts[-1].endswith("?"):
        parts.pop()
    return " ".join(parts)

