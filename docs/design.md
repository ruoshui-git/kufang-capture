# Design direction

This is a field tool, used one-handed in dim storage rooms with dusty gloves on. The priorities are speed, legibility and certainty that the work was saved. It should feel calm and utilitarian, like a well-made clipboard, not a dashboard.

## Principles

1. **The Entry List is the workbench.** Every routine action can be done in the row. Detail is optional.
2. **Never surprise the thumb.** Tapping an input, a thumbnail or Add Photo never navigates. Navigation happens only through a deliberate `Details ›` control, or by tapping the non-interactive header area of a row.
3. **Saved means saved.** Each row and each Detail screen shows a quiet save/sync state: `Saved on this device`, `Syncing`, `Backed up` or `Sync error`. Errors are loud. Success is quiet.
4. **Numbers are tabular.** Sequence numbers, quantities and counts use `font-variant-numeric: tabular-nums`.
5. **Honest hardware.** Camera controls appear only when supported. Anything missing is explained in plain words in Diagnostics.

## Tokens (Tailwind v4 `@theme` in `src/app.css`)

- Light surfaces are warm paper: `--color-paper #f6f5f2`, `--color-card #ffffff`, `--color-line #e4e1da`.
- Ink is `#1c1b19`, muted text is `#6b675f`.
- The primary colour is deep teal, `--color-primary #0f5f5c`, with `--color-primary-ink #ffffff`. It is used for New Entry and the primary buttons.
- The capture colour is amber, `--color-capture #d9822b`. It is used **only** for camera/Add Photo actions, so they are findable at a glance.
- Status colours: `--color-ok #2f7d4f`, `--color-warn #b7791f`, `--color-danger #b42318`, `--color-local #5b5bd6` (the Local Only badge).
- Dark mode (`prefers-color-scheme: dark`): paper `#141413`, card `#1e1d1b`, line `#33312d`, ink `#f1efe9`, muted `#a39e94`. The accents stay the same hue with adjusted contrast.
- Radius is 10px on cards and 8px on inputs/buttons. Shadows are minimal; use 1px lines instead.
- Font is the system stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`), which works offline and feels native. No web fonts.

## Geometry and iOS specifics

- Touch targets are at least 44×44 px. **Inputs are at least 16px font**, otherwise iOS zooms on focus.
- Respect safe areas (`env(safe-area-inset-*)`) and `viewport-fit=cover`. The fixed bottom bar sits above the home indicator.
- `+ New Entry` is a fixed, full-width bottom bar button (thumb zone). Toasts (Undo) float above it.
- Use `inputmode="decimal"` for quantity. Put `enterkeyhint` on inputs. Use `autocapitalize="sentences"` for notes and titles, and `autocomplete="off"`.
- Keep the focused input visible when the keyboard opens. Never re-render a row in a way that drops focus or caret position during autosave or sync updates.

## Entry row layout (phone, 390–430pt wide)

```text
┌──────────────────────────────────────────────┐
│ #0042  [Title — placeholder "Entry #0042"] ⋯ │
│ [▣][▣][▣] +4    [ 📷 Add Photo ] [ 🖼 ]      │
│ [ Qty ][ unit ]  [ Short note…            ]  │
│ ▸ More (count detail, long notes)  Details › │
│ ● Saved on this device · 7 photos            │
└──────────────────────────────────────────────┘
```

- **Thumbnails**: show the 3 most recently captured photos at about 64px, as rounded squares. Tapping one opens the full-screen viewer at that photo. `+N` opens the viewer at the first photo not shown.
- **Incomplete**: an entry with no photos or no quantity, or one flagged for review, gets a small amber left edge or an amber `Incomplete` chip. Saving is never blocked.
- **Deleted**: the row collapses and an Undo toast appears for 8 seconds. The entry stays in `Recently Deleted` until it is restored or purged.

## Copy

Use sentence case, short verbs and plain English: `Add Photo`, `Add from Photos`, `New Entry`, `Details`, `Delete entry`, `Undo`, `Recently Deleted`, `Export ZIP`, `Local Only`, `Sync to Server`, `Backed up`. Summaries never add different units together. Write `12 boxes · 30 pieces`, not `42`.
