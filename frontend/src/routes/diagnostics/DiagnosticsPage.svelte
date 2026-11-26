<script lang="ts">
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { m } from '$lib/paraglide/messages.js'
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
      sampleMessage =
        getLocale() === 'en'
          ? m.account_sample_created_named({ name: result.name, count: 300 })
          : m.account_sample_created({ count: 300 })
    } catch (cause) {
      sampleError = m.account_sample_failed()
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
          ? m.account_camera_zoom_range({ min: zoom.min, max: zoom.max })
          : m.account_no_hardware_zoom()
      const labels = cameras.map((device) => device.label || m.account_camera_label_missing())
      summaryItems = [
        m.account_camera_secure({ value: candidate.secure_context ? m.account_yes() : m.account_no() }),
        m.account_camera_installed({ value: candidate.standalone ? m.account_yes() : m.account_no() }),
        labels.length
          ? m.account_camera_found_with_labels({
              count: cameras.length,
              labels: labels.join(getLocale() === 'zh-CN' ? '、' : ', '),
            })
          : m.account_camera_found({ count: cameras.length }),
        m.account_lens_choice({ value: backCameras.length > 1 ? m.account_yes() : m.account_no() }),
        m.account_camera_hardware_zoom({ value: hardwareZoom }),
        m.account_camera_torch({ value: capabilities.torch === true ? m.account_yes() : m.account_no() }),
        m.account_camera_focus({
          value:
            Array.isArray(capabilities.focusMode) ||
            typeof capabilities.focusDistance === 'object' ||
            capabilities.pointsOfInterest === true
              ? m.account_yes()
              : m.account_no(),
        }),
        m.account_camera_resolution({
          value: actualResolution
            ? `${actualResolution.width} × ${actualResolution.height}`
            : m.account_not_reported(),
        }),
        m.account_camera_take_photo({ value: takePhotoAvailable ? m.account_yes() : m.account_no() }),
        m.account_camera_persisted({
          value:
            storage.persisted == null
              ? m.account_not_reported()
              : storage.persisted
                ? m.account_yes()
                : m.account_no(),
        }),
      ]
      // i18n-ignore: diagnostics report stays English
      reportText = `Kufang Capture camera diagnostics\n${new Date().toLocaleString('en')}\n\n${JSON.stringify(candidate, null, 2)}`
    } catch (cause) {
      error = m.account_camera_test_failed()
    } finally {
      stopCamera(stream)
      busy = false
    }
  }

  async function copyReport() {
    if (!reportText) return
    try {
      await navigator.clipboard.writeText(reportText)
      copyMessage = m.account_report_copied()
    } catch {
      reportArea?.focus()
      reportArea?.select()
      copyMessage = m.account_report_select_copy()
    }
  }
</script>

<svelte:head><title>{m.account_diagnostics_title()}</title></svelte:head>
<section class="page diagnostics-page">
  <div class="page-heading">
    <div>
      <h1>{m.account_diagnostics()}</h1>
      <p class="summary-copy">{m.account_diagnostics_privacy()}</p>
    </div>
  </div>
  <div class="diagnostic-card">
    <h2>{m.account_camera_capabilities()}</h2>
    <p>
      {m.account_camera_test_hint()}
    </p>
    <Button variant="primary" disabled={busy} onclick={startTest}
      >{busy ? m.account_camera_testing() : m.account_camera_test_start()}</Button
    >
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if report}
      <div class="report-actions">
        <strong>{m.account_camera_test_complete()}</strong><Button variant="quiet" onclick={copyReport}
          >{m.account_copy_report()}</Button
        >
      </div>
      {#if copyMessage}<p role="status">{copyMessage}</p>{/if}
      <ul class="diagnostic-summary">
        {#each summaryItems as item}<li>{item}</li>{/each}
      </ul>
      <label class="report-label"
        >{m.account_camera_report()}
        <textarea bind:this={reportArea} readonly rows="18" value={reportText}></textarea></label
      >
    {/if}
  </div>
  <div class="diagnostic-card">
    <h2>{m.account_sample_data()}</h2>
    <p>{m.account_sample_hint({ count: 300 })}</p>
    <Button variant="quiet" disabled={sampleBusy} onclick={generateTestData}
      >{sampleBusy ? m.account_sample_generating() : m.account_sample_generate_count({ count: 300 })}</Button
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
