<script lang="ts">
  import { repo } from '$lib/db'
  import { backCameraDevices, openCamera, readCapabilities, stopCamera } from '$lib/camera/stream'
  import { generateSampleData } from '$lib/dev/sampleData'
  import Button from '../../components/ui/Button.svelte'

  type Report = Record<string, unknown>
  let busy = $state(false)
  let error = $state('')
  let report = $state<Report | null>(null)
  let reportText = $state('')
  let copyMessage = $state('')
  let reportArea = $state<HTMLTextAreaElement>()
  let sampleBusy = $state(false)
  let sampleMessage = $state('')
  let sampleError = $state('')
  let summaryItems = $state<string[]>([])

  async function generateTestData() {
    sampleBusy = true
    sampleMessage = ''
    sampleError = ''
    try {
      const result = await generateSampleData()
      sampleMessage = `Created ${result.name} with 300 entries. Open it from Collections.`
    } catch (cause) {
      sampleError = 'Could not generate test data. Check available storage and try again.'
    } finally {
      sampleBusy = false
    }
  }

  function shortHash(value: string) {
    let hash = 2166136261
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
    return (hash >>> 0).toString(16).slice(0, 8)
  }

  async function startTest() {
    busy = true
    error = ''
    report = null
    let stream: MediaStream | undefined
    try {
      const storage = await repo.estimateStorage()
      const mediaDevices = navigator.mediaDevices as MediaDevices | undefined
      let frame: Record<string, unknown> | null = null
      let selected: Record<string, unknown> | null = null
      let photoCapabilities: unknown = 'ImageCapture unavailable'
      let actualResolution: { width: number; height: number } | null = null
      let takePhotoAvailable = false
      if (typeof mediaDevices?.getUserMedia === 'function') {
        stream = await openCamera()
        const track = stream.getVideoTracks()[0]
        if (track) {
          const video = document.createElement('video')
          video.muted = true
          video.playsInline = true
          video.srcObject = stream
          await video.play().catch(() => undefined)
          actualResolution = { width: video.videoWidth, height: video.videoHeight }
          const settings = track.getSettings()
          selected = {
            settings,
            capabilities: readCapabilities(track),
            constraints: track.getConstraints(),
          }
          const ctor = (
            globalThis as typeof globalThis & {
              ImageCapture?: new (track: MediaStreamTrack) => {
                takePhoto?: () => Promise<Blob>
                getPhotoCapabilities?: () => Promise<unknown>
              }
            }
          ).ImageCapture
          if (ctor) {
            const capture = new ctor(track)
            takePhotoAvailable = typeof capture.takePhoto === 'function'
            photoCapabilities = capture.getPhotoCapabilities
              ? await capture.getPhotoCapabilities().catch((cause) => ({ error: String(cause) }))
              : 'ImageCapture available; getPhotoCapabilities unavailable'
            if (capture.takePhoto) {
              const blob = await capture.takePhoto()
              let dimensions: { width: number; height: number } | null = null
              if ('createImageBitmap' in globalThis) {
                const bitmap = await createImageBitmap(blob)
                dimensions = { width: bitmap.width, height: bitmap.height }
                bitmap.close()
              }
              frame = {
                route: 'ImageCapture.takePhoto',
                pixel_dimensions: dimensions,
                byte_size: blob.size,
                mime_type: blob.type,
              }
            }
          }
          if (!frame) {
            const canvas = document.createElement('canvas')
            canvas.width = settings.width || video.videoWidth
            canvas.height = settings.height || video.videoHeight
            const context = canvas.getContext('2d')
            if (context && canvas.width && canvas.height) {
              context.drawImage(video, 0, 0, canvas.width, canvas.height)
              const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, 'image/jpeg', 0.92),
              )
              if (blob)
                frame = {
                  route: 'video frame canvas',
                  pixel_dimensions: { width: canvas.width, height: canvas.height },
                  byte_size: blob.size,
                  mime_type: blob.type,
                }
            }
          }
          video.srcObject = null
        }
      }
      const devices =
        typeof mediaDevices?.enumerateDevices === 'function' ? await mediaDevices.enumerateDevices() : []
      const cameras = devices.filter((device) => device.kind === 'videoinput')
      const backCameras = backCameraDevices(cameras)
      const captureInput = document.createElement('input')
      captureInput.type = 'file'
      captureInput.accept = 'image/*'
      captureInput.setAttribute('capture', 'environment')
      const candidate: Report = {
        generated_at: new Date().toISOString(),
        user_agent: navigator.userAgent,
        standalone:
          window.matchMedia('(display-mode: standalone)').matches ||
          ('standalone' in navigator &&
            Boolean((navigator as Navigator & { standalone?: boolean }).standalone)),
        secure_context: window.isSecureContext,
        media_devices_supported: Boolean(mediaDevices?.getUserMedia),
        devices: devices.map((device) => ({
          kind: device.kind,
          label: device.label,
          group_id_hash: device.groupId ? shortHash(device.groupId) : null,
        })),
        selected_track: selected,
        actual_video_resolution: actualResolution,
        image_capture_available:
          typeof (globalThis as typeof globalThis & { ImageCapture?: unknown }).ImageCapture === 'function',
        take_photo_available: takePhotoAvailable,
        photo_capabilities: photoCapabilities,
        test_frame: frame,
        file_input_capture_note:
          'The capture attribute is present on image file input. Browser support does not guarantee which native picker or camera UI will open.',
        storage,
      }
      report = candidate
      const capabilities = (selected as { capabilities?: Record<string, unknown> } | null)?.capabilities ?? {}
      const zoom = capabilities.zoom as { min?: number; max?: number } | undefined
      const hardwareZoom =
        zoom && typeof zoom === 'object' && typeof zoom.min === 'number' && typeof zoom.max === 'number'
          ? `${zoom.min}× to ${zoom.max}×`
          : 'Not exposed — pinch uses digital crop'
      const labels = cameras.map((device) => device.label || '(label not exposed)')
      summaryItems = [
        `Secure context: ${candidate.secure_context ? 'yes' : 'no'}`,
        `Installed (standalone): ${candidate.standalone ? 'yes' : 'no'}`,
        `Cameras found: ${cameras.length}${labels.length ? ` — ${labels.join(', ')}` : ''}`,
        `Lens choice available: ${backCameras.length > 1 ? 'yes' : 'no'}`,
        `Hardware zoom: ${hardwareZoom}`,
        `Torch: ${capabilities.torch === true ? 'yes' : 'no'}`,
        `Focus controls: ${Array.isArray(capabilities.focusMode) || typeof capabilities.focusDistance === 'object' || capabilities.pointsOfInterest === true ? 'yes' : 'no'}`,
        `Live frame resolution: ${actualResolution ? `${actualResolution.width} × ${actualResolution.height}` : 'not reported'}`,
        `ImageCapture.takePhoto available: ${takePhotoAvailable ? 'yes' : 'no'}`,
        `Storage persisted: ${storage.persisted == null ? 'not reported' : storage.persisted ? 'yes' : 'no'}`,
      ]
      reportText = `Kufang Capture camera diagnostics\n${new Date().toLocaleString()}\n\n${JSON.stringify(candidate, null, 2)}`
    } catch (cause) {
      error = 'Camera test failed. Allow camera access and try again.'
    } finally {
      stopCamera(stream)
      busy = false
    }
  }

  async function copyReport() {
    if (!reportText) return
    try {
      await navigator.clipboard.writeText(reportText)
      copyMessage = 'Report copied'
    } catch {
      reportArea?.focus()
      reportArea?.select()
      copyMessage = 'Select and copy the report text'
    }
  }
</script>

<svelte:head><title>Diagnostics — Kufang Capture</title></svelte:head>
<section class="page diagnostics-page">
  <div class="page-heading">
    <div>
      <h1>Diagnostics</h1>
      <p class="summary-copy">Camera and storage details stay on this device.</p>
    </div>
  </div>
  <div class="diagnostic-card">
    <h2>Camera capabilities</h2>
    <p>
      Start a test to request camera access, inspect browser-reported controls, and capture one sample frame.
    </p>
    <Button variant="primary" disabled={busy} onclick={startTest}
      >{busy ? 'Testing camera…' : 'Start camera test'}</Button
    >
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if report}
      <div class="report-actions">
        <strong>Test complete</strong><Button variant="quiet" onclick={copyReport}>Copy report</Button>
      </div>
      {#if copyMessage}<p role="status">{copyMessage}</p>{/if}
      <ul class="diagnostic-summary">
        {#each summaryItems as item}<li>{item}</li>{/each}
      </ul>
      <label class="report-label"
        >Camera report <textarea bind:this={reportArea} readonly rows="18" value={reportText}
        ></textarea></label
      >
    {/if}
  </div>
  <div class="diagnostic-card">
    <h2>Test data</h2>
    <p>Generate a clearly labelled Local Only collection with 300 entries and small sample photos.</p>
    <Button variant="quiet" disabled={sampleBusy} onclick={generateTestData}
      >{sampleBusy ? 'Generating…' : 'Generate 300 sample entries'}</Button
    >
    {#if sampleMessage}<p role="status">{sampleMessage}</p>{/if}
    {#if sampleError}<p class="error" role="alert">{sampleError}</p>{/if}
  </div>
</section>

<style>
  .diagnostics-page {
    max-width: 860px;
  }
  .diagnostic-card {
    margin-bottom: var(--space-5);
    padding: var(--space-5);
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
  }
  .diagnostic-card h2 {
    margin-bottom: var(--space-3);
  }
  .diagnostic-card p {
    color: var(--color-muted);
  }
  .error {
    color: var(--color-danger) !important;
  }
  .report-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: var(--space-5);
  }
  .diagnostic-summary {
    margin: var(--space-4) 0;
    padding-left: var(--space-6);
  }
  .diagnostic-summary li {
    margin-block: var(--space-2);
  }
  .report-label {
    display: grid;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .report-label textarea {
    width: 100%;
    font:
      var(--text-sm) ui-monospace,
      monospace;
    line-height: 1.45;
    padding: var(--space-4);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-floor);
    color: var(--color-ink);
    resize: vertical;
  }
</style>
