<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Camera, ChevronDown, Images } from '@lucide/svelte'
  import type { EntryRow as EntryRowModel, EntryView, Photo } from '$lib/types'
  import { byCoverThenNewest, formatSequence } from '$lib/types'
  import { repo } from '$lib/db'
  import { pickPhotos, type CaptureMode } from '$lib/camera'
  import Button from '../ui/Button.svelte'
  import Tag from '../ui/Tag.svelte'
  import Menu from '../ui/Menu.svelte'
  import StatusLine from '../ui/StatusLine.svelte'
  import ThumbnailStrip from './ThumbnailStrip.svelte'
  import CameraSheet from '../camera/CameraSheet.svelte'
  import { createEntryAutosave, normalizeQuantityInput } from '$lib/entries/autosave'
  import MoveToSheet from './MoveToSheet.svelte'

  let {
    row,
    units,
    ondetails,
    onviewer,
    ondelete,
  }: {
    row: EntryRowModel
    units: string[]
    ondetails: (entry: EntryView) => void
    onviewer: (entryId: string, photoId: string) => void
    ondelete: (row: EntryRowModel) => void
  } = $props()
  const initialEntry = untrack(() => row.entry)
  let title = $state(initialEntry.title)
  let quantity = $state(initialEntry.quantity ?? '')
  let unit = $state(initialEntry.unit)
  let notes = $state(initialEntry.notes)
  let shortNote = $state(initialEntry.notes.split('\n')[0] ?? '')
  let countDetail = $state(initialEntry.count_detail)
  let expirationDate = $state(initialEntry.expiration_date ?? '')
  let dimensions = $state(initialEntry.dimensions)
  let entryNotes = $state(initialEntry.entry_notes)
  let expanded = $state(false)
  let dirty = $state({
    title: false,
    quantity: false,
    unit: false,
    shortNote: false,
    countDetail: false,
    notes: false,
    expirationDate: false,
    dimensions: false,
  })
  let acknowledged = $state<{
    title: string | undefined
    quantity: string | null | undefined
    unit: string | undefined
    count_detail: string | undefined
    notes: string | undefined
    expiration_date: string | null | undefined
    dimensions: string | undefined
  }>({
    title: undefined,
    quantity: undefined,
    unit: undefined,
    count_detail: undefined,
    notes: undefined,
    expiration_date: undefined,
    dimensions: undefined,
  })
  let quantityError = $state(false)
  let status = $state<'idle' | 'saving' | 'photo-error'>('idle')
  let mode = $state<CaptureMode>('native')
  let cameraOpen = $state(false)
  let moveOpen = $state(false)
  let autosaveEntryId = initialEntry.id
  let autosave = $state.raw(createEntryAutosave(repo, initialEntry.id))

  $effect(() => {
    const entry = row.entry
    if (autosaveEntryId !== entry.id) {
      autosaveEntryId = entry.id
      autosave = createEntryAutosave(repo, entry.id)
    }
    if (dirty.title && acknowledged.title === entry.title) dirty.title = false
    if (!dirty.title && title !== entry.title) title = entry.title
    if (dirty.quantity && acknowledged.quantity === entry.quantity) dirty.quantity = false
    if (!dirty.quantity && quantity !== (entry.quantity ?? '')) quantity = entry.quantity ?? ''
    if (dirty.unit && acknowledged.unit === entry.unit) dirty.unit = false
    if (!dirty.unit && unit !== entry.unit) unit = entry.unit
    if (dirty.shortNote && acknowledged.notes === entry.notes) dirty.shortNote = false
    if (dirty.countDetail && acknowledged.count_detail === entry.count_detail) dirty.countDetail = false
    if (dirty.notes && acknowledged.notes === entry.notes) dirty.notes = false
    if (!dirty.shortNote && !dirty.notes) {
      if (notes !== entry.notes) notes = entry.notes
      const nextShortNote = entry.notes.split('\n')[0] ?? ''
      if (shortNote !== nextShortNote) shortNote = nextShortNote
    }
    if (!dirty.countDetail && countDetail !== entry.count_detail) countDetail = entry.count_detail
    if (dirty.expirationDate && acknowledged.expiration_date === entry.expiration_date)
      dirty.expirationDate = false
    if (!dirty.expirationDate && expirationDate !== (entry.expiration_date ?? ''))
      expirationDate = entry.expiration_date ?? ''
    if (dirty.dimensions && acknowledged.dimensions === entry.dimensions) dirty.dimensions = false
    if (!dirty.dimensions && dimensions !== entry.dimensions) dimensions = entry.dimensions
    if (entryNotes !== entry.entry_notes) entryNotes = entry.entry_notes
  })
  onDestroy(() => void autosave.dispose())
  onMount(() => {
    void repo.getSetting<CaptureMode>('capture_mode', 'native').then((value) => (mode = value))
    const flush = () => void autosave.flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  })

  function save(
    field: 'title' | 'quantity' | 'unit' | 'count_detail' | 'notes' | 'expiration_date' | 'dimensions',
    value: string | null,
  ) {
    if (field === 'title') dirty.title = true
    if (field === 'quantity') dirty.quantity = true
    if (field === 'unit') dirty.unit = true
    if (field === 'count_detail') dirty.countDetail = true
    if (field === 'notes') dirty.notes = true
    if (field === 'expiration_date') dirty.expirationDate = true
    if (field === 'dimensions') dirty.dimensions = true
    acknowledged[field] = undefined
    status = 'saving'
    autosave.schedule(field, value)
    setTimeout(() => {
      if (status === 'saving') status = 'idle'
    }, 340)
  }
  function quantityChanged(value: string) {
    quantity = value
    const normalized = normalizeQuantityInput(value)
    quantityError = normalized === undefined
    if (normalized !== undefined) save('quantity', normalized)
    else dirty.quantity = true
  }
  async function flushDrafts() {
    await autosave.flush()
    const persisted = await repo.getEntry(row.entry.id)
    if (!persisted) return
    if (dirty.title && persisted.title === title) acknowledged.title = persisted.title
    if (dirty.quantity && persisted.quantity === normalizeQuantityInput(quantity))
      acknowledged.quantity = persisted.quantity
    if (dirty.unit && persisted.unit === unit) acknowledged.unit = persisted.unit
    if (dirty.countDetail && persisted.count_detail === countDetail)
      acknowledged.count_detail = persisted.count_detail
    if ((dirty.shortNote || dirty.notes) && persisted.notes === notes) acknowledged.notes = persisted.notes
    if (dirty.expirationDate && persisted.expiration_date === (expirationDate || null))
      acknowledged.expiration_date = persisted.expiration_date
    if (dirty.dimensions && persisted.dimensions === dimensions)
      acknowledged.dimensions = persisted.dimensions
  }
  async function capture(kind: 'camera' | 'library') {
    // Keep the picker invocation in the click call stack for iOS.
    const picked = pickPhotos(kind, row.entry.id)
    try {
      const photos = await picked
      if (photos.length) await repo.addPhotos(row.entry.id, photos)
    } catch {
      status = 'photo-error'
    }
  }
  function openCapture() {
    if (mode === 'fast') cameraOpen = true
    else void capture('camera')
  }
  async function openMorePhotos() {
    const photos = await new Promise<Photo[]>((resolve, reject) => {
      let stop: ReturnType<ReturnType<typeof repo.watchPhotos>['subscribe']> | undefined
      stop = repo.watchPhotos(row.entry.id).subscribe((items) => {
        if (typeof stop === 'function') stop()
        else stop?.unsubscribe()
        resolve(items)
      }, reject)
    })
    const next = photos.slice().sort(byCoverThenNewest)[3]
    if (next) onviewer(row.entry.id, next.id)
  }
  const syncLabel = $derived(
    row.entry.display_sync_state === 'conflict'
      ? m.entry_conflict()
      : row.entry.display_sync_state === 'error'
        ? m.entry_sync_error()
        : row.entry.display_sync_state === 'synced'
          ? m.entry_backed_up()
          : row.entry.display_sync_state === 'pending'
            ? m.entry_pending_sync()
            : m.entry_saved_device(),
  )
</script>

<article class="entry-row">
  <div class="row-head">
    <button
      class="tag-link"
      aria-label={m.entry_details_for({ sequence: formatSequence(row.entry.sequence_number) })}
      onclick={() => ondetails(row.entry)}
    >
      <Tag sequence={row.entry.sequence_number} incomplete={row.is_incomplete} />
    </button>
    <input
      class="title"
      aria-label={m.entry_title()}
      placeholder={m.core_entry_untitled({ sequence: formatSequence(row.entry.sequence_number) })}
      value={title}
      oninput={(event) => {
        title = event.currentTarget.value
        save('title', title)
      }}
      onblur={() => void flushDrafts()}
    />
    {#if row.entry.starred_at}<button
        class="star-toggle"
        aria-label={m.entry_unstar()}
        aria-pressed="true"
        onclick={() => void repo.setEntryStarred(row.entry.id, false)}>★</button
      >{:else}<button
        class="star-toggle"
        aria-label={m.entry_star()}
        aria-pressed="false"
        onclick={() => void repo.setEntryStarred(row.entry.id, true)}>☆</button
      >{/if}
    <div class="row-badges">
      {#if row.entry.review_status === 'needs_review'}<span class="badge needs-review"
          >{m.entry_needs_review()}</span
        >{/if}
      {#if row.entry.shared_with.length > 0}<span class="shared-tag"
          >{m.entry_shared_tag({ count: row.entry.shared_with.length + 1 })}</span
        >{/if}
    </div>
    <div class="menu-cell">
      <Menu label={m.entry_actions()}>
        <button role="menuitem" onclick={() => (moveOpen = true)}>{m.entry_move_to()}</button>
        <button
          role="menuitem"
          onclick={() => void repo.setEntryStarred(row.entry.id, row.entry.starred_at === null)}
          >{row.entry.starred_at ? m.entry_unstar() : m.entry_star()}</button
        >
        <button
          role="menuitem"
          onclick={() =>
            void repo.updateEntry(row.entry.id, {
              review_status: row.entry.review_status === 'needs_review' ? 'complete' : 'needs_review',
            })}
          >{row.entry.review_status === 'needs_review'
            ? m.entry_mark_complete()
            : m.entry_mark_needs_review()}</button
        >
        <button role="menuitem" onclick={() => ondelete(row)}>{m.entry_delete()}</button>
      </Menu>
    </div>
  </div>

  <ThumbnailStrip
    photos={row.recent_photos}
    total={row.photo_count}
    onmore={() => void openMorePhotos()}
    onopen={(id) => onviewer(row.entry.id, id)}
  />
  <div class="photo-actions">
    <Button variant="capture" onclick={openCapture}>
      <Camera size={18} aria-hidden="true" />
      <span class="camera-label">{m.entry_add_photo()}</span>
    </Button>
    <button class="library" aria-label={m.entry_add_from_photos()} onclick={() => void capture('library')}>
      <Images size={18} aria-hidden="true" />
      <span class="visually-hidden">{m.entry_add_from_photos()}</span>
    </button>
  </div>

  <div class="entry-meta">
    {#if entryNotes}<p class="entry-note-preview">{entryNotes}</p>{/if}
    {#if row.movement_summary}
      <p class="movement-preview">
        {row.movement_summary.from
          ? m.entry_moves_from({ name: row.movement_summary.from, count: row.movement_summary.count })
          : m.entry_moves({ count: row.movement_summary.count })}
      </p>
    {/if}
  </div>
  <div class="fields">
    <div class="quantity-wrap">
      <input
        aria-label={m.entry_quantity()}
        inputmode="decimal"
        placeholder={m.entry_qty()}
        value={quantity}
        oninput={(event) => quantityChanged(event.currentTarget.value)}
        onblur={() => void flushDrafts()}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            ;(
              event.currentTarget.parentElement?.parentElement?.querySelector(
                '.dimensions',
              ) as HTMLInputElement | null
            )?.focus()
          }
        }}
      />
    </div>
    <input
      class="dimensions"
      aria-label={m.entry_dimensions()}
      placeholder={m.entry_dimensions()}
      value={dimensions}
      oninput={(event) => {
        dimensions = event.currentTarget.value
        save('dimensions', dimensions)
      }}
      onblur={() => void flushDrafts()}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          ;(
            event.currentTarget.parentElement?.parentElement?.querySelector(
              '.short-note',
            ) as HTMLInputElement | null
          )?.focus()
        }
      }}
    />
    <input
      class="short-note"
      aria-label={m.entry_short_note()}
      placeholder={m.entry_short_note()}
      value={shortNote}
      oninput={(event) => {
        shortNote = event.currentTarget.value
        notes = notes.includes('\n') ? `${shortNote}\n${notes.split('\n').slice(1).join('\n')}` : shortNote
        dirty.shortNote = true
        save('notes', notes)
      }}
      onblur={() => void flushDrafts()}
    />
    {#if quantityError}<small class="error" role="alert">{m.entry_invalid_quantity_short()}</small>{/if}
  </div>

  <div class="row-foot">
    <button
      class="more-toggle"
      aria-expanded={expanded}
      aria-controls="extra-{row.entry.id}"
      aria-label={m.entry_more_details()}
      onclick={() => (expanded = !expanded)}
      >{m.entry_more()}<ChevronDown size={16} aria-hidden="true" class={expanded ? 'flipped' : ''} /></button
    >
    <div class="row-status" aria-live="polite">
      <StatusLine
        tone={row.entry.display_sync_state === 'conflict' || row.entry.display_sync_state === 'error'
          ? 'danger'
          : row.entry.display_sync_state === 'synced'
            ? 'ok'
            : row.entry.display_sync_state === 'pending'
              ? 'warn'
              : 'muted'}
        >{status === 'saving'
          ? m.entry_saving()
          : status === 'photo-error'
            ? m.entry_add_photos_failed_short()
            : syncLabel}</StatusLine
      ><span class="photo-count">{m.entry_photo_count({ count: row.photo_count })}</span>
    </div>
    <button class="details-link" aria-label={m.entry_details()} onclick={() => ondetails(row.entry)}
      >{m.entry_details_link()}</button
    >
  </div>
  {#if expanded}
    <div class="extra" id="extra-{row.entry.id}">
      <label
        >{m.entry_unit()}<input
          list="units-{row.entry.collection_id}"
          placeholder={m.entry_unit_example()}
          value={unit}
          oninput={(event) => {
            unit = event.currentTarget.value
            save('unit', unit)
          }}
          onblur={() => void flushDrafts()}
        /></label
      >
      <datalist id="units-{row.entry.collection_id}"
        >{#each units as item}<option value={item}></option>{/each}</datalist
      >
      <label
        >{m.entry_expiration()}<input
          type="date"
          value={expirationDate}
          oninput={(event) => {
            expirationDate = event.currentTarget.value
            save('expiration_date', expirationDate || null)
          }}
          onblur={() => void flushDrafts()}
        /></label
      >
      <label class="wide"
        >{m.entry_count_detail()}<textarea
          rows="2"
          value={countDetail}
          oninput={(event) => {
            countDetail = event.currentTarget.value
            save('count_detail', countDetail)
          }}
          onblur={() => void flushDrafts()}></textarea></label
      >
      <label class="wide"
        >{m.entry_notes()}<textarea
          rows="3"
          value={notes}
          oninput={(event) => {
            notes = event.currentTarget.value
            shortNote = notes.split('\n')[0] ?? ''
            dirty.shortNote = true
            save('notes', notes)
          }}
          onblur={() => void flushDrafts()}></textarea></label
      >
    </div>
  {/if}
  {#if cameraOpen}<CameraSheet bind:open={cameraOpen} entryId={row.entry.id} />{/if}
  {#if moveOpen}<MoveToSheet
      bind:open={moveOpen}
      entryId={row.entry.id}
      beforemove={() => autosave.flush()}
    />{/if}
</article>

<style>
  .entry-row {
    position: relative;
    min-width: 0;
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'head head'
      'thumbs actions'
      'meta meta'
      'fields fields'
      'foot foot'
      'extra extra';
    align-items: center;
    gap: var(--space-2);
  }
  .row-head {
    grid-area: head;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    grid-template-areas:
      'tag title star menu'
      '. badges badges .';
    align-items: center;
    gap: var(--space-3);
  }
  .tag-link {
    grid-area: tag;
  }
  .title {
    grid-area: title;
  }
  .star-toggle {
    grid-area: star;
  }
  .menu-cell {
    grid-area: menu;
  }
  .row-badges {
    grid-area: badges;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .shared-tag {
    color: var(--color-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-tight);
    overflow-wrap: anywhere;
  }
  .needs-review {
    color: var(--color-warn);
    background: var(--color-warn-soft);
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }
  .star-toggle {
    min-width: var(--size-touch);
    min-height: var(--size-touch);
    border: 0;
    background: transparent;
    color: var(--color-warn);
  }
  .entry-meta {
    grid-area: meta;
    min-width: 0;
    min-height: calc(var(--text-sm) * var(--leading-body));
    display: flex;
    gap: var(--space-3);
  }
  .entry-note-preview,
  .movement-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
    margin: 0;
    font-size: var(--text-sm);
  }
  .tag-link {
    border: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }
  .title {
    min-width: 0;
    font-weight: 600;
  }
  .entry-row input,
  .entry-row textarea {
    width: 100%;
    min-width: 0;
    min-height: 44px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-3);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .menu-cell {
    min-width: 44px;
    display: flex;
    justify-content: flex-end;
  }
  .menu-cell:global(.menu) {
    margin: 0;
  }
  :global(.thumb-strip),
  :global(.no-photos) {
    grid-area: thumbs;
    min-width: 0;
  }
  .photo-actions {
    grid-area: actions;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    white-space: nowrap;
  }
  .photo-actions:global(.button),
  .library {
    width: var(--size-touch);
    min-width: var(--size-touch);
    height: 44px;
    min-height: 44px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .library {
    border: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-ink);
    border-radius: var(--radius-md);
    cursor: pointer;
  }
  .photo-actions:global(.button) {
    width: auto;
    min-width: 108px;
    padding: 0 var(--space-3);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -var(--space-1);
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .camera-label {
    white-space: nowrap;
  }
  .fields {
    grid-area: fields;
    position: relative;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.5fr) minmax(0, 1.8fr);
    gap: var(--space-2);
  }
  .quantity-wrap {
    position: relative;
    min-width: 0;
  }
  .fields .error {
    /* Floats below the fields so a typing slip never moves the row. */
    position: absolute;
    top: 100%;
    left: 0;
    z-index: var(--z-bottom-bar);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    background: var(--color-card);
  }
  datalist {
    display: none;
  }
  .error {
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
  .row-foot {
    grid-area: foot;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .more-toggle,
  .details-link {
    min-height: var(--size-touch);
    border: 0;
    padding: 0 var(--space-2);
    background: none;
    color: var(--color-ballpoint);
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .more-toggle {
    grid-area: more;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding-left: 0;
  }
  .more-toggle :global(svg) {
    transition: transform var(--duration-fast) var(--easing-standard);
  }
  .more-toggle :global(svg.flipped) {
    transform: rotate(180deg);
  }
  .details-link {
    grid-area: details;
    padding-right: 0;
  }
  .row-status {
    grid-area: status;
    flex: 1;
    min-width: 0;
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    overflow: hidden;
    white-space: nowrap;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .row-status :global(.status-line) {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .photo-count {
    flex: 0 0 var(--size-status-copy);
    width: var(--size-status-copy);
    text-align: right;
  }
  .extra {
    grid-area: extra;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-3) var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-line);
  }
  .extra label {
    min-width: 0;
    display: grid;
    gap: var(--space-1);
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .extra .wide {
    grid-column: 1 / -1;
  }
  /* iOS gives date inputs an intrinsic width that ignores the grid column unless the native look is dropped. */
  .extra input[type='date'] {
    display: block;
    -webkit-appearance: none;
    appearance: none;
  }

  @media (max-width: 430px) {
    .entry-row {
      padding: var(--space-2);
      gap: var(--space-2) var(--space-1);
    }
  }

  @container entry-list (min-width: 1130px) {
    .entry-row {
      grid-template-columns: 76px minmax(120px, 1.5fr) 44px 236px auto 72px 140px minmax(96px, 2fr) auto 44px;
      grid-template-areas:
        'tag title star thumbs actions quantity dimensions note details menu'
        '. badges badges badges badges badges badges badges badges .'
        '. meta meta meta meta meta meta meta meta .'
        'status status status status status status status status status status';
      gap: var(--space-1);
      padding: var(--space-2);
      border-radius: 0;
    }
    .row-head,
    .fields,
    .row-foot {
      display: contents;
    }
    .tag-link {
      grid-area: tag;
      justify-self: start;
    }
    .title {
      grid-area: title;
      min-width: 0;
    }
    .star-toggle {
      grid-area: star;
    }
    :global(.thumb-strip),
    :global(.no-photos) {
      grid-area: thumbs;
    }
    .photo-actions {
      grid-area: actions;
      flex-wrap: nowrap;
      justify-content: flex-start;
      gap: var(--space-2);
    }
    .quantity-wrap {
      grid-area: quantity;
    }
    .dimensions {
      grid-area: dimensions;
    }
    .short-note {
      grid-area: note;
      grid-column: auto;
    }
    .details-link {
      grid-area: details;
      min-height: 44px;
    }
    .menu-cell {
      grid-area: menu;
    }
    .row-badges {
      grid-area: badges;
    }
    .more-toggle,
    .extra {
      display: none;
    }
    .row-status {
      justify-content: space-between;
      border-top: 1px solid var(--color-line);
      padding-top: var(--space-2);
    }
  }
</style>
