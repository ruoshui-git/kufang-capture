<script lang="ts">
  import type { Photo } from '$lib/types'
  import { thumbnailUrl } from '$lib/photos'
  import { photoAccount } from '$lib/sync/binding'

  let {
    photos,
    total,
    onopen,
    onmore,
  }: { photos: Photo[]; total: number; onopen: (id: string) => void; onmore: () => void } = $props()
  type PreviewKey = { revision: number; account: string | null }
  let urls = $state<Record<string, PreviewKey & { url: string }>>({})
  let requested = $state<Record<string, PreviewKey>>({})

  $effect(() => {
    const account = $photoAccount
    for (const photo of photos) {
      const request = requested[photo.id]
      if (request?.revision === photo.revision && request.account === account) continue
      requested[photo.id] = { revision: photo.revision, account }
      void thumbnailUrl(photo.id).then((url) => {
        if (url && $photoAccount === account && requested[photo.id]?.revision === photo.revision)
          urls[photo.id] = { revision: photo.revision, account, url }
      })
    }
  })
</script>

{#if photos.length === 0}
  <div class="no-photos" aria-label="No photos">No photos</div>
{:else}
  <div class="thumb-strip" aria-label="Recent photos">
    {#each photos as photo (photo.id)}
      <button class="thumb" aria-label="Open photo" onclick={() => onopen(photo.id)}>
        {#if urls[photo.id]?.account === $photoAccount}<img
            src={urls[photo.id]?.url ?? ''}
            alt=""
            loading="lazy"
          />{:else}<span aria-hidden="true">▧</span>{/if}
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
    gap: var(--space-1);
    align-items: center;
    min-width: 0;
  }
  .thumb,
  .no-photos {
    flex: 0 0 var(--size-thumb);
    width: var(--size-thumb);
    height: var(--size-thumb);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
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
    font-size: var(--text-xs);
    text-align: center;
  }
  @container entry-list (min-width: 1130px) {
    .thumb-strip {
      gap: var(--space-2);
    }
  }
</style>
