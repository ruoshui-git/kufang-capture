<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import type { CollectionSummary, EntryView } from '$lib/types'
  import { SETTING_KEYS, formatSequence } from '$lib/types'
  import { navigate } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import Sheet from '../ui/Sheet.svelte'
  let {
    open = $bindable(false),
    entryId,
    onmoved,
    beforemove,
  }: {
    open?: boolean
    entryId: string
    onmoved?: () => void
    /** Saves pending edits first, so they land on the entry before it moves. */
    beforemove?: () => Promise<void>
  } = $props()
  let collections = $state<CollectionSummary[]>([])
  let entry = $state<EntryView | undefined>()
  let query = $state('')
  let recent = $state<string[]>([])
  onMount(() => {
    const sub = repo
      .watchCollectionSummaries({ includeArchived: false })
      .subscribe((items) => (collections = items))
    void repo.getSetting<string[]>(SETTING_KEYS.recentMoveTargets, []).then((ids) => (recent = ids))
    return () => (typeof sub === 'function' ? sub() : sub.unsubscribe())
  })
  $effect(() => {
    if (open) {
      void repo.getEntry(entryId).then((value) => (entry = value))
      void repo.getSetting<string[]>(SETTING_KEYS.recentMoveTargets, []).then((value) => (recent = value))
    }
  })
  const eligible = $derived(
    collections.filter(
      (item) =>
        item.collection.id !== entry?.collection_id &&
        item.collection.storage_mode ===
          collections.find((c) => c.collection.id === entry?.collection_id)?.collection.storage_mode &&
        item.collection.status === 'active' &&
        item.collection.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  )
  const recentItems = $derived(
    recent
      .map((id) => eligible.find((item) => item.collection.id === id))
      .filter((item): item is CollectionSummary => !!item),
  )
  const others = $derived(
    eligible.filter(
      (item) => !recentItems.some((recentItem) => recentItem.collection.id === item.collection.id),
    ),
  )
  async function move(target: CollectionSummary['collection']) {
    if (!entry) return
    try {
      await beforemove?.()
      const result = await repo.moveEntries(target.id, [entry.id])
      const placed = [...result.created, ...result.restored, ...result.merged_into_existing][0]
      if (!placed) return
      recent = [target.id, ...recent.filter((id) => id !== target.id)].slice(0, 5)
      await repo.setSetting(SETTING_KEYS.recentMoveTargets, [...recent])
      open = false
      onmoved?.()
      showToast({
        message: `Moved to "${target.name}" as ${formatSequence(placed.sequence_number)}${result.merged_into_existing.length ? ' (already there)' : ''}`,
        actions: [
          {
            label: 'Undo',
            action: async () => {
              try {
                await repo.undoMove(result.undo)
                showToast({ message: 'Move undone' })
              } catch (error) {
                showToast({ message: error instanceof Error ? error.message : 'Could not undo move' })
              }
            },
          },
          { label: 'Open', action: () => navigate(`/c/${target.id}/e/${placed.id}`) },
        ],
      })
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : 'Could not move entry' })
    }
  }
</script>

<Sheet bind:open title={entry ? `Move ${formatSequence(entry.sequence_number)} to…` : 'Move to…'}>
  <div class="picker">
    <input class="search" aria-label="Search collections" placeholder="Search rooms" bind:value={query} />
    {#if recentItems.length}<h3>Recent</h3>
      {#each recentItems as item (item.collection.id)}<button
          class="destination"
          onclick={() => void move(item.collection)}
          ><span>{item.collection.name}</span><small>{item.entry_count} entries</small></button
        >{/each}{/if}
    {#each [...new Set(others.map((item) => item.collection.folder || 'Unfiled'))] as folder (folder)}<h3>
        {folder}
      </h3>
      {#each others.filter((item) => (item.collection.folder || 'Unfiled') === folder) as item (item.collection.id)}<button
          class="destination"
          onclick={() => void move(item.collection)}
          ><span>{item.collection.name}</span><small>{item.entry_count} entries</small></button
        >{/each}{/each}
    {#if eligible.length === 0}<p>
        No eligible collections. Collections must use the same storage mode.
      </p>{/if}
  </div>
</Sheet>

<style>
  .picker {
    display: grid;
    gap: var(--space-2);
    max-height: 70vh;
    overflow: auto;
    padding: var(--space-4);
  }
  .search {
    min-height: var(--size-touch);
    border: var(--border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-4);
    font: inherit;
  }
  h3 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-md);
  }
  .destination {
    min-height: var(--size-touch);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: var(--border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-4);
    background: var(--color-card);
    color: var(--color-ink);
    text-align: left;
  }
  small {
    color: var(--color-muted);
  }
</style>
