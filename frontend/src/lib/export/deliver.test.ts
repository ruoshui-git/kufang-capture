import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverExport } from './deliver'

function stubShare(share: () => Promise<void>, isActive?: boolean) {
  vi.stubGlobal('navigator', {
    ...navigator,
    canShare: () => true,
    share: vi.fn(share),
    userActivation: isActive === undefined ? undefined : { isActive },
  })
}

function stubObjectUrls() {
  const create = vi.fn(() => 'blob:test')
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { create, revoke }
}

describe('deliverExport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('shares the ZIP when the share sheet opens', async () => {
    stubShare(async () => {})
    expect(await deliverExport(new Blob(['zip']), 'a.zip')).toBe('shared')
  })

  it('reports a dismissed share sheet as cancelled', async () => {
    stubShare(async () => {
      throw new DOMException('dismissed', 'AbortError')
    })
    expect(await deliverExport(new Blob(['zip']), 'a.zip')).toBe('cancelled')
  })

  it('asks for a fresh tap when the share sheet refuses a stale gesture', async () => {
    stubShare(async () => {
      throw new DOMException('no user activation', 'NotAllowedError')
    })
    expect(await deliverExport(new Blob(['zip']), 'a.zip')).toBe('needs_tap')
  })

  it('downloads when NotAllowedError occurs during active user activation', async () => {
    stubShare(async () => {
      throw new DOMException('unsupported file type', 'NotAllowedError')
    }, true)
    const { create } = stubObjectUrls()
    expect(await deliverExport(new Blob(['zip']), 'a.zip')).toBe('download')
    expect(create).toHaveBeenCalledOnce()
  })

  it('downloads instead of asking for another tap after a fresh-tap refusal', async () => {
    stubShare(async () => {
      throw new DOMException('unsupported file type', 'NotAllowedError')
    })
    const { create } = stubObjectUrls()
    expect(await deliverExport(new Blob(['zip']), 'a.zip', { fromFreshTap: true })).toBe('download')
    expect(create).toHaveBeenCalledOnce()
  })

  it('attaches and removes the download link, then revokes its URL after the timer', async () => {
    vi.useFakeTimers()
    const anchor = document.createElement('a')
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => {})
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    const { create, revoke } = stubObjectUrls()
    const wasAttachedAtClick = vi.fn(() => document.body.contains(anchor))
    click.mockImplementation(wasAttachedAtClick)

    expect(await deliverExport(new Blob(['zip']), 'a.zip', { forceDownload: true })).toBe('download')
    expect(anchor.download).toBe('a.zip')
    expect(anchor.rel).toBe('noopener')
    expect(anchor.hidden).toBe(true)
    expect(wasAttachedAtClick).toHaveReturnedWith(true)
    expect(document.body.contains(anchor)).toBe(false)
    expect(create).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(revoke).toHaveBeenCalledWith('blob:test')
    createElement.mockRestore()
    click.mockRestore()
    vi.useRealTimers()
  })

  it('downloads when canShare returns false', async () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: () => false, share: vi.fn() })
    const { create } = stubObjectUrls()
    expect(await deliverExport(new Blob(['zip']), 'a.zip')).toBe('download')
    expect(create).toHaveBeenCalledOnce()
  })

  it('still surfaces other share failures', async () => {
    stubShare(async () => {
      throw new DOMException('bad data', 'DataError')
    })
    await expect(deliverExport(new Blob(['zip']), 'a.zip')).rejects.toThrow('bad data')
  })
})
