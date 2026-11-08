<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import type { Entry, Id, Photo } from '$lib/types'
  import { SETTING_KEYS, formatSequence } from '$lib/types'
  import type { EntryPatch, EntrySort } from '$lib/repo'
  import { pickPhotos, type CaptureMode } from '$lib/camera'
  import { navigate, restoreScroll, saveScroll } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import Tag from '../../components/ui/Tag.svelte'
  import Button from '../../components/ui/Button.svelte'
  import CameraSheet from '../../components/camera/CameraSheet.svelte'
  import PhotoGrid from '../../components/gallery/PhotoGrid.svelte'
  import PhotoViewer from '../../components/viewer/PhotoViewer.svelte'

  type EditableKey =
    'title' | 'quantity' | 'unit' | 'count_detail' | 'notes' | 'expiration_date' | 'dimensions'
  let {
    collectionId,
    entryId,
    variant = 'page',
  }: { collectionId: Id; entryId: Id; variant?: 'page' | 'panel' } = $props()

  let entry = $state<Entry | undefined>()
  let draft = $state<Partial<Record<EditableKey, string>>>({})
  let dirty = $state(new Set<EditableKey>())
  let savingCount = $state(0)
  let invalidQuantity = $state(false)
  let photos = $state<Photo[]>([])
  let cameraOpen = $state(false)
  let viewerOpen = $state(false)
  let viewerPhotoId = $state<Id | null>(null)
  let sort = $state<EntrySort>('newest')
  let adjacent = $state<{ prev: Id | null; next: Id | null }>({ prev: null, next: null })
  let captureMode = $state<CaptureMode>('native')
  let expanded = $state(false)
  let failure = $state('')
  const timers = new Map<EditableKey, ReturnType<typeof setTimeout>>()

  const displayedQuantity = $derived(draft.quantity ?? '')

  onMount(() => {
    const entrySubscription = repo.watchEntry(entryId).subscribe((value) => {
      entry = value
      if (!value) return
      const fields: EditableKey[] = [
        'title',
        'quantity',
        'unit',
        'count_detail',
        'notes',
        'expiration_date',
        'dimensions',
      ]
      for (const field of fields) {
        if (
          dirty.has(field) ||
          ((document.activeElement instanceof HTMLInputElement ||
            document.activeElement instanceof HTMLTextAreaElement) &&
            document.activeElement.dataset.field === field)
        )
          continue
        const valueForField = value[field]
        draft[field] = field === 'quantity' ? (valueForField ?? '') : ((valueForField ?? '') as string)
      }
    })
    const photoSubscription = repo.watchPhotos(entryId).subscribe((value) => {
      photos = value
      void refreshAdjacent()
    })
    void repo.getSetting<EntrySort>(SETTING_KEYS.entrySort, 'newest').then((value) => {
      sort = value
      void refreshAdjacent()
    })
    void repo
      .getSetting<CaptureMode>(SETTING_KEYS.captureMode, 'native')
      .then((value) => (captureMode = value))
    void refreshAdjacent()
    const onPageHide = () => {
      void flushAll()
    }
    window.addEventListener('pagehide', onPageHide)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && variant === 'panel' && !viewerOpen) navigate(`/c/${collectionId}`)
      if (event.altKey && event.key === 'ArrowLeft' && adjacent.prev)
        navigate(`/c/${collectionId}/e/${adjacent.prev}`)
      if (event.altKey && event.key === 'ArrowRight' && adjacent.next)
        navigate(`/c/${collectionId}/e/${adjacent.next}`)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('keydown', onKey)
      if (typeof entrySubscription === 'function') entrySubscription()
      else entrySubscription.unsubscribe()
      if (typeof photoSubscription === 'function') photoSubscription()
      else photoSubscription.unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      void flushAll()
    }
  })

  $effect(() => {
    if (entryId) void refreshAdjacent()
  })

  async function refreshAdjacent() {
    try {
      adjacent = await repo.getAdjacentEntryIds(entryId, sort)
    } catch {
      /* Entry may be removed while navigating. */
    }
  }
  function setField(field: EditableKey, value: string) {
    draft[field] = value
    dirty.add(field)
    dirty = new Set(dirty)
    if (field === 'quantity') {
      const normalized = normalizeQuantity(value)
      invalidQuantity = value.trim() !== '' && normalized === null
    }
    const old = timers.get(field)
    if (old) clearTimeout(old)
    timers.set(
      field,
      setTimeout(() => void flushField(field), 300),
    )
  }
  function normalizeQuantity(value: string): string | null {
    const trimmed = value.trim().replace(',', '.')
    if (!trimmed) return null
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null
    return trimmed
  }
  async function flushField(field: EditableKey) {
    const timer = timers.get(field)
    if (timer) clearTimeout(timer)
    timers.delete(field)
    if (!dirty.has(field) || !entry) return
    const value = draft[field] ?? ''
    if (field === 'quantity') {
      const quantity = normalizeQuantity(value)
      if (value.trim() && quantity === null) {
        invalidQuantity = true
        return
      }
      invalidQuantity = false
      await persist(field, quantity)
    } else {
      await persist(field, field === 'expiration_date' && value === '' ? null : value)
    }
  }
  async function persist(field: EditableKey, value: string | null) {
    if (!entry) return
    const patch = { [field]: value } as EntryPatch
    savingCount += 1
    failure = ''
    try {
      await repo.updateEntry(entry.id, patch)
      dirty.delete(field)
      dirty = new Set(dirty)
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : 'Could not save this change.'
    } finally {
      savingCount -= 1
    }
  }
  async function flushAll() {
    for (const field of [...dirty]) await flushField(field)
  }
  async function add(kind: 'camera' | 'library') {
    try {
      // Invoke synchronously from the click handler to preserve the browser's user activation.
      const selection = pickPhotos(kind)
      const incoming = await selection
      if (incoming.length) await repo.addPhotos(entryId, incoming)
    } catch (cause) {
      showToast({ message: cause instanceof Error ? cause.message : 'Could not add photos' })
    }
  }
  function openCamera() {
    if (captureMode === 'fast') cameraOpen = true
    else void add('camera')
  }
  async function newEntry() {
    const created = await repo.createEntry(collectionId)
    navigate(`/c/${collectionId}/e/${created.id}`)
  }
  function backToList() {
    saveScroll(`entries:${collectionId}`)
    navigate(`/c/${collectionId}`)
    requestAnimationFrame(() => restoreScroll(`entries:${collectionId}`))
  }
  function undoDelete(photo: Photo) {
    showToast({ message: 'Photo deleted', actionLabel: 'Undo', action: () => repo.restorePhoto(photo.id) })
  }
</script>

<svelte:head
  ><title
    >{entry ? `${formatSequence(entry.sequence_number)} · Entry detail` : 'Entry detail'} · Kufang Capture</title
  ></svelte:head
>
{#if !entry}
  <section class="detail-empty">
    {#if entry === undefined}<p>Loading entry…</p>{/if}
  </section>
{:else}
  <section class:panel={variant === 'panel'} class="detail-page">
    <header class="detail-header">
      {#if variant === 'page'}<button class="back-link" onclick={backToList}>← Back to list</button
        >{:else}<button class="back-link" onclick={() => navigate(`/c/${collectionId}`)}>Close</button>{/if}
      <div class="detail-title-row">
        <Tag sequence={entry.sequence_number} size="lg" /><input
          class="title-input"
          aria-label="Entry title"
          placeholder="Entry title"
          value={draft.title ?? ''}
          data-field="title"
          oninput={(event) => setField('title', event.currentTarget.value)}
          onblur={() => void flushField('title')}
        />
      </div>
      <label class="review-select"
        >Review status <select
          value={entry.review_status}
          onchange={(event) =>
            void repo.updateEntry(entryId, {
              review_status: event.currentTarget.value as Entry['review_status'],
            })}
          ><option value="draft">Draft</option><option value="complete">Complete</option><option
            value="needs_review">Needs review</option
          ></select
        ></label
      >
      <p class="save-state" aria-live="polite">
        {#if savingCount}Saving…{:else if failure}{failure}{:else if entry.sync_state === 'pending'}Pending
          sync{:else if entry.sync_state === 'synced'}Backed up{:else}Saved on this device{/if}
      </p>
    </header>

    {#if entry.deleted_at}
      <div class="deleted-notice" role="status">
        <span>This entry was deleted.</span><Button
          onclick={async () => {
            await repo.restoreEntry(entryId)
          }}>Restore</Button
        >
      </div>
    {:else}
      <div class="photo-actions">
        <Button variant="capture" onclick={openCamera}>Add Photo</Button><Button
          variant="quiet"
          onclick={() => void add('library')}>Add from Photos</Button
        >
      </div>
      <PhotoGrid
        {photos}
        onopen={(id) => {
          viewerPhotoId = id
          viewerOpen = true
        }}
        ondelete={undoDelete}
      />

      <div class="field-grid">
        <label class="field"
          >Quantity<input
            aria-label="Quantity"
            data-field="quantity"
            inputmode="decimal"
            enterkeyhint="next"
            value={displayedQuantity}
            oninput={(event) => setField('quantity', event.currentTarget.value)}
            onblur={() => void flushField('quantity')}
            aria-invalid={invalidQuantity}
          />{#if invalidQuantity}<small class="field-hint" role="alert"
              >Enter a decimal number, such as 12.5.</small
            >{/if}</label
        >
        <label class="field"
          >Unit<input
            aria-label="Unit"
            data-field="unit"
            value={draft.unit ?? ''}
            oninput={(event) => setField('unit', event.currentTarget.value)}
            onblur={() => void flushField('unit')}
          /></label
        >
        <label class="field full-field"
          >Count detail<textarea
            data-field="count_detail"
            rows="2"
            placeholder="e.g. 3 boxes, 24 packs each, plus 2 loose packs"
            value={draft.count_detail ?? ''}
            oninput={(event) => setField('count_detail', event.currentTarget.value)}
            onblur={() => void flushField('count_detail')}></textarea></label
        >
        <label class="field full-field"
          >Notes<textarea
            data-field="notes"
            rows="4"
            value={draft.notes ?? ''}
            oninput={(event) => setField('notes', event.currentTarget.value)}
            onblur={() => void flushField('notes')}></textarea></label
        >
      </div>
      <button class="more-toggle" aria-expanded={expanded} onclick={() => (expanded = !expanded)}
        >More details {expanded ? '−' : '+'}</button
      >
      {#if expanded}<div class="field-grid extra-fields">
          <label class="field"
            >Expiration date<input
              type="date"
              data-field="expiration_date"
              value={draft.expiration_date ?? ''}
              oninput={(event) => setField('expiration_date', event.currentTarget.value)}
              onblur={() => void flushField('expiration_date')}
            /><small>Leave blank if unknown</small></label
          ><label class="field"
            >Dimensions<input
              data-field="dimensions"
              placeholder="e.g. 30 × 20 × 15 cm"
              value={draft.dimensions ?? ''}
              oninput={(event) => setField('dimensions', event.currentTarget.value)}
              onblur={() => void flushField('dimensions')}
            /></label
          >
        </div>{/if}
    {/if}
    <nav class="detail-navigation" aria-label="Entry navigation">
      <Button
        variant="quiet"
        disabled={!adjacent.prev}
        onclick={() => adjacent.prev && navigate(`/c/${collectionId}/e/${adjacent.prev}`)}>Previous</Button
      ><Button
        variant="quiet"
        disabled={!adjacent.next}
        onclick={() => adjacent.next && navigate(`/c/${collectionId}/e/${adjacent.next}`)}>Next</Button
      ><Button onclick={() => void newEntry()}>+ New Entry</Button>
    </nav>
  </section>
{/if}
{#if entry}<CameraSheet bind:open={cameraOpen} entryId={entry.id} />{/if}
<PhotoViewer bind:open={viewerOpen} {entryId} startPhotoId={viewerPhotoId} />

<style>
  .detail-page {
    max-width: 900px;
    margin: 0 auto;
    padding: 20px 16px calc(36px + env(safe-area-inset-bottom));
  }
  .detail-page.panel {
    max-width: none;
    padding: 20px 24px;
  }
  .detail-header {
    display: grid;
    gap: 14px;
    margin-bottom: 20px;
  }
  .back-link {
    justify-self: start;
    min-height: 44px;
    padding: 6px 0;
    color: var(--color-ballpoint);
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .detail-title-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .title-input {
    min-width: 0;
    flex: 1;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-ink);
    font-size: 26px;
    padding: 8px 4px;
  }
  .review-select {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-muted);
  }
  .review-select select {
    min-height: 42px;
    padding: 6px 10px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-card);
    color: var(--color-ink);
  }
  .save-state {
    margin: -6px 0 0;
    color: var(--color-muted);
    font-size: 14px;
  }
  .photo-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 18px 0;
  }
  .field-grid {
    display: grid;
    grid-template-columns: minmax(100px, 0.7fr) minmax(120px, 1fr);
    gap: 16px;
    margin: 24px 0;
  }
  .full-field {
    grid-column: 1 / -1;
  }
  .field input,
  .field textarea {
    width: 100%;
    min-height: 46px;
    padding: 10px 12px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-card);
    color: var(--color-ink);
    font-size: 16px;
  }
  .field textarea {
    resize: vertical;
  }
  .field-hint {
    color: var(--color-danger);
    font-weight: 400;
  }
  .more-toggle {
    width: 100%;
    min-height: 48px;
    text-align: left;
    border: 0;
    border-top: 1px solid var(--color-line);
    border-bottom: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-ballpoint);
    font-weight: 600;
    cursor: pointer;
  }
  .extra-fields {
    margin-top: 18px;
  }
  .extra-fields small {
    color: var(--color-muted);
    font-weight: 400;
  }
  .detail-navigation {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    margin-top: 28px;
  }
  .deleted-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--color-warn);
    border-radius: 8px;
    background: var(--color-card);
  }
  .detail-empty {
    max-width: 900px;
    margin: auto;
    padding: 24px;
  }
  @media (min-width: 900px) {
    .detail-page:not(.panel) {
      padding-top: 32px;
    }
    .panel .field-grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
