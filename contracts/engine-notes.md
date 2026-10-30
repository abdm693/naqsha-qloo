# House SDK: engine notes for design.js authors (pasted into Argon's prompt)

## Projections (LDA)
- Nothing may cross a plot edge with a **zero setback** (a party wall). Stop at the outer wall face.
- Into an open setback, canopies, chajjas, fins, frames and similar may project past the setback line by at most:
  - **1.5 ft** where that open space is under 10 ft deep;
  - **3 ft** where it is 10 ft or more.
- The engine cuts anything beyond these limits back, with a warning, and the as-built LDA check reports it. Design inside the limits.

## Geometry semantics
- `facade.canopy({ h_ft })`: `h_ft` is the height of the canopy's **top surface** above the road crown.
- `facade.frame(region)`: the region is the frame's **outer** bounds. A frame standing on the ground (bottom within 1 ft of the ground or plinth) is built as a **U**: posts down to the ground, no bottom member.
- **Nothing low in the way in front of the house**: no frame member, fin rail, louvre slat or post lower than 7 ft may cross a porch's car way (the bay and the way its car drives in from the gate), a door or gate opening, or the walkway from the gate to the main door. The engine leaves such a member off, or slides a post in along the frame. Keep frames around a porch opening as a portal whose posts stand beside the car, not across it.
- `RoomHandle.ceiling_h_ft` is **absolute** (above the road crown). `interior.accent_wall` heights (`from_h_ft`/`to_h_ft`) are **relative to the room's floor**.
- Custom geometry on the boundary wall should use a kind starting with `boundary_`, so it isn't counted as a building projection.

## Sections
- Each section runs on its own. Re-read what you need from `s.plan`, `s.room(id)` and `s.face(side, level)` instead of relying on variables from other sections.
- Prefer `furnish(...)` with `against`/`along_ft` for wall-hugging items (beds, wardrobes, sofas, TV units, kitchen counters, vanities) and `at`/`rot_deg` for free-standing ones (dining tables, coffee tables, rugs, islands).
- Use `auto_furnish(room)` for minor rooms (store, laundry, powder).


## What the engine guarantees (do not fight it)
- **Stairs** are built at code from `plan.stairs`: treads at least 10 in, a mid-landing as deep as the flight, and a 3 ft clear strip in front of the first riser on every floor (a dog-leg also arrives there). Stacked stairs share one layout. If the stair room is too short, the build reports it; make the stair room longer in the plan rather than shrinking the stair.
- **A flight reaches the roof.** If the plan has none from the top floor, the engine copies the stair below.
- **The mumty** grows to cover the top flight and its 3 ft top landing. Its door goes on a wall that touches that landing, at roof level, never over the stairwell, a party wall or the tank. Do not add your own roof door.
- **Guards**: every stairwell edge and every edge with a drop over 30 in gets a 3.5 ft railing in the `railing` style you chose; roof terraces stand behind the roof parapet. Do not draw your own stair or terrace railings.
- **Openings** are cut only into the wall between the two rooms they name, on their own level (an outer wall can face several terraces or yards along its length: the room just outside the opening counts). An opening onto a room on another floor is not built. Doors are placed first (the main door before all); a window on the same wall is narrowed (down to 1.5 ft) or moved to make room. Any opening that cannot be built is reported, and a missing door is a fail: keep 0.3 ft between openings on one wall.
- **No head-strike zone under a stair.** Wherever a flight or landing passes less than 6′8″ over walkable floor (a dog-leg's lower flight and mid-landing, and the low end of its upper flight), the engine closes that space off with built-in under-stair storage: a plastered box up to the soffit, with cupboard doors on the faces you can stand in front of. Where the soffit is 6′8″ or more, the floor under the stair stays open and the first treads can still be stepped onto from the side. Do not put a door, a walkway or furniture under the low end of a flight.
- **A stair never passes low over a door.** If a flight or landing would be less than 7 ft above the floor in front of a door below it, the engine turns the stair around (or mirrors it); if that does not clear every door, the build fails "Stair landing blocks <door>". Do not put a door under a stair's mid-landing.
- **Stair windows**: glass beside a flight or landing keeps 3 ft above the treads; the engine raises the sill (reported), or adds a guard rail across the glass.
- **Balconies that touch**: two balconies or terraces on an upper floor that share an edge and are not `open_to` each other get a 7 ft privacy screen between them, so one bedroom is never reached through another's balcony.
- **Voids over a court** (one rule for the engine, the plan checks and the viewer): an `open_space` or `courtyard` on an upper floor that overlaps a ground-floor `open_space` or `courtyard` (or a void over one) by more than half of its own area is a **void**. It has no floor and no slab, the court below is open to the sky, it gets no privacy screens, and its edges against terraces or floors get the standard 3′6″ railing. Nothing is furnished in it, and it is not a place anyone walks to or needs a door. An upper `open_space` over enclosed rooms is a floored light court (a terrace).
- **As-built notes report problems only**, one plain sentence each. What the engine adds on purpose (guard rails, privacy screens, the roof stair and its tower) is not a note.

## Furniture
- `along_ft` is measured from the wall's LEFT end as you face that wall from inside the room: on the **front** wall that is its high-x end (x = room.x + room.w − along_ft); back wall: low-x end; left wall: low-y end; right wall: high-y end.
- Keep these clear (the engine moves anything placed there, or leaves it out): every door, arch and sliding door's width × 3 ft on BOTH sides plus the leaf's swing (no furniture, counter, fixture or appliance ever stands there), the open-plan crossing between rooms, the stair, its foot and top landings, and 2 ft in front of windows for tall pieces (wardrobes, bookshelves, fridges, a TV unit with its TV).
- Every bedroom gets a bed; every bath a WC, a basin and a shower or tub; every powder room a WC and a basin; every kitchen a fridge and a hob; every dressing room a wardrobe. When the full-size piece has no place the engine tries a smaller one (a 1.5 × 1.2 ft wall-hung basin, a 2.6 ft shower tray, then a wet-area shower on the wall; a 1.6 ft deep hanging unit in a dressing). If the room still cannot hold one with its doorways clear, the build fails. Size those rooms for them.
- **Windows stay clear.** In a bedroom, lounge, drawing, dining, study or prayer room no tall piece (wardrobe, bookshelf, a TV unit with its TV) stands across the room's only window: the engine tries every wall and narrower sizes (a wardrobe down to 60 %, then 1.6 ft deep) first; with two or more windows only the smallest may be covered; otherwise the piece is left out with a note ("the wardrobe was left out to keep the window clear"). In any other room (a dressing, a store) a tall piece never stands across the room's only window either; a kitchen's fridge may as a last resort. A wardrobe or bookshelf whose only spot is across that window is built low, its top under the sill. Put wardrobes on solid walls.
- **Curtains** always hang centred on a window or sliding door: on the wall you name, the one nearest `along_ft`; with none on that wall, the room's largest. They never hang over a door, and a room without a window gets none.
- Optional furniture that does not fit (a sideboard, a coffee table, a dresser on the walkway) is left out quietly; notes are kept for the pieces a room needs, cars, windows and walkways under 3 ft.
- TV: the `tv_unit` stands against a real wall (an open-plan side is no wall: the unit, and its TV, move to a wall), keeps 1.5 ft from every door and arch frame, never on the wall the room is entered through (the main door's wall, or the wall with the door from the lobby, porch or corridor you come in by), and in a bedroom only on the wall the bed faces. Put the `tv` at the same `against`/`along_ft` as its `tv_unit` (the engine lines them up anyway).
- Nightstands (`side_table`) stand on the two sides of the bed (the engine puts them there; leave 1.5 ft each side of the bed); `table_lamp`s stand on them. Hob, sink and microwave stand on a kitchen counter.
- Wall items only on solid wall: never a TV, painting, mirror, AC or towel rail over a door or window, or on an open-plan side (a picture whose piece moves is re-centred on solid wall, or taken down).
- **Every room stays usable** (checked after every section): each door (entry, attached bath, dressing, balcony) and stair landing joins every other by a 3 ft path; a long side of every bed and the approach to every window can be reached. Leave walking room between pieces (sofa to coffee table at least 1.5 ft, 2.5 ft beside beds).
- When the pieces as asked do not allow that, the engine 1. moves them, 2. uses a smaller version (a queen becomes a single bed, a wardrobe narrower, then 1.6 ft deep), 3. leaves out the least-needed piece with a note ("the wardrobe was left out to keep the way to the bath clear"). A bed whose only spot runs its long side along a window becomes a smaller bed clear of it. A door that still cannot be reached at all is a **fail** ("door unreachable").
- Small bedrooms with an attached bath: in a 10 × 10 ft room whose entry and bath doors sit on opposite walls, keep a 3 ft strip joining the two doors, put the headboard on a wall that leaves that strip (a single bed, not a queen, when the room is that small), keep the window wall clear, and put the wardrobe where it does not close the strip (or in a dressing).
- A tiny WC or bath (under 36 sq ft) gets an outward-opening door so the WC and basin stay clear.

## Parking and the way in
- Cars go into parking bays the engine lays out in the porch (and the driveway for a further car), nose toward the house, leaving a 3 ft walkway from the pedestrian gate to the main door. Call `furnish("car_sedan" | "car_suv", { room: porch })` once per car in the brief (a 2-car porch needs two calls); the position you give only picks the nearest bay. Every bay is the plan rule's 9 × 18 ft (8.5 ft wide at the least, so the car doors open; its tail may stand up to 4 ft out over the porch's open front edge). Bays sit side by side, either side of the walkway, or one behind the other in a 36 ft deep porch; a porch needs 9 ft of width per car plus the walkway. Name the porch with its car count ("Car porch (2 cars)"): the engine parks that many cars even if the design furnishes fewer. A car that does not fit is a fail: "Only N of M cars fit".
- Every car stands under the porch roof (in an 8.5 ft bay if need be) before one stands out over the drive-in edge into the driveway.
- Nothing may stand on that walkway (plants, swings, motorbikes are moved). Outdoor furniture (porch chairs, plants, a swing) never closes the 3 ft way from the gate to a door or a yard: the engine moves it, or leaves it out with a note.

## Planting (`s.landscape.tree`, `planter`, `hedge`)
- What an item builds below 7 ft (a low canopy, palm fronds, a planter's shrubs) is its footprint, and it is solid to a walker.
- Nothing stands within 3 ft outside an exterior door, sliding door, arch or gate (its width plus 1 ft each side; a gate on both sides of the boundary wall), on the walkway, or in a car's way in.
- In a passage (an outdoor room under 8 ft wide: a side or rear space, a light court) 3 ft of clear walking width stays beside every item. Plant passages with slim trees against the boundary wall, away from doors.
- Planting never cuts the 3 ft way from the gate to an exterior door or an outdoor room.
- An item that breaks a rule is slid along, made a slim column against the boundary wall, moved into a wider lawn or yard nearby, or left out (a hedge keeps the stretches that break none), with a warning in the build log.

## Roof
- **Pitched roofs**: `plan.roof.pitched` (gable or hip) is the place's usual roof, and `s.structure()` builds it from the plan. Pass `roof` in `s.structure` to change its material, pitch, overhang or ridge, or `roof: { form: "flat" }` to drop it. It covers the bounding rectangle of the top storey's enclosed rooms, so a one-storey wing keeps a flat roof with a parapet. The eaves start at the parapet top; what the plan calls the parapet is a knee wall under them, and `s.face(side).top_h_ft` still gives its top, so cladding ends at the eaves. Gable ends take the exterior wall material. The roof level becomes an attic: no stair tower, roof door, tank, solar frame or roof terrace; furnish nothing there. Overhangs stop at party walls and the plot edge.
- `plan.site.boundary_wall.front_height_ft` 0 is an open front: no front wall, no gates or gate pillars (the plan's gates still mark the way in), and the side walls start level with the house. Don't add a gate or front wall in the facade sections then; use `boundary_wall: "wood_cladding"` for timber fences.
- `plan.roof.water_tank.material`: "plastic" (blue ribbed tank on a pad) or "concrete" (rendered RCC box). Do not model your own tank.
- `plan.roof.solar`: the engine keeps its area clear ("panels" also builds the panel rows). Keep the roof clear: no domes, cupolas, chhatris, minarets or pergolas unless the brief asks; they are reported when they stand in the solar area.

## Kinds for viewers
- Cars and motorbikes are tagged kind `vehicle`; the road, footpaths, poles, wires, street trees and neighbouring houses kind `context`. Keep custom street context in `s.landscape.street()`; tag your own context objects `kind: "context"`.
