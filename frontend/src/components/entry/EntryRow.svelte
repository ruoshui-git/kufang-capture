<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Camera, Images } from '@lucide/svelte'
  import type { EntryRow as EntryRowModel, Entry, Photo } from '$lib/types'
  import { formatSequence } from '$lib/types'
  import { repo } from '$lib/db'
  import { pickPhotos, type CaptureMode } from '$lib/camera'
  import Button from '../ui/Button.svelte'
  import Tag from '../ui/Tag.svelte'
  import Menu from '../ui/Menu.svelte'
  import StatusLine from '../ui/StatusLine.svelte'
  import ThumbnailStrip from './ThumbnailStrip.svelte'
  import CameraSheet from '../camera/CameraSheet.svelte'
  import { createEntryAutosave, normalizeQuantityInput } from '$lib/entries/autosave'

  let {
    row,
    units,
    ondetails,
    onviewer,
    ondelete,
  }: {
    row: EntryRowModel
    units: string[]
    ondetails: (entry: Entry) => void
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
  let dirty = $state({
    title: false,
    quantity: false,
    unit: false,
    shortNote: false,
    countDetail: false,
    notes: false,
  })
  let acknowledged = $state<{
    title: string | undefined
    quantity: string | null | undefined
    unit: string | undefined
    count_detail: string | undefined
    notes: string | undefined
  }>({ title: undefined, quantity: undefined, unit: undefined, count_detail: undefined, notes: undefined })
  let quantityError = $state(false)
  let status = $state('Saved on this device')
  let syncPhase = $state('idle')
  let mode = $state<CaptureMode>('native')
  let cameraOpen = $state(false)
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
  })
  onDestroy(() => void autosave.dispose())
  onMount(() => {
    void repo.getSetting<CaptureMode>('capture_mode', 'native').then((value) => (mode = value))
    const flush = () => void autosave.flush()
    let unsubscribeStatus: (() => void) | undefined
    void import('$lib/sync').then(({ syncEngine }) => {
      const subscription = syncEngine.status.subscribe((value) => (syncPhase = value.phase))
      unsubscribeStatus =
        typeof subscription === 'function'
          ? subscription
          : subscription?.unsubscribe
            ? () => subscription.unsubscribe()
            : undefined
    })
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      unsubscribeStatus?.()
    }
  })

  function save(field: 'title' | 'quantity' | 'unit' | 'count_detail' | 'notes', value: string | null) {
    if (field === 'title') dirty.title = true
    if (field === 'quantity') dirty.quantity = true
    if (field === 'unit') dirty.unit = true
    if (field === 'count_detail') dirty.countDetail = true
    if (field === 'notes') dirty.notes = true
    acknowledged[field] = undefined
    status = 'Saving…'
    autosave.schedule(field, value)
    setTimeout(() => {
      if (status === 'Saving…') status = row.pending_sync ? 'Pending sync' : 'Saved on this device'
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
  }
  async function capture(kind: 'camera' | 'library') {
    // Keep the picker invocation in the click call stack for iOS.
    const picked = pickPhotos(kind)
    try {
      const photos = await picked
      if (photos.length) await repo.addPhotos(row.entry.id, photos)
    } catch {
      status = 'Could not add photos'
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
    const next = photos
      .slice()
      .sort((a, b) => b.captured_at.localeCompare(a.captured_at) || b.id.localeCompare(a.id))[3]
    if (next) onviewer(row.entry.id, next.id)
  }
  const syncLabel = $derived(
    syncPhase === 'syncing' && row.entry.sync_state === 'pending'
      ? 'Syncing'
      : row.entry.sync_state === 'conflict'
        ? 'Conflict'
        : row.entry.sync_state === 'error'
          ? 'Sync error'
          : row.entry.sync_state === 'synced'
            ? 'Backed up'
            : row.pending_sync || row.entry.sync_state === 'pending'
              ? 'Pending sync'
              : 'Saved on this device',
  )
</script>

<article class="entry-row">
  <div class="row-head">
    <button
      class="tag-link"
      aria-label="Open details for {formatSequence(row.entry.sequence_number)}"
      onclick={() => ondetails(row.entry)}
    >
      <Tag sequence={row.entry.sequence_number} incomplete={row.is_incomplete} />
    </button>
    <input
      class="title"
      aria-label="Entry title"
      placeholder="Entry {formatSequence(row.entry.sequence_number)}"
      value={title}
      oninput={(event) => {
        title = event.currentTarget.value
        save('title', title)
      }}
      onblur={() => void flushDrafts()}
    />
    <div class="menu-cell">
      <Menu label="Entry actions">
        <button
          role="menuitem"
          onclick={() =>
            void repo.updateEntry(row.entry.id, {
              review_status: row.entry.review_status === 'needs_review' ? 'complete' : 'needs_review',
            })}>{row.entry.review_status === 'needs_review' ? 'Mark complete' : 'Mark needs review'}</button
        >
        <button role="menuitem" onclick={() => ondelete(row)}>Delete entry</button>
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
      <span class="camera-label">Add Photo</span>
    </Button>
    <button class="library" aria-label="Add from Photos" onclick={() => void capture('library')}>
      <Images size={18} aria-hidden="true" />
      <span class="visually-hidden">Add from Photos</span>
    </button>
  </div>

  <div class="fields">
    <div class="quantity-wrap">
      <input
        aria-label="Quantity"
        inputmode="decimal"
        placeholder="Qty"
        value={quantity}
        oninput={(event) => quantityChanged(event.currentTarget.value)}
        onblur={() => void flushDrafts()}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            ;(
              event.currentTarget.parentElement?.parentElement?.querySelector(
                '[aria-label="Unit"]',
              ) as HTMLInputElement | null
            )?.focus()
          }
        }}
      />
      {#if quantityError}<small class="error">Enter a number such as 12 or 12.5.</small>{/if}
    </div>
    <input
      class="unit"
      aria-label="Unit"
      list="units-{row.entry.collection_id}"
      placeholder="Unit"
      value={unit}
      oninput={(event) => {
        unit = event.currentTarget.value
        save('unit', unit)
      }}
      onblur={() => void flushDrafts()}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          ;(
            event.currentTarget.parentElement?.parentElement?.querySelector(
              '[aria-label="Short note"]',
            ) as HTMLInputElement | null
          )?.focus()
        }
      }}
    />
    <input
      class="short-note"
      aria-label="Short note"
      placeholder="Short note"
      value={shortNote}
      oninput={(event) => {
        shortNote = event.currentTarget.value
        notes = notes.includes('\n') ? `${shortNote}\n${notes.split('\n').slice(1).join('\n')}` : shortNote
        dirty.shortNote = true
        save('notes', notes)
      }}
      onblur={() => void flushDrafts()}
    />
    <datalist id="units-{row.entry.collection_id}"
      >{#each units as item}<option value={item}></option>{/each}</datalist
    >
  </div>

  <div class="row-foot">
    <details class="more-details">
      <summary>More details</summary>
      <label
        >Count detail<textarea
          rows="2"
          value={countDetail}
          oninput={(event) => {
            countDetail = event.currentTarget.value
            save('count_detail', countDetail)
          }}
          onblur={() => void flushDrafts()}></textarea></label
      >
      <label
        >Notes<textarea
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
    </details>
    <button class="details-link" aria-label="Details" onclick={() => ondetails(row.entry)}>Details ›</button>
  </div>
  <div class="row-status" aria-live="polite">
    <StatusLine
      tone={syncLabel === 'Syncing'
        ? 'syncing'
        : row.entry.sync_state === 'conflict' || row.entry.sync_state === 'error'
          ? 'danger'
          : row.entry.sync_state === 'synced'
            ? 'ok'
            : row.pending_sync || row.entry.sync_state === 'pending'
              ? 'warn'
              : 'muted'}
      >{status === 'Saving…' || status === 'Could not add photos' ? status : syncLabel}</StatusLine
    ><span>{row.photo_count} {row.photo_count === 1 ? 'photo' : 'photos'}</span>
  </div>
  <CameraSheet bind:open={cameraOpen} entryId={row.entry.id} />
</article>

<style>
  .entry-row {
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
      'fields fields'
      'more details'
      'status status';
    align-items: center;
    gap: var(--space-3) var(--space-2);
  }
  .row-head {
    grid-area: head;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
  }
  .tag-link {
    grid-area: auto;
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
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-3);
  }
  .quantity-wrap {
    position: relative;
    min-width: 0;
  }
  .unit {
    grid-column: 2;
  }
  .short-note {
    grid-column: 1 / -1;
  }
  datalist {
    display: none;
  }
  .error {
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
  .row-foot {
    display: contents;
  }
  .more-details {
    grid-area: more;
  }
  .more-details summary,
  .details-link {
    cursor: pointer;
    color: var(--color-ballpoint);
  }
  .more-details summary {
    display: flex;
    align-items: center;
    min-height: var(--size-touch);
  }
  .more-details label {
    display: block;
    margin-top: var(--space-3);
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .more-details textarea {
    display: block;
    margin-top: var(--space-2);
  }
  .details-link {
    grid-area: details;
    min-height: 44px;
    border: 0;
    padding: 0 var(--space-2);
    background: none;
    color: var(--color-ballpoint);
    font: inherit;
    white-space: nowrap;
  }
  .row-status {
    grid-area: status;
    display: flex;
    justify-content: space-between;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }

  @media (max-width: 430px) {
    .entry-row {
      padding: var(--space-2);
      gap: var(--space-2) var(--space-1);
    }
  }

  @container entry-list (min-width: 1130px) {
    .entry-row {
      grid-template-columns: 76px minmax(160px, 1.2fr) 242px 140px 88px 110px minmax(180px, 2fr) 64px 44px;
      grid-template-areas:
        'tag title thumbs actions quantity unit note details menu'
        'status status status status status status status status status';
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
      min-width: 160px;
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
    .unit {
      grid-area: unit;
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
    .more-details {
      display: none;
    }
    .row-status {
      border-top: 1px solid var(--color-line);
      padding-top: var(--space-2);
    }
  }

  @container entry-list (min-width: 700px) and (max-width: 1129px) {
    .entry-row {
      grid-template-columns: 56px minmax(70px, 1fr) 114px 156px 56px 56px minmax(70px, 1fr) 72px 44px;
      grid-template-areas:
        'tag title thumbs actions quantity unit note details menu'
        'status status status status status status status status status';
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
    :global(.thumb-strip),
    :global(.no-photos) {
      grid-area: thumbs;
    }
    .entry-row :global(.thumb:nth-child(n + 3)) {
      display: none;
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
    .unit {
      grid-area: unit;
    }
    .short-note {
      grid-area: note;
      grid-column: auto;
    }
    .details-link {
      grid-area: details;
      min-height: var(--size-touch);
    }
    .menu-cell {
      grid-area: menu;
    }
    .more-details {
      display: none;
    }
    .row-status {
      border-top: 1px solid var(--color-line);
      padding-top: var(--space-2);
    }
  }
</style>
