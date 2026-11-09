<script lang="ts">
  import { exportFromDevice, type DeviceExportResult } from '$lib/export/device'
  import type { ExportDelivery } from '$lib/export/deliver'
  import type { Id } from '$lib/types'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  let {
    open = $bindable(false),
    scope,
    title = 'Export ZIP',
    onexported,
  }: {
    open?: boolean
    scope: Id[] | 'all'
    title?: string
    onexported?: (filename: string) => void
  } = $props()
  let includeTrash = $state(false)
  let busy = $state(false)
  let message = $state('')
  let error = $state('')
  // Set when the ZIP is built but the share sheet needs a fresh tap (see ExportDelivery 'needs_tap').
  let ready = $state<DeviceExportResult | null>(null)
  const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  function finish(result: DeviceExportResult, delivery: ExportDelivery) {
    if (delivery === 'cancelled') {
      message = 'Export cancelled.'
      ready = null
    } else if (delivery === 'needs_tap') {
      message = `ZIP ready (${megabytes(result.byteSize)}). Tap Share ZIP to save it.`
      ready = result
    } else {
      message = `Exported ${result.filename}`
      ready = null
      onexported?.(result.filename)
    }
  }
  function failed(cause: unknown) {
    const reason = cause instanceof Error && cause.message ? ` ${cause.message}` : ''
    error = `Could not export this data.${reason}`
    message = ''
  }
  async function exportZip() {
    if (busy) return
    busy = true
    error = ''
    ready = null
    message = 'Preparing ZIP…'
    try {
      const result = await exportFromDevice(scope, {
        includeTrash,
        onProgress: (done, total) => (message = `Preparing ZIP… photo ${done} of ${total}`),
      })
      finish(result, result.delivery)
    } catch (cause) {
      failed(cause)
    } finally {
      busy = false
    }
  }
  async function shareReady() {
    const result = ready
    if (busy || !result?.deliverAgain) return
    busy = true
    error = ''
    try {
      finish(result, await result.deliverAgain())
    } catch (cause) {
      failed(cause)
    } finally {
      busy = false
    }
  }
  $effect(() => {
    // A closed sheet drops a prepared ZIP so the next export reflects current data.
    if (!open) ready = null
  })
</script>

<Sheet bind:open {title}>
  {#snippet children()}
    <p>
      This export is built from this device and works offline. On iPhone, choose Save to Files in the share
      sheet.
    </p>
    <label class="toggle"
      ><input type="checkbox" bind:checked={includeTrash} onchange={() => (ready = null)} /> Include Recently Deleted</label
    >
    {#if ready}
      <Button disabled={busy} onclick={() => void shareReady()}>Share ZIP</Button>
    {:else}
      <Button disabled={busy} onclick={() => void exportZip()}>{busy ? 'Building ZIP…' : 'Export ZIP'}</Button
      >
    {/if}
    {#if message}<p role="status">{message}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-5) 0;
  }
  .toggle input {
    width: 20px;
    height: 20px;
  }
</style>
