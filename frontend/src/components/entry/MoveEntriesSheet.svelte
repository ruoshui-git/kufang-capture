<script lang="ts">
  import { onDestroy } from 'svelte'
  import { repo } from '$lib/db'
  import type { CollectionSummary, EntryRow, Id, StorageMode } from '$lib/types'
  import type { Watchable } from '$lib/repo'
  import { formatSequence } from '$lib/types'
  import { showToast } from '../../app/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import Sheet from '../ui/Sheet.svelte'

  let {
    collectionId,
    sourceName,
    folder,
    storageMode,
    open = $bindable(false),
  }: {
    collectionId: Id
    sourceName: string
    folder: string
    storageMode: StorageMode
    open?: boolean
  } = $props()
  let rows = $state<EntryRow[]>([])
  let collections = $state<CollectionSummary[]>([])
  let selected = $state(new Set<Id>())
  let destination = $state<'new' | Id>('new')
  let name = $state('')
  let newFolder = $state('')
  let search = $state('')
  let busy = $state(false)
  let error = $state('')
  let rowSub: ReturnType<Watchable<EntryRow[]>['subscribe']> | undefined
  let collectionSub: ReturnType<Watchable<CollectionSummary[]>['subscribe']> | undefined
  const destinations = $derived(
    collections.filter(
      (item) => item.collection.id !== collectionId && item.collection.storage_mode === storageMode,
    ),
  )
  const filteredRows = $derived(
    rows.filter((row) => {
      const term = search.trim().toLocaleLowerCase()
      return (
        !term ||
        [
          String(row.entry.sequence_number),
          row.entry.title,
          row.entry.notes,
          row.entry.entry_notes,
          row.entry.unit,
          row.entry.count_detail,
        ].some((value) => value.toLocaleLowerCase().includes(term))
      )
    }),
  )
  const allFilteredSelected = $derived(
    filteredRows.length > 0 && filteredRows.every((row) => selected.has(row.entry.id)),
  )

  $effect(() => {
    if (!open) return
    name = `${sourceName} (split)`
    newFolder = folder
    selected = new Set()
    destination = 'new'
    search = ''
    error = ''
    stopSubscriptions()
    rowSub = repo
      .watchEntryRows(collectionId, { search: '', filter: 'all', sort: 'oldest' })
      .subscribe((items) => (rows = items))
    collectionSub = repo
      .watchCollectionSummaries({ includeArchived: false })
      .subscribe((items) => (collections = items))
    return stopSubscriptions
  })
  onDestroy(stopSubscriptions)
  function stopSubscriptions() {
    if (typeof rowSub === 'function') rowSub()
    else rowSub?.unsubscribe()
    if (typeof collectionSub === 'function') collectionSub()
    else collectionSub?.unsubscribe()
    rowSub = undefined
    collectionSub = undefined
  }
  function toggle(id: Id) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected = next
  }
  function toggleAll() {
    const next = new Set(selected)
    if (allFilteredSelected) filteredRows.forEach((row) => next.delete(row.entry.id))
    else filteredRows.forEach((row) => next.add(row.entry.id))
    selected = next
  }
  async function move() {
    if (!selected.size || busy || (destination === 'new' && !name.trim())) return
    busy = true
    error = ''
    try {
      const ids = [...selected]
      let count = 0
      if (destination === 'new') {
        const { result } = await repo.splitEntries(ids, { name, folder: newFolder })
        count = result.created.length + result.restored.length + result.merged_into_existing.length
      } else {
        const result = await repo.moveEntries(destination, ids)
        count = result.created.length + result.restored.length + result.merged_into_existing.length
      }
      open = false
      showToast({ message: `Moved ${count} ${count === 1 ? 'entry' : 'entries'}` })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
</script>

<Sheet bind:open title="Move entries">
  {#snippet children()}
    <label class="search-field"
      >Search entries<input aria-label="Search move entries" bind:value={search} /></label
    >
    <div class="select-actions">
      <span>{selected.size} selected</span>
      <button type="button" class="quiet-link" onclick={toggleAll}
        >{allFilteredSelected ? 'Clear' : 'Select all'}</button
      >
    </div>
    <div class="entry-list" aria-label="Entries to move">
      {#each filteredRows as row (row.entry.id)}
        <label class="entry-row">
          <input type="checkbox" checked={selected.has(row.entry.id)} onchange={() => toggle(row.entry.id)} />
          <strong>{formatSequence(row.entry.sequence_number)}</strong>
          <span>{row.entry.title || 'Untitled'}</span>
          <small>{row.entry.quantity ?? ''}{row.entry.unit ? ` ${row.entry.unit}` : ''}</small>
        </label>
      {:else}<p>No active entries found.</p>{/each}
    </div>
    <fieldset class="destinations">
      <legend>Move to</legend>
      <label class="destination-row"
        ><input type="radio" name="move-destination" value="new" bind:group={destination} />New collection</label
      >
      {#if destination === 'new'}
        <label class="field">Name<input aria-label="New collection name" bind:value={name} /></label>
        <label class="field">Folder<input aria-label="New collection folder" bind:value={newFolder} /></label>
      {/if}
      {#each destinations as item (item.collection.id)}
        <label class="destination-row"
          ><input
            type="radio"
            name="move-destination"
            value={item.collection.id}
            bind:group={destination}
          />{item.collection.name}</label
        >
      {/each}
    </fieldset>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions">
      <Button
        disabled={!selected.size || busy || (destination === 'new' && !name.trim())}
        onclick={() => void move()}>{busy ? 'Moving…' : `Move ${selected.size}`}</Button
      >
    </div>
  {/snippet}
</Sheet>

<style>
  .search-field,
  .field {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-3) 0;
  }
  .search-field input,
  .field input {
    min-height: var(--size-touch);
    padding: 0 var(--space-4);
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .select-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: var(--space-3) 0;
    color: var(--color-muted);
  }
  .entry-list {
    display: grid;
    gap: var(--space-2);
  }
  .entry-row,
  .destination-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--size-touch);
    padding: var(--space-3);
    border: var(--border);
    border-radius: var(--radius-md);
  }
  .entry-row span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-row small {
    color: var(--color-muted);
  }
  .destinations {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-4) 0 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--space-2);
    font-weight: var(--weight-medium);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-4);
  }
  .error {
    color: var(--color-danger);
  }
</style>
