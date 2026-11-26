<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import type { EntryView, Id, Movement, Photo } from '$lib/types'
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
  import MovementHistory from './MovementHistory.svelte'
  import MoveToSheet from '../../components/entry/MoveToSheet.svelte'

  type EditableKey =
    | 'title'
    | 'quantity'
    | 'unit'
    | 'count_detail'
    | 'notes'
    | 'entry_notes'
    | 'expiration_date'
    | 'dimensions'
  let {
    collectionId,
    entryId,
    variant = 'page',
  }: { collectionId: Id; entryId: Id; variant?: 'page' | 'panel' } = $props()

  let entry = $state<EntryView | undefined>()
  let movements = $state<Movement[]>([])
  const itemId = $derived(entry?.item_id)
  $effect(() => {
    movements = []
    if (!itemId) return
    const subscription = repo.watchMovements(itemId).subscribe((rows) => (movements = rows))
    return typeof subscription === 'function' ? subscription : () => subscription.unsubscribe()
  })
  const lastPlacementChange = $derived(
    movements.findLast(
      (row) =>
        !row.undone_at &&
        (row.to_entry_id === entryId || (row.from_entry_id === entryId && row.kind !== 'part')),
    ),
  )
  const movedAway = $derived(lastPlacementChange?.from_entry_id === entryId ? lastPlacementChange : undefined)
  let draft = $state<Partial<Record<EditableKey, string>>>({})
  let dirty = $state(new Set<EditableKey>())
  let savingCount = $state(0)
  let invalidQuantity = $state(false)
  let photos = $state<Photo[]>([])
  let cameraOpen = $state(false)
  let moveOpen = $state(false)
  let viewerOpen = $state(false)
  let viewerPhotoId = $state<Id | null>(null)
  let sort = $state<EntrySort>('newest')
  let adjacent = $state<{ prev: Id | null; next: Id | null }>({ prev: null, next: null })
  let captureMode = $state<CaptureMode>('native')
  let failure = $state('')
  let showEntryNotes = $state(false)
  let collectionName = $state<string>()
  let dimensionsField: HTMLTextAreaElement | undefined = $state()
  let syncPhase = $state('idle')
  const timers = new Map<EditableKey, ReturnType<typeof setTimeout>>()

  const displayedQuantity = $derived(draft.quantity ?? '')

  $effect(() => {
    draft.dimensions
    if (!dimensionsField) return
    dimensionsField.style.height = 'auto'
    dimensionsField.style.height = `${dimensionsField.scrollHeight}px`
  })

  onMount(() => {
    void repo.getCollection(collectionId).then((value) => {
      if (value) collectionName = value.name
    })
    let unsubscribeSync: (() => void) | undefined
    void import('$lib/sync').then(({ syncEngine }) => {
      const subscription = syncEngine.status.subscribe((value) => (syncPhase = value.phase))
      unsubscribeSync =
        typeof subscription === 'function'
          ? subscription
          : subscription?.unsubscribe
            ? () => subscription.unsubscribe()
            : undefined
    })
    const entrySubscription = repo.watchEntry(entryId).subscribe((value) => {
      entry = value
      if (!value) return
      const fields: EditableKey[] = [
        'title',
        'quantity',
        'unit',
        'count_detail',
        'notes',
        'entry_notes',
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
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void flushAll()
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
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
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('keydown', onKey)
      unsubscribeSync?.()
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
      failure = m.entry_save_failed()
    } finally {
      savingCount -= 1
    }
  }
  async function flushAll() {
    // oxlint-disable-next-line no-useless-spread -- flushField removes keys from dirty while we iterate
    for (const field of [...dirty]) await flushField(field)
  }
  async function add(kind: 'camera' | 'library') {
    try {
      void flushAll()
      // Invoke synchronously from the click handler to preserve the browser's user activation.
      const selection = pickPhotos(kind, entryId)
      const incoming = await selection
      if (incoming.length) await repo.addPhotos(entryId, incoming)
    } catch (cause) {
      showToast({ message: m.entry_add_photos_failed() })
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
    const count = (entry?.shared_with.length ?? 0) + 1
    showToast({
      message: count > 1 ? m.entry_photo_deleted_shared({ count }) : m.entry_photo_deleted(),
      actionLabel: m.entry_undo(),
      action: () => repo.restorePhoto(photo.id),
    })
  }
</script>

<svelte:head
  ><title
    >{entry
      ? `${formatSequence(entry.sequence_number)} — ${m.entry_page_title()}`
      : m.entry_page_title()}</title
  ></svelte:head
>
{#if !entry}
  <section class="detail-empty">
    {#if entry === undefined}<p>{m.entry_loading()}</p>{/if}
  </section>
{:else}
  <section class:panel={variant === 'panel'} class="detail-page">
    <header class="detail-header">
      {#if variant === 'page'}<button class="back-link" onclick={backToList}>{m.entry_back_to_list()}</button
        >{:else}<button class="back-link" onclick={() => navigate(`/c/${collectionId}`)}
          >{m.entry_close()}</button
        >{/if}
      <div class="detail-title-row">
        <Tag sequence={entry.sequence_number} size="lg" /><input
          class="title-input"
          aria-label={m.entry_title()}
          placeholder={m.entry_title()}
          value={draft.title ?? ''}
          data-field="title"
          oninput={(event) => setField('title', event.currentTarget.value)}
          onblur={() => void flushField('title')}
        />
      </div>
      {#if entry.review_status === 'needs_review'}<span class="review-badge">{m.entry_needs_review()}</span
        >{/if}
      <button
        class="star-detail"
        aria-label={entry.starred_at ? m.entry_unstar() : m.entry_star()}
        aria-pressed={entry.starred_at !== null}
        onclick={() => void repo.setEntryStarred(entryId, entry?.starred_at === null)}
        >{entry.starred_at ? m.entry_starred() : m.entry_star_action()}</button
      >
      {#if !entry.deleted_at}<Button variant="quiet" onclick={() => (moveOpen = true)}
          >{m.entry_move_to()}</Button
        >{/if}
      {#if entry.deleted_at}
        {@const legacy = lastPlacementChange
          ? null
          : entry.entry_notes.match(/^Moved to "(.+)" (#[0-9]+)\r?$/m)}
        {@const placed = entry.shared_with.find((item) =>
          movedAway
            ? item.entry_id === movedAway.to_entry_id
            : legacy &&
              item.collection_name === legacy[1] &&
              formatSequence(item.sequence_number) === legacy[2],
        )}
        {@const placement = placed ?? (movedAway || legacy ? undefined : entry.shared_with[0])}
        <div
          class="deleted-notice moved-notice"
          class:empty-notice={!movedAway && !legacy && !placement}
          role="status"
        >
          <span>
            {#if movedAway}
              {m.entry_moved_notice({
                name: placed?.collection_name ?? movedAway.to_name,
                sequence: formatSequence(placed?.sequence_number ?? movedAway.to_sequence),
              })}
            {:else if legacy}
              {m.entry_moved_notice({ name: legacy[1]!, sequence: legacy[2]! })}
            {:else if placement}
              {m.entry_removed_shared_notice({
                name: placement.collection_name,
                sequence: formatSequence(placement.sequence_number),
              })}
            {/if}
          </span>
          {#if placement}<a href="/c/{placement.collection_id}/e/{placement.entry_id}">{m.entry_open()}</a
            >{/if}
        </div>
      {/if}
      {#if entry.shared_with.length > 0}<p class="shared-hint">
          {m.entry_shared_hint({ count: entry.shared_with.length + 1 })}
        </p>{/if}
      {#if entry.shared_with.length > 0}<section class="also-in" aria-label={m.entry_also_in()}>
          <strong>{m.entry_also_in()}</strong>
          {#each entry.shared_with as placement (placement.entry_id)}<a
              href="/c/{placement.collection_id}/e/{placement.entry_id}"
              >{placement.collection_name} · {formatSequence(placement.sequence_number)}</a
            >{/each}
        </section>{/if}
      <label class="review-select"
        >{m.entry_review_status()}
        <select
          value={entry.review_status}
          onchange={(event) =>
            void repo.updateEntry(entryId, {
              review_status: event.currentTarget.value as EntryView['review_status'],
            })}
          ><option value="draft">{m.entry_draft()}</option><option value="complete"
            >{m.entry_complete()}</option
          ><option value="needs_review">{m.entry_needs_review()}</option></select
        ></label
      >
      <p class="save-state" aria-live="polite">
        {#if savingCount}{m.entry_saving()}{:else if failure}{failure}{:else if syncPhase === 'syncing' && entry.display_sync_state === 'pending'}{m.entry_syncing()}{:else if entry.display_sync_state === 'conflict'}{m.entry_conflict()}{:else if entry.display_sync_state === 'error'}{m.entry_sync_error()}{:else if entry.display_sync_state === 'pending'}{m.entry_pending_sync()}{:else if entry.display_sync_state === 'synced'}{m.entry_backed_up()}{:else}{m.entry_saved_device()}{/if}
      </p>
    </header>

    {#if entry.deleted_at}
      <div class="deleted-notice" role="status">
        <span>{entry.shared_with.length ? m.entry_deleted_shared_restore() : m.entry_deleted_notice()}</span
        ><Button
          onclick={async () => {
            await repo.restoreEntry(entryId)
          }}>{m.entry_restore()}</Button
        >
      </div>
    {:else}
      <div class="photo-actions">
        <Button variant="capture" onclick={openCamera}>{m.entry_add_photo()}</Button><Button
          variant="quiet"
          onclick={() => void add('library')}>{m.entry_add_from_photos()}</Button
        >
      </div>
      <PhotoGrid
        {photos}
        {entryId}
        onopen={(id) => {
          viewerPhotoId = id
          viewerOpen = true
        }}
        ondelete={undoDelete}
      />

      <div class="field-grid">
        <label class="field"
          >{m.entry_quantity()}<input
            aria-label={m.entry_quantity()}
            data-field="quantity"
            inputmode="decimal"
            enterkeyhint="next"
            value={displayedQuantity}
            oninput={(event) => setField('quantity', event.currentTarget.value)}
            onblur={() => void flushField('quantity')}
            aria-invalid={invalidQuantity}
          />{#if entry.shared_with.length > 0}<small class="field-note">{m.entry_qty_local()}</small
            >{/if}{#if invalidQuantity}<small class="field-hint" role="alert"
              >{m.entry_invalid_quantity()}</small
            >{/if}</label
        >
        <label class="field"
          >{m.entry_unit()}<input
            aria-label={m.entry_unit()}
            data-field="unit"
            value={draft.unit ?? ''}
            oninput={(event) => setField('unit', event.currentTarget.value)}
            onblur={() => void flushField('unit')}
          /></label
        >
        <label class="field"
          >{m.entry_expiration()}<input
            type="date"
            data-field="expiration_date"
            value={draft.expiration_date ?? ''}
            oninput={(event) => setField('expiration_date', event.currentTarget.value)}
            onblur={() => void flushField('expiration_date')}
          /><small class="field-note">{m.entry_expiration_hint()}</small></label
        >
        <label class="field full-field"
          >{m.entry_dimensions()}<textarea
            class="dimensions-field"
            data-field="dimensions"
            bind:this={dimensionsField}
            rows="2"
            placeholder={m.entry_dimensions_example()}
            value={draft.dimensions ?? ''}
            oninput={(event) => {
              const field = event.currentTarget
              const value = field.value.replace(/[\r\n]+/g, ' ')
              if (value !== field.value) field.value = value
              setField('dimensions', value)
            }}
            onkeydown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
            onblur={() => void flushField('dimensions')}></textarea></label
        >
        <label class="field full-field"
          >{m.entry_count_detail()}<textarea
            data-field="count_detail"
            rows="2"
            placeholder={m.entry_count_detail_example()}
            value={draft.count_detail ?? ''}
            oninput={(event) => setField('count_detail', event.currentTarget.value)}
            onblur={() => void flushField('count_detail')}></textarea></label
        >
        <label class="field full-field"
          >{m.entry_notes()}<textarea
            data-field="notes"
            rows="4"
            value={draft.notes ?? ''}
            oninput={(event) => setField('notes', event.currentTarget.value)}
            onblur={() => void flushField('notes')}></textarea>{#if entry.shared_with.length > 0}<small
              class="field-note">{m.entry_changes_shared({ count: entry.shared_with.length + 1 })}</small
            >{/if}</label
        >
        {#if entry.shared_with.length > 0 || entry.entry_notes || showEntryNotes}
          <label class="field full-field"
            >{collectionName === undefined
              ? m.entry_notes_this_collection()
              : m.entry_notes_collection({ name: collectionName })}<textarea
              data-field="entry_notes"
              rows="3"
              value={draft.entry_notes ?? ''}
              oninput={(event) => setField('entry_notes', event.currentTarget.value)}
              onblur={() => void flushField('entry_notes')}></textarea><small class="field-note"
              >{m.entry_note_local()}</small
            ></label
          >
        {:else}<button class="add-entry-note" onclick={() => (showEntryNotes = true)}
            >{m.entry_add_collection_note()}</button
          >{/if}
      </div>
    {/if}
    <nav class="detail-navigation" aria-label={m.entry_navigation()}>
      <Button
        variant="quiet"
        disabled={!adjacent.prev}
        onclick={() => adjacent.prev && navigate(`/c/${collectionId}/e/${adjacent.prev}`)}
        >{m.entry_previous()}</Button
      ><Button
        variant="quiet"
        disabled={!adjacent.next}
        onclick={() => adjacent.next && navigate(`/c/${collectionId}/e/${adjacent.next}`)}
        >{m.entry_next()}</Button
      ><Button onclick={() => void newEntry()}>{m.entry_new()}</Button>
    </nav>
    <MovementHistory {entryId} {movements} />
  </section>
{/if}
{#if entry}<CameraSheet bind:open={cameraOpen} entryId={entry.id} />{/if}
<PhotoViewer bind:open={viewerOpen} {entryId} startPhotoId={viewerPhotoId} />
<MoveToSheet
  bind:open={moveOpen}
  {entryId}
  onmoved={({ partial }) => {
    if (!partial) backToList()
  }}
  beforemove={flushAll}
/>

<style>
  .review-badge {
    justify-self: start;
    border-radius: var(--radius-pill);
    padding: var(--space-1) var(--space-3);
    color: var(--color-warn);
    background: var(--color-warn-soft);
    font-size: var(--text-sm);
  }
  .star-detail,
  .add-entry-note {
    justify-self: start;
    min-height: var(--size-touch);
    padding: 0 var(--space-3);
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
  }
  .detail-page {
    max-width: 900px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-5) calc(var(--space-7) + env(safe-area-inset-bottom));
  }
  .detail-page.panel {
    max-width: none;
    padding: var(--space-5) var(--space-6);
  }
  .detail-header {
    display: grid;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .back-link {
    justify-self: start;
    min-height: 44px;
    padding: var(--space-2) 0;
    color: var(--color-ballpoint);
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .detail-title-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-4);
  }
  .shared-hint,
  .also-in {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .also-in {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
  .also-in a {
    min-width: 0;
    color: var(--color-ballpoint);
    overflow-wrap: anywhere;
  }
  .title-input {
    min-width: 0;
    max-width: 100%;
    flex: 1;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-ink);
    font-size: var(--text-2xl);
    padding: var(--space-3) var(--space-2);
  }
  .review-select {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--color-muted);
  }
  .review-select select {
    min-height: var(--size-touch);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
  }
  .save-state {
    margin: -var(--space-2) 0 0;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .photo-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: var(--space-5) 0;
  }
  .field-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-5) var(--space-4);
    margin: var(--space-6) 0;
  }
  .field {
    min-width: 0;
    align-self: start;
  }
  .full-field {
    grid-column: 1 / -1;
  }
  .field input,
  .field textarea {
    width: 100%;
    min-height: 46px;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .field textarea {
    resize: vertical;
  }
  .field textarea.dimensions-field {
    field-sizing: content;
    /* Two lines tall to start, so long values read at a glance; grows with the text. */
    min-height: calc(2lh + 2 * var(--space-3) + 2px);
    overflow-wrap: anywhere;
    resize: none;
  }
  /* iOS gives date inputs an intrinsic width that ignores the grid column unless the native look is dropped. */
  .field input[type='date'] {
    display: block;
    min-width: 0;
    -webkit-appearance: none;
    appearance: none;
  }
  .field-hint {
    color: var(--color-danger);
    font-weight: 400;
  }
  .field-note {
    color: var(--color-muted);
    font-weight: 400;
  }
  .detail-navigation {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }
  .moved-notice {
    min-height: var(--size-touch);
  }
  .moved-notice span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .empty-notice {
    visibility: hidden;
  }
  .deleted-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--color-warn);
    border-radius: var(--radius-md);
    background: var(--color-card);
  }
  .deleted-notice :global(.button) {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .detail-empty {
    max-width: 900px;
    margin: auto;
    padding: var(--space-6);
  }
  @media (min-width: 900px) {
    .detail-page:not(.panel) {
      padding-top: var(--space-7);
    }
    .panel .field-grid {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
