<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
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
  let isDesktop = $state(false)
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
    const media = window.matchMedia('(min-width: 900px)')
    const update = () => (isDesktop = media.matches)
    const flush = () => void autosave.flush()
    update()
    media.addEventListener('change', update)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      media.removeEventListener('change', update)
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
</script>

<article class="entry-row" class:desktop-row={isDesktop}>
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
  <div class="photos-actions">
    <ThumbnailStrip
      photos={row.recent_photos}
      total={row.photo_count}
      onmore={() => void openMorePhotos()}
      onopen={(id) => {
        onviewer(row.entry.id, id)
      }}
    />
    <Button variant="capture" onclick={openCapture}>▣ Add Photo</Button>
    <button class="library" aria-label="Add from Photos" onclick={() => void capture('library')}
      >＋<span>Add from Photos</span></button
    >
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
    <button class="details-link" onclick={() => ondetails(row.entry)}>Details ›</button>
  </div>
  <div class="row-status">
    <StatusLine tone={row.pending_sync ? 'warn' : 'muted'}
      >{row.pending_sync ? 'Pending sync' : status}</StatusLine
    ><span>{row.photo_count} {row.photo_count === 1 ? 'photo' : 'photos'}</span>
  </div>
  <CameraSheet bind:open={cameraOpen} entryId={row.entry.id} />
</article>

<style>
  .entry-row {
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: 8px;
    padding: 12px;
    content-visibility: auto;
    contain-intrinsic-size: 270px;
    display: grid;
    gap: 10px;
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tag-link {
    border: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }
  .title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
  }
  .entry-row input,
  .entry-row textarea {
    font-size: 16px;
    min-height: 42px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--color-card);
    color: var(--color-ink);
    width: 100%;
  }
  .photos-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .library {
    border: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-ink);
    border-radius: 6px;
    min-height: 44px;
    padding: 8px 10px;
  }
  .library span {
    position: absolute;
    clip: rect(0, 0, 0, 0);
    clip-path: inset(50%);
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .quantity-wrap {
    position: relative;
  }
  .error {
    color: var(--color-danger);
    font-size: 13px;
  }
  .row-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .more-details summary,
  .details-link {
    cursor: pointer;
    color: var(--color-ballpoint);
  }
  .more-details label {
    display: block;
    margin-top: 8px;
    font-size: 13px;
    color: var(--color-muted);
  }
  .more-details textarea {
    display: block;
    width: 100%;
    margin-top: 4px;
  }
  .details-link {
    border: 0;
    background: none;
    font: inherit;
    white-space: nowrap;
  }
  .row-status {
    display: flex;
    justify-content: space-between;
    color: var(--color-muted);
    font-size: 13px;
  }
  .desktop-row {
    grid-template-columns: 250px 230px minmax(270px, 1.5fr) minmax(180px, 1fr) 90px;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 0;
  }
  .desktop-row .row-head {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
  }
  .desktop-row .photos-actions {
    grid-column: 2;
    grid-row: 1;
    flex-wrap: wrap;
  }
  .desktop-row .photos-actions :global(.button) {
    min-height: 36px;
    padding: 5px 8px;
    font-size: 13px;
  }
  .desktop-row .fields {
    grid-column: 3 / 5;
    grid-row: 1;
    grid-template-columns: 90px 110px minmax(100px, 1fr);
  }
  .desktop-row .row-foot {
    grid-column: 5;
    grid-row: 1;
  }
  .desktop-row .row-status {
    grid-column: 1 / -1;
    border-top: 1px solid var(--color-line);
    padding-top: 5px;
  }
  .desktop-row .more-details {
    display: none;
  }
  @media (min-width: 900px) {
    .library span {
      position: static;
      clip: auto;
      clip-path: none;
    }
    .library {
      white-space: nowrap;
    }
  }
</style>
