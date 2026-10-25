# OSM → map pipeline (Plac Defilad, M2)

The map is the real block around the Palace of Culture and Science, from OpenStreetMap
(© OpenStreetMap contributors, ODbL 1.0 — attribution is shown in the in-game menu and logged in
`ASSETS.md`). No names, brands or signage are carried into game data.

| Step                        | Command                                                                                                                          | Output                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. Raw export (git-ignored) | Overpass bbox around Plac Defilad → `tools/osm/raw/plac_defilad.json`                                                            | ~4 MB                                                           |
| 2. Convert                  | `node tools/osm/build-map.ts`                                                                                                    | `packages/shared/src/maps/placDefilad/osm.gen.json` (committed) |
| 3. Review plan              | `python tools/osm/plot.py`                                                                                                       | `tools/osm/preview/plan.png`                                    |
| 4. Review layout + spawns   | `pnpm --filter @wd/server exec tsx ../../tools/osm/dump-layout.ts` then `python tools/osm/plot.py tools/osm/preview/layout.json` | `tools/osm/preview/layout.png`                                  |

What the converter does:

- Projects lat/lon to metres around the Palace and rotates by −19.5° so the street grid is axis
  aligned (+X ≈ east along Świętokrzyska, +Z ≈ south along Marszałkowska).
- Buildings → convex prisms (triangulate + merge; courtyards subtracted), with real heights or
  levels × 3.3 m. Real building passages (`tunnel=building_passage`) become walk-through routes.
  Buildings outside the block and tall towers within 1.3 km become a non-colliding skyline.
- Roads, paths, squares, lawns → flat markings; tram tracks → rails; trees (mapped + tree rows +
  seeded park scatter).
- Soft concealment: bushes around trees and in parks, tall grass in lawns — never on roads/paving.
- Playable bounds = far pavements of Świętokrzyska, Marszałkowska, Aleje Jerozolimskie, Emilii Plater.

The gameplay layer (Palace massing and interiors, underground, construction site, market, street
blockers, map-size sections) is authored in TypeScript in `packages/shared/src/maps/placDefilad/`.
