# RTL Architecture Visualizer — Design System

## Direction

**Intent:** Hardware engineer tracing signal connectivity through Verilog module hierarchies. Must navigate hierarchy, select modules, read dense wiring data.

**Feel:** Precision instrument — oscilloscope, logic analyzer. Dense, engineered, no decoration. Every pixel earns its place.

**Domain:** Oscilloscope screens, PCB silkscreen text, logic analyzer grids, schematic capture tools, waveform viewers, test equipment enclosures.

**Signature:** Cyan probe accent — a thin luminous line evoking oscilloscope probe channel 1. Appears on brand mark (with glow), hover/focus states, active items, and signal chips.

---

## Palette

### Surfaces (same hue, lightness-only shifts)

| Token          | Value     | Role                          |
|----------------|-----------|-------------------------------|
| `--surface-0`  | `#111113` | Deepest — page bg, inset fields |
| `--surface-1`  | `#18181b` | Base panels                   |
| `--surface-2`  | `#1c1c20` | Raised — toolbar, header      |
| `--surface-3`  | `#222228` | Highest — dropdowns, overlays |

### Borders (rgba progression)

| Token              | Value                        | Role              |
|--------------------|------------------------------|--------------------|
| `--border-subtle`  | `rgba(255,255,255,0.06)`     | Soft separation    |
| `--border-default` | `rgba(255,255,255,0.10)`     | Standard borders   |
| `--border-emphasis`| `rgba(255,255,255,0.16)`     | Emphasis borders   |
| `--border-focus`   | `#22d3ee`                    | Focus rings        |

### Text hierarchy

| Token              | Value     | Role                    |
|--------------------|-----------|--------------------------|
| `--text-primary`   | `#e4e4e7` | Default text             |
| `--text-secondary` | `#a1a1aa` | Supporting text          |
| `--text-tertiary`  | `#71717a` | Metadata, labels         |
| `--text-muted`     | `#52525b` | Disabled, placeholder    |

### Accent

| Token          | Value                        | Role                |
|----------------|------------------------------|----------------------|
| `--probe`      | `#22d3ee`                    | Primary accent (cyan)|
| `--probe-dim`  | `rgba(34,211,238,0.15)`      | Active bg tint       |
| `--probe-glow` | `rgba(34,211,238,0.25)`      | Brand mark glow      |

### Semantic

| Token      | Value     |
|------------|-----------|
| `--ok`     | `#4ade80` |
| `--warn`   | `#f59e0b` |
| `--danger` | `#ef4444` |

### Schematic domain colors (shared with viewer)

`--module` `#3ea6ff`, `--instance` `#ffb347`, `--instance-port` `#ffd38a`, `--port` `#70e1c5`, `--net` `#d58cff`, `--signal` `#42d392`, `--bus-edge` `#4fb6ff`, `--wire-edge` `#42d392`

---

## Depth Strategy

**Borders-only.** No shadows on panels. No gradients on surfaces. Like test equipment — flat matte enclosures with clean line separation. Borders at low rgba opacity define structure without demanding attention.

---

## Typography

**Primary face:** IBM Plex Mono (loaded from Google Fonts).

| Level          | Size  | Weight | Tracking  | Transform  |
|----------------|-------|--------|-----------|------------|
| Section header | 9-10px| 600    | 0.10-0.12em | uppercase |
| Panel title    | 11-12px| 600   | 0.06em    | uppercase  |
| Body/data      | 11px  | 400    | normal    | none       |
| Metadata       | 10px  | 400-500| 0.04em    | none       |
| Micro label    | 9px   | 500    | 0.08em    | uppercase  |

Section headers use wide letter-spacing and uppercase — PCB silkscreen feel.

---

## Spacing

**Base unit:** 6px

| Token    | Value |
|----------|-------|
| `--sp-1` | 3px   |
| `--sp-2` | 6px   |
| `--sp-3` | 12px  |
| `--sp-4` | 18px  |
| `--sp-5` | 24px  |
| `--sp-6` | 36px  |

---

## Border Radius

Sharp/technical scale:

| Token          | Value | Use                    |
|----------------|-------|------------------------|
| `--radius-sm`  | 3px   | Inputs, buttons, chips |
| `--radius-md`  | 4px   | Tooltips, cards        |
| `--radius-lg`  | 6px   | Modals, overlays       |
| `--radius-pill`| 999px | Status badges          |

---

## Layout

- **Three-panel workspace:** Left sidebar (260px), center (flex), right sidebar (280px)
- **Edge-to-edge panels** — no outer padding, no rounded panel corners. Like instrument rack modules.
- **Sidebars share the same background** as content — separated by 1px border only
- **Topbar** is surface-2 with bottom border, no gradient
- **Graph canvas** fills center with zero margin, dot-grid background at 24px

---

## Key Component Patterns

### Status badge
Pill-shaped, 10px uppercase, 1px border. Color matches semantic meaning. Border uses 25% opacity of the text color.

### Stat pills
3px radius, 10px font, 1px border at 25% opacity of the domain color. No background fill.

### Item list buttons
Transparent bg by default, no visible border. On hover/active: probe-dim background + emphasis border. Minimal footprint until interacted with.

### Tree module buttons
Same pattern as item list — invisible until hovered. 11px monospace.

### Mini-check controls
3px radius, subtle border, transparent bg. Checkbox uses accent-color: var(--probe).

### Breadcrumb crumbs
3px radius, subtle border, 10px. Module crumbs tinted blue, instance crumbs tinted amber — at 30% opacity on border only.

---

## Constraints

- **Do not modify** anything inside the schematic viewer canvas (`.schematic-*` classes, cytoscape styles, SVG rendering)
- Schematic domain colors are shared between CSS and JS — keep them in sync
- The app uses vanilla JS with no framework — all DOM manipulation is in app.js
