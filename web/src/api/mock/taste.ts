/** Mock taste stream (dev only): the shape the real /taste endpoint streams, with a believable family. */
import type { Taste, TasteInput, TasteProfile, StyleBrief } from "@contracts/api-types";
import { ev, type Step } from "./stream";

const profile: TasteProfile = {
  family: [
    { eid: "T1", name: "Cozy", type: "urn:tag:ambience:qloo", affinity: 0.92, from: ["E1", "E3"] },
    { eid: "T2", name: "Historic", type: "urn:tag:decor:qloo", affinity: 0.88, from: ["E1", "E2"] },
    { eid: "T3", name: "Soulful", type: "urn:tag:genre:media", affinity: 0.81, from: ["E3", "E4"] },
    { eid: "T4", name: "Courtyard", type: "urn:tag:setting:qloo", affinity: 0.77, from: ["E1"] },
    { eid: "T5", name: "Artisanal", type: "urn:tag:style:qloo", affinity: 0.74, from: ["E5"] },
    { eid: "T6", name: "Calm", type: "urn:tag:ambience:qloo", affinity: 0.7, from: ["E2"] },
    { eid: "T7", name: "Garden", type: "urn:tag:setting:qloo", affinity: 0.66, from: ["E2", "E6"] },
    { eid: "T8", name: "Family friendly", type: "urn:tag:good_for:qloo", affinity: 0.61, from: ["E6"] },
  ],
  feel: [],
  people: [
    { label: "Ammi & Abbu", role: "parents", tags: [{ eid: "T2", name: "Historic" }, { eid: "T4", name: "Courtyard" }, { eid: "T3", name: "Soulful" }] },
    { label: "Sara & Ali", role: "kids", tags: [{ eid: "T6", name: "Calm" }, { eid: "T9", name: "Minimalist" }, { eid: "T10", name: "Whimsical" }] },
  ],
  destinations: [
    { eid: "E7", name: "Marrakech", affinity: 0.84 },
    { eid: "E8", name: "Lisbon", affinity: 0.79 },
    { eid: "E9", name: "Fez", affinity: 0.75 },
  ],
  brands: [{ eid: "E10", name: "Khaadi" }, { eid: "E11", name: "Generation" }, { eid: "E12", name: "Aesop" }],
  area: {
    location: "DHA Phase 6, Lahore",
    tags: [{ eid: "T11", name: "Leafy", affinity: 0.8 }, { eid: "T12", name: "Upscale", affinity: 0.7 }, { eid: "T13", name: "Café culture", affinity: 0.66 }],
    places: [
      { eid: "P1", name: "Cosa Nostra", address: "Phase 6, DHA", tags: ["Cozy", "Italian"] },
      { eid: "P2", name: "Interwood Mobel", address: "Main Boulevard", tags: ["Furniture store"] },
    ],
  },
};

const style: StyleBrief = {
  headline: "Warm brick, carved shade, a quiet courtyard",
  story:
    "This family loves things with soul and history: old cities, Coke Studio, long dinners in cosy rooms. Their home gathers around a shaded courtyard in warm brick and timber, with calm, light rooms for the children upstairs.",
  family_tags: [{ name: "Cozy", id: "T1" }, { name: "Historic", id: "T2" }, { name: "Soulful", id: "T3" }, { name: "Courtyard", id: "T4" }],
  people: [
    { label: "Ammi & Abbu", signature: "Old-city warmth: Istanbul, Abida Parveen, carved wood.", room: "Ground-floor bedroom off the courtyard", because: ["E1", "T2"] },
    { label: "Sara & Ali", signature: "Calm and playful: Studio Ghibli, Kyoto, clean lines.", room: "Upstairs bedrooms and the study nook", because: ["E2", "T6"] },
  ],
  exterior: {
    style: "Warm Modern with Mughal craft",
    massing: "A solid brick base, a lighter upper floor set on the same building line, a deep shaded entrance",
    materials: ["handmade red brick", "teak screens", "lime plaster", "Bahawalpur stone sills"],
    palette: [{ name: "Brick", hex: "#A4553A" }, { name: "Lime", hex: "#EDE6DA" }, { name: "Teak", hex: "#7A5232" }, { name: "Indigo", hex: "#2E3A59" }],
    details: ["jaali screen over the stair window", "arched niche at the gate", "brass wall lights"],
    because: ["E1", "T2", "T5"],
  },
  interiors: {
    mood: "Warm, layered and lived in",
    palette: [{ name: "Clay", hex: "#C8775A" }, { name: "Ivory", hex: "#F4EEE3" }, { name: "Olive", hex: "#6B6B3A" }, { name: "Ink", hex: "#26304A" }],
    materials: ["terrazzo floors", "teak", "hand-block cotton", "brass"],
    lighting: "Low, warm pools of light; lanterns in the courtyard",
    furniture: "Low seating, a long dining table for family dinners",
    objects: "A record and music corner, books, framed truck art",
    because: ["T1", "E3", "E4"],
  },
  rooms: [
    { room: "lounge", for: "everyone", mood: "Gathering room with a music corner", palette: ["#C8775A", "#F4EEE3"], because: ["E3", "T1"] },
    { room: "parents_bedroom", for: "Ammi & Abbu", mood: "Carved timber, indigo textiles, a reading chair", palette: ["#26304A", "#7A5232"], because: ["E1", "T2"] },
    { room: "kids_bedroom", for: "Sara & Ali", mood: "Pale oak, soft greens, a window seat", palette: ["#DCE3D2", "#B9A27E"], because: ["E2", "T6"] },
  ],
  landscape: { idea: "A shaded courtyard with a neem tree and jasmine", plants: ["neem", "jasmine", "bougainvillea"], because: ["T4", "T7"] },
  neighbourhood: { reading: "Leafy, upscale, lots of cafés", response: "A generous front garden and a quiet street face", because: ["T11", "T13"] },
  takes: [
    { title: "Family courtyard", direction: "Warm brick around a shaded courtyard, teak screens", why: "What you all share", because: ["T1", "T4"] },
    { title: "Old-city warmth", direction: "Arched brick openings, carved timber and lime plaster", why: "Ammi & Abbu's taste", because: ["E1", "T2"] },
    { title: "Leafy street", direction: "Calm white planes, deep shade and a green front", why: "Fits DHA Phase 6", because: ["T11"] },
    { title: "Marrakech bold", direction: "Terracotta render, deep arches, a roof garden", why: "A taste next door to yours", because: ["E7"] },
  ],
  decisions: [
    { decision: "Handmade red brick and teak", reason: "You share a love of historic, crafted places", because: ["E1", "T2"] },
    { decision: "A shaded courtyard at the heart", reason: "Courtyards come up across your favourite places", because: ["T4", "E1"] },
    { decision: "A music corner in the lounge", reason: "Music is the strongest thread in your taste", because: ["E3", "E4"] },
  ],
  shop: [{ id: "P2", why: "Teak and handcrafted pieces near you" }],
  evidence: {
    E1: { eid: "E1", name: "Istanbul", type: "urn:entity:destination", via: ["Ammi & Abbu's favourite"] },
    E2: { eid: "E2", name: "Kyoto", type: "urn:entity:destination", via: ["Sara & Ali's favourite"] },
    E3: { eid: "E3", name: "Coke Studio", type: "urn:entity:tv_show", via: ["Everyone's favourite"] },
    E4: { eid: "E4", name: "Abida Parveen", type: "urn:entity:artist", via: ["Ammi & Abbu's favourite"] },
    E7: { eid: "E7", name: "Marrakech", type: "urn:entity:destination", via: ["destinations people with this taste love"] },
    T1: { eid: "T1", name: "Cozy", type: "urn:tag:ambience:qloo", via: ["the family's taste"], from: ["E1", "E3"] },
    T2: { eid: "T2", name: "Historic", type: "urn:tag:decor:qloo", via: ["the family's taste"], from: ["E1", "E2"] },
    T4: { eid: "T4", name: "Courtyard", type: "urn:tag:setting:qloo", via: ["the family's taste"], from: ["E1"] },
    T5: { eid: "T5", name: "Artisanal", via: ["the family's taste"] },
    T6: { eid: "T6", name: "Calm", via: ["Sara & Ali's taste"] },
    T7: { eid: "T7", name: "Garden", via: ["the family's taste"] },
    T11: { eid: "T11", name: "Leafy", via: ["how DHA Phase 6, Lahore feels"] },
    T13: { eid: "T13", name: "Café culture", via: ["how DHA Phase 6, Lahore feels"] },
    P2: { eid: "P2", name: "Interwood Mobel", address: "Main Boulevard", via: ["furniture store in DHA Phase 6"] },
  },
};

export async function* tasteScript(input: TasteInput): AsyncGenerator<Step> {
  yield ev("step", { id: "resolve", message: "Finding your favourites in Qloo's taste graph" });
  yield 700;
  const found = input.people.flatMap((p, i) =>
    p.favourites.map((f, j) => ({ eid: `E${i * 10 + j + 1}`, who: p.label, asked: f.name, name: f.name, type: f.kind })),
  );
  yield ev("favourites", { found, missing: [] });
  yield 600;
  yield ev("step", { id: "taste", message: "Reading the taste behind them" });
  yield 900;
  profile.favourites = found;
  yield ev("profile", profile);
  yield ev("step", { id: "explore", message: "Following the threads that matter for your home" });
  yield 700;
  yield ev("step", { id: "x1", message: "Asking Qloo which destinations people with this taste love", tool: "qloo_similar" });
  yield 800;
  yield ev("step", { id: "x2", message: "Looking for furniture stores in DHA Phase 6 that suit the family", tool: "qloo_places" });
  yield 800;
  yield ev("step", { id: "write", message: "Turning your taste into architecture" });
  yield 1400;
  const taste: Taste = { input, profile, style, at: new Date().toISOString() };
  yield ev("taste", taste);
}
