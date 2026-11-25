<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { repo } from '$lib/db'
  import type { Collection, Id } from '$lib/types'
  import type { ImportCandidate, ImportResult, ImportSearchRow, Watchable } from '$lib/repo'
  import { entryDisplayTitle, formatSequence } from '$lib/types'
  import { thumbnailUrl } from '$lib/photos'
  import { photoAccount } from '$lib/sync/binding'
  import { showToast } from '../../app/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import Sheet from '../ui/Sheet.svelte'

  let {
    targetCollectionId,
    storageMode,
    open = $bindable(false),
  }: { targetCollectionId: Id; storageMode: 'local_only' | 'synced'; open?: boolean } = $props()
  let step = $state<1 | 2>(1)
  let sources = $state<Collection[]>([])
  let sourceId = $state<Id>('')
  let sourceName = $state('')
  let candidates = $state<ImportCandidate[]>([])
  let searchRows = $state<ImportSearchRow[]>([])
  let selected = $state(new Map<Id, Id>())
  let search = $state('')
  let busy = $state(false)
  let error = $state('')
  let limit = $state(50)
  let searched = $state(false)
  let thumbnails = $state<Record<Id, { url: string; account: string | null }>>({})
  let sourceSubscription: ReturnType<Watchable<Collection[]>['subscribe']> | undefined
  let candidateSubscription: ReturnType<Watchable<ImportCandidate[]>['subscribe']> | undefined
  let searchSubscription: ReturnType<Watchable<ImportSearchRow[]>['subscribe']> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    if (!open) return
    step = 1
    sourceId = ''
    selected = new Map()
    search = ''
    error = ''
    limit = 50
    stopSources()
    sourceSubscription = repo.watchImportSources(targetCollectionId).subscribe((items) => {
      sources = [...items].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived'))
    })
    return () => {
      stopSources()
      stopCandidates()
      stopSearch()
      if (debounce) clearTimeout(debounce)
    }
  })

  $effect(() => {
    const account = $photoAccount
    if (open) untrack(() => loadThumbnails((sourceId ? candidates : searchRows).slice(0, limit), account))
  })

  onDestroy(() => {
    stopSources()
    stopCandidates()
    stopSearch()
    if (debounce) clearTimeout(debounce)
  })

  function stopSources() {
    if (typeof sourceSubscription === 'function') sourceSubscription()
    else sourceSubscription?.unsubscribe()
    sourceSubscription = undefined
  }
  function stopCandidates() {
    if (typeof candidateSubscription === 'function') candidateSubscription()
    else candidateSubscription?.unsubscribe()
    candidateSubscription = undefined
  }
  function stopSearch() {
    if (typeof searchSubscription === 'function') searchSubscription()
    else searchSubscription?.unsubscribe()
    searchSubscription = undefined
  }
  function loadThumbnails(rows: Array<{ recent_photos: Array<{ id: Id }> }>, account = $photoAccount) {
    for (const row of rows) {
      const photo = row.recent_photos[0]
      if (photo && thumbnails[photo.id]?.account !== account)
        void thumbnailUrl(photo.id).then((url) => {
          if (url && $photoAccount === account) thumbnails[photo.id] = { url, account }
        })
    }
  }
  function watchCandidates(query: string) {
    stopCandidates()
    candidateSubscription = repo
      .watchImportCandidates(targetCollectionId, sourceId, query)
      .subscribe((items) => {
        candidates = items
        loadThumbnails(items.slice(0, limit))
      })
  }
  function watchSearch(query: string) {
    stopSearch()
    searchSubscription = repo.watchImportSearch(targetCollectionId, query).subscribe((items) => {
      searchRows = items
      searched = true
      loadThumbnails(items.slice(0, limit))
    })
  }
  function placementsText(row: ImportSearchRow) {
    const shown = row.placements.slice(0, 2).map((placement) => {
      const count = [placement.quantity, placement.unit].filter(Boolean).join(' ')
      const place = `${placement.collection_name} ${formatSequence(placement.sequence_number)}`
      return count ? `${place} · ${count}` : place
    })
    const more = row.placements.length - shown.length
    return shown.join('; ') + (more > 0 ? ` +${more} more` : '')
  }
  function chooseSource(source: Collection) {
    stopSearch()
    sourceId = source.id
    sourceName = source.name
    step = 2
    search = ''
    candidates = []
    limit = 50
    watchCandidates('')
  }
  function searchChanged(value: string) {
    search = value
    limit = 50
    if (step === 2) {
      watchCandidates(value)
      return
    }
    if (debounce) clearTimeout(debounce)
    if (!value.trim()) {
      stopSearch()
      searchRows = []
      searched = false
      return
    }
    debounce = setTimeout(() => watchSearch(value), 150)
  }
  function back() {
    stopCandidates()
    step = 1
    sourceId = ''
  }
  function toggle(itemId: Id, entryId: Id) {
    const next = new Map(selected)
    if (next.has(itemId)) next.delete(itemId)
    else next.set(itemId, entryId)
    selected = next
  }
  async function importSelected() {
    if (!selected.size || busy) return
    busy = true
    error = ''
    try {
      const result = await repo.importEntries(targetCollectionId, [...selected.values()])
      const count = result.created.length + result.restored.length
      const restoredCount = result.restored.length
      open = false
      showToast({
        message:
          restoredCount > 0
            ? `Imported ${count} · ${restoredCount} restored with ${restoredCount === 1 ? 'its' : 'their'} old ${restoredCount === 1 ? 'number' : 'numbers'}`
            : `Imported ${count} ${count === 1 ? 'item' : 'items'}`,
        actionLabel: 'Undo',
        action: () => undoImport(result),
      })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
  async function undoImport(result: ImportResult) {
    for (const entry of [...result.created, ...result.restored]) await repo.deleteEntry(entry.id)
  }
</script>

<Sheet bind:open title={step === 1 ? 'Import from another collection' : `Import from ${sourceName}`}>
  {#snippet children()}
    {#if step === 1}
      <h2>Import from</h2>
      <label class="search-field"
        >Search all collections<input
          aria-label="Search all collections"
          value={search}
          oninput={(event) => searchChanged(event.currentTarget.value)}
        /></label
      >
      {#if search.trim()}
        <div class="candidate-list" aria-label="Import search results">
          {#each searchRows.slice(0, limit) as row (row.entry.item_id)}
            {@const photo = row.recent_photos[0]}
            <label class="candidate-row" class:disabled={row.already_here}>
              <input
                type="checkbox"
                checked={row.already_here || selected.has(row.entry.item_id)}
                disabled={row.already_here}
                onchange={() => toggle(row.entry.item_id, row.entry.id)}
              />
              {#if photo && thumbnails[photo.id]?.account === $photoAccount}<img
                  src={thumbnails[photo.id]?.url}
                  alt=""
                />{:else}<span class="thumb-placeholder">Photo</span>{/if}
              <span class="candidate-copy"
                ><strong>{entryDisplayTitle(row.entry)}</strong>{#if row.entry.dimensions}<small
                    >{row.entry.dimensions}</small
                  >{/if}<span class="placements">{placementsText(row)}</span></span
              >
              {#if row.archived}<span class="archived">Archived</span>{/if}
              {#if row.already_here}<span class="already">Already here</span>{/if}
            </label>
          {/each}
        </div>
        {#if searched && searchRows.length === 0}<p class="quiet" role="status">No matching items.</p>{/if}
        {#if searchRows.length > limit}<Button
            variant="quiet"
            onclick={() => {
              limit += 50
              loadThumbnails(searchRows.slice(limit - 50, limit))
            }}>Show more</Button
          >{/if}
      {:else if sources.length}
        <div class="source-list">
          {#each sources as source (source.id)}
            <button class="source-row" onclick={() => chooseSource(source)}
              ><span>{source.name}</span>{#if source.status === 'archived'}<span class="archived"
                  >Archived</span
                >{/if}</button
            >
          {/each}
        </div>
      {:else}
        <p>No other {storageMode === 'local_only' ? 'Local Only' : 'Synced'} collections yet.</p>
      {/if}
      <p class="quiet">
        Only {storageMode === 'local_only' ? 'Local Only' : 'Synced'} collections can share items with a {storageMode ===
        'local_only'
          ? 'Local Only'
          : 'Synced'} collection.
      </p>
    {:else}
      <button class="back" onclick={back}>← Back</button>
      <label class="search-field"
        >Search items<input
          aria-label="Search import items"
          value={search}
          oninput={(event) => searchChanged(event.currentTarget.value)}
        /></label
      >
      <div class="candidate-list" aria-label="Import candidates">
        {#each candidates.slice(0, limit) as candidate (candidate.entry.id)}
          {@const photo = candidate.recent_photos[0]}
          <label class="candidate-row" class:disabled={candidate.already_here}>
            <input
              type="checkbox"
              checked={candidate.already_here || selected.has(candidate.entry.item_id)}
              disabled={candidate.already_here}
              onchange={() => toggle(candidate.entry.item_id, candidate.entry.id)}
            />
            {#if photo && thumbnails[photo.id]?.account === $photoAccount}<img
                src={thumbnails[photo.id]?.url}
                alt=""
              />{:else}<span class="thumb-placeholder">Photo</span>{/if}
            <span class="candidate-copy"
              ><strong>{formatSequence(candidate.entry.sequence_number)}</strong><span
                >{entryDisplayTitle(candidate.entry)}</span
              ><small
                >{candidate.entry.quantity ?? ''}{candidate.entry.quantity && candidate.entry.unit
                  ? ` ${candidate.entry.unit}`
                  : candidate.entry.unit}</small
              ></span
            >
            {#if candidate.already_here}<span class="already">Already here</span>{/if}
          </label>
        {/each}
      </div>
      {#if candidates.length > limit}<Button
          variant="quiet"
          onclick={() => {
            limit += 50
            loadThumbnails(candidates.slice(limit - 50, limit))
          }}>Show more</Button
        >{/if}
    {/if}
    <div class="actions">
      <span class="selected-count">{selected.size} selected</span><Button
        variant="quiet"
        disabled={!selected.size}
        onclick={() => (selected = new Map())}>Clear</Button
      ><Button disabled={selected.size === 0 || busy} onclick={() => void importSelected()}
        >{busy ? 'Importing…' : `Import ${selected.size}`}</Button
      >
    </div>
    {#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
  h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-xl);
  }
  /* Keep the sheet as the only scroller so WebKit can still receive taps after the keyboard opens. */
  .source-list,
  .candidate-list {
    display: grid;
    gap: var(--space-2);
  }
  .source-row,
  .candidate-row {
    min-height: var(--size-touch);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    text-align: left;
  }
  .source-row {
    justify-content: space-between;
    cursor: pointer;
  }
  .archived,
  .already,
  .quiet {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .quiet {
    margin-top: var(--space-4);
  }
  .back {
    min-height: var(--size-touch);
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--color-ballpoint);
  }
  .search-field {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-3) 0;
  }
  .search-field input {
    min-height: var(--size-touch);
    padding: 0 var(--space-4);
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .candidate-row {
    position: relative;
    min-height: var(--size-thumb);
    cursor: pointer;
  }
  .candidate-row input {
    width: 20px;
    height: 20px;
    flex: none;
  }
  .candidate-row img,
  .thumb-placeholder {
    width: var(--size-thumb);
    height: var(--size-thumb);
    flex: none;
    object-fit: cover;
    border-radius: var(--radius-md);
    background: var(--color-sunken);
  }
  .thumb-placeholder {
    display: grid;
    place-items: center;
    color: var(--color-muted);
    font-size: var(--text-xs);
  }
  .candidate-copy {
    display: grid;
    min-width: 0;
    flex: 1;
  }
  .candidate-copy > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .candidate-row.disabled {
    opacity: 0.7;
    cursor: default;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
  .selected-count {
    flex: 1;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .candidate-copy > .placements {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
  }
  .candidate-copy small {
    color: var(--color-muted);
  }
  .actions {
    position: sticky;
    bottom: calc(-1 * var(--space-5));
    padding: var(--space-3) 0 var(--space-5);
    background: var(--color-card);
  }
</style>
