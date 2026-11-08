<script lang="ts">
  import type { Photo } from '$lib/types'
  import { thumbnailUrl } from '$lib/photos'

  let {
    photos,
    total,
    onopen,
    onmore,
  }: { photos: Photo[]; total: number; onopen: (id: string) => void; onmore: () => void } = $props()
  let urls = $state<Record<string, string | null>>({})

  $effect(() => {
    for (const photo of photos) {
      if (!(photo.id in urls)) void thumbnailUrl(photo.id).then((url) => (urls[photo.id] = url))
    }
  })
</script>

{#if photos.length === 0}
  <div class="no-photos" aria-label="No photos">No photos</div>
{:else}
  <div class="thumb-strip" aria-label="Recent photos">
    {#each photos as photo (photo.id)}
      <button class="thumb" aria-label="Open photo" onclick={() => onopen(photo.id)}>
        {#if urls[photo.id]}<img src={urls[photo.id] ?? ''} alt="" loading="lazy" />{:else}<span
            aria-hidden="true">▧</span
          >{/if}
      </button>
    {/each}
    {#if total > photos.length}<button class="thumb more" aria-label="Open remaining photos" onclick={onmore}
        >+{total - photos.length}</button
      >{/if}
  </div>
{/if}

<style>
  .thumb-strip {
    display: flex;
    gap: 2px;
    align-items: center;
    min-width: 0;
  }
  .thumb,
  .no-photos {
    flex: 0 0 56px;
    width: 56px;
    height: 56px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-floor);
    color: var(--color-muted);
    padding: 0;
    overflow: hidden;
    display: grid;
    place-items: center;
  }
  .thumb {
    cursor: pointer;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .more {
    font-weight: 600;
  }
  .no-photos {
    border-style: dashed;
    font-size: 12px;
    text-align: center;
  }
  @container entry-list (min-width: 1130px) {
    .thumb-strip {
      gap: 4px;
    }
  }
</style>
