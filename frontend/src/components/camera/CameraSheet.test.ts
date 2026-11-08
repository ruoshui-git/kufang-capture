import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { addPhotos, openCamera, stopCamera, captureFrame } = vi.hoisted(() => ({
  addPhotos: vi.fn(),
  openCamera: vi.fn(),
  stopCamera: vi.fn(),
  captureFrame: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo: { addPhotos } }))
vi.mock('$lib/camera/stream', () => ({
  backCameraDevices: (devices: MediaDeviceInfo[]) =>
    devices.filter((device) => /back|rear/i.test(device.label)),
  cameraPermissionMessage: (error: unknown) => String(error),
  openCamera,
  readCapabilities: (track: MediaStreamTrack) => track.getCapabilities(),
  setTrackConstraint: vi.fn(),
  stopCamera,
  captureFrame,
}))
import CameraSheet from './CameraSheet.svelte'

let track: MediaStreamTrack
let stream: MediaStream

function setup(capabilities: MediaTrackCapabilities = {}) {
  track = {
    stop: vi.fn(),
    getSettings: () => ({ deviceId: 'back-one', width: 1920, height: 1080 }),
    getCapabilities: () => capabilities,
    applyConstraints: vi.fn(),
  } as unknown as MediaStreamTrack
  stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  openCamera.mockResolvedValue(stream)
  captureFrame.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }))
  addPhotos.mockReturnValue(new Promise(() => undefined))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, value: 2 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, value: 1920 })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: vi.fn().mockResolvedValue([]) },
  })
})
afterEach(() => cleanup())

describe('fast camera controls', () => {
  it('offers only the controls exposed by the current track', async () => {
    setup({
      zoom: { min: 1, max: 4, step: 0.1 },
      torch: true,
      focusMode: ['manual', 'continuous'],
    } as MediaTrackCapabilities)
    render(CameraSheet, { props: { open: true, entryId: 'entry' } })
    expect(await screen.findByLabelText('Zoom')).toBeInTheDocument()
    expect(screen.getByLabelText('Focus mode')).toBeInTheDocument()
    expect(screen.getByLabelText('Torch')).toBeInTheDocument()
    expect(screen.queryByLabelText('Focus distance')).not.toBeInTheDocument()
  })

  it('shows exact lens labels only when multiple back cameras are exposed', async () => {
    setup()
    const devices = [
      { kind: 'videoinput', label: 'Back Wide Camera', deviceId: 'wide' },
      { kind: 'videoinput', label: 'Back Ultra Wide Camera', deviceId: 'ultra' },
      { kind: 'videoinput', label: 'Front Camera', deviceId: 'front' },
    ]
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue(devices as MediaDeviceInfo[])
    const { unmount } = render(CameraSheet, { props: { open: true, entryId: 'entry' } })
    expect(await screen.findByText('Back Ultra Wide Camera')).toBeInTheDocument()
    expect(screen.getByText('Back Wide Camera')).toBeInTheDocument()
    expect(screen.queryByText('Front Camera')).not.toBeInTheDocument()
    unmount()

    vi.clearAllMocks()
    setup()
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([devices[0] as MediaDeviceInfo])
    render(CameraSheet, { props: { open: true, entryId: 'entry' } })
    await waitFor(() => expect(openCamera).toHaveBeenCalledOnce())
    expect(screen.queryByLabelText('Lens')).not.toBeInTheDocument()
  })

  it('labels a pinch as digital crop when hardware zoom is unavailable', async () => {
    setup({ torch: true } as MediaTrackCapabilities)
    render(CameraSheet, { props: { open: true, entryId: 'entry' } })
    const preview = await screen.findByLabelText('Camera preview')
    const wrapper = preview.parentElement!
    await fireEvent.touchStart(wrapper, {
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
    })
    await fireEvent.touchMove(wrapper, {
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 20, clientY: 0 },
      ],
    })
    expect(screen.getByText('Digital crop 2.0×')).toBeInTheDocument()
    expect(screen.queryByText('Zoom')).not.toBeInTheDocument()
  })

  it('queues two shutter writes without waiting for the first repository promise', async () => {
    setup()
    render(CameraSheet, { props: { open: true, entryId: 'entry' } })
    const shutter = await screen.findByRole('button', { name: 'Take photo' })
    await waitFor(() => expect(openCamera).toHaveBeenCalledOnce())
    await fireEvent.click(shutter)
    await fireEvent.click(shutter)
    await waitFor(() => expect(addPhotos).toHaveBeenCalledTimes(2))
    expect(addPhotos.mock.calls[0]?.[1][0].source).toBe('camera_frame')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(stopCamera).toHaveBeenCalled()
  })

  it('stops the stream when the page becomes hidden', async () => {
    setup()
    render(CameraSheet, { props: { open: true, entryId: 'entry' } })
    await waitFor(() => expect(openCamera).toHaveBeenCalledOnce())
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(stopCamera).toHaveBeenCalledWith(stream))
  })
})
