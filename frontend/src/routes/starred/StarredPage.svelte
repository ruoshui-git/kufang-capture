<script lang="ts">
  import { repo } from '$lib/db'
  import type { StarredRow } from '$lib/types'
  let rows = $state<StarredRow[]>([])
  $effect(() => {
    const subscription = repo.watchStarredRows().subscribe((value) => (rows = value))
    return () => (typeof subscription === 'function' ? subscription() : subscription.unsubscribe())
  })
  const groups = $derived.by(() => {
    const names = [...new Set(rows.map((row) => row.collection.id))]
    return names.map((id) => ({
      collection: rows.find((row) => row.collection.id === id)!.collection,
      rows: rows.filter((row) => row.collection.id === id),
    }))
  })
</script>

<svelte:head><title>Starred — Kufang Capture</title></svelte:head>
<section class="page">
  <h1>Starred</h1>
  {#if !rows.length}
    <p>No starred entries yet. Use the star button on an entry to keep it here.</p>
  {:else}
    {#each groups as group (group.collection.id)}
      <section class="starred-group">
        <h2>
          {group.collection.name}{#if group.collection.folder}<small>{group.collection.folder}</small>{/if}
        </h2>
        {#each group.rows as row (row.entry.id)}
          <div class="starred-row">
            <a href="/c/{row.entry.collection_id}/e/{row.entry.id}"
              >{row.entry.title.trim() || `Entry #${String(row.entry.sequence_number).padStart(4, '0')}`}</a
            ><button
              aria-label="Unstar entry"
              aria-pressed="true"
              onclick={() => void repo.setEntryStarred(row.entry.id, false)}>★</button
            >
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</section>

<style>
  .starred-group {
    margin-top: var(--space-5);
  }
  .starred-group h2 {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .starred-group small {
    color: var(--color-muted);
    font: var(--weight-regular) var(--text-sm) var(--font-body);
  }
  .starred-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: var(--size-touch);
    border-bottom: var(--border);
  }
  .starred-row button {
    min-width: var(--size-touch);
    min-height: var(--size-touch);
    border: 0;
    background: transparent;
    color: var(--color-warn);
  }
</style>
