<script lang="ts">
  import { repo } from '$lib/db'
  import type { Id, Photo } from '$lib/types'
  import { thumbnailUrl } from '$lib/photos'
  import Button from '../ui/Button.svelte'

  let {
    photos,
    entryId,
    onopen,
    ondelete,
  }: { photos: Photo[]; entryId: Id; onopen: (id: Id) => void; ondelete: (photo: Photo) => void } = $props()
  let urls = $state<Record<Id, string>>({})
  let captionDraft = $state<Record<Id, string>>({})
  let captionDirty = $state(new Set<Id>())
  const captionTimers = new Map<Id, ReturnType<typeof setTimeout>>()

  $effect(() => {
    for (const photo of photos) {
      const inputIsFocused =
        document.activeElement instanceof HTMLInputElement &&
        document.activeElement.dataset.photoCaption === photo.id
      if (!captionDirty.has(photo.id) && !inputIsFocused) captionDraft[photo.id] = photo.caption
      if (!urls[photo.id])
        void thumbnailUrl(photo.id).then((url) => {
          if (url) urls[photo.id] = url
        })
    }
  })
  async function move(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= photos.length) return
    const ordered = [...photos]
    ;[ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!]
    await repo.reorderPhotos(
      entryId,
      ordered.map((photo) => photo.id),
    )
  }
  function captionChanged(photo: Photo, value: string) {
    captionDraft[photo.id] = value
    captionDirty.add(photo.id)
    captionDirty = new Set(captionDirty)
    const timer = captionTimers.get(photo.id)
    if (timer) clearTimeout(timer)
    captionTimers.set(
      photo.id,
      setTimeout(() => {
        captionTimers.delete(photo.id)
        void flushCaption(photo, value)
      }, 300),
    )
  }
  async function flushCaption(photo: Photo, value: string) {
    const timer = captionTimers.get(photo.id)
    if (timer) clearTimeout(timer)
    captionTimers.delete(photo.id)
    await repo.updatePhoto(photo.id, { caption: value })
    captionDirty.delete(photo.id)
    captionDirty = new Set(captionDirty)
  }
</script>

{#if photos.length}
  <div class="photo-grid" aria-label="Entry photos">
    {#each photos as photo, index (photo.id)}
      <article class="photo-card">
        <button class="photo-open" aria-label="View photo {index + 1}" onclick={() => onopen(photo.id)}>
          {#if urls[photo.id]}<img
              src={urls[photo.id]}
              alt={photo.caption || `Entry photo ${index + 1}`}
            />{:else}<span class="photo-placeholder">Loading photo…</span>{/if}
          {#if photo.is_cover}<span class="cover-badge">Cover</span>{/if}
        </button>
        <div class="photo-controls">
          {#if !photo.is_cover}<button onclick={() => void repo.setCoverPhoto(photo.id)}>Set as cover</button
            >{:else}<span>Cover photo</span>{/if}
          <div class="move-controls">
            <button aria-label="Move earlier" disabled={index === 0} onclick={() => void move(index, -1)}
              >↑</button
            ><button
              aria-label="Move later"
              disabled={index === photos.length - 1}
              onclick={() => void move(index, 1)}>↓</button
            >
          </div>
        </div>
        <label class="caption-field"
          >Caption<input
            value={captionDraft[photo.id] ?? photo.caption}
            aria-label="Photo caption"
            data-photo-caption={photo.id}
            oninput={(event) => captionChanged(photo, event.currentTarget.value)}
            onblur={(event) => void flushCaption(photo, event.currentTarget.value)}
          /></label
        >
        <Button
          variant="quiet"
          onclick={async () => {
            await repo.deletePhoto(photo.id)
            ondelete(photo)
          }}>Delete photo</Button
        >
      </article>
    {/each}
  </div>
{/if}

<style>
  .photo-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }
  .photo-card {
    min-width: 0;
    padding: var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-card);
  }
  .photo-open {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--color-floor);
    cursor: zoom-in;
  }
  .photo-open img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .photo-placeholder {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .cover-badge {
    position: absolute;
    left: var(--space-3);
    top: var(--space-3);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--color-tag);
    color: var(--color-tag-ink);
    font-size: var(--text-sm);
  }
  .photo-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-height: 44px;
  }
  .photo-controls button,
  .move-controls button {
    min-height: var(--size-touch);
    padding: var(--space-2) var(--space-3);
    border: 0;
    background: transparent;
    color: var(--color-ballpoint);
    cursor: pointer;
  }
  .photo-controls span {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .move-controls {
    display: flex;
  }
  .move-controls button {
    min-width: 40px;
    font-size: var(--text-xl);
  }
  .move-controls button:disabled {
    opacity: 0.35;
  }
  .caption-field {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-2) 0 var(--space-3);
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .caption-field input {
    width: 100%;
    min-height: var(--size-touch);
    padding: var(--space-3) var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-sm);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  @media (min-width: 640px) {
    .photo-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-5);
    }
  }
  @media (min-width: 900px) {
    .photo-grid {
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    }
  }
</style>
