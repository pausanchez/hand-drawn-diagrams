---
name: hand-drawn-diagrams
description: Draw flowcharts, workflows, screen flows, wireframes, prototypes, kanban/status boards, schematic maps and illustrated whiteboard scenes in a sketchy hand-drawn whiteboard style (rough lines, hachure fills, handwritten font) as SVG and PNG. Use when the user asks for a flow, workflow, user flow, onboarding flow, wireframe, prototype, process diagram, board of cards in columns, a map (battle, campaign, route, territory, floor plan), or a drawn explainer scene with people, laptops, bubbles and arrows ("like a whiteboard animation video", "visual thinking", "sketchnote") that should look hand-drawn, sketched, or "whiteboard style".
---

# Hand-drawn diagrams

Renders a JSON spec into an SVG (and PNG) that looks sketched on a whiteboard:
rough.js strokes, hachure fills, a handwritten font, automatic layout with ELK.
You never compute coordinates — you describe nodes, screens and edges; the script lays them out.

## Setup

None. `scripts/render.mjs` is a prebuilt bundle with every dependency inside, and PNG export uses
WebAssembly (`scripts/resvg.wasm`), so it runs with plain Node 18+: no `npm install`, no browser.
Don't run `npm install` in the skill folder; that's only for developing the renderer (see `src/`).

## Workflow

1. **Decide the diagram type** (see below) and write a spec JSON in the working directory.
   Read `reference/spec-format.md` for every field and component. `examples/` has seven complete specs (process, screen flow, swimlanes, wireframe, board, map, scene).
2. **Render**: `node <skill-dir>/scripts/render.mjs spec.json --out out/name`
   → `out/name.svg` + `out/name.png` (2x). Flags: `--no-png`, `--scale 3`.
3. **Read the warnings** the script prints (unknown component, missing component id, word too long) and fix them.
4. **Look at the PNG** before delivering. Check: text overflowing a box, edges crossing labels,
   screens stair-stepping, a branch landing in a strange place. Fix by editing the spec
   (node order, `direction`, `spacing`, splitting long labels) and re-render. Usually 1–2 passes.
5. **Deliver** the PNG (for viewing/sharing) and the SVG (scalable, fonts embedded). Keep the spec
   so the user can ask for changes and you can re-render instead of starting over.

## Diagram types

| Want | Use |
|---|---|
| Process / workflow / decision flow | `box`, `diamond`, `start`/`end`, `note` nodes; `direction: "RIGHT"` or `"DOWN"` |
| Swimlanes / ownership | wrap nodes in `groups` (one per team/actor); add `color` to tint a lane |
| Screen flow / onboarding / prototype | `screen` nodes with `components`; edges from a button: `"from": "screenId#componentId"` |
| Single wireframe | one `screen` node, no edges (use `device: "desktop"` for web) |
| Board / kanban / status columns / comparison | `"layout": "board"` + one group per column; no edges needed (see spec-format.md) |
| Map: campaign, battle, route, trip, territory, floor or site plan | `"layout": "map"` + `bounds`, `land`, `areas`, `lines`, nodes with `"at": [lon, lat]`, arrows with `via` (see spec-format.md, `examples/map-normandy.json`) |
| Illustrated scene: explain a story, a demo or how a team works, "like a whiteboard video" | `"layout": "scene"` + doodles (`crowd`, `person`, `laptop`, `cloud`, `bubble`, `notepad`, `mic`, `bulb`, `doc`, `sparkle`, `text`) and screens placed with `"at": [x, y]`, numbered `step`s, arrows with `via` (see spec-format.md, `examples/scene-demo.json`) |

Mixing is fine: screens plus a `diamond` for a decision plus a `note`, as in `examples/onboarding.json`.

## Rules that keep diagrams clean

- **List nodes in flow order.** Layout follows model order where that doesn't add edge crossings; main path first, branches after.
  If a reorder has no effect, ELK is avoiding a crossing: change `direction` or the edges instead.
- **Edges from buttons** need an `id` on that component (`{"id": "cta", "type": "button", ...}`) and
  `"from": "screen#cta"`. They start with a red dot on the button, like a prototype link.
  The target screen is entered at the same height, so a linear flow comes out as a straight row.
- **Loops** (retry, "no" branches) are detected automatically; colour them (`"color": "red"`) so they read as the exception.
- **Labels short**: node labels ≤ 5 words, edge labels ≤ 3 words. Put detail in `sub` or a `note`.
- **Colour has meaning, not decoration**: one colour per role (e.g. user action blue, system green,
  decision yellow, error red). 3–4 colours max per diagram. See `reference/style-guide.md`.
- **Realistic copy in wireframes**: real titles, button text and placeholders in the user's language, not lorem ipsum.
- Screens are ~250 px wide; more than ~8 screens in a row gets very wide — use `"wrap": true`,
  or split into two diagrams (e.g. happy path / edge cases).
- The font has Latin letters and common punctuation only (accents, ñ, ¿¡, · – — … “” €, ×, •). No emoji, CJK,
  arrows or checkmarks: write `->`, `<-`, `=>`, `ok`. The script swaps → ← ⇒ ✓ ✗ ● for these automatically and
  warns about any other symbol it can't draw (it would show as a box): replace those and re-render.

## Scenes

- Sketch the story first: 5–8 moments, numbered with `step`, read in a loop or left to right.
- Lay it out on a rough grid (columns ~350–450 px apart) and leave room for captions under each drawing.
- One strong colour for the key arrow of the story (`width: 5`, e.g. blue), black for the rest.
- Captions short (≤ 4 words); put speech in `bubble`s and ideas in `cloud`s.
- Fix every overlap warning: drawings that touch read as a mess in a scene.

## Style knobs (top level of the spec)

`font` (`kalam` default, `caveat` more scribbly) · `roughness` (0.6 neat → 2 messy, default 1.1) ·
`fillStyle` (`hachure` default, `cross-hatch`, `zigzag`, `dots`, `solid`) · `accent` (primary button colour) ·
`background` (`#ffffff` or `transparent`) · `seed` (change for a differently-wobbled drawing).
