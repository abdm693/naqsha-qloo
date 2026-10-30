# Naqsha

## Product
Naqsha designs a family's home around what they share. Home is where the heart is: each person privately names what they love, Naqsha finds what the whole family has in common, and that becomes the heart of the house. What two people share becomes the spaces between them; what belongs to one person becomes their own room. The family ends with a floor plan checked against their city's rules and a 3D home they can walk through.

## Users
Primary: a family about to build or rebuild a home, anywhere in the world, deciding together. One person starts it, often on a phone, and invites the others (parents, children, a grandparent, possibly in another country). They are not designers and cannot name an architectural style, but they can name a film, a song and the place they miss.

Secondary: hackathon judges, who should see the real product through a family's eyes, with sample families one tap away.

## Mechanism
1. Each person answers separately, on their own link, without seeing the others.
2. The reveal: Naqsha shows what the family shares, in one or two words, drawn from the real overlap between their tastes.
3. The overlap shapes the plan: shared taste becomes the central room; pairs become in-between spaces; individual taste becomes private rooms.

Taste comes from Qloo on the server. The app never names Qloo or any data source to families; the feature's own words are used instead. Local building form (roof, lot, parking, room conventions, rules) comes from research for that place, because Qloo knows taste, not houses.

## Brand
Personality: intimate, warm, quietly surprising. It should feel like a family moment, not a software tool.
Copy: minimal. One idea, one picture, one sentence per screen; detail on demand. Human words only: no "not X but Y", no "Meet X", no slogans about speed. Lahore is one place among many, never the default.

## Must keep
- The walkable 3D house and comments.
- The floor plan checked against each city's rules.
- The name Naqsha and its Urdu mark (نقشہ), unless the owner says otherwise. (Inferred: not confirmed in the design round.)

## Free to replace
The current look: cream ground, saffron-to-plum gradient, Plus Jakarta Sans display, card grids.

## Platform
web (mobile-first for the personal link and the reveal; desktop for the plan and 3D house).

## Stack
React, Tailwind v4, motion, three.js; FastAPI on Cloud Run. Existing project: keep it.

## Accessibility
WCAG AA contrast, full keyboard use, reduced-motion alternatives for the reveal, and no information carried by animation alone.
