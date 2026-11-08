<script lang="ts">
  import { repo } from '$lib/db'
  import { openCamera, readCapabilities, stopCamera } from '$lib/camera/stream'
  import Button from '../../components/ui/Button.svelte'

  type Report = Record<string, unknown>
  let busy = $state(false)
  let error = $state('')
  let report = $state<Report | null>(null)
  let reportText = $state('')
  let copyMessage = $state('')
  let reportArea = $state<HTMLTextAreaElement>()

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
        photo_capabilities: photoCapabilities,
        test_frame: frame,
        file_input_capture_note:
          'The capture attribute is present on image file input. Browser support does not guarantee which native picker or camera UI will open.',
        storage,
      }
      report = candidate
      reportText = `Kufang Capture camera diagnostics\n${new Date().toLocaleString()}\n\n${JSON.stringify(candidate, null, 2)}`
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Camera test failed.'
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

<svelte:head><title>Diagnostics · Kufang Capture</title></svelte:head>
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
      <label class="report-label"
        >Camera report <textarea bind:this={reportArea} readonly rows="18" value={reportText}
        ></textarea></label
      >
    {/if}
  </div>
</section>

<style>
  .diagnostics-page {
    max-width: 860px;
  }
  .diagnostic-card {
    padding: 20px;
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: 8px;
  }
  .diagnostic-card h2 {
    margin-bottom: 8px;
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
    margin-top: 20px;
  }
  .report-label {
    display: grid;
    gap: 8px;
    margin-top: 12px;
  }
  .report-label textarea {
    width: 100%;
    font:
      13px ui-monospace,
      monospace;
    line-height: 1.45;
    padding: 12px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-floor);
    color: var(--color-ink);
    resize: vertical;
  }
</style>
