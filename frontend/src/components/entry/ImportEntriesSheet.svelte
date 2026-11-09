<script lang="ts">
  import { onDestroy } from 'svelte'
  import { repo } from '$lib/db'
  import type { Collection, Id } from '$lib/types'
  import type { ImportCandidate, ImportResult, Watchable } from '$lib/repo'
  import { entryDisplayTitle, formatSequence } from '$lib/types'
  import { thumbnailUrl } from '$lib/photos'
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
  let selected = $state(new Set<Id>())
  let search = $state('')
  let busy = $state(false)
  let error = $state('')
  let thumbnails = $state<Record<Id, string>>({})
  let sourceSubscription: ReturnType<Watchable<Collection[]>['subscribe']> | undefined
  let candidateSubscription: ReturnType<Watchable<ImportCandidate[]>['subscribe']> | undefined

  $effect(() => {
    if (!open) return
    step = 1
    sourceId = ''
    selected = new Set()
    search = ''
    error = ''
    stopSources()
    sourceSubscription = repo.watchImportSources(targetCollectionId).subscribe((items) => {
      sources = [...items].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived'))
    })
    return () => {
      stopSources()
      stopCandidates()
    }
  })

  onDestroy(() => {
    stopSources()
    stopCandidates()
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
  function chooseSource(source: Collection) {
    stopCandidates()
    sourceId = source.id
    sourceName = source.name
    step = 2
    candidates = []
    selected = new Set()
    search = ''
    watchCandidates('')
  }
  function watchCandidates(query: string) {
    stopCandidates()
    candidateSubscription = repo
      .watchImportCandidates(targetCollectionId, sourceId, query)
      .subscribe((items) => {
        candidates = items
        for (const candidate of items) {
          const photo = candidate.recent_photos[0]
          if (photo && !thumbnails[photo.id])
            void thumbnailUrl(photo.id).then((url) => {
              if (url) thumbnails[photo.id] = url
            })
        }
      })
  }
  function searchChanged(value: string) {
    search = value
    watchCandidates(value)
  }
  function back() {
    stopCandidates()
    step = 1
    selected = new Set()
  }
  function toggle(id: Id) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected = next
  }
  async function importSelected() {
    if (!selected.size || busy) return
    busy = true
    error = ''
    try {
      const result = await repo.importEntries(targetCollectionId, [...selected])
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
      {#if sources.length}
        <div class="source-list">
          {#each sources as source (source.id)}
            <button class="source-row" onclick={() => chooseSource(source)}>
              <span>{source.name}</span>
              {#if source.status === 'archived'}<span class="archived">Archived</span>{/if}
            </button>
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
        {#each candidates as candidate (candidate.entry.id)}
          {@const photo = candidate.recent_photos[0]}
          <label class="candidate-row" class:disabled={candidate.already_here}>
            <input
              type="checkbox"
              checked={candidate.already_here || selected.has(candidate.entry.id)}
              disabled={candidate.already_here}
              onchange={() => toggle(candidate.entry.id)}
            />
            {#if photo && thumbnails[photo.id]}<img src={thumbnails[photo.id]} alt="" />{:else}<span
                class="thumb-placeholder">Photo</span
              >{/if}
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
      <div class="actions">
        <Button disabled={selected.size === 0 || busy} onclick={() => void importSelected()}
          >{busy ? 'Importing…' : `Import ${selected.size}`}</Button
        >
      </div>
      {#if error}<p role="alert">{error}</p>{/if}
    {/if}
  {/snippet}
</Sheet>

<style>
  h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-xl);
  }
  .source-list,
  .candidate-list {
    display: grid;
    gap: var(--space-2);
    max-height: 55vh;
    overflow: auto;
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
    min-height: 64px;
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
  }
  .candidate-copy small {
    color: var(--color-muted);
  }
  .candidate-row.disabled {
    opacity: 0.7;
    cursor: default;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-4);
  }
</style>
