## Inspiration

A family builds a house once in a lifetime, and the conversation usually goes badly. One person talks, the rest nod, and the plan ends up belonging to whoever spoke first. Then the house comes off a stock template, and it could be anyone's.

"Home is where the heart is" sounds like a greeting card until you try to design from it. Where is the heart of a particular family? What does a mother who loves Fairuz share with a son who loves Dune? Nobody in the family can tell you, because nobody has asked them separately.

We had already built Naqsha, an agentic home designer that takes a family from one message to a bylaw-checked floor plan and a 3D house they can walk through. Qloo gave us a way to ask the question properly.

## What it does

**Everyone answers alone. What they share becomes the heart of the house.**

1. **Who's home?** Name the people who will live there. Each gets a window in a house at dusk and a private link.
2. **Each person answers alone**, on their own phone: the film they rewatch, the song that's home, the place they miss, picked from a live search with pictures. Their window lights up when they finish.
3. **The reveal.** When everyone has answered, the windows come on one by one and the heart lights last. It shows the words their tastes really share, and the actual favourites behind each word: for the Garcias, Patagonia for Elena and Mateo, Spider-Verse for Sofia and Mateo.
4. **The house grows around it.** What they share becomes the room at the centre of the plan. What's one person's alone becomes that person's room. The Garcias' plan wraps around a shaded back porch with a grill; Elena gets a sunlit design studio and Marco a music and art den.
5. **It's built for where you live.** Naqsha researches how homes are built in that place, then designs to it: a gabled Craftsman on a 50 × 140 lot in Austin, a brick house with a laneway garage on a 30 × 120 lot in Toronto, a villa with a guest majlis and a maid's room in Dubai, a courtyard house on 1 kanal in Lahore. Local rules, local units, local materials.
6. **Plan, walk, change.** The floor plan is checked against the city's own rules. The 3D house is written as code and furnished room by room. Walk through it, pin a note on any wall, and ask for a change.

The sample families on the landing page go straight to their reveal. No account needed.

## How Qloo is used

Qloo decides what the heart is. The language model never does.

- **Picking favourites.** `/search` powers the picker, with images, across films, artists, shows, brands, places and restaurants. A person chooses the exact entity they mean, which matters: a plain name search for "Selena" returned Selena Gomez in our first samples.
- **Reading each person alone.** Taste Analysis (`/v2/insights`, `filter.type=urn:tag`) runs once per person, on that person's favourites only, across aesthetic, style, lifestyle and emotional tags. Destinations carry few of those, so place-only answers fall back to Qloo's character, culture and scenery tags.
- **The heart is an overlap.** The heart words are the exact tags that appear in everyone's reading. Failing that, in most readings, and failing that, in the family's reading together. The app's wording follows the level, so it never claims more agreement than the data shows. Gemini is only allowed to choose among those words; anything else is thrown away in code.
- **The proof behind the word.** Taste Analysis returned no per-tag explanation on this API, so we read each favourite on its own to find which ones carry each shared word. That is what lets the reveal say Patagonia, for Elena and Mateo, instead of asking you to trust a summary.
- **A little of home.** If someone names where their heart lives, the place search near the new plot (`filter.location` with a radius, signalled by those favourites) can surface somewhere close that feels like it. We only show this when the results differ from what is simply popular there. When they didn't, in our tests, it stays hidden.
- **The style brief and rooms.** The family's tags and affinities feed the style brief, the concepts and each person's room, and the revision agent can ask Qloo what a café or a city feels like when a comment names one.

Only favourites and a place name go to Qloo: no names, emails or personal data.

**What Qloo adds that a model doesn't.** We tested this. Ask Gemini alone what a family has in common and a plain prompt gives you "Music, Mexico, Cities"; a prompt tuned for feeling gives lovely words like "soulful", and they change on each run. So the claim is narrow and we think it's the honest one: Qloo's words come from what people actually like, each person is read separately, and every word points to a real favourite. The list of shared words comes from the data; Gemini picks which ones lead, so that choice can vary between runs, but it can't add a word that isn't there.

## Measured impact

Every concept run also draws the same plot and brief without the family's taste, and a vision check scores both against the same checklist. That measures whether the design follows the taste brief; it doesn't prove the family would prefer it.

- **The Maliks, Lahore:** *Contemporary and traditional*, all four of them. The heart is a central courtyard veranda. 21% without their taste, 73% with it. 46/46 LDA rules.
- **The Garcias, Austin:** *Adventure and comfort*, most of them. A shaded back porch. 27% without, 79% with. 34/34 local rules.
- **The Al Mansouris, Dubai:** *Elegant and inspiring*, all four. A sunlit central majlis. 35% without, 88% with. 52/52 local rules.
- **The Parks, Toronto:** *Heartwarming*, all three. The cozy kitchen hearth. 55% without, 91% with. Their taste sits closer to a typical new house, so the gap is smaller. 34/34 local rules.

## How we built it

- **Agents:** Gemini 4 Argon writes the style brief, plans, 3D model and revisions; Gemini 3.8 Flash runs the setup conversation, home research and the heart's wording, on Vertex AI with Google's Agent Development Kit.
- **Local homes:** Tavily research plus Flash produce a cached profile of how homes are built in any place, which steers the brief, concepts, plan and 3D. Lahore is one profile among the rest.
- **Rules engine:** deterministic Python; other cities' rules researched and cited.
- **3D:** the house is a program the browser runs on three.js, including pitched roofs with cross-gables over lower wings.
- **App:** FastAPI on Cloud Run streaming each step over Server-Sent Events, with a React front end. A Playwright suite walks all four sample families on the live app.

## Challenges we ran into

- **Our first idea was wrong.** We started by designing from the places around the plot. Testing it showed the neighbourhood says little about the people moving in, and Qloo's nearby results lean commercial. We threw that away and rebuilt around the family.
- **Explanations came back empty.** Tags had no "because", so the first reveal had no proof. Reading each favourite alone fixed that, at the cost of a slower step, which now arrives just after the words.
- **Every house looked the same.** Rules and proportions were quietly inherited from Lahore: a water tank on an Austin roof, marla on a Toronto lot. Patching them one by one failed, so we removed the default place altogether and made every city earn its own profile.
- **A big brief on a small lot.** Our first Lahore and Toronto plans passed few checks because we'd asked for too much on too little land, and the fixer agents ran out of time. A more honest brief helped more than more retries did. Lahore's remaining problems were then fixed by one typed request to the product's own revision agent, which is why that sample opens on version 2.
- **A shared word isn't always a good word.** Taste data includes "marriage" and "athletes". We filter what can never describe a home and let the model choose among the rest. Some results still surprise us, like Parasite as heartwarming, and we show them as they are.

## Accomplishments that we're proud of

Four sample families in four countries, each with a house that looks like its own street and a heart that came from data rather than a guess. The whole reveal takes a few seconds and needs no explaining.

## What we learned

The most useful thing a taste API can do for a family is notice what they share without anyone having to say it.

## What's next

Real families. We want to know whether the words ring true to them, and whether the house they see is one they'd want.
