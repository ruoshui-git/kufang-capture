import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { exportFromDevice } = vi.hoisted(() => ({ exportFromDevice: vi.fn() }))
vi.mock('$lib/export/device', () => ({ exportFromDevice }))

import ExportSheet from './ExportSheet.svelte'

describe('ExportSheet', () => {
  beforeEach(() => {
    exportFromDevice.mockReset()
  })
  afterEach(cleanup)

  it('offers Share ZIP when the built ZIP needs a fresh tap, then shares it', async () => {
    const deliverAgain = vi.fn(async () => 'shared')
    const downloadAgain = vi.fn(async () => 'download')
    const onexported = vi.fn()
    exportFromDevice.mockImplementation(async (_scope, opts) => {
      opts.onProgress(25, 25)
      return {
        delivery: 'needs_tap',
        filename: 'a01.zip',
        byteSize: 3 * 1024 * 1024,
        deliverAgain,
        downloadAgain,
      }
    })
    render(ExportSheet, { props: { open: true, scope: ['a01'], onexported } })

    await fireEvent.click(screen.getByRole('button', { name: 'Export ZIP' }))

    expect(await screen.findByText('ZIP ready (3.0 MB). Tap Share ZIP to save it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share ZIP' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download ZIP' })).toBeInTheDocument()
    expect(screen.getByText(/On Android, the ZIP is saved to Downloads\./)).toBeInTheDocument()
    expect(onexported).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Share ZIP' }))
    await waitFor(() => expect(screen.getByText('Exported a01.zip')).toBeInTheDocument())
    expect(deliverAgain).toHaveBeenCalledOnce()
    expect(onexported).toHaveBeenCalledWith('a01.zip')
    expect(screen.getByRole('button', { name: 'Export ZIP' })).toBeInTheDocument()
  })

  it('shows photo progress while the ZIP is built', async () => {
    let finish: (value: unknown) => void = () => {}
    exportFromDevice.mockImplementation(async (_scope, opts) => {
      opts.onProgress(12, 25)
      return new Promise((resolve) => (finish = resolve))
    })
    render(ExportSheet, { props: { open: true, scope: ['a01'] } })
    await fireEvent.click(screen.getByRole('button', { name: 'Export ZIP' }))
    expect(await screen.findByText('Preparing ZIP… photo 12 of 25')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Building ZIP…' })).toBeDisabled()
    finish({ delivery: 'download', filename: 'a01.zip', byteSize: 1 })
    expect(await screen.findByText('Exported a01.zip')).toBeInTheDocument()
  })

  it('downloads a prepared ZIP and reports the exported filename', async () => {
    const downloadAgain = vi.fn(async () => 'download')
    exportFromDevice.mockResolvedValue({
      delivery: 'needs_tap',
      filename: 'a01.zip',
      byteSize: 3,
      deliverAgain: vi.fn(),
      downloadAgain,
    })
    render(ExportSheet, { props: { open: true, scope: ['a01'] } })
    await fireEvent.click(screen.getByRole('button', { name: 'Export ZIP' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Download ZIP' }))
    expect(downloadAgain).toHaveBeenCalledOnce()
    expect(await screen.findByText('Exported a01.zip')).toBeInTheDocument()
  })

  it('says why an export failed', async () => {
    exportFromDevice.mockRejectedValue(new Error('Original photo P1 is missing on this device.'))
    render(ExportSheet, { props: { open: true, scope: ['a01'] } })
    await fireEvent.click(screen.getByRole('button', { name: 'Export ZIP' }))
    expect(
      await screen.findByText('Could not export this data. Original photo P1 is missing on this device.'),
    ).toBeInTheDocument()
  })
})
