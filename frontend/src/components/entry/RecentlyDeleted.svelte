<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import type { EntryRow, Photo } from '$lib/types'
  import { formatSequence } from '$lib/types'
  let { collectionId }: { collectionId: string } = $props()
  let rows = $state<EntryRow[]>([])
  let photos = $state<Photo[]>([])
  onMount(() => {
    const a = repo
      .watchEntryRows(collectionId, { search: '', filter: 'deleted', sort: 'newest' })
      .subscribe((v) => (rows = v))
    const b = repo.watchDeletedPhotos(collectionId).subscribe((v) => (photos = v))
    return () => {
      typeof a === 'function' ? a() : a.unsubscribe()
      typeof b === 'function' ? b() : b.unsubscribe()
    }
  })
</script>

<section class="trash" aria-label="Recently Deleted">
  <h2>Deleted entries</h2>
  {#each rows as row (row.entry.id)}<div class="trash-row">
      <span>{formatSequence(row.entry.sequence_number)} · {row.entry.title || 'Untitled entry'}</span><button
        onclick={() => void repo.restoreEntry(row.entry.id)}>Restore</button
      >
    </div>{/each}
  <h2>Deleted photos</h2>
  {#each photos as photo (photo.id)}<div class="trash-row">
      <span
        >Photo from {formatSequence(
          rows.find((row) => row.entry.id === photo.entry_id)?.entry.sequence_number ?? 0,
        )}</span
      ><button onclick={() => void repo.restorePhoto(photo.id)}>Restore</button>
    </div>{/each}
  {#if !rows.length && !photos.length}<p>No recently deleted entries or photos.</p>{/if}
</section>

<style>
  .trash {
    display: grid;
    gap: 8px;
  }
  .trash h2 {
    margin: 18px 0 4px;
  }
  .trash-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: 8px;
  }
  .trash-row button {
    min-height: 40px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: transparent;
    color: var(--color-ballpoint);
    padding: 6px 12px;
  }
</style>
