<script lang="ts">
  import { onDestroy } from 'svelte'
  import { repo } from '$lib/db'
  import type { IncomingPhoto } from '$lib/repo'
  import type { Id, Photo } from '$lib/types'
  import {
    backCameraDevices,
    cameraPermissionMessage,
    openCamera,
    readCapabilities,
    setTrackConstraint,
    stopCamera,
    captureFrame,
    type CameraCapabilities,
  } from '$lib/camera/stream'
  import { pickPhotos } from '$lib/camera'

  let {
    open = $bindable(false),
    entryId,
    oncaptured,
  }: { open?: boolean; entryId: Id; oncaptured?: (photos: Photo[]) => void } = $props()

  let video = $state<HTMLVideoElement>()
  let stream: MediaStream | null = null
  let capabilities = $state<CameraCapabilities>({})
  let cameras = $state<MediaDeviceInfo[]>([])
  let selectedCamera = $state('')
  let savedCount = $state(0)
  let queuedCount = $state(0)
  let error = $state('')
  let paused = $state(false)
  let flash = $state(false)
  let digitalCrop = $state(1)
  let digitalCropTouched = $state(false)
  let currentZoom = $state(1)
  let urls = $state<string[]>([])
  let startToken = 0
  let pinchStart: number | null = null
  let savedPhotos: Photo[] = []

  $effect(() => {
    if (open) void start()
    else stop()
  })

  function stop() {
    startToken++
    stopCamera(stream)
    stream = null
    if (video) video.srcObject = null
  }

  async function start(deviceId?: string) {
    stop()
    const token = startToken
    error = ''
    paused = false
    try {
      stream = await openCamera(deviceId)
      if (!open || token !== startToken) {
        stopCamera(stream)
        stream = null
        return
      }
      if (video) {
        video.srcObject = stream
        await video.play().catch(() => undefined)
      }
      const track = stream.getVideoTracks()[0]
      if (track) {
        capabilities = readCapabilities(track)
        currentZoom = track.getSettings().zoom ?? 1
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
        cameras = backCameraDevices(devices)
        if (deviceId) selectedCamera = deviceId
        else selectedCamera = track.getSettings().deviceId || ''
      }
    } catch (cause) {
      error = cameraPermissionMessage(cause)
      paused = true
    }
  }

  function visibilityChanged() {
    if (document.visibilityState === 'hidden') {
      stop()
      paused = true
    } else if (open && paused) void start(selectedCamera || undefined)
  }
  $effect(() => {
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => document.removeEventListener('visibilitychange', visibilityChanged)
  })

  onDestroy(() => {
    stop()
    urls.forEach((url) => URL.revokeObjectURL(url))
  })

  function track() {
    return stream?.getVideoTracks()[0]
  }

  async function changeLens(event: Event) {
    const deviceId = (event.currentTarget as HTMLSelectElement).value
    selectedCamera = deviceId
    await start(deviceId)
  }

  async function setZoom(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    currentZoom = value
    try {
      await setTrackConstraint(track()!, { zoom: value })
    } catch {
      error = 'The camera rejected that zoom setting.'
    }
  }

  async function setTorch(event: Event) {
    try {
      await setTrackConstraint(track()!, { torch: (event.currentTarget as HTMLInputElement).checked })
    } catch {
      error = 'The camera could not change the torch setting.'
    }
  }

  async function setFocusMode(event: Event) {
    try {
      await setTrackConstraint(track()!, { focusMode: (event.currentTarget as HTMLSelectElement).value })
    } catch {
      error = 'The camera could not change focus mode.'
    }
  }

  async function setFocusDistance(event: Event) {
    try {
      await setTrackConstraint(track()!, {
        focusDistance: Number((event.currentTarget as HTMLInputElement).value),
      })
    } catch {
      error = 'The camera could not change focus distance.'
    }
  }

  async function tapFocus(event: PointerEvent) {
    if (!capabilities.pointsOfInterest) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const pointsOfInterest = [
      { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height },
    ]
    try {
      await setTrackConstraint(track()!, { pointsOfInterest })
    } catch {
      // Capability was advertised but the browser may still reject the request.
    }
  }

  function pinchDistance(event: TouchEvent) {
    if (event.touches.length < 2) return
    const [first, second] = Array.from(event.touches)
    if (!first || !second) return
    const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
    if (pinchStart !== null && !capabilities.zoom) {
      digitalCropTouched = true
      digitalCrop = Math.max(1, Math.min(4, digitalCrop * (distance / pinchStart)))
    } else if (pinchStart !== null && capabilities.zoom) {
      const range = zoomRange
      const max = typeof range === 'number' ? range : (range?.max ?? currentZoom)
      const min = typeof range === 'number' ? 1 : (range?.min ?? 1)
      currentZoom = Math.max(min, Math.min(max, currentZoom * (distance / pinchStart)))
      if (track()) void setTrackConstraint(track()!, { zoom: currentZoom }).catch(() => undefined)
    }
    pinchStart = distance
  }

  function shot() {
    const currentStream = stream
    const currentVideo = video
    const currentTrack = track()
    if (!currentStream || !currentVideo || !currentTrack || currentVideo.readyState < 2) return
    error = ''
    flash = true
    window.setTimeout(() => (flash = false), 110)
    queuedCount++
    void (async () => {
      let url: string | undefined
      try {
        const blob = await captureFrame(currentVideo, currentTrack, capabilities.zoom ? 1 : digitalCrop)
        url = URL.createObjectURL(blob)
        urls = [...urls, url].slice(-5)
        const incoming: IncomingPhoto = {
          blob,
          filename: `camera-${new Date().toISOString().replaceAll(':', '-')}.jpg`,
          source: 'camera_frame',
          captured_at: new Date().toISOString(),
        }
        const photos = await repo.addPhotos(entryId, [incoming])
        savedCount++
        savedPhotos = [...savedPhotos, ...photos]
        oncaptured?.(photos)
      } catch (cause) {
        if (url) {
          URL.revokeObjectURL(url)
          urls = urls.filter((candidate) => candidate !== url)
        }
        error = 'Could not save this photo. Check available storage and try again.'
      } finally {
        queuedCount = Math.max(0, queuedCount - 1)
      }
    })()
  }

  async function useSystemCamera() {
    try {
      const photos = await pickPhotos('camera')
      if (photos.length) {
        queuedCount++
        void repo
          .addPhotos(entryId, photos)
          .then((added) => {
            savedCount += added.length
            savedPhotos = [...savedPhotos, ...added]
            oncaptured?.(added)
          })
          .catch((cause) => {
            error = 'Could not save this photo. Check available storage and try again.'
          })
          .finally(() => queuedCount--)
      }
    } catch (cause) {
      error = 'Could not open the system camera. Check camera permission and try again.'
    }
  }

  function close() {
    stop()
    open = false
  }

  const zoomRange = $derived(
    typeof capabilities.zoom === 'number' ? { min: 1, max: capabilities.zoom, step: 0.1 } : capabilities.zoom,
  )
  const focusRange = $derived(capabilities.focusDistance)
</script>

{#if open}
  <div class="camera-overlay" role="dialog" aria-modal="true" aria-label="Fast camera">
    <header class="camera-head">
      <button class="camera-text-button" onclick={close}>Done</button>
      <strong>Fast camera</strong>
      <span class="camera-count" aria-live="polite"
        >{savedCount} saved{queuedCount ? ` — ${queuedCount} saving` : ''}</span
      >
    </header>
    <main class="camera-main">
      <div
        class="preview-wrap"
        role="application"
        aria-label="Camera preview controls"
        onpointerup={tapFocus}
        ontouchstart={pinchDistance}
        ontouchmove={pinchDistance}
        ontouchend={() => (pinchStart = null)}
      >
        <video bind:this={video} autoplay playsinline muted aria-label="Camera preview"></video>
        {#if flash}<div class="flash" aria-hidden="true"></div>{/if}
        {#if paused}<div class="paused">
            <strong>Camera paused</strong><span>Tap to resume</span><button
              class="camera-text-button"
              onclick={() => start(selectedCamera || undefined)}>Resume camera</button
            >
          </div>{/if}
        {#if error}<div class="camera-error" role="alert">{error}</div>{/if}
      </div>
      <div class="camera-tools">
        {#if cameras.length > 1}
          <label
            >Lens <select value={selectedCamera} onchange={changeLens}
              >{#each cameras as camera (camera.deviceId)}<option value={camera.deviceId}
                  >{camera.label}</option
                >{/each}</select
            ></label
          >
        {/if}
        {#if zoomRange}
          <label
            >Zoom <input
              aria-label="Zoom"
              type="range"
              min={zoomRange.min}
              max={zoomRange.max}
              step={zoomRange.step ?? 0.1}
              value={currentZoom}
              oninput={setZoom}
            /></label
          >
        {:else if digitalCropTouched}<span class="digital-label">Digital crop {digitalCrop.toFixed(1)}×</span
          >{/if}
        {#if capabilities.torch}<label class="toggle-control"
            ><input type="checkbox" onchange={setTorch} /> Torch</label
          >{/if}
        {#if capabilities.focusMode?.length}
          <label
            >Focus mode <select onchange={setFocusMode}
              >{#each capabilities.focusMode as mode}<option value={mode}>{mode}</option>{/each}</select
            ></label
          >
        {/if}
        {#if focusRange}<label
            >Focus distance <input
              aria-label="Focus distance"
              type="range"
              min={focusRange.min}
              max={focusRange.max}
              step={focusRange.step ?? 0.01}
              oninput={setFocusDistance}
            /></label
          >{/if}
      </div>
      <div class="camera-strip" aria-label="Recent captures">
        {#each urls as url}<img src={url} alt="Recent capture" />{/each}
      </div>
      {#if error.includes('Allow camera access') || paused}
        <button class="system-camera" onclick={useSystemCamera}>Use system camera instead</button>
      {/if}
    </main>
    <footer class="camera-footer">
      <button class="shutter" aria-label="Take photo" onclick={shot} disabled={paused}>
        <span></span>
      </button>
    </footer>
  </div>
{/if}

<style>
  .camera-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-viewer);
    display: flex;
    flex-direction: column;
    background: var(--color-viewer);
    color: var(--color-viewer-text);
    padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
  }
  .camera-head {
    height: 58px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-5);
    border-bottom: 1px solid var(--color-line);
  }
  .camera-count {
    font-size: var(--text-sm);
    color: var(--color-viewer-text);
  }
  .camera-text-button,
  .system-camera {
    border: 0;
    background: transparent;
    color: var(--color-viewer-text);
    padding: var(--space-3) var(--space-2);
    min-height: 44px;
  }
  .camera-main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
  }
  .preview-wrap {
    position: relative;
    flex: 1;
    min-height: 160px;
    overflow: hidden;
    background: var(--color-viewer);
    touch-action: none;
  }
  .preview-wrap video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .flash {
    position: absolute;
    inset: 0;
    background: var(--color-card);
    animation: flash var(--duration-fast) var(--easing-standard);
  }
  .paused {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: var(--color-scrim);
  }
  .camera-error {
    position: absolute;
    bottom: var(--space-4);
    left: var(--space-4);
    right: var(--space-4);
    padding: var(--space-4);
    background: var(--color-danger);
    color: var(--color-on-ink);
    border-radius: var(--radius-md);
  }
  .camera-tools {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    font-size: var(--text-sm);
  }
  .camera-tools label {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .camera-tools select {
    max-width: 180px;
    background: var(--color-card);
    color: var(--color-ink);
    border: 1px solid var(--color-line-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-2);
  }
  .camera-tools input[type='range'] {
    width: 100px;
  }
  .digital-label {
    color: var(--color-viewer-text);
  }
  .toggle-control {
    min-height: var(--size-touch);
  }
  .camera-strip {
    height: 56px;
    display: flex;
    gap: var(--space-3);
    justify-content: center;
  }
  .camera-strip img {
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: var(--radius-sm);
  }
  .system-camera {
    align-self: center;
    text-decoration: underline;
  }
  .camera-footer {
    height: 112px;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .shutter {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    border: 4px solid var(--color-card);
    background: transparent;
    display: grid;
    place-items: center;
  }
  .shutter span {
    width: 58px;
    height: 58px;
    border-radius: 50%;
    background: var(--color-card);
  }
  .shutter:disabled {
    opacity: 0.45;
  }
  @keyframes flash {
    from {
      opacity: 0.8;
    }
    to {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flash {
      animation: none;
      opacity: 0.4;
    }
  }
</style>
