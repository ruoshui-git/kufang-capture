import { m } from '../paraglide/messages.js'
import { getLocale } from '../paraglide/runtime.js'

class CameraOpenError extends Error {}
export type CameraCapabilities = MediaTrackCapabilities & {
  zoom?: number | { min: number; max: number; step?: number }
  torch?: boolean
  focusMode?: string[]
  focusDistance?: { min: number; max: number; step?: number }
  pointsOfInterest?: boolean
}

export function backCameraDevices(devices: MediaDeviceInfo[]) {
  return devices.filter(
    (device) =>
      device.kind === 'videoinput' &&
      !/front|user-facing/i.test(device.label) &&
      /back|rear|environment|ultra.?wide|telephoto/i.test(device.label),
  )
}

export function stopCamera(stream?: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

export async function openCamera(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraOpenError(m.core_camera_unsupported())
  const sizes = [
    { width: 4032, height: 3024 },
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 640, height: 480 },
  ]
  let lastError: unknown
  for (const size of sizes) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: deviceId ? undefined : { ideal: 'environment' },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: size.width },
          height: { ideal: size.height },
        },
      })
    } catch (error) {
      lastError = error
      if (error instanceof DOMException && ['NotAllowedError', 'NotFoundError'].includes(error.name))
        throw error
    }
  }
  throw lastError ?? new CameraOpenError(m.core_camera_open_failed())
}

export function readCapabilities(track: MediaStreamTrack): CameraCapabilities {
  return (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as CameraCapabilities
}

export async function setTrackConstraint(track: MediaStreamTrack, constraint: Record<string, unknown>) {
  await track.applyConstraints({ advanced: [constraint] } as MediaTrackConstraints)
}

export async function captureFrame(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  digitalCrop = 1,
): Promise<Blob> {
  const imageCaptureCtor = (
    globalThis as typeof globalThis & {
      ImageCapture?: new (track: MediaStreamTrack) => {
        takePhoto: () => Promise<Blob>
      }
    }
  ).ImageCapture

  if (imageCaptureCtor) {
    const still = await new imageCaptureCtor(track).takePhoto()
    if (digitalCrop <= 1) return still
    const bitmap = await createImageBitmap(still)
    try {
      const canvas = document.createElement('canvas')
      const width = Math.max(1, Math.round(bitmap.width / digitalCrop))
      const height = Math.max(1, Math.round(bitmap.height / digitalCrop))
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error(m.core_camera_crop_failed())
      context.drawImage(
        bitmap,
        (bitmap.width - width) / 2,
        (bitmap.height - height) / 2,
        width,
        height,
        0,
        0,
        width,
        height,
      )
      return await canvasBlob(canvas)
    } finally {
      bitmap.close()
    }
  }

  const settings = track.getSettings()
  const sourceWidth = settings.width || video.videoWidth
  const sourceHeight = settings.height || video.videoHeight
  if (!sourceWidth || !sourceHeight) throw new Error(m.core_camera_preview_unready())
  const cropWidth = Math.max(1, Math.round(sourceWidth / digitalCrop))
  const cropHeight = Math.max(1, Math.round(sourceHeight / digitalCrop))
  const canvas = document.createElement('canvas')
  canvas.width = cropWidth
  canvas.height = cropHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error(m.core_camera_frame_failed())
  context.drawImage(
    video,
    (video.videoWidth - cropWidth) / 2,
    (video.videoHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  )
  return canvasBlob(canvas)
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(m.core_camera_encode_failed()))),
      'image/jpeg',
      0.92,
    )
  })
}

export function cameraPermissionMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return m.core_camera_permission()
  if (error instanceof DOMException && error.name === 'NotFoundError') return m.core_camera_not_found()
  if (error instanceof CameraOpenError || (getLocale() === 'en' && error instanceof Error))
    return error.message
  return m.core_camera_start_failed()
}
