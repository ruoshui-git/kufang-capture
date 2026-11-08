import type { IncomingPhoto } from '../repo'

/** 'native' = iOS system camera via file input; 'fast' = in-app getUserMedia sheet. */
export type CaptureMode = 'native' | 'fast'

let picker: HTMLInputElement | undefined
/** Settles the previous, still-pending pick (e.g. a browser without the cancel event). */
let settlePending: ((photos: IncomingPhoto[]) => void) | undefined

function getPicker() {
  if (picker?.isConnected) return picker
  picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = 'image/*'
  picker.hidden = true
  picker.tabIndex = -1
  picker.setAttribute('aria-hidden', 'true')
  document.body.append(picker)
  return picker
}

/** Open the system camera or library synchronously from the initiating gesture. */
export function pickPhotos(kind: 'camera' | 'library'): Promise<IncomingPhoto[]> {
  // A new pick supersedes an old one whose cancel was never reported, so its
  // listeners cannot also receive this pick's files.
  settlePending?.([])
  const input = getPicker()
  input.value = ''
  input.multiple = kind === 'library'
  if (kind === 'camera') input.setAttribute('capture', 'environment')
  else input.removeAttribute('capture')

  return new Promise((resolve) => {
    let settled = false
    const finish = (photos: IncomingPhoto[]) => {
      if (settled) return
      settled = true
      if (settlePending === finish) settlePending = undefined
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      input.value = ''
      resolve(photos)
    }
    const onChange = () => {
      const files = Array.from(input.files ?? [])
      finish(
        files.map((file) => ({
          blob: file,
          filename: file.name,
          source: kind === 'camera' ? 'native_camera' : 'photo_library',
          captured_at: new Date(
            kind === 'camera' ||
              !Number.isFinite(file.lastModified) ||
              file.lastModified < Date.UTC(1980, 0, 1) ||
              file.lastModified > Date.now() + 24 * 60 * 60 * 1000
              ? Date.now()
              : file.lastModified,
          ).toISOString(),
        })),
      )
    }
    const onCancel = () => finish([])
    // No focus-based timeout: on iOS, 'change' can arrive well after the page
    // regains focus while the camera image is processed; a timeout would drop it.
    settlePending = finish
    input.addEventListener('change', onChange, { once: true })
    input.addEventListener('cancel', onCancel, { once: true })
    // Must remain in this stack for iOS to recognize the user gesture.
    input.click()
  })
}
