# Spec format

The spec is plain JSON (the `//` comments below are annotations only — do not put them in the file).

```json
{
  "title": "Optional big title", "subtitle": "Optional one-liner",
  "direction": "RIGHT",            // RIGHT | DOWN | LEFT | UP
  "layout": "board",               // optional: "board" (columns) or "map" (coordinates); see below
  "columnWidth": 240,              // board only: fixed card/column width
  "nodes":  [ ... ],
  "edges":  [ ... ],
  "groups": [ ... ],               // optional
  "font": "kalam", "roughness": 1.1, "fillStyle": "hachure", "accent": "blue",
  "spacing": 1,                    // multiplies gaps between nodes (1.3 = airier)
  "wrap": false,                   // wrap a long row onto several lines
  "background": "#ffffff", "seed": 7,
  "elk": { }                       // raw ELK layout options, escape hatch
}
```

Colours (any field called `color`): `blue green yellow red violet orange pink teal gray white`, or a hex value.

## Nodes

Common fields: `id` (required, unique), `label`, `kind`, `color`, `fillStyle`, `width`, `height`.

| kind | Looks like | Extra fields |
|---|---|---|
| `box` (default) | rounded rectangle | `sub` (small second line), `r` corner radius, `dashed` |
| `diamond` | decision | |
| `ellipse` / `circle` | | |
| `start` / `pill` | green pill | |
| `end` | grey pill, thick border | |
| `note` | yellow sticky note | |
| `text` | just text, no shape | `size` |
| `screen` | device frame with UI inside | see below |

### Screens

```json
{ "id": "signup", "label": "Crear cuenta", "step": 2, "device": "phone",
  "accent": "blue", "bg": "white", "components": [ ... ] }
```
- `device`: `phone` (250 px wide, default) · `tablet` · `desktop` (browser chrome; optional `url`).
- `label` + `step` render as the caption above the frame ("2  Crear cuenta").
- Components stack top to bottom, full width. A `{"type":"spacer","flex":true}` pushes everything after it to the bottom of the screen (CTA area).
- Any component can take `"id"` (to start an edge from it) and `"highlight": true` (red dashed callout around it).

### Components

| type | Fields |
|---|---|
| `header` | `text` (centered title), `back` (default true), `action` (right text, e.g. "Saltar") |
| `progress` | `step`, `total`, `style`: `dots` (default) or `bar`, `color` |
| `title` | `text`, `align` (`center`/`left`), `size` (default 21) |
| `text` | `text`, `align`, `size` (default 14) |
| `image` | `label` (what the picture is), `h` (default 130), `w`, `color` |
| `avatar` | `size`, `text`, `color` |
| `input` | `label`, `placeholder` or `value`, `icon: "eye"`, `error: true` |
| `otp` | `count` (default 6), `value` (digits already typed) |
| `button` | `text`, `variant`: `primary` (default) / `secondary` / `link`, `color` |
| `social` | `items` (default `["Google","Apple"]`) |
| `divider` | `text` (e.g. "o") |
| `checkbox` | `text`, `checked` |
| `toggle` | `text`, `on` |
| `chips` | `items`, `selected` (list of items), `color` |
| `list` | `items` (strings), `color` |
| `card` | `title`, `text`, `color` |
| `tabs` | `items`, `active` (index) — bottom tab bar |
| `spacer` | `h` (px) or `flex: true` |

## Edges

```json
{ "from": "welcome#cta", "to": "signup", "label": "sí", "color": "red",
  "dashed": true, "arrow": true, "width": 1.8 }
```
- `from` / `to`: node ids. `from` can be `screenId#componentId` to start at a button or link.
- `dashed`: `true` (dashes) or `"dot"` (dotted — good for connecting notes, with `"arrow": false`).
- `color`: tints the line (use red for error / retry paths).

## Groups

```json
{ "id": "editorial", "label": "Equipo editorial", "children": ["review", "ok"], "color": "gray", "direction": "DOWN" }
```
Dashed rounded container around its children. Use for swimlanes, systems, or phases. A node belongs to at most one group.
- `color` fills the group with a light tint of that colour (45 % strength, `gray` at full) so the nodes inside still stand out.
  `tint` (0–1) overrides the strength, e.g. `"tint": 0.25` for very faint, `1` for the full pastel.

## Board layout

`"layout": "board"` skips the automatic graph layout and lays the diagram out like a kanban or status board:

- Each group is a **column**, in the order of `groups`; nodes go top to bottom in the order of each group's `children`.
- Nodes in no group form one extra column at the end, without a frame.
- All columns share one width (the widest card, or `columnWidth`) and the same height. Boxes, notes and pills
  stretch to the column width; diamonds, circles and screens stay their size, centered.
- `direction: "DOWN"` turns columns into rows (cards left to right). `LEFT` / `UP` reverse the lane order.
- Edges are optional and drawn as simple elbows between cards. Fine for one or two links; for anything
  with real flow, use the normal layout instead.

No invisible edges or fixed widths needed: with the normal layout, groups without edges get stacked and reordered.

## Map layout

`"layout": "map"` places everything by **coordinates** instead of laying it out automatically: campaigns and
battles, routes and trips, territories, sales regions, a floor plan or a site map. Labels are placed
automatically around their point or along their line, avoiding arrows, lines, outlines and each other.

```json
{
  "layout": "map",
  "map": {
    "bounds": [-2.15, 48.38, 0.96, 50.05],   // [west, south, east, north]
    "projection": "geo",                     // "geo" (lon/lat, default) or "plain" (x/y units, e.g. metres of a plan)
    "width": 1400,                           // px of the map frame; height follows the bounds
    "sea": "blue",                           // background colour; default blue when "land" exists, else white; false = none
    "legend": [ { "badge": "1", "color": "violet", "label": "Engaño" },
                { "type": "arrow", "color": "blue", "label": "Avance aliado" } ],
    "legendPos": "bottom-left"               // top-left | top-right | bottom-left | bottom-right
  },
  "land":  [ [[lon, lat], ...] ],            // polygons drawn as land (sand + hatching); may run past the bounds
  "areas": [ ... ], "lines": [ ... ], "nodes": [ ... ], "edges": [ ... ]
}
```

**Every coordinate is `[lon, lat]`** (x first, like GeoJSON), never `[lat, lon]`. With `projection: "plain"`, `[x, y]` with y up.

- `land`: one polygon per landmass, 15–40 points is plenty. Coastlines drawn from memory are approximate:
  say "mapa esquemático" in the subtitle. Close the polygon off-map (past the bounds) so the frame cuts it cleanly.
- `areas`: zones. Polygon `{ "points": [...] }` or ellipse `{ "center": [lon, lat], "size": [w, h] }` (size in px).
  Fields: `label`, `sub`, `labelAt` ([lon, lat] to move the label), `color`, `fillStyle` (default `cross-hatch`),
  `fill: false` (outline only), `dashed` (default true).
- `lines`: no arrowhead (fronts, walls, roads, borders, beaches). `points`, `color`, `width` (default 3), `dashed`, `label`.
- `nodes`: each needs `"at": [lon, lat]`. Kinds:
  - `place`: dot + label (`minor: true` for a small, light label). `labelPos` (e, w, n, s, ne, nw, se, sw) forces a side.
  - `unit`: military-style rectangle; `symbol`: `armor`, `infantry`, `airborne` or `none`; optional `label`/`sub`.
  - `badge`: numbered circle (`label: "1"`), to link places to the legend or the text.
  - `label`: free text at that point (sea names, "Flota aliada…"); `size`, `bold`, `color`, `sub`.
  - `box`, `note`, `pill`, …: the usual diagram shapes, centred on the coordinate.
- `edges`: arrows. `from` / `to` are a node id or a `[lon, lat]`; `via` is a list of points the arrow curves through.
  `color` (default blue), `width` (default 4: 6–7 for main thrusts, 3 for minor moves), `dashed`, `label`, `arrow: false`.

Colour names give a strong tone for lines, arrows and labels and the pastel tone for fills.
A node under the legend is reported as a warning; move it or change `legendPos`.
