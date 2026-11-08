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

<div class="thumb-strip" aria-label="Recent photos">
  {#each photos as photo (photo.id)}
    <button class="thumb" aria-label="Open photo" onclick={() => onopen(photo.id)}>
      {#if urls[photo.id]}<img src={urls[photo.id] ?? ''} alt="" loading="lazy" />{:else}<span
          aria-hidden="true">▧</span
        >{/if}
    </button>
  {/each}
  {#if total > photos.length}<button class="thumb more" onclick={onmore}>+{total - photos.length}</button
    >{/if}
</div>

<style>
  .thumb-strip {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .thumb {
    width: 52px;
    height: 52px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-floor);
    color: var(--color-muted);
    padding: 0;
    overflow: hidden;
    display: grid;
    place-items: center;
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
  @media (min-width: 900px) {
    .thumb {
      width: 40px;
      height: 40px;
    }
  }
</style>
