---
name: Naqsha
description: A family's home designed around what they share, seen from the street at dusk and walked through indoors.
colors:
  lamp: "#FFC46B"
  lamp-soft: "#FFE3B0"
  dusk-1: "#0E1432"
  dusk-2: "#171F48"
  dusk-3: "#252E63"
  dusk-line: "#48528C"
  dusk-ink: "#F6F1E8"
  dusk-ink-2: "#BCC1DC"
  canvas: "#F8F4ED"
  surface: "#FFFDF9"
  surface-2: "#F2ECE3"
  surface-3: "#E9E1D5"
  line: "#E9E1D6"
  line-strong: "#D6CBBC"
  ink: "#1E1915"
  ink-2: "#4A4039"
  ink-3: "#6E6359"
  ink-4: "#A89D91"
  accent: "#6B2A5E"
  accent-press: "#56214B"
  accent-soft: "#F6EBF2"
  accent-line: "#DDBDD2"
  hud: "#1B1714"
  hud-ink: "#F7F2EC"
  hud-ink-2: "#D3C9BF"
  hud-accent: "#F2B8DB"
  pass: "#16704C"
  pass-soft: "#E6F2EA"
  warn: "#93520A"
  warn-soft: "#FBEFD9"
  fail: "#B42A1F"
  fail-soft: "#FBE9E5"
  plan-bed: "#F1ECF5"
  plan-wet: "#E6F0F2"
  plan-living: "#F4F0E9"
  plan-service: "#EDE7DE"
  plan-outdoor: "#E8F0E3"
  author-1: "#0D7C72"
  author-2: "#6A4FD6"
  author-3: "#C23F78"
  author-4: "#A8641A"
  author-5: "#4F6378"
  author-6: "#2F7A3A"
typography:
  display-hero:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.2rem, 9.2vw, 6rem)"
    fontWeight: 700
    lineHeight: 0.96
    letterSpacing: "-0.035em"
  display-words:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.2rem, 11vw, 6rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.8rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  headline-wide:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "4rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  field-dusk:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  hero:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.75rem, 5.8vw, 5.5rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.045em"
  display:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 700
    lineHeight: "3.1rem"
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Bricolage Grotesque, Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: "2.2rem"
    letterSpacing: "-0.025em"
  heading:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.625rem"
    letterSpacing: "-0.01em"
  body-lg:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: "1.625rem"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.375rem"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.125rem"
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "0.01em"
  numeric:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontWeight: 500
rounded:
  chip: "10px"
  control: "12px"
  dusk: "16px"
  card: "20px"
  panel: "28px"
  media: "32px"
  full: "999px"
spacing:
  chrome: "12px"
  chrome-wide: "16px"
  gutter: "20px"
  gutter-wide: "32px"
  stack-tight: "12px"
  stack: "24px"
  stack-loose: "32px"
  section: "64px"
components:
  lamp-button:
    backgroundColor: "{colors.lamp}"
    textColor: "{colors.dusk-1}"
    rounded: "{rounded.full}"
    padding: "0 28px"
    height: "52px"
  lamp-button-hover:
    backgroundColor: "{colors.lamp-soft}"
    textColor: "{colors.dusk-1}"
  lamp-button-disabled:
    backgroundColor: "{colors.dusk-3}"
    textColor: "{colors.dusk-ink-2}"
  dusk-input:
    backgroundColor: "transparent"
    textColor: "{colors.dusk-ink}"
    typography: "{typography.field-dusk}"
    padding: "12px 0"
  dusk-list:
    backgroundColor: "{colors.dusk-2}"
    textColor: "{colors.dusk-ink}"
    rounded: "{rounded.dusk}"
    padding: "6px 0"
  dusk-list-option-active:
    backgroundColor: "{colors.dusk-3}"
  lit-chip:
    backgroundColor: "{colors.lamp-soft}"
    textColor: "{colors.dusk-1}"
    typography: "{typography.body}"
    rounded: "{rounded.full}"
    padding: "4px 6px 4px 4px"
  dusk-pill:
    backgroundColor: "{colors.dusk-3}"
    textColor: "{colors.dusk-ink}"
    rounded: "{rounded.full}"
    padding: "6px 12px"
  dusk-pill-hover:
    backgroundColor: "{colors.dusk-line}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.full}"
  button-primary-hover:
    backgroundColor: "{colors.accent-press}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.full}"
  button-quiet-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "4px 12px"
  chip-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "44px"
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "26px"
    padding: "8px"
  media-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  hud-capsule:
    backgroundColor: "{colors.hud}"
    textColor: "{colors.hud-ink}"
    rounded: "{rounded.full}"
---

# Design System: Naqsha

## Overview

**Creative North Star: "The House at Dusk"**

A home is the people lit up inside it. Everything outside the house is one dusk: a drenched blue sky with a band of last light on the horizon, a dark street, and a house at street scale whose windows belong to the family. Each person is a window. It stays dark until they answer, and the room in the middle lights last, from the real overlap in the family's tastes.

The product moves through three places, and each has its own material. Outdoors (landing, the Heart, the private link, the workspace hero) is dusk blue with warm lamp light. Indoors (plan, lists, brief, concepts) is lamp-lit warm paper, where the family has stepped inside to work. The House view is a heads-up display of glass floating over the 3D home. Dusk is sparse and set large, with one sentence and one thing to press. Indoors is calm and denser, a working room with tools in reach.

This is a replacement world. It retires the cream ground with a saffron-to-plum gradient, the Plus Jakarta Sans display and the style-quiz card grid. The signature motion is a lamp coming on: it catches, dips, then holds, slowly and physically, and it has an instant equivalent under reduced motion.

**Key Characteristics:**
- Dusk blue ground, warm light as the only warm colour on screen
- Lit shapes on the dusk, with no boxed cards
- One display voice set large in the sky, Geist for everything you operate
- A house pinned to the foot of the viewport, copy in the sky above it
- Warm paper and brown shadows indoors, glass over 3D
- Pills for every action, underlines for fields on dusk

## Colors

Three worlds share one idea of warmth: blue outside, paper inside, dark glass over 3D, with lamp light carrying the warmth outdoors and jamun plum marking the next move indoors.

### Primary
- **Lamp** (#FFC46B): the light a person brings. Lit windows, the answered dot, the one button on a dusk screen, the caret, the focused underline.
- **Lamp Soft** (#FFE3B0): lamp light as text and fill. The words of the reveal, a chosen thing's chip, a lit window's name, the Lamp Button's hover.

### Secondary
- **Jamun** (#6B2A5E): the indoor accent for "next move" and "selected". White on it is 9.9:1. It sits clear of the compliance hues, so a primary button never reads as a warning.
- **Jamun Pressed** (#56214B): hover and press on indoor primary buttons.
- **Jamun Tint** (#F6EBF2) and **Jamun Line** (#DDBDD2): the fill and inset line of a selected chip, and the indoor text selection.

### Tertiary
- **Pass Green** (#16704C on #E6F2EA), **Warn Amber** (#93520A on #FBEFD9), **Fail Red** (#B42A1F on #FBE9E5): rule outcomes on the plan and errors indoors, each at least 5:1 on its own fill. Fail also fills the destructive button.
- **Plan fills** (`plan-bed`, `plan-wet`, `plan-living`, `plan-service`, `plan-outdoor`): pale room-type washes used only on the floor plan.
- **Author colours** (`author-1` to `author-6`): one identity colour per collaborator on comments and avatars.

### Neutral

Dusk, for outdoors:
- **Deep Dusk** (#0E1432): the sky's top, solid dusk sections, text on lamp fills.
- **Dusk Raised** (#171F48): the suggestion list and sample image wells.
- **Dusk Pill** (#252E63): quiet filled controls, an unanswered dot, the fallback initial behind a thumbnail.
- **Dusk Line** (#48528C): hairlines between rows, at 60% opacity on lists.
- **Dusk Ink** (#F6F1E8): headings and body on dusk.
- **Dusk Ink Muted** (#BCC1DC): secondary text and placeholders, 10.1:1 on Deep Dusk.

The sky itself is one fixed gradient: #0E1432 at 0%, #161E4A at 46%, #2A3268 at 70%, #5F5688 at 86%, #C28C78 at 97%, #E3AD82 at 100%. Those stops live in the sky alone.

Paper, for indoors:
- **Warm Ivory** (#F8F4ED): the page.
- **Warm White** (#FFFDF9): cards, sheets, fields.
- **Oat** (#F2ECE3) and **Pressed Oat** (#E9E1D5): hover, tracks, quiet chips, and pressed states.
- **Hairline** (#E9E1D6) and **Strong Line** (#D6CBBC): dividers and control borders.
- **Ink** (#1E1915), **Ink Soft** (#4A4039), **Ink Muted** (#6E6359): text, down to the lowest level allowed for reading, 5.3:1 on Warm Ivory.
- **Ink Faint** (#A89D91): placeholders and disabled states only, at 2.6:1.

Glass, for over 3D:
- **HUD Umber** (#1B1714): the glass tint and the base of the House view.
- **HUD Ink** (#F7F2EC), **HUD Ink Muted** (#D3C9BF), **HUD Pink** (#F2B8DB): text, secondary text at 4.7:1 over glass on the brightest sky, and the accent and focus colour.

### Named Rules

**The Lamp Means Someone Rule.** On the dusk, warm light belongs to a person or something a person does: a window they lit, their dot, the thing they chose, the one button they can press. The horizon and the neighbours' windows are the only other warmth, and they are scenery.

**The Three Worlds Rule.** Lamp lives outdoors, jamun lives indoors, HUD pink lives over 3D. A screen sits in one world. Indoors, lamp appears only as a small ring or dot on the family's own chosen or live thing.

**The Earned Light Rule.** The heart's light comes from data. It never lights on a guess, a timer or a loading state.

**The Compliance Hues Rule.** Green, amber and red mean rule outcomes and errors, indoors, and nothing else.

## Typography

**Display Font:** Bricolage Grotesque (with Geist, ui-sans-serif, system-ui). The optical-size axis is loaded from 12 to 96.
**Body Font:** Geist (with ui-sans-serif, system-ui, -apple-system)
**Label/Mono Font:** Geist Mono for tabular numbers, at weight 500

**Character:** Bricolage is a modern grotesque with warmth and a little irregularity, and it does the speaking at weight 700 with tight tracking. Geist is the quiet working face under it. The Urdu mark (نقشہ) in the wordmark uses Noto Nastaliq Urdu and nothing else does.

### Hierarchy

Outdoors:
- **Display Hero** (700, clamp(3.2rem, 9.2vw, 6rem), 0.96, -0.035em): the one sentence in the sky, capped at 12ch.
- **Display Words** (700, clamp(3.2rem, 11vw, 6rem), 0.98, -0.02em, Lamp Soft): the word or two the family shares.
- **Headline** (700, 2.8rem, rising to 4rem from 640px, 1.02, -0.03em): the single question or statement on a dusk screen.
- **Field Dusk** (700, 1.6rem, rising to 2rem from 640px, -0.02em): typing into the dusk is set as display, because the family's words are the content.
- **Reading text** (Body Lg, Dusk Ink Muted): at most one or two sentences, 30 to 34rem wide.

Indoors:
- **Hero** (700, clamp(2.75rem, 5.8vw, 5.5rem), 1, -0.045em), **Display** (700, 2.75rem/3.1rem, -0.035em), **Title** (700, 1.75rem/2.2rem, -0.025em): Bricolage, for page and section names.
- **Heading** (Geist 600, 1.25rem/1.625rem, -0.01em): panel and group headings.
- **Body Lg** (400, 1.0625rem/1.625rem) and **Body** (400, 0.9375rem/1.375rem): reading and UI text.
- **Label** (500, 0.8125rem/1.125rem) and **Caption** (500, 0.75rem/1rem, 0.01em): controls and small notes.

### Named Rules

**The One Voice Rule.** What the house says is Bricolage 700. What you operate is Geist. A line of dusk copy is one or the other, with no third voice.

**The Sentence Case Rule.** All type is sentence case with tight or neutral tracking. There are no eyebrows and no uppercase labels.

## Layout

**The Street Scale Rule.** On dusk screens the house is pinned to the foot of the viewport at full width, taking 38 to 58dvh and passing no pointer events. Copy sits in the sky above it on a higher layer. The drawing crops from the bottom centre, so the ground stays on the floor of the screen at any aspect ratio. Keep text above the 86% stop of the sky, since Dusk Ink Muted falls to 1.1:1 on the horizon band.

Dusk screens are a single left-aligned column in a centred container: 1200px on the landing, 1120px on the Heart, 640px on the phone-first private link. The gutter is 20px, 32px from 640px. Vertical rhythm is loose and made of plain margins (12px between heading and line, 24 to 32px before the action, 48px between questions), with sections 64px or more apart.

Indoors, content runs in a 1280px container with a 16px gutter (32px from 640px), and grids go from one column to two at 640px and three at 1024px. Chrome floats: top capsules and the dock are inset 12px, 16px from 1024px. Scrolling views start just under the capsules and fade their first 20px, so content never sits beneath them. Small controls keep a 44px hit area on touch screens and phones.

A view can walk from one world to the next as you scroll. On the Heart, the dusk ends in solid Deep Dusk and the family's profile opens below on Warm Ivory. The workspace does the same under its hero. The change is a hard edge: you have stepped inside.

## Elevation & Depth

Each world has its own answer. On dusk, depth comes from light: nothing casts a shadow except the lamp's glow and the one floating list. Indoors, surfaces lift on warm layered shadows built from a hairline, a contact shadow and a soft spread, all tinted brown. Over 3D, depth comes from glass, blurred 24px over the scene with an inset white hairline.

### Shadow Vocabulary
- **Lamp glow** (`box-shadow: 0 10px 34px -8px rgb(255 196 107 / .55)`): under the Lamp Button.
- **Answered glow** (`box-shadow: 0 2px 10px rgb(255 196 107 / .8)`): on a person's lit dot.
- **Dusk float** (`box-shadow: 0 24px 60px -20px rgb(4 6 20 / .9)`): the suggestion list.
- **e1** (`box-shadow: 0 0 0 1px rgb(74 52 30 / .07), 0 1px 2px rgb(74 52 30 / .05), 0 6px 16px -10px rgb(74 52 30 / .10)`): cards and panels at rest.
- **e2** (`box-shadow: 0 0 0 1px rgb(74 52 30 / .06), 0 2px 4px rgb(74 52 30 / .04), 0 18px 40px -16px rgb(74 52 30 / .22)`): card hover, menus.
- **e3** (`box-shadow: 0 0 0 1px rgb(74 52 30 / .06), 0 4px 10px rgb(74 52 30 / .05), 0 36px 80px -28px rgb(74 52 30 / .34)`): sheets and dialogs.
- **Focus halo** (`box-shadow: 0 0 0 4px rgb(107 42 94 / .20)`): indoor focus on paper only.
- **HUD focus** (`box-shadow: 0 0 0 2px #1B1714, 0 0 0 4px #F2B8DB`): a two-tone ring that keeps 3:1 against any sky in the 3D view.

### Named Rules

**The Light Is Lift Rule.** On dusk, a thing comes forward by glowing. Indoors it comes forward on a brown shadow. Neutral black shadows do not appear on paper.

## Shapes

Actions are pills everywhere. On dusk, the only filled shapes are the Lamp Button, the lit chip and the quiet pill, and fields are a single underline with no box. Indoors, corners step up with size: chips 10px, controls 12px, cards 20px, panels 28px, media 32px. Dusk images and the suggestion list use a gentler 16px. Thumbnails are always circles. Windows are the one square-cornered form in the world, with mullions dividing the glass, and the house is drawn in flat silhouettes with no outlines.

## Components

### Lamp Button
The one warm thing you can press. A dusk screen has one.
- **Shape:** full pill, at least 52px tall, 28px side padding, 1.0625rem Geist 600.
- **Color:** Lamp with Deep Dusk text, 11.5:1, on the lamp glow.
- **Hover / Focus:** fills to Lamp Soft over 200ms; focus is a 4px ring of lamp at 40%.
- **Disabled:** Dusk Pill with Dusk Ink Muted and no glow. While a form is incomplete its label counts down ("2 more").
- **Loading:** a breathing Deep Dusk dot before the label.

### Dusk Actions
- **Text link:** Body in Dusk Ink Muted, warming to Dusk Ink on hover, underlined with a 4px offset (Skip, Replay, Change my answers). The landing's second action is Dusk Ink with a Dusk Line underline that turns lamp on hover.
- **Quiet pill:** Dusk Pill with Dusk Ink, 12px by 6px, moving to Dusk Line on hover. "Send link" is the model, and it swaps to a check and "Copied" for 1.8 seconds.

### Dusk Fields
- **Style:** transparent, a 2px Dusk Line underline, Field Dusk type, a lamp caret, Dusk Ink Muted placeholder.
- **Focus:** the underline turns lamp.
- **Picker:** the empty field cycles through human prompts every 3.2 seconds. Suggestions float in a Dusk Raised list with a Dusk Pill highlight, a 36px circular thumbnail and the name. Anything it doesn't know stays in the person's own words.

### Lit Chips
- **Style:** full pill in Lamp Soft with Deep Dusk text at Body 500, a 28px circular thumbnail and a remove control with a 24px target.
- **State:** arrives by scaling from 0.92 and fading in, with neighbours reflowing on layout animation.

### Person Row
A line of the family. A 10px dot (Dusk Pill while dark, Lamp with the answered glow once lit), the name in Body Lg, then the state at the end: "Light's on" in Lamp Soft, or the send action. Rows are at least 48px tall and divided by a Dusk Line hairline at 60%.

### Buttons (indoors)
- **Shape:** full pill. Heights of 32, 40 and 48px with 13, 15 and 16px labels in Geist 500.
- **Primary:** Jamun with white text, a faint top highlight and a plum contact shadow, so it sits on the page like a pressed tile.
- **Hover / Focus:** Jamun Pressed on hover, the focus halo on focus, a 0.97 scale press over 120ms.
- **Secondary / Quiet / Ink / Danger:** Warm White with a Strong Line border; transparent Ink Soft warming to Oat; Ink with white text; Fail with white text.
- **HUD:** glass with HUD Ink.

### Chips
- **Style:** 10px radius, 28 or 32px tall, Oat with Ink, or Warm White with a Strong Line inset.
- **State:** selected is Jamun Tint with Jamun text and a Jamun Line inset. Over 3D, chips use white at 10% and selected is solid white with Ink.
- **Status:** a 6px tone dot with a label, on `glass-light` when it sits on an image.

### Cards / Containers
- **Corner Style:** 20px for media cards, 28px for panels and empty states.
- **Background:** Warm White, e1 at rest.
- **Media:** a 4:3 image with no text on it, heading and Ink Muted caption underneath. On hover the image scales 1.02 over 600ms and the frame lifts to e2. Badges sit on the image in `glass-light`.
- **Loading:** an Oat block with a shimmer pass.

### Inputs / Fields (indoors)
- **Style:** 44px tall, 12px radius, Warm White with a border, 15px Geist.
- **Composer:** a 26px-radius grown field with an e1 shadow. It keeps paper on the workspace hero, and it switches to glass with a pink inset over 3D.
- **Focus:** Jamun border with the focus halo. When a field sits in a rounded wrapper, the wrapper carries the ring.
- **Error / Disabled:** a Fail border and caption, never a red fill; disabled is Oat with Ink Muted.

### Navigation
- **Style:** floating capsules. The view switch is a 48px pill in `glass-light` indoors, `glass-hud` over 3D, and dusk-blue glass (`rgb(23 31 72 / .78)`) on the Heart. A sliding thumb marks the current view on the shared spring.
- **Landing:** only the white wordmark and one text link, on the sky.
- **Mobile:** the dock and capsules stay, inset 12px, and clear the safe area.

### The House (signature)
The drawing that carries the product. Wall gradient #2A3470 to #1C2455, roof #1A2152, ground #0A0E28, neighbouring silhouettes #111840 with a few windows lit #E9B26B at 50%. Each person takes a window slot, upper floor from the middle out, then the ground floor, then the eaves. Dark glass is #141B3F in a #070B1F frame with mullions. Lit glass runs #FFE7BD to lamp to #F2A24E, with a blurred spill onto the wall. A person's name sits under their window, in Lamp Soft once lit. The heart is the large room at the centre, with a 46-blur glow.

- **Lighting a window:** opacity 0, 0.75, 0.4, 1 over 1.1 seconds, easing out, with the spill fading in over 1.4 seconds.
- **The reveal:** first window at 700ms, one per second after that, a 1.2-second hold, the heart over 2.4 seconds, then the words 1.5 seconds later over 1.1 seconds.
- **Reduced motion:** every light is simply on, with no flicker and no delay, and the words appear at once. Scene titles state the count, so nothing depends on the animation.

## Do's and Don'ts

### Do:
- **Do** build every outdoor screen from the sky and the one Lamp Button, with one sentence and the house below.
- **Do** use Display Words in Lamp Soft for anything the family actually shares, and only that.
- **Do** step indoors for work: plan, lists, brief and concepts go on Warm Ivory with Warm White surfaces.
- **Do** use `glass-hud` for anything floating over the 3D house, with the two-tone HUD focus ring.
- **Do** tint indoor shadows brown (`rgb(74 52 30)`), matching e1 to e3.
- **Do** give every lit moment a reduced-motion state and a text equivalent.
- **Do** use `--ease-out` and the shared spring (stiffness 380, damping 34) for interface motion, and keep the slow lamp timing for lights only.
- **Do** use the family's own words and pictures as the visual content; a thumbnail is a circle.

### Don't:
- **Don't** put a boxed card around a control on the dusk.
- **Don't** add a warm colour outdoors that isn't lamp light, the horizon or a neighbour's window.
- **Don't** light the heart before the overlap is real.
- **Don't** bring back the saffron-to-plum gradient, Plus Jakarta Sans, or the `taste-*` colours on new surfaces.
- **Don't** use jamun or the compliance hues on dusk, or lamp as an indoor accent.
- **Don't** set text on the horizon band.
- **Don't** use eyebrows, uppercase labels or positive display tracking.
- **Don't** set reading text in Ink Faint.
- **Don't** name a data source anywhere in the app; the feature speaks in its own words.
