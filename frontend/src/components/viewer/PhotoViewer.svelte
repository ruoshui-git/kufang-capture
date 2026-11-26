<script module lang="ts">
  import type { Id, Photo } from '$lib/types'

  type ViewPhoto = Pick<Photo, 'id' | 'caption' | 'width' | 'height' | 'byte_size'> &
    Partial<Pick<Photo, 'capture_source'>> & { stored?: boolean }

  export interface ViewerPhotoSource {
    photos: ViewPhoto[]
    loadOriginal: (id: Id, signal: AbortSignal) => Promise<Blob>
    onError?: (error: unknown) => void
  }

  async function loadLocalSource() {
    const [{ repo }, { originalUrl, thumbnailUrl }, { photoAccount }] = await Promise.all([
      import('$lib/db'),
      import('$lib/photos'),
      import('$lib/sync/binding'),
    ])
    return { repo, originalUrl, thumbnailUrl, photoAccount }
  }
</script>

<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { formatBytes } from '$lib/i18n/format'
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { onDestroy, untrack } from 'svelte'
  import { openOverlay } from '$lib/ui/overlayHistory'

  let {
    open = $bindable(false),
    entryId,
    startPhotoId = null,
    photoSource,
  }: { open?: boolean; startPhotoId?: Id | null } & (
    | { entryId: Id; photoSource?: never }
    | { entryId?: never; photoSource: ViewerPhotoSource }
  ) = $props()
  let local = $state.raw<Awaited<ReturnType<typeof loadLocalSource>>>()
  let localPhotos = $state<Photo[]>([])
  let account = $state<string | null>(null)
  const photos: ViewPhoto[] = $derived(photoSource?.photos ?? localPhotos)
  let index = $state(0)
  let source = $state<{ id: Id; url: string; account: string | null } | null>(null)
  let initialFocus: HTMLButtonElement | undefined = $state()
  let scale = $state(1)
  let panX = $state(0)
  let panY = $state(0)
  let pointers = new Map<number, { x: number; y: number }>()
  let startPoint: { x: number; y: number } | null = null
  let pinchDistance = 0
  let previousTap = 0
  let savedFocus: HTMLElement | null = null
  let unregisterOverlay: (() => void) | undefined
  const current = $derived(photos[index])

  $effect(() => {
    if (open) {
      unregisterOverlay = openOverlay(() => (open = false))
      savedFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      queueMicrotask(() => initialFocus?.focus())
    } else {
      unregisterOverlay?.()
      unregisterOverlay = undefined
      savedFocus?.focus()
      resetZoom()
    }
  })

  $effect(() => {
    if (!open || photoSource || local) return
    let active = true
    void loadLocalSource().then((source) => {
      if (active) local = source
    })
    return () => {
      active = false
    }
  })

  function chooseStartingPhoto(items: ViewPhoto[], requestedId: Id | null) {
    const requested = requestedId ? items.findIndex((photo) => photo.id === requestedId) : -1
    if (requested >= 0) index = requested
    else if (index >= items.length) index = Math.max(0, items.length - 1)
  }

  $effect(() => {
    if (!open || !local || !entryId) return
    const stopAccount = local.photoAccount.subscribe((value) => (account = value))
    const subscription = local.repo.watchPhotos(entryId).subscribe((items) => {
      localPhotos = items
      untrack(() => chooseStartingPhoto(items, startPhotoId))
    })
    return () => {
      stopAccount()
      if (typeof subscription === 'function') subscription()
      else subscription.unsubscribe()
    }
  })

  $effect(() => {
    if (!open || !photoSource) return
    const requested = startPhotoId
    index = 0
    untrack(() => chooseStartingPhoto(photoSource!.photos, requested))
  })

  let sharedLoadFailed = $state(false)
  $effect(() => {
    if (!open || !current) return
    const id = current.id
    if (local && !photoSource) {
      void loadLocalImage(id, account, local)
      for (const photo of [photos[index - 1], photos[index + 1]]) if (photo) void local.thumbnailUrl(photo.id)
      return
    }
    if (!photoSource) return
    source = null
    sharedLoadFailed = false
    if (current.stored === false) return
    const loader = photoSource
    const controller = new AbortController()
    let objectUrl: string | undefined
    void loader.loadOriginal(id, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        source = { id, url: objectUrl, account: null }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        sharedLoadFailed = true
        loader.onError?.(error)
      },
    )
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  })

  onDestroy(() => unregisterOverlay?.())

  async function loadLocalImage(
    id: Id,
    requestAccount: string | null,
    urls: Awaited<ReturnType<typeof loadLocalSource>>,
  ) {
    const preview = await urls.thumbnailUrl(id)
    if (current?.id !== id || account !== requestAccount) return
    source = preview ? { id, url: preview, account: requestAccount } : null
    const full = await urls.originalUrl(id)
    if (current?.id === id && account === requestAccount && full)
      source = { id, url: full, account: requestAccount }
  }
  function change(delta: number) {
    const next = index + delta
    if (next < 0 || next >= photos.length) return
    index = next
    resetZoom()
  }
  function close() {
    unregisterOverlay?.()
    unregisterOverlay = undefined
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
  function sourceLabel(photo: ViewPhoto) {
    return photo.capture_source === 'native_camera'
      ? m.entry_system_camera()
      : photo.capture_source === 'photo_library'
        ? m.entry_photo_library()
        : m.entry_camera_frame()
  }
  function sizeLabel(bytes: number) {
    if (getLocale() !== 'en') return formatBytes(bytes)
    // Keep the existing KB minimum and rounding in English.
    const megabytes = bytes >= 1024 * 1024
    const unit = megabytes ? 'MB' : 'KB'
    const amount = megabytes ? (bytes / (1024 * 1024)).toFixed(1) : (bytes / 1024).toFixed(0)
    return `${amount} ${unit}`
  }
</script>

{#if open}
  <div
    class="viewer"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label={m.entry_photo_viewer()}
    onkeydown={keydown}
  >
    <header class="viewer-head">
      <span>{m.entry_photo_position({ number: index + 1, total: photos.length })}</span><button
        bind:this={initialFocus}
        aria-label={m.entry_close_viewer()}
        onclick={close}>{m.entry_close()}</button
      >
    </header>
    <div
      class="viewer-stage"
      role="group"
      aria-label={m.entry_photo_image_area()}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      ondblclick={onDoubleTap}
    >
      {#if source && source.id === current?.id && source.account === account}<img
          class="viewer-image"
          src={source.url}
          alt={current?.caption || m.entry_photo_number({ number: index + 1 })}
          style:transform="translate({panX}px, {panY}px) scale({scale})"
          draggable="false"
        />{:else if photoSource && current?.stored === false}<p>{m.share_unuploaded()}</p>
      {:else if photoSource && current && !sharedLoadFailed}<p>{m.entry_loading_photo()}</p>
      {:else}<p>{m.entry_no_photo_available()}</p>{/if}
    </div>
    <button
      class="viewer-prev"
      aria-label={m.entry_previous_photo()}
      disabled={index === 0}
      onclick={() => change(-1)}>‹</button
    >
    <button
      class="viewer-next"
      aria-label={m.entry_next_photo()}
      disabled={index >= photos.length - 1}
      onclick={() => change(1)}>›</button
    >
    {#if current}<footer class="viewer-meta">
        <strong>{current.caption || m.entry_no_caption()}</strong><span
          >{photoSource
            ? m.share_photo_metadata({
                width: current.width ?? '—',
                height: current.height ?? '—',
                size: sizeLabel(current.byte_size),
              })
            : m.entry_photo_metadata({
                source: sourceLabel(current),
                width: current.width ?? '—',
                height: current.height ?? '—',
                size: sizeLabel(current.byte_size),
              })}</span
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
