import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickPhotos } from './index'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('system photo picker', () => {
  it('returns the original File object and configures the camera input synchronously', async () => {
    const file = new File(['original bytes'], 'label.jpg', {
      type: 'image/jpeg',
      lastModified: 1_800_000_000_000,
    })
    let input!: HTMLInputElement
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      input = this
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.dispatchEvent(new Event('change'))
    })

    const result = await pickPhotos('camera')

    expect(click).toHaveBeenCalledOnce()
    expect(input.getAttribute('capture')).toBe('environment')
    expect(result[0]?.blob).toBe(file)
    expect(result[0]?.filename).toBe('label.jpg')
    expect(result[0]?.source).toBe('native_camera')
    expect(await result[0]!.blob.text()).toBe('original bytes')
    expect(input.value).toBe('')
  })

  it('allows multiple library files and resolves an explicit cancel as an empty list', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      expect(this.multiple).toBe(true)
      expect(this.hasAttribute('capture')).toBe(false)
      this.dispatchEvent(new Event('cancel'))
    })
    await expect(pickPhotos('library')).resolves.toEqual([])
    expect(click).toHaveBeenCalledOnce()
  })

  it('keeps waiting for a slow change after focus returns, and a new pick supersedes an unreported cancel', async () => {
    vi.useFakeTimers()
    const file = new File(['slow camera bytes'], 'slow.jpg', { type: 'image/jpeg' })
    let input!: HTMLInputElement
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      input = this
    })
    const first = pickPhotos('camera')
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(5000)
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change'))
    const photos = await first
    expect(photos[0]?.blob).toBe(file)

    const abandoned = pickPhotos('library')
    const next = pickPhotos('library')
    await expect(abandoned).resolves.toEqual([])
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change'))
    expect((await next).map((p) => p.blob)).toEqual([file])
    vi.useRealTimers()
  })
})
