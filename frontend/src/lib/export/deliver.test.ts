import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverExport } from './deliver'

function stubShare(share: () => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: vi.fn(share) })
}

describe('deliverExport', () => {
  afterEach(() => vi.unstubAllGlobals())

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

  it('still surfaces other share failures', async () => {
    stubShare(async () => {
      throw new DOMException('bad data', 'DataError')
    })
    await expect(deliverExport(new Blob(['zip']), 'a.zip')).rejects.toThrow('bad data')
  })
})
