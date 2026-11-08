# Design direction — "Storeroom tag"

**Subject.** A person counts goods in temple storerooms (*kufang*): shelves of cardboard boxes, bundles, candles and supplies. Their hands are busy, the light is dim and the signal is poor. The app is their clipboard and their roll of manila inventory tags.

**Primary job.** Capture an entry (photos, count, note) in seconds. Return to any earlier entry and fix it without losing your place.

**The one memorable thing.** Each entry wears a **manila inventory tag**: a small die-cut label with a punched hole that carries the stencil-style sequence number `#0042`. The tag is the entry's identity everywhere: list rows, Detail, the viewer header, the Undo toast and Recently Deleted. Everything else stays quiet, disciplined and native-feeling.

## Palette and type

The exact colours, type scale, spacing, radii, elevation and motion are tokens in
[design-system.md](design-system.md) (implemented in `frontend/src/styles/tokens.css`). In short:
cool concrete floor, white cards, blue-black ink, ballpoint blue for primary actions, manila for
the tag and quantity chips, status colours for sync state; Barlow Condensed SemiBold for tag numbers
and titles, the system UI font for everything else. Avoid cream/terracotta, neon-on-black,
gradient washes and soft drop shadows; elevation comes from 1px lines and card-on-floor contrast.

## Layout

### Phone (default, 360–430pt)

```text
┌ Temple 2 / A04 ───────────── Local Only ┐   header: name in Barlow 26
│ 15 entries   42 photos   3 incomplete   │   summary chips (tap = filter)
│ 12 boxes   30 pieces                    │   per-unit chips, never summed
├─────────────────────────────────────────┤
│ (o#0015)  [Title… placeholder]       ⋯ │   tag + inline title + overflow
│ [▣][▣][▣] +2      [ Add Photo ][ ⊞ ]  │   3 newest thumbs; camera; library
│ [qty][ unit ][ short note………………… ]   │   one line of inline fields
│ More ⌄   ● Saved · 7 photos    Details › │   expander, state, nav
├─────────────────────────────────────────┤
│ …                                       │
╞═════════════════════════════════════════╡
│ [ + New Entry ]  (fixed, ink bar)       │   thumb zone, above home indicator
└─────────────────────────────────────────┘
```

Rows are full-bleed cards separated by 8px of floor colour. **More** expands Expiration date, Dimensions, Count detail and Notes inside the row, so these fields are one tap away. Detail shows every field without an expander. Overflow menus (`⋯`) close on a tap outside, on Escape, and after an item is chosen. Content is left aligned, and the tag hangs at the left edge, as if tied to the row.

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
