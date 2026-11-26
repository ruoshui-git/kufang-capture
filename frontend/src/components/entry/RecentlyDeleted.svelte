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
  {#each rows as row (row.entry.id)}
    {@const target = row.movement_summary?.to}
    {@const legacy = target ? null : row.entry.entry_notes.match(/^Moved to .+$/m)}
    <div class="trash-row">
      <span>
        {formatSequence(row.entry.sequence_number)} — {row.entry.title || 'Untitled entry'}
        <small
          >{#if target}Moved to "{target.name}" {formatSequence(
              target.sequence,
            )}{:else if legacy}{legacy[0]}{/if}</small
        >
      </span>
      <button onclick={() => void repo.restoreEntry(row.entry.id)}>Restore</button>
    </div>
  {/each}
  <h2>Deleted photos</h2>
  {#each photos as photo (photo.id)}<div class="trash-row">
      <span
        >Photo from {formatSequence(
          rows.find((row) => row.entry.item_id === photo.item_id)?.entry.sequence_number ?? 0,
        )}</span
      ><button onclick={() => void repo.restorePhoto(photo.id)}>Restore</button>
    </div>{/each}
  {#if !rows.length && !photos.length}<p>No recently deleted entries or photos.</p>{/if}
</section>

<style>
  .trash {
    display: grid;
    gap: var(--space-3);
  }
  .trash h2 {
    margin: var(--space-5) 0 var(--space-2);
  }
  .trash-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
  }
  .trash-row button {
    min-height: var(--size-touch);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-ballpoint);
    padding: var(--space-2) var(--space-4);
  }
  .trash-row > span {
    min-width: 0;
  }
  .trash-row small {
    display: block;
    margin-top: var(--space-2);
    min-height: calc(var(--text-sm) * var(--leading-body));
    font-size: var(--text-sm);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--color-muted);
  }
</style>
