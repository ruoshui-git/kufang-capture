# Design direction — "Storeroom tag"

**Subject.** A person counts goods in temple storerooms (*kufang*): shelves of cardboard boxes, bundles, candles and supplies. Their hands are busy, the light is dim and the signal is poor. The app is their clipboard and their roll of manila inventory tags.

**Primary job.** Capture an entry (photos, count, note) in seconds. Return to any earlier entry and fix it without losing your place.

**The one memorable thing.** Each entry wears a **manila inventory tag**: a small die-cut label with a punched hole that carries the stencil-style sequence number `#0042`. The tag is the entry's identity everywhere: list rows, Detail, the viewer header, the Undo toast and Recently Deleted. Everything else stays quiet, disciplined and native-feeling.

## Palette (cool concrete + ballpoint ink + manila)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-floor` | `#ECEFF1` | `#0E1418` | App background, like a concrete floor |
| `--color-card` | `#FFFFFF` | `#172027` | Row/card surfaces |
| `--color-line` | `#D5DBDF` | `#2A353D` | 1px dividers and input borders |
| `--color-ink` | `#16212B` | `#E8EDF0` | Text, New Entry bar |
| `--color-muted` | `#5E6B75` | `#93A1AB` | Secondary text |
| `--color-ballpoint` | `#2346B0` | `#7C9BFF` | Primary actions: Add Photo, links, focus ring |
| `--color-tag` | `#EBCB7A` | `#C9A957` | The manila tag fill (only the tag and its echoes) |
| `--color-tag-ink` | `#3A2E10` | `#2A2009` | Text on the tag |
| `--color-ok` | `#1F7A47` | `#5CC48A` | Backed up |
| `--color-warn` | `#A15F00` | `#E0A23A` | Incomplete, pending |
| `--color-danger` | `#B3261E` | `#FF8A80` | Sync error, delete |
| `--color-local` | `#5A4BC4` | `#A99CFF` | Local Only badge |

Avoid cream/terracotta, pure-black-with-neon, gradient washes and soft grey drop shadows. Elevation comes from 1px lines and the card-on-floor contrast.

## Type

- **Barlow Condensed, SemiBold 600** (self-hosted with `@fontsource/barlow-condensed`, precached so it works offline) is used for sequence numbers on tags, screen titles and summary figures. Its highway-sign, industrial-label voice suits a storeroom. Use it with `tabular-nums` wherever numbers align.
- **System UI** (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`) is used for everything else, inputs especially. It feels native, renders crisply, and the iOS keyboard and dictation behave normally with it.
- Type scale: 13 / 15 / 17 (body and inputs, never below 16px in inputs, or iOS zooms) / 20 / 26 / 34. Line height is 1.4 for body text and 1.1 for condensed display.
- Use sentence case everywhere. No all-caps eyebrow labels, no labels above every block, and no `A · B · C` meta strings: show separate chips or short lines instead.

## Layout

### Phone (default, 360–430pt)

```text
┌ Temple 2 / A04 ───────────── Local Only ┐   header: name in Barlow 26
│ 15 entries   42 photos   3 incomplete   │   summary chips (tap = filter)
│ 12 boxes   30 pieces                    │   per-unit chips, never summed
├─────────────────────────────────────────┤
│ (o#0015)  [Title… placeholder]       ⋯ │   tag + inline title + overflow
│ [▣][▣][▣] +2      [ Add Photo ][ ⊞ ]  │   3 newest thumbs; camera; library
│ [ qty ][ unit  ]  [ short note……… ]   │
│ More details                Details ›  │   expander; deliberate nav control
│ Saved on this device         7 photos  │   quiet state line
├─────────────────────────────────────────┤
│ …                                       │
╞═════════════════════════════════════════╡
│ [ + New Entry ]  (fixed, ink bar)       │   thumb zone, above home indicator
└─────────────────────────────────────────┘
```

Rows are full-bleed cards separated by 8px of floor colour. Content is left aligned, and the tag hangs at the left edge, as if tied to the row.

### Desktop and tablet (≥ 900px wide)

This is not a stretched phone. Above 900px, Collections becomes a persistent **left rail** (260px) and the Entry List becomes a dense **ledger**: one row per entry, laid out horizontally:

```text
┌ Collections ┐┌ Temple 2 / A04 ──────────────── summary chips ─── [Export ZIP] ┐
│ A04       15 ││ (o#0015) [Title……………]  [▣][▣][▣]+2  [qty][unit] [note………]  📷 ⊞ ⋯ │
│ A05        3 ││ (o#0014) …                                                        │
│ + New        ││                                                                   │
└──────────────┘└──────────────────────────────── [ + New Entry ] (top right) ─────┘
```

- The main column has a max-width of 1200px. Detail opens as a **right-hand panel** (min(520px, 40vw)) beside the ledger, not as a full page, so the list keeps its place.
- New Entry moves to the toolbar (top right), with keyboard shortcut `N`. `Enter` in quantity moves to unit, then to the note.
- Hover reveals nothing essential. Every action is visible or reachable with the keyboard, with a visible focus ring (2px ballpoint, 2px offset).

## Components

- **Tag**: a manila rounded rectangle with a notched left edge and a punched hole (a 6px circle in the floor colour), holding `#0042` in Barlow Condensed. Sizes are `sm` 28px (toast, trash), `md` 36px (rows) and `lg` 56px (Detail header).
- **Thumbnails**: 64px squares with 6px corners and a 1px line. The newest is on the left. `+N` is a muted square. Tapping opens the viewer at that photo.
- **Add Photo**: a filled ballpoint button with a camera glyph and label. Add from Photos is an outlined icon button with the label `Add from Photos` (visible text on desktop, accessible name on phone).
- **Inputs**: 16–17px, a 1px line border, and 6px corners. The focus ring is ballpoint. Saving shows no spinner. The state line changes to `Saving…` and then to `Saved on this device` within 300–400 ms.
- **Status line and chips**: dot plus words, with no icon-only states. `Backed up` (ok), `Syncing` (ballpoint), `3 photos pending, 24 MB` (warn), `Sync error — tap to retry` (danger), `Local Only` (local).
- **Toast**: an ink bar above New Entry: `Deleted (o#0042)  [Undo]`. It lasts 8 seconds and can be stacked.
- **Incomplete**: the tag gets a small warn-coloured corner fold. The row is never blocked.

## Motion

Motion is used only in response to an action:
- a new row slides in, and its title input takes focus
- a deleted row collapses
- a new thumbnail drops into place
- the viewer zooms from the thumbnail

There are no ambient animations. Honour `prefers-reduced-motion`.

## iOS specifics

- Respect `viewport-fit=cover` and the `env(safe-area-inset-*)` insets.
- Use `inputmode="decimal"` on quantity, and set `enterkeyhint` on inputs.
- Set `autocapitalize="sentences"` on notes and titles, and `autocomplete="off"`.
- Keep the focused input visible above the keyboard. Autosave or sync must never re-mount a row, or the input loses focus and caret position.

## Copy

Use plain verbs that are consistent through a flow: `Add Photo`, `Add from Photos`, `New Entry`, `Details`, `Delete entry` → toast `Deleted` → `Undo` / `Restore`, `Recently Deleted`, `Export ZIP` → `Exported`, `Local Only`, `Sync to Server`, `Backed up`.

Empty states give direction. For example: "No entries yet. Tap New Entry, then Add Photo to start counting this room." Errors say what happened and what to do next: "Couldn't reach the server. Changes are saved on this device and will upload when you're back online."
