<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { exportFromDevice, type DeviceExportResult } from '$lib/export/device'
  import type { ExportDelivery } from '$lib/export/deliver'
  import type { Id } from '$lib/types'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  let {
    open = $bindable(false),
    scope,
    title = m.account_export_zip(),
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
  const collectionCount = $derived(Array.isArray(scope) ? scope.length : 0)
  function finish(result: DeviceExportResult, delivery: ExportDelivery) {
    if (delivery === 'cancelled') {
      message = m.account_export_cancelled()
      ready = null
    } else if (delivery === 'needs_tap') {
      message = m.account_zip_ready_size({
        size: m.account_size_megabytes({ amount: (result.byteSize / (1024 * 1024)).toFixed(1) }),
      })
      ready = result
    } else {
      message = m.account_exported({ filename: result.filename })
      ready = null
      onexported?.(result.filename)
    }
  }
  function failed(cause: unknown) {
    const reason = cause instanceof Error && cause.message ? cause.message : ''
    error = reason ? m.account_export_failed_reason({ reason }) : m.account_export_failed()
    message = ''
  }
  async function exportZip() {
    if (busy) return
    busy = true
    error = ''
    ready = null
    message = m.account_preparing_zip()
    try {
      const result = await exportFromDevice(scope, {
        includeTrash,
        onProgress: (done, total) => (message = m.account_preparing_zip_progress({ done, total })),
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
  async function downloadReady() {
    const result = ready
    if (busy || !result?.downloadAgain) return
    busy = true
    error = ''
    try {
      finish(result, await result.downloadAgain())
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
      {collectionCount > 1
        ? m.account_export_hint_multiple({ count: collectionCount })
        : m.account_export_hint()}
    </p>
    <label class="toggle"
      ><input type="checkbox" bind:checked={includeTrash} onchange={() => (ready = null)} />
      {m.account_include_deleted()}</label
    >
    {#if ready}
      <Button disabled={busy} onclick={() => void shareReady()}>{m.account_share_zip()}</Button>
      <Button variant="quiet" disabled={busy} onclick={() => void downloadReady()}
        >{m.account_download_zip()}</Button
      >
    {:else}
      <Button disabled={busy} onclick={() => void exportZip()}
        >{busy ? m.account_building_zip() : m.account_export_zip()}</Button
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
