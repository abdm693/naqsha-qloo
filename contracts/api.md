# Naqsha HTTP API (FastAPI, same origin as the SPA)

**Identity.** The MVP runs without auth. The client generates a UUID once, stores it in `localStorage["naqsha.uid"]` and sends it as `X-Naqsha-User` on every request. That UUID defines the workspace.

**Streaming.** Long operations stream **SSE over POST**. The response is `text/event-stream`, and each event has this form:

```
event: <name>
data: <json>
```

A blank line ends each event. The client reads it with `fetch()` plus a `ReadableStream` parser (see `web/src/api/sse.ts`). Every stream ends with `event: done` or `event: error` (`{message, recoverable}`). The server sends `event: ping` every 15 s as a keepalive.

TypeScript shapes come from `contracts/plan.ts` (`BuildingPlan`, `ComplianceReport`) and the shapes below.

## Types

```ts
type Stage = "setup" | "concepts" | "planning" | "building" | "ready" | "revising";

interface Brief {
  city: string;                 // "Lahore"
  authority: Authority;         // "LDA" (DHA/BAHRIA flagged: own bylaws)
  scheme?: string;              // "Johar Town"
  coordinates?: { lat: number; lng: number };
  plot: { width_ft: number; depth_ft: number; area_marla: number; corner: boolean };
  facing?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  storeys: number;              // 1..3 (LDA max 3)
  basement: boolean;
  bedrooms: number;
  bathrooms: number;
  spaces: string[];             // "drawing", "tv_lounge", "dining", "kitchen", "dirty_kitchen", "servant_quarter",
                                // "car_porch:2", "lawn", "prayer", "store", "laundry", "roof_terrace", "study", "gym"
  style: string;                // "Modern Contemporary" | "Spanish" | "Classic" | "Minimalist" | "Mediterranean" | "Mughal Revival" | "Industrial" | free text
  style_notes?: string;
  inspiration_image_url?: string;
  budget?: "economy" | "standard" | "premium" | "luxury";
  notes?: string;
  auto_filled: string[];        // facts Naqsha chose: fields the user skipped or Naqsha changed, plus "corner" (assumed
                                // mid-row), "storeys" (also when capped) and "porch" (the default car porch)
  corner_stated?: boolean;      // true only when the family said corner or mid-row
  storeys_asked?: number;       // what they asked for when the authority capped storeys
}

interface Envelope {            // from the LDA engine, as soon as the plot is known
  authority: Authority; band: string;
  setbacks_ft: { front: number; rear: number; left: number; right: number };
  side_space_note?: string;     // e.g. "5 ft side space on one side"
  max_coverage_pct: number; max_far: number; max_height_ft: number; max_storeys: number;
  buildable_rect: Rect;         // plan ft
  max_ground_coverage_sqft: number;
  notes: string[];              // short plain-English bullets
}

interface Chip { label: string; value: string; image_url?: string; hint?: string }

interface ChatMessage {
  id: string; role: "user" | "assistant"; text: string; created_at: string;
  chips?: Chip[];               // one-tap answers for the current question
  multi?: boolean;              // chips are multi-select
  input?: "text" | "number" | "plot" | "map" | "style" | "rooms" | null;  // special widget to show
  field?: string;               // Brief field being asked about
  allow_skip?: boolean;
}

interface Concept { id: string; url: string; prompt: string; model: string; created_at: string; parent_id?: string; instruction?: string }

interface DesignSection { name: string; layer: Layer; code: string }   // Layer from house-sdk.d.ts

interface Change { id: string; summary: string; kind: "plan" | "section"; targets: string[]; comment_ids: string[] }

interface Version {
  id: string; n: number; created_at: string; parent_id?: string;
  plan: BuildingPlan; sections: DesignSection[]; compliance: ComplianceReport;
  changes?: Change[];           // vs the parent version (revisions)
  status: "building" | "ready" | "failed";
  thumbnail_url?: string;
}

interface Project {
  id: string; name: string; created_at: string; updated_at: string; stage: Stage;
  brief: Brief | null; envelope: Envelope | null;
  concepts: Concept[]; selected_concept_id: string | null;
  versions: { id: string; n: number; created_at: string; status: Version["status"]; summary?: string }[];
  current_version_id: string | null;
  thumbnail_url: string | null;
}

interface CommentAnchor {
  position: [number, number, number];  // world meters
  normal: [number, number, number];
  level?: string; room?: string; element_id?: string; kind?: string; label?: string;
}
interface Comment {
  id: string; version_id: string; text: string; anchor: CommentAnchor;
  camera: { position: [number, number, number]; target: [number, number, number] };
  snapshot_url?: string; created_at: string;
  status: "open" | "resolved" | "partial" | "rejected"; resolution?: string; resolved_in_version?: string;
}
```

## Endpoints

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ok, models}` |
| GET | `/api/samples` | | `{projects: Project[]}`: finished example homes, shown in the workspace as "Explore a sample home" |
| POST | `/api/projects/{pid}/clone` | `{name?}` | `Project`: copies a sample (or your own project) into your workspace, including versions and comments |
| GET | `/api/projects` | | `{projects: Project[]}` (newest first) |
| POST | `/api/projects` | `{name?}` | `Project` |
| GET | `/api/projects/{pid}` | | `Project` |
| PATCH | `/api/projects/{pid}` | `{name?, brief?}` | `Project` (patching the brief recomputes the envelope) |
| DELETE | `/api/projects/{pid}` | | `{ok}` |
| GET | `/api/projects/{pid}/messages` | | `{messages: ChatMessage[]}` |
| POST | `/api/projects/{pid}/intake` | `{message?: string, action?: "start" \| "skip_question" \| "skip_all", chips?: string[]}` | **SSE**: `message.delta {text}` · `message {ChatMessage}` · `brief {brief, envelope}` · `intake.complete {brief, envelope}` · `done` |
| GET | `/api/lda/envelope` | `?width_ft&depth_ft&authority=LDA&corner=false` | `Envelope` |
| POST | `/api/lda/check` | `{plan}` | `ComplianceReport` |
| POST | `/api/projects/{pid}/concepts` | `{count?: 4, instruction?: string, base_concept_id?: string}` | **SSE**: `concept.started {index, prompt}` · `concept {index, concept}` · `concept.failed {index, message}` · `done` |
| POST | `/api/projects/{pid}/concepts/{cid}/select` | | `Project` |
| POST | `/api/projects/{pid}/design` | `{}` | **SSE**: `stage {stage: "plan" \| "compliance" \| "fix" \| "build" \| "save", message}` · `plan {plan, attempt}` · `compliance {report, attempt}` · `section {section: DesignSection, index}` · `progress {chars}` · `version {version: Version}` · `done` |
| GET | `/api/projects/{pid}/run` | | **SSE** replay of the running design/revise pipeline (all events so far, then live); **204** if none. Call on project load to resume after a refresh. POST /design and /revise also re-attach if a run is already active. |
| GET | `/api/projects/{pid}/versions/{vid}` | | `Version` |
| POST | `/api/projects/{pid}/versions/{vid}/repair` | `{section: string, error: string}` | **SSE**: `section {section, index}` · `done` (Argon fixes one failing section) |
| POST | `/api/projects/{pid}/versions/{vid}/thumbnail` | `{image_data_url}` | `{url}`: stores a viewport capture as the version and project thumbnail. Call it after the first build. |
| POST | `/api/projects/{pid}/versions/{vid}/asbuilt` | `{summary: AsBuiltSummary}` | `ComplianceReport` (as-built checks, e.g. facade projections) |
| GET | `/api/projects/{pid}/comments` | `?version_id` | `{comments: Comment[]}` |
| POST | `/api/projects/{pid}/comments` | `{version_id, text, anchor, camera, snapshot_data_url?}` | `Comment` |
| PATCH | `/api/projects/{pid}/comments/{cid}` | `{text?, status?}` | `Comment` |
| DELETE | `/api/projects/{pid}/comments/{cid}` | | `{ok}` |
| POST | `/api/projects/{pid}/revise` | `{version_id, comment_ids?: string[], instruction?: string}` (which comments: see "Revise" below) | **SSE**: `stage` · `changes {changes: Change[]}` · `plan` · `compliance` · `section` (changed sections only) · `comment {comment}` (resolution) · `version {version}` (with `version.summary`, the rail label) · `done` |
| POST | `/api/projects/{pid}/render` | `{image_data_url, prompt?, version_id?}` | `{url}`: a photoreal AI render of that viewport |
| GET | `/api/assets/{path}` | | Image bytes, proxied from GCS (cacheable) |

`AsBuiltSummary` is produced by the engine (`web/src/engine`):

```ts
interface AsBuiltSummary {
  objects: { id: string; layer: Layer; kind?: string; level?: string; room?: string;
             bbox_ft: { min: [number, number, number]; max: [number, number, number] } }[];  // plan ft: [x, y, h]
  section_errors: { section: string; error: string }[];
  checks?: { id: string; title: string; status: "pass" | "warn" | "fail"; message: string; element_ids?: string[] }[];
}
```

## Accounts and collaboration (simple by default)

### Identity
- **Google Identity Platform**, email + password (already enabled). The SPA calls the Identity Toolkit REST API (`accounts:signUp`, `accounts:signInWithPassword`, `securetoken.googleapis.com/v1/token` to refresh) with the browser key from `GET /api/config`.
- The ID token goes in `Authorization: Bearer <idToken>`. The backend verifies it with `google.oauth2.id_token.verify_firebase_token(token, audience=PROJECT)`.
- **Guests still work.** With no token, `X-Naqsha-User: <guest uuid>` is used as today. Sign-in is offered, never forced. The prompts are "Save your work: create an account" and "Share".
- On the first sign-in, `POST /api/me/claim {guest_id}` moves the guest's projects to the account, so nothing is lost.

### Roles: three, named in plain words
| Role | Who | Can do |
|---|---|---|
| **Owner** | Creator | Everything: share, invite, design, revise, delete |
| **Team** | Architects and colleagues invited by email | Design, comment, run revisions |
| **Client** | Anyone with the client link, or invited as client | View the plan and 3D, walk, comment and reply. No editing or revising |

### Sharing UX: one "Share" button and one dialog
- **Invite by email**, with a role select (Team / Client) and an "Invite" button. People who already have access show as avatar rows with a role menu and Remove.
- **Client link**: a toggle labelled "Anyone with the link can view and comment", with Copy link. It opens `/s/<token>`, a calm read-only client view (plan, 3D and walk, comments). The visitor's name is asked once, on their first comment, if they aren't signed in.

### Comments become a conversation
- Every comment has an **author** `{id, name, role}` and an initials avatar coloured by role. Replies form a thread under it.
- Filter chips: All · Mine · Team · Client · Open · Resolved.
- **Revise uses the open comments.** The owner or team sees "Apply 5 open comments" and can untick any. The agent's resolution is posted as a reply from "Naqsha" in the thread, so clients see the answer where they asked.

### API additions
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/config` | | `{auth: {api_key, project_id}}` |
| GET | `/api/me` | | `{user: {uid, email, name}}` or 401 |
| POST | `/api/me/claim` | `{guest_id}` | `{moved: n}` |
| GET | `/api/projects/{pid}/members` | | `{members: [{uid?, email, name?, role, status: "active" \| "invited"}], share: {enabled, url?}}` |
| POST | `/api/projects/{pid}/members` | `{email, role: "team" \| "client"}` | member |
| PATCH / DELETE | `/api/projects/{pid}/members/{email}` | `{role}` | |
| POST | `/api/projects/{pid}/share` | `{enabled}` | `{enabled, token, url}` |
| GET | `/api/share/{token}` | | `{project (public fields), version, comments, role: "client"}` |
| GET | `/api/share/{token}/meta` | | `{current_version_id, versions: [{id, n}]}` (no plan, no comments; what the client link polls) |
| POST | `/api/share/{token}/comments` | `{author_name, text, anchor, camera, snapshot_data_url?}` | Comment |
| POST | `/api/projects/{pid}/comments/{cid}/replies` (and `/api/share/{token}/comments/{cid}/replies`) | `{text, author_name?}` | Comment |
| POST | `/api/projects/{pid}/revise` | adds `{instruction?: string}` | Conversational edits without pins ("make the kitchen bigger") |

- `Comment` gains `author {id, name, role}` and `replies: [{id, author, text, created_at}]`.
- `Project` gains `role` (the caller's role) and `members_count`.

## Overhaul additions (2026-10-17)

### Brief additions
`floors` is the per-floor program, `water_tank` the tank type, `solar` the rooftop plan, and `preferences` the soft wishes, recorded verbatim. Example:

```json
{
  "floors": [{"level": "ground", "rooms": ["drawing", "kitchen", "dirty_kitchen", "bedroom:1", "bath:2"]},
             {"level": "first", "rooms": ["bedroom:3", "bath:3", "lounge"]}],
  "water_tank": "plastic | concrete",
  "solar": "none | ready | panels",
  "preferences": ["open kitchen", "parents' bedroom on ground floor"]
}
```

- `ready` means the roof is kept clear for panels later; `panels` means they are included now.
- `notes` are appended to, never overwritten.

### Concepts
- `Concept.night_url?`: the same image at night, with the same camera, made by editing the day image.
- `POST /api/projects/{pid}/concepts/night` `{ids?: string[]}` is an **SSE** stream: `concept {index, concept}` (with `night_url` filled in), then `done`. The UI's Day/Night toggle calls it once, lazily.

### Compliance
- `ComplianceCheck.category`: `"lda"` (regulation) or `"livable"` (Naqsha planning rules: room independence, reachability, stairs to the roof, guards, doors, walking space).
- The UI shows two groups: **LDA rules** and **Livable home**.

### Revise
`POST /api/projects/{pid}/revise` takes `{version_id, comment_ids?: string[], instruction?: string}`.
- Which comments are applied:
  - `comment_ids` given: exactly those (any not resolved yet, on any version); `[]` means none.
  - `comment_ids` missing **with** an `instruction`: none. What was typed (House, Plan or Revisions Ask, the compliance sheet's Fix) is the whole ask, so a comment held back in the chooser stays open, with no reply.
  - `comment_ids` missing **without** an `instruction`: every open comment on the version (the Next pill's "Apply open comments").
- With `instruction` and no comments, it runs a conversational edit, e.g. "make the kitchen bigger" typed into the Ask field.
- The agent's resolutions are also added as a reply from `{id: "naqsha", name: "Naqsha", role: "agent"}`.
- The new version's `source` is `{comment_ids, instruction, answer?}`: `answer` is Naqsha's answer to the typed request (what changed, in feet and inches). The `version` event's `version.summary` is the label the version rail shows.
- Earlier answers are kept: the reviser sees every comment resolved in the version's lineage, and a later request that would shrink a window or room an earlier comment asked for restores it (or, when a rule forces it, says so in that earlier thread).

### Samples
`POST /api/projects/{sample}/clone` returns the caller's copy of that sample while it is untouched (the name it was made with, no comments, replies or versions of its own; refreshed in place when the sample has changed since). Otherwise, or with `{fresh: true}`, it makes a new copy. Copies drop the "Sample · " prefix (`"10 marla modern home, Johar Town"`), a second copy in the same workspace is named `"… (2)"`, and `cloned_from` names the sample.

### Setup messages
- `ChatMessage.understood?` is `{guaranteed[], preferences[], assumptions[]}`, the "Here's what I understood" card.
- `ChatMessage.suggestions?` holds what's-next prompt chips.
- `input: "floors"` opens the per-floor program editor. It sends chips such as `floor:ground=drawing,kitchen,dirty_kitchen,bedroom:1,bath:2` and `floor:first=bedroom:3,bath:3,lounge`.
- Tank and solar answers use chips: `tank:plastic` or `tank:concrete`, and `solar:none`, `solar:ready` or `solar:panels`.

### Backend notes (added by the backend track, all additive)
- **Chips the setup parses without a model** (instant replies): `plot:WxD`, `corner:true|false`, `facing:N` (or `N`…`NW`), `storeys:n`,
  `bedrooms:n`, `bathrooms:n`, `basement:true`, `coords:lat,lng`, `floor:<level>=<rooms>`, `floors:auto` ("decide for me"),
  `tank:…`, `solar:…`, `style:<name>` (or a style name), `budget:<tier>`, an authority (`LDA`, `DHA`…), space ids and `car_porch:n`.
  Send the chip values in `chips` and the label in `message`. Anything else goes to the conversational agent.
- **Setup greeting**: `action: "start"` on an empty chat returns "Tell me about the plot and who will live there…" with `suggestions`
  (example first messages). The agent asks at most: location, plot, facing, storeys, rooms, `floors`, `water_tank`, `solar`, style.
- **`intake.complete`** is sent once, when the brief first becomes complete. Later edits send `brief` + `message` only; if a version
  exists the stage never regresses and `Project.brief_changed` becomes true (cleared by the next design or revision).
- **Compliance checks** carry `category`, `unit` (`"ft"`, `"sq ft"`, `"%"`, `"sides"`…) and, when failing, `fix`. Livable rules
  include named summary passes (`plan.rule.independence`, `.circulation`, `.stairs`, `.roof_door`, `.openings`, `.brief`).
  `POST /api/lda/check` also takes an optional `brief` (enables the brief-adherence rules).
- **Design stream**: starts with `run {kind, started_at, elapsed_s}` (also on re-attach); stage `review` is the architect's
  self-review of the drawn floors; a `stage` with `busy: true` reports a model back-off ("Busy right now, retrying in 20 s…").
  `Version` gains `review`, `plan_images` (one PNG per level), `fix_history` and, for revisions, `source`.
- **Concepts** gain `title` and `summary` (the design take). `POST /concepts/night` without `ids` does the latest four.
- **Sharing**: `GET /api/share/{token}/versions/{vid}` and `GET /api/share/{token}/comments` (polling) also exist. Share comments
  take an optional `version_id` (default: the current version). `GET /members` also returns the caller's `role`; the share
  `token`/`url` are only returned to the owner and team.
- **Comments**: `POST /comments` and `/replies` accept `author_name` (shown for guests). Naqsha's revision replies carry
  `author {id: "naqsha", role: "agent"}` plus `status` and `version_id`. Clients may edit or delete only their own comments.
- **Revise**: changes made for the typed `instruction` carry `from_request: true` (their `comment_ids` list only real comments);
  the resolution of the request is also sent as a final `stage` message. Plan edits may not add any LDA or livable failure the
  version didn't already have; failures that were already there stay visible in the new version's report.
- **Comment authors** (round 1): no comment payload (share link, `/comments`, replies, the revise stream's `comment` events)
  carries a raw uid or guest id. `author.id` is an opaque per-project handle `"a_" + 16 hex` (stable within the project, so
  pins and threads still group by author); the owner's own app keeps the caller's own raw id. Every comment and reply has
  `mine: boolean`, computed for the caller (share endpoints read the optional `X-Naqsha-User` / Bearer identity); use it
  instead of comparing ids.
- **Approvals**: `POST /api/share/{token}/comments` takes `kind: "approval"` (the client's "Approve vN"; the text
  "Approved version N." on a general anchor is also recognised). It is stored `status: "resolved"`, `kind: "approval"`: never
  counted as open, never pre-ticked, applied or revised. General notes (no `room` / `element_id` in the anchor) are nudged
  sideways so their pins don't stack: 0, +s, -s, +2s along x from the anchor, then the next four 0.9 s higher, with s a quarter
  of the plot width (2.67 m on a 35 ft plot, at least 1.6 m); a slot within 0.75 s of another general pin is taken.
- **Open comments follow new versions**: when a design or revise run saves a new current version, every comment still
  `open` on the version it replaces (including ones posted while the run was going) moves to the new version, keeping its
  anchor and thread, with `from_version_id` = the version it was written on. Resolved, partial and rejected threads stay
  where they were answered. `revise {comment_ids}` accepts open comments from any version.
- **Brief PATCH**: `preferences` in `PATCH /projects/{pid} {brief}` replaces the list (`[]` clears it). Storeys are capped
  at the authority's maximum (DHA: 2). A name set with `PATCH {name}` is kept; an auto-made name follows plot changes.
- **Review notes**: the self-review's unresolved issues are livable `warn` checks `review.<n>` in the version's report (with
  `severity` major/minor and `fix`), and the version summary ends with "· N review notes". A revision keeps the notes about
  rooms it didn't change.
- **New planning checks (round 1)**, all `category: "livable"`: `plan.stair.door_under_flight:<door>` (a door under a stair's
  flights or mid-landing), `plan.opening.clash:<opening>` (two openings closer than 0.3 ft on one wall; fail with a door, else
  warn), `plan.circulation.porch:<porch>` (fewer 9 × 18 ft bays than `car_porch:N`; `value`/`limit` in cars) and
  `plan.circulation.porch_walkway:<porch>` (no 3′6″ path past the parked cars to the door), `plan.privacy.dressing:<room>`,
  `plan.circulation.balcony_links_bedrooms:<deck>` (now a fail, over touching balconies and terraces),
  `plan.open_space.covered:<room>` (a courtyard roofed over by a higher floor; its windows no longer count as daylight).
  `room.vent:<bath>` is a fail with no opening at all (a warn under 2 sq ft). Check titles and messages never contain element
  ids (they stay in `element_ids` and `fix`); LDA stair checks are titled "Ground → first stair" with "19 risers of 6.95 in,
  3′6″ wide…"; `plan.roof.solar` reads "64% kept clear (min 55%)…" with `unit: "%"`.
- **Round 2 checks and brief marks**: `plan.privacy.wc_into_dining:<bath>` is now a fail (a powder room or common bath whose
  only door opens into the dining room); new fail `plan.room.dressing_size:<dressing>` (short side under 5 ft or under
  25 sq ft; `value`/`limit`/`unit` give the failing figure). The setup keeps `auto_filled` honest for "You said": "corner"
  is in it from the moment the plot is known until the family says corner or mid-row (`corner_stated: true`), "storeys"
  when the authority capped the count (`storeys_asked` holds what they asked for; the card reads "Kept to 2 storeys: DHA's
  limit"), and "porch" when the car porch came with Naqsha's default spaces. The brief panel's whole-brief PATCH counts only
  changed fields, and facts whose mark it removed, as the family's word.
- **Round 3**:
  - New fail `plan.privacy.wc_on_entry:<bath>`: a powder room or common bath door that faces the main door across the room it
    opens into, or sits within 30° of the main door's line and within 15 ft ("From the main door you look straight into the
    Powder Room…"). New warns `plan.circulation.lobby_crowded:<lobby>` (the lobby inside the main door is under 5 ft deep
    with 4 or more doors) and `plan.circulation.porch_bike:<porch>` (the brief mentions a motorbike and no 3 × 7 ft bay is
    left beside the cars and the walkway).
  - `plan.circulation.porch` counts bays as the engine parks them: a bay may be 14 ft deep where the car's tail can stand
    up to 4 ft out over the porch's open drive-in edge.
  - The brief may hold the space `motorbike`. A "terrace" in a first- or second-floor program is a terrace on that floor,
    never `roof_terrace`.
  - At the authority's storey limit, every brief write (setup turns, the brief PATCH, the start of a design) moves enclosed
    roof rooms down (laundry, store and servant rooms to the ground floor; gym, kitchenette and the rest to the top floor),
    with one sentence ("DHA counts a roof room as a storey, so I've put the laundry by the dirty kitchen.").
  - `Version.review` is stored on every design run. A run that used every plan attempt (or ran long) gets the critique only:
    `{verdict, summary, issues, applied: false, open_issues, revision: "skipped_time"}`, with its open issues as
    `review.<n>` rows. A critique past its timeout (`REVIEW_CRITIQUE_S`, 90 s) is `{verdict: "skipped", reason:
    "timeout"}`, and the run goes on. Fix-round stages read "Fixing N problems (round 1 of 2)…".
- **Clone**: `{fresh: true}` forces a new copy of a sample. Opening a sample again returns your copy (one copy, even from
  parallel requests); an untouched copy of an older sample (no messages, comments, versions or concepts of its own) is
  refreshed in place with the current sample.
- **Thumbnails**: `GET /api/assets/{path}?w=320|640|960` serves a WebP that wide (made once, cached); `thumbnail_url` in
  project payloads points at the 640 px variant.
- **Errors**: an invalid or expired Bearer token returns **401** ("Your sign-in has expired…"); refresh the token and retry.
  A role that may not do something gets **403**; a project you can't see is **404**.
`checks` lists what the engine had to repair or could not repair while building (stair fit, roof door moved to the
top landing, guard rails added, openings not built, furniture moved or dropped, blocked walking paths, cars that
had no parking bay). The backend can append them to the as-built report with `category: "livable"`.

## Local home profile (2026-10-30)
- `Project.homes` (`HomeProfile`, api-types.ts): what a family home is in this place, for any place, Lahore included. Researched with Tavily and written by Gemini Flash in `agents/homes.py`, cached by place for 90 days (the `rulepacks` collection, key `home-<place>`). Concepts, plan, 3D build and photos read it; nothing else decides form, roof, parking or rooms.
- `Brief.local` is its digest (`locale.digest`), for code that has only the brief. `Brief.units` is what the family spoke in; `Brief.roof_form` and `Brief.home_form` are set only when they asked, and beat the profile.
- **Setup**: the one required fact is the place (`intake.to_ask` returns `["place"]` or `[]`). There is no question sequence: a turn with the place known fills the rest from the profile as assumptions and sends the card. When the profile isn't ready within 2 s, the turn sends a short `message` first and holds the stream: `brief`, the card `message` and `intake.complete` follow when it lands (about 15 s), then a `message` about the local rules if they had to be looked up. The question bank (`intake.question`) only serves a fact reopened with "Don't assume". The agent may ask one follow-up in plain words (`field: "other"`, no chips).
