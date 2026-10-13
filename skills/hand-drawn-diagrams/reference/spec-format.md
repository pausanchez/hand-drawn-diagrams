# Spec format

The spec is plain JSON (the `//` comments below are annotations only — do not put them in the file).

```json
{
  "title": "Optional big title", "subtitle": "Optional one-liner",
  "direction": "RIGHT",            // RIGHT | DOWN | LEFT | UP
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
