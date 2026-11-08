# Kufang Capture design system

This is the source of truth for how the app looks. [design.md](design.md) explains the intent: the "storeroom tag" direction, the layouts and the copy. This file defines the **tokens** and **rules** that keep every screen consistent. Every style in `frontend/src` uses these tokens. `pnpm lint:design` (also run in CI) rejects raw colours and off-scale values outside the token file.

## Where things live

| File | Contents |
|---|---|
| `frontend/src/styles/tokens.css` | **The only place raw values are allowed.** It defines every token as a CSS custom property on `:root`, with dark-mode overrides. |
| `frontend/src/app.css` | Imports Tailwind, the font and `tokens.css`. Holds base element styles and the shared component classes (`.button`, `.chip`, `.card`, …), all written with tokens. |
| `*.svelte` `<style>` blocks | Component layout only, written with tokens. |

To change the look, change a token. To add a token, add it here first, then to `tokens.css`, and give it a role, not just a value.

## Colour

Each colour is a semantic role. Components never use hex, rgb or hsl. Dark values apply under `prefers-color-scheme: dark`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-floor` | `#ECEFF1` | `#0E1418` | App background (concrete floor) |
| `--color-card` | `#FFFFFF` | `#172027` | Cards, rows, sheets, inputs |
| `--color-sunken` | `#F4F6F7` | `#121A20` | Placeholders, read-only wells, hover backgrounds |
| `--color-line` | `#D5DBDF` | `#2A353D` | 1px borders and dividers |
| `--color-line-strong` | `#B8C1C7` | `#3A4752` | Input borders on hover, the active divider |
| `--color-ink` | `#16212B` | `#E8EDF0` | Primary text, the New Entry bar |
| `--color-muted` | `#5E6B75` | `#93A1AB` | Secondary text (≥ 4.5:1 on card and floor) |
| `--color-on-ink` | `#FFFFFF` | `#0E1418` | Text on an ink background |
| `--color-ballpoint` | `#2346B0` | `#7C9BFF` | Primary actions (Add Photo), links, focus ring |
| `--color-on-ballpoint` | `#FFFFFF` | `#0E1418` | Text on ballpoint |
| `--color-tag` | `#EBCB7A` | `#C9A957` | Manila tag fill and per-unit quantity chips (tinted) |
| `--color-tag-soft` | `#F7EBCB` | `#3A3220` | Quantity chip background |
| `--color-tag-ink` | `#3A2E10` | `#2A2009` | Text on the tag |
| `--color-ok` | `#1F7A47` | `#5CC48A` | Backed up |
| `--color-warn` | `#A15F00` | `#E0A23A` | Incomplete, pending |
| `--color-danger` | `#B3261E` | `#FF8A80` | Sync error, conflict, destructive actions |
| `--color-local` | `#5A4BC4` | `#A99CFF` | Local Only badge |
| `--color-scrim` | `rgb(14 20 24 / 0.55)` | `rgb(0 0 0 / 0.65)` | Behind sheets and the viewer |
| `--color-viewer` | `#0B0F12` | `#0B0F12` | Photo viewer background |

Each status colour also has a `-soft` background variant (`--color-ok-soft`, `--color-warn-soft`, `--color-danger-soft`, `--color-local-soft`), used for chips and banners.

### Status mapping

Use these everywhere: rows, Detail, collection cards, header badges.

| State | Dot / text colour | Words |
|---|---|---|
| Saved on this device, Local Only | `--color-muted` (dot), badge `--color-local` | "Saved on this device", "Local Only" |
| Pending sync or upload | `--color-warn` | "Pending sync", "3 photos pending (24 MB)" |
| Syncing | `--color-ballpoint` | "Syncing" |
| Backed up | `--color-ok` | "Backed up" |
| Sync error, Conflict | `--color-danger` | "Sync error — tap to retry", "Conflict" |
| Incomplete | `--color-warn` | the tag corner fold and the "Incomplete" chip |

## Typography

| Token | Value | Use |
|---|---|---|
| `--font-display` | `'Barlow Condensed', system-ui, sans-serif` (600) | Tag numbers, screen titles, summary figures |
| `--font-body` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif` | Everything else |
| `--text-xs` | `12px` | Badges and fine print only |
| `--text-sm` | `13px` | Status lines, meta text |
| `--text-md` | `15px` | Secondary body, chips, buttons |
| `--text-lg` | `17px` | Body text and **all inputs** (never below 16px, or iOS zooms on focus) |
| `--text-xl` | `20px` | Section headings |
| `--text-2xl` | `26px` | Screen titles (phone) |
| `--text-3xl` | `34px` | Screen titles (desktop), large tag |
| `--leading-tight` | `1.1` | Display text |
| `--leading-body` | `1.4` | Body text |
| `--weight-regular` / `--weight-medium` / `--weight-bold` | `400` / `500` / `600` | Weights |

Numbers that align (sequence numbers, quantities, counts) use `font-variant-numeric: tabular-nums`. Text is sentence case. There are no all-caps labels.

## Spacing

The scale is based on 4px. Padding, margin, gap and inset values use **only** these tokens; `0` is allowed.

| Token | Value | Typical use |
|---|---|---|
| `--space-1` | `2px` | Hairline nudges, badge padding |
| `--space-2` | `4px` | Icon-to-label gaps |
| `--space-3` | `8px` | Gaps inside controls and chips, between rows |
| `--space-4` | `12px` | Card padding (phone), form gaps |
| `--space-5` | `16px` | Page gutter (phone), card padding (desktop) |
| `--space-6` | `24px` | Section spacing, page gutter (desktop) |
| `--space-7` | `32px` | Large section breaks |
| `--space-8` | `48px` | Page top and bottom breathing room |

Layout sizes:

| Token | Value |
|---|---|
| `--size-touch` | `44px` (minimum target) |
| `--size-thumb` | `56px` |
| `--size-thumb-lg` | `120px` (gallery on phone) |
| `--size-rail` | `260px` |
| `--size-panel` | `min(520px, 40vw)` |
| `--size-content` | `1200px` |
| `--size-bottom-bar` | `64px` + `env(safe-area-inset-bottom)` |

## Shape, elevation and layers

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `4px` | Tag notch, small marks |
| `--radius-md` | `6px` | Inputs, buttons, thumbnails |
| `--radius-lg` | `10px` | Cards and rows |
| `--radius-sheet` | `14px` | Top corners of the bottom sheet |
| `--radius-pill` | `999px` | Chips and badges |
| `--radius-round` | `50%` | Dots and the tag hole |
| `--border` | `1px solid var(--color-line)` | The default border |
| `--focus-ring` | `0 0 0 2px var(--color-card), 0 0 0 4px var(--color-ballpoint)` | `:focus-visible` on every interactive element |
| `--shadow-overlay` | `0 8px 24px rgb(0 0 0 / 0.18)` | **Only** for floating overlays: sheets, menus, toasts. Cards use lines, not shadows. |
| `--z-bottom-bar` / `--z-panel` / `--z-menu` / `--z-sheet` / `--z-viewer` / `--z-toast` | `10` / `20` / `30` / `40` / `50` / `60` | Stacking order |

## Motion

| Token | Value |
|---|---|
| `--duration-fast` | `120ms` (press feedback, hover) |
| `--duration-base` | `200ms` (row insert and collapse, sheet open) |
| `--easing-standard` | `cubic-bezier(0.2, 0, 0, 1)` |

Motion is used only in response to an action. Under `prefers-reduced-motion: reduce`, durations become `0ms`.

## Shared components

These live as classes in `app.css` or as components in `src/components/ui`. Reuse them instead of restyling.

| Component | Rules |
|---|---|
| **Button** (`.button`, `ui/Button`) | Height `--size-touch`, radius `--radius-md`, `--text-md` medium, padding `0 var(--space-5)`. Variants: `primary` (ballpoint), `ink`, `quiet` (card + border), `danger`. The icon + label gap is `--space-2`. A disabled button explains itself through nearby helper text. |
| **IconButton** | `--size-touch` square, `quiet` style, and a mandatory `aria-label`. |
| **Input / TextField** | Height `--size-touch`, `--text-lg`, `--border`, radius `--radius-md`, padding `0 var(--space-4)`, `--focus-ring`. Hover uses `--color-line-strong`. |
| **Chip / summary chip** (`.chip`) | Pill, `--text-md`, padding `var(--space-1) var(--space-4)`. A count chip uses card + border. A **quantity** chip uses `--color-tag-soft` and `--color-tag-ink`. A status chip uses the status `-soft` background with status text. |
| **Badge** (Local Only, Backed up…) | Pill, `--text-xs`/`--text-sm`, status colour text on its `-soft` background. |
| **Card / row** (`.card`) | `--color-card`, `--border`, radius `--radius-lg`, padding `--space-4` (phone) or `--space-5` (desktop). Rows are separated by `--space-3` of floor. |
| **Tag** (`ui/Tag`) | Manila fill, a notched left edge, a punched hole (`--radius-round`, floor colour) and `--font-display`. Sizes are sm 28px, md 36px and lg 56px tall. The incomplete fold uses `--color-warn`. |
| **Sheet** | A bottom sheet on phone with `--radius-sheet` top corners, and a centred dialog (max 560px) on desktop. Uses `--shadow-overlay`, `--color-scrim` and `--z-sheet`. |
| **Menu** | A popover with `--color-card`, `--border`, `--radius-lg`, `--shadow-overlay` and `--z-menu`. Items are `--size-touch` tall. |
| **Toast** | `--color-ink` background, `--color-on-ink` text, radius `--radius-lg`, sitting above the bottom bar. The action button uses ballpoint text on ink. |
| **Status line** | `--text-sm`: a dot (8px, `--radius-round`) plus words, coloured by the status mapping above. |

## Breakpoints

| Name | Query | Change |
|---|---|---|
| phone | default | Single column, fixed bottom New Entry bar |
| wide phone / tablet | `min-width: 600px` | Larger gutters |
| desktop | `min-width: 900px` | Collections rail, ledger rows, Detail as a side panel |
| list container | `@container entry-list (min-width: 1130px)` | One-line ledger row inside the list column. Narrower lists (including beside the Detail panel) use compact cards. |

## Rules for future edits

1. **No raw colours** (`#…`, `rgb()`, `hsl()`, named colours other than `transparent` and `currentColor`) outside `styles/tokens.css`.
2. **No off-scale spacing.** Padding, margin, gap and inset use `--space-*`, `0` or a layout `--size-*` token. Font sizes use `--text-*`, radii use `--radius-*`, and stacking uses `--z-*`.
3. **1px is the only raw length allowed in components**, for borders and hairlines. Prefer `--border`.
4. **New UI reuses the shared components.** If something new is needed, add it to this file, then build it once in `src/components/ui`.
5. **Both themes and both layouts** (phone at 360px, desktop at 1440px) are checked before a change is done: no clipping and no horizontal scroll.
6. `pnpm lint:design` must pass. It runs in CI.
