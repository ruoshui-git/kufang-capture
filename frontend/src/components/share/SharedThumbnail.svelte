<script module lang="ts">
  const targets = new Map<Element, (visible: boolean) => void>()
  let observer: IntersectionObserver | undefined

  function observeThumbnail(node: HTMLElement, visible: (visible: boolean) => void) {
    if (typeof IntersectionObserver === 'undefined') {
      visible(true)
    } else {
      observer ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) targets.get(entry.target)?.(entry.isIntersecting)
        },
        { rootMargin: '160px' },
      )
      targets.set(node, visible)
      observer.observe(node)
    }
    return {
      destroy() {
        observer?.unobserve(node)
        targets.delete(node)
      },
    }
  }
</script>

<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { SharedPhoto } from '$lib/share/contract'
  import { loadSharedThumbnail } from '$lib/share/thumbnailQueue'

  let {
    photo,
    token,
    number,
    open,
    onError,
  }: {
    photo: SharedPhoto
    token: string
    number: number
    open: (trigger: HTMLButtonElement) => void
    onError: (error: unknown) => void
  } = $props()

  let near = $state(false)
  let url = $state<string>()
  let failed = $state(false)

  $effect(() => {
    if (!near || !photo.stored) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void loadSharedThumbnail(token, photo.id, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        url = objectUrl
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        failed = true
        onError(error)
      },
    )
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      url = undefined
      failed = false
    }
  })
</script>

<div class="thumbnail" use:observeThumbnail={(value) => (near = value)}>
  {#if photo.stored}
    <button
      type="button"
      aria-label={m.entry_view_photo({ number })}
      onclick={(event) => open(event.currentTarget)}
    >
      {#if url && !failed}
        <img
          src={url}
          alt={photo.caption || m.entry_photo_number({ number })}
          draggable="false"
          onerror={() => (failed = true)}
        />
      {:else if failed}
        <span>{m.entry_no_photo_available()}</span>
      {/if}
    </button>
  {:else}
    <span>{m.share_unuploaded()}</span>
  {/if}
</div>

<style>
  .thumbnail {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-sunken);
    color: var(--color-muted);
    text-align: center;
    font-size: var(--text-xs);
    line-height: var(--leading-tight);
  }
  button {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    border-radius: inherit;
  }
  span {
    padding-inline: var(--space-1);
    overflow-wrap: anywhere;
  }
  img {
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: cover;
    border-radius: inherit;
  }
</style>
