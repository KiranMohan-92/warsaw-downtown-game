# Market art pass

Scope: `codex/isolated-finish`, Market only as the current review area. Main and Claude's files remain untouched. No cloud job, publication or asset purchase.

## Acceptance checks before editing

- Preserve the shared map, physics, solid counter/back-panel cover, paths and existing lightmap scene inputs. Do not remove the original cover geometry.
- First slice: improve existing stall surfaces with physically sized timber, bevelled plank overlays, fasteners and grain on produce trays. Match only complete authored stall assemblies; do not decorate arbitrary wood walls.
- Surface overlays stay within 4 mm of the original cover envelope. Recessed gaps retain the original solid counter/panel beneath them. No new dynamic lights, shadow casters or texture downloads.
- Reuse the exact existing wood material, maps and shader; keep quality/grid changes coherent. Merge pieces per existing 64 m chunk and material; bound additional geometry to 1,200 triangles per stall.
- Verify rotations, raised stalls, orphan/hidden pieces, finite unit normals, geometry bounds, unchanged map input, shared material identity and draw/triangle totals. Run focused tests, typecheck, lint and build.
- Capture actual browser before/after at matching daylight and neon poses. Report bounded stationary rendering observations separately from gameplay performance; no claim of a verified 60 fps combat target.

## Remaining Market coverage

1. Stalls and counter surfaces: first slice above; smoother near produce and better local lighting remain.
2. Ground contacts: sharpen local grime without raising every world texture to 4K. Puddles, drains, manholes and scattered litter already exist.
3. Containers: real corner/door/rib depth and fittings, retaining walk-through openings and shootable silhouettes.
4. Hall and metro: trims, tiles, interior fixtures and material transitions.
5. Integrated signage, cables and lighting: shared atlases and measured baked spill; assess cloud baking only with explicit spending authority.

The column/entrance upgrade does not yet establish AAA quality across this area. Browser performance and the real visual result determine whether each slice expands.

## Execution ledger

Read-only inventory identified untextured tray timber and rectangular stall surfaces as the first bounded improvement. Existing woven awnings and fruit remain in use. No speedup or GPU cost estimate is claimed.

## Result and evidence

- Timber overlay kit: 10 narrow front planks, four top planks, seven back boards and 12 small metal heads per complete stall. Actual chamfered geometry and metre-scale UVs, with the original solid boxes still rendered underneath.
- 1,020 extra triangles per stall, below the 1,200 cap. The Market dressing assembled triangle total (including all fruit instances, whether visible or culled) changes from 726,390 to 815,130: 88,740 added triangles for 87 stall finishes. Assembled dressing batches change from 29 to 33. These are geometry/batch counts, not triangles drawn each frame.
- Exact base wood material reuse: no new images, texture objects, material shader variant, dynamic lights or shadow casters. The extra geometry still costs GPU work and four additional wood chunk batches; it is not free.
- At the matched sunny counter-close pose, scene draws were 471 before and 472 after. Current FPS readings were 23.6 and 29.1 respectively, but these are unpaired stationary observations with timing/background activity uncontrolled; they do not establish a speedup or a 60 fps gameplay result.
- Final focused checks: 57 tests across five files passed in 12.35 s. Includes actual Market coverage/immutable map, rotations, raised stalls, fallback, bounded geometry, normals/winding, tray UVs, exact shared-material identity and Low/High/grid settings. Typecheck and scoped lint passed. Production build passed; existing large bundle warning remains (8,039.31 kB main bundle).
- Real daylight/neon before/after screenshots: `C:/Users/kiran/myprojects/gameplay-captures/2026-10-04/market-stalls/`. Before means this isolated branch immediately before the Market stall finish, not main.
- Normal branch game remains on `http://127.0.0.1:5174/`; temporary review tabs and servers were closed. Main HEAD remains `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e` with its two preexisting untracked entries. Seven original/Claude file hashes checked, zero changed. No commits, push or cloud jobs.

## Retrospective

One read-only inventory helper and one bounded geometry writer; root owned integration and final review. First focused suite passed. Review then refined plank proportions, removed coplanar fasteners and aligned grain. Integration was simplified from a clone to the exact base material to avoid another shader variant. No cloud job or measured cloud cost; no measured concurrency speedup. The visible timber improvement is modest: faceted produce, dark stall lighting, containers and interiors still limit the broader result.
