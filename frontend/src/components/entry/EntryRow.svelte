<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
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
  let title = $state('')
  let quantity = $state('')
  let unit = $state('')
  let shortNote = $state('')
  let countDetail = $state('')
  let notes = $state('')
  let focused = $state('')
  let quantityError = $state(false)
  let status = $state('Saved on this device')
  let mode = $state<CaptureMode>('native')
  let cameraOpen = $state(false)
  let autosaveEntryId = ''
  let autosave = $state.raw(createEntryAutosave(repo, ''))

  $effect(() => {
    const entry = row.entry
    if (autosaveEntryId !== entry.id) {
      autosaveEntryId = entry.id
      autosave = createEntryAutosave(repo, entry.id)
    }
    if (focused !== 'title') title = entry.title
    if (focused !== 'quantity') quantity = entry.quantity ?? ''
    if (focused !== 'unit') unit = entry.unit
    if (focused !== 'shortNote') shortNote = entry.notes.split('\n')[0] ?? ''
    if (focused !== 'countDetail') countDetail = entry.count_detail
    if (focused !== 'notes') notes = entry.notes
    void repo.getSetting<CaptureMode>('capture_mode', 'native').then((value) => (mode = value))
  })
  onDestroy(() => void autosave.dispose())
  onMount(() => {
    const flush = () => void autosave.flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  })

  function save(field: 'title' | 'quantity' | 'unit' | 'count_detail' | 'notes', value: string | null) {
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
    row.entry.sync_state === 'conflict'
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
      bind:value={title}
      onfocus={() => (focused = 'title')}
      oninput={() => save('title', title)}
      onblur={() => {
        focused = ''
        void autosave.flush()
      }}
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
        onfocus={() => (focused = 'quantity')}
        oninput={(event) => quantityChanged(event.currentTarget.value)}
        onblur={() => {
          focused = ''
          void autosave.flush()
        }}
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
      bind:value={unit}
      onfocus={() => (focused = 'unit')}
      oninput={() => save('unit', unit)}
      onblur={() => {
        focused = ''
        void autosave.flush()
      }}
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
      bind:value={shortNote}
      onfocus={() => (focused = 'shortNote')}
      oninput={() => {
        notes = notes.includes('\n') ? `${shortNote}\n${notes.split('\n').slice(1).join('\n')}` : shortNote
        save('notes', notes)
      }}
      onblur={() => {
        focused = ''
        void autosave.flush()
      }}
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
          bind:value={countDetail}
          onfocus={() => (focused = 'countDetail')}
          oninput={() => save('count_detail', countDetail)}
          onblur={() => {
            focused = ''
            void autosave.flush()
          }}></textarea></label
      >
      <label
        >Notes<textarea
          rows="3"
          bind:value={notes}
          onfocus={() => (focused = 'notes')}
          oninput={() => save('notes', notes)}
          onblur={() => {
            focused = ''
            void autosave.flush()
          }}></textarea></label
      >
    </details>
    <button class="details-link" aria-label="Details" onclick={() => ondetails(row.entry)}>Details ›</button>
  </div>
  <div class="row-status">
    <StatusLine tone={row.pending_sync ? 'warn' : 'muted'}
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
    border-radius: 8px;
    padding: 8px;
    content-visibility: auto;
    contain-intrinsic-size: 300px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'head head'
      'thumbs actions'
      'fields fields'
      'more details'
      'status status';
    align-items: center;
    gap: 8px 4px;
  }
  .row-head {
    grid-area: head;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
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
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--color-card);
    color: var(--color-ink);
    font-size: 16px;
  }
  .menu-cell {
    min-width: 44px;
    display: flex;
    justify-content: flex-end;
  }
  .menu-cell :global(.menu) {
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
    gap: 2px;
    white-space: nowrap;
  }
  .photo-actions :global(.button),
  .library {
    width: 44px;
    min-width: 44px;
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
    border-radius: 6px;
    cursor: pointer;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .camera-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .fields {
    grid-area: fields;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
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
    font-size: 13px;
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
  .more-details label {
    display: block;
    margin-top: 8px;
    color: var(--color-muted);
    font-size: 13px;
  }
  .more-details textarea {
    display: block;
    margin-top: 4px;
  }
  .details-link {
    grid-area: details;
    min-height: 44px;
    border: 0;
    padding: 0 4px;
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
    font-size: 13px;
  }

  @media (max-width: 430px) {
    .entry-row {
      padding: 4px;
      gap: 6px 2px;
    }
  }

  @container entry-list (min-width: 1130px) {
    .entry-row {
      grid-template-columns: 76px minmax(160px, 1.2fr) 242px 140px 88px 110px minmax(180px, 2fr) 64px 44px;
      grid-template-areas:
        'tag title thumbs actions quantity unit note details menu'
        'status status status status status status status status status';
      gap: 2px;
      padding: 4px;
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
      gap: 4px;
    }
    .photo-actions :global(.button) {
      width: auto;
      min-width: 92px;
      padding: 0 8px;
    }
    .camera-label {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
      clip-path: none;
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
      padding-top: 4px;
    }
  }
</style>
