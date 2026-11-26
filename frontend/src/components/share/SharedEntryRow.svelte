<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { entryDisplayTitle, formatSequence } from '$lib/types'
  import type { SharedEntry } from '$lib/share/contract'
  import { sharedPhotoOrder } from '$lib/share/entries'
  import Tag from '../ui/Tag.svelte'
  import Chip from '../ui/Chip.svelte'
  import SharedThumbnail from './SharedThumbnail.svelte'

  let {
    entry,
    token,
    openEntry,
    openPhoto,
    onPhotoError,
  }: {
    entry: SharedEntry
    token: string
    openEntry: (entry: SharedEntry, button: HTMLButtonElement) => void
    openPhoto: (entry: SharedEntry, photoId: string, button: HTMLButtonElement) => void
    onPhotoError: (error: unknown) => void
  } = $props()

  const photos = $derived([...entry.photos].sort(sharedPhotoOrder).slice(0, 3))
  const more = $derived(entry.photos.length - photos.length)
</script>

<article class="card shared-row">
  <button
    type="button"
    class="row-entry"
    aria-label={m.share_open_entry({
      sequence: formatSequence(entry.sequence_number),
      title: entryDisplayTitle(entry),
    })}
    onclick={(event) => openEntry(entry, event.currentTarget)}
  >
    <Tag sequence={entry.sequence_number} />
    <span class="row-copy">
      <span class="row-title">
        <strong>{entryDisplayTitle(entry)}</strong>
        {#if entry.review_status === 'needs_review'}
          <Chip variant="status-warn">{m.entry_needs_review()}</Chip>
        {/if}
      </span>
      {#if entry.quantity?.trim() || entry.unit.trim()}
        <span class="quantity">{entry.quantity?.trim() ? entry.quantity : '—'} {entry.unit}</span>
      {/if}
      {#if entry.count_detail}<span>{entry.count_detail}</span>{/if}
      {#if entry.notes}<span class="notes">{entry.notes}</span>{/if}
    </span>
  </button>
  {#if photos.length}
    <div class="photos">
      {#each photos as photo, index (photo.id)}
        <SharedThumbnail
          {photo}
          {token}
          number={index + 1}
          open={(button) => openPhoto(entry, photo.id, button)}
          onError={onPhotoError}
        />
      {/each}
      {#if more > 0}
        <button
          type="button"
          class="button quiet more-photos"
          aria-label={m.share_show_more_photos({ count: more })}
          onclick={(event) => openEntry(entry, event.currentTarget)}
          >{m.share_more_photos({ count: more })}</button
        >
      {/if}
    </div>
  {/if}
</article>

<style>
  .shared-row {
    display: grid;
    align-items: start;
    gap: var(--space-3);
  }
  .row-entry {
    display: flex;
    align-items: start;
    min-width: 0;
    min-height: var(--size-touch);
    gap: var(--space-4);
    text-align: start;
  }
  /* The tag is the entry's identity; a long title or badge must never clip it. */
  .row-entry > :global(.tag) {
    flex-shrink: 0;
  }
  .row-copy {
    display: grid;
    min-width: 0;
    gap: var(--space-2);
    overflow-wrap: anywhere;
  }
  .row-copy > span:not(.row-title) {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .quantity {
    font-variant-numeric: tabular-nums;
  }
  .notes {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .row-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .row-title :global(.chip) {
    min-height: 0;
    font-size: var(--text-xs);
  }
  .photos {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .photos > :global(.thumbnail),
  .more-photos {
    width: calc(var(--size-thumb) + var(--space-3));
  }
  .more-photos {
    padding: 0;
    background: var(--color-sunken);
    color: var(--color-muted);
  }
  @media (min-width: 600px) {
    .shared-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }
</style>
