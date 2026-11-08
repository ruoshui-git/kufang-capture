<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import type { Id, Photo } from '$lib/types'
  import { originalUrl, thumbnailUrl } from '$lib/photos'

  let {
    open = $bindable(false),
    entryId,
    startPhotoId = null,
  }: { open?: boolean; entryId: Id; startPhotoId?: Id | null } = $props()
  let photos = $state<Photo[]>([])
  let index = $state(0)
  let source = $state<string | null>(null)
  let initialFocus: HTMLButtonElement | undefined = $state()
  let scale = $state(1)
  let panX = $state(0)
  let panY = $state(0)
  let pointers = new Map<number, { x: number; y: number }>()
  let startPoint: { x: number; y: number } | null = null
  let pinchDistance = 0
  let previousTap = 0
  let savedFocus: HTMLElement | null = null
  let subscription: (() => void) | { unsubscribe(): void } | undefined
  const current = $derived(photos[index])

  $effect(() => {
    if (open) {
      savedFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (!subscription) {
        subscription = repo.watchPhotos(entryId).subscribe((items) => {
          photos = items
          const requested = startPhotoId ? items.findIndex((photo) => photo.id === startPhotoId) : -1
          if (requested >= 0) index = requested
          else if (index >= items.length) index = Math.max(0, items.length - 1)
        })
      }
      void loadImage()
      queueMicrotask(() => initialFocus?.focus())
    } else {
      if (subscription) {
        if (typeof subscription === 'function') subscription()
        else subscription.unsubscribe()
        subscription = undefined
      }
      savedFocus?.focus()
      resetZoom()
    }
  })
  $effect(() => {
    if (!open || !current) return
    void loadImage()
    for (const photo of [photos[index - 1], photos[index + 1]]) if (photo) void thumbnailUrl(photo.id)
  })

  onMount(() => () => {
    if (typeof subscription === 'function') subscription()
    else subscription?.unsubscribe()
  })

  async function loadImage() {
    const photo = current
    if (!photo) {
      source = null
      return
    }
    source = await thumbnailUrl(photo.id)
    const full = await originalUrl(photo.id)
    if (current?.id === photo.id && full) source = full
  }
  function change(delta: number) {
    const next = index + delta
    if (next < 0 || next >= photos.length) return
    index = next
    resetZoom()
  }
  function close() {
    open = false
  }
  function resetZoom() {
    scale = 1
    panX = 0
    panY = 0
  }
  function onPointerDown(event: PointerEvent) {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) startPoint = { x: event.clientX, y: event.clientY }
    if (pointers.size === 2) pinchDistance = distance([...pointers.values()][0]!, [...pointers.values()][1]!)
  }
  function onPointerMove(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      const points = [...pointers.values()]
      const nextDistance = distance(points[0]!, points[1]!)
      if (pinchDistance) scale = Math.max(1, Math.min(5, scale * (nextDistance / pinchDistance)))
      pinchDistance = nextDistance
    } else if (scale > 1 && startPoint) {
      panX += event.movementX
      panY += event.movementY
    }
  }
  function onPointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinchDistance = 0
    if (startPoint) {
      const dx = event.clientX - startPoint.x
      const dy = event.clientY - startPoint.y
      if (scale === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) change(dx < 0 ? 1 : -1)
      else if (scale === 1 && dy > 100) close()
      startPoint = null
    }
  }
  function onDoubleTap(event: MouseEvent) {
    const now = Date.now()
    if (now - previousTap < 320) {
      if (scale > 1) resetZoom()
      else {
        scale = 2.5
        panX = event.clientX - innerWidth / 2
        panY = event.clientY - innerHeight / 2
      }
    }
    previousTap = now
  }
  function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      change(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      change(1)
    } else if (event.key === 'Tab') {
      const buttons = [
        ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled)'),
      ]
      const first = buttons[0],
        last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
  }
  function sourceLabel(photo: Photo) {
    return photo.capture_source === 'native_camera'
      ? 'System camera'
      : photo.capture_source === 'photo_library'
        ? 'Photo library'
        : 'Camera frame'
  }
  function sizeLabel(bytes: number) {
    return bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

{#if open}
  <div
    class="viewer"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Photo viewer"
    onkeydown={keydown}
  >
    <header class="viewer-head">
      <span>{index + 1} of {photos.length}</span><button
        bind:this={initialFocus}
        aria-label="Close photo viewer"
        onclick={close}>Close</button
      >
    </header>
    <div
      class="viewer-stage"
      role="group"
      aria-label="Photo image area"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      ondblclick={onDoubleTap}
    >
      {#if source}<img
          class="viewer-image"
          src={source}
          alt={current?.caption || `Photo ${index + 1}`}
          style:transform="translate({panX}px, {panY}px) scale({scale})"
          draggable="false"
        />{:else}<p>No photo available</p>{/if}
    </div>
    <button class="viewer-prev" aria-label="Previous photo" disabled={index === 0} onclick={() => change(-1)}
      >‹</button
    >
    <button
      class="viewer-next"
      aria-label="Next photo"
      disabled={index >= photos.length - 1}
      onclick={() => change(1)}>›</button
    >
    {#if current}<footer class="viewer-meta">
        <strong>{current.caption || 'No caption'}</strong><span
          >{sourceLabel(current)} — {current.width ?? '—'} × {current.height ?? '—'} — {sizeLabel(
            current.byte_size,
          )}</span
        >
      </footer>{/if}
  </div>
{/if}

<style>
  .viewer {
    position: fixed;
    z-index: var(--z-viewer);
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr auto;
    background: var(--color-viewer);
    color: var(--color-viewer-text);
    padding: env(safe-area-inset-top) var(--space-5) env(safe-area-inset-bottom);
  }
  .viewer-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 56px;
  }
  .viewer-head button,
  .viewer-prev,
  .viewer-next {
    min-width: 44px;
    min-height: 44px;
    border: 1px solid var(--color-line-strong);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    cursor: pointer;
  }
  .viewer-stage {
    min-height: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    touch-action: none;
  }
  .viewer-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    user-select: none;
    transform-origin: center;
  }
  .viewer-prev,
  .viewer-next {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--text-3xl);
  }
  .viewer-prev {
    left: var(--space-3);
  }
  .viewer-next {
    right: var(--space-3);
  }
  button:disabled {
    opacity: 0.35;
  }
  .viewer-meta {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-8) var(--space-3);
    text-align: center;
    color: var(--color-viewer-text);
  }
  .viewer-meta span {
    color: var(--color-viewer-muted);
    font-size: var(--text-sm);
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
