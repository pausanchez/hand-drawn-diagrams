# Style guide

## Colour roles (pick 3–4 per diagram, keep them consistent)
| Role | Colour |
|---|---|
| Start / success / system done | `green` |
| User action / main step | `blue` |
| Decision | `yellow` |
| Error / retry / blocked | `red` (also for the edge) |
| External service / integration | `violet` |
| Waiting / manual / human review | `orange` |
| Neutral, background lanes | `gray` |

Groups are tinted lighter automatically. With 3+ groups side by side, prefer `gray` (or no colour) for all
of them and keep colour for the nodes: four coloured columns compete with what's inside them.

Fills are pastel hachure; strokes stay near-black so the drawing reads like a marker sketch.
Primary buttons inside screens use the stronger `accent` tone as a solid fill so the CTA pops.

## Layout
- `RIGHT` for screen flows and timelines; `DOWN` for decision-heavy processes and org-like flows.
- 5–9 boxes per diagram reads well. Past ~12, split into two diagrams or group into phases.
- Happy path first in `nodes`; exceptions after. Keep loops few and colour them.
- `spacing: 1.2–1.4` if labels feel cramped; `0.8` for compact slides.

## Wireframes
- One clear primary button per screen, at the bottom (`spacer` with `flex: true` before it).
- `image` placeholders say what the picture shows ("Ilustración: persona regando una planta").
- Use `highlight: true` sparingly — it marks the thing the diagram is about.
- Copy in the user's language and tone; real-looking values ("laura@email.com"), never lorem ipsum.

## Roughness
- `0.7–0.9` tidy sketch (client-facing) · `1.1` default whiteboard · `1.6+` napkin brainstorm.
- Change `seed` to get a different wobble without changing the layout.
