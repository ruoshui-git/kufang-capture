<script lang="ts">
  import { exportFromDevice } from '$lib/export/device'
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
  async function exportZip() {
    if (busy) return
    busy = true
    error = ''
    message = 'Preparing ZIP…'
    try {
      const result = await exportFromDevice(scope, { includeTrash })
      if (result.delivery === 'cancelled') message = 'Export cancelled.'
      else {
        message = `Exported ${result.filename}`
        onexported?.(result.filename)
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not export this data.'
      message = ''
    } finally {
      busy = false
    }
  }
</script>

<Sheet bind:open {title}>
  {#snippet children()}
    <p>
      This export is built from this device and works offline. On iPhone, choose Save to Files in the share
      sheet.
    </p>
    <label class="toggle"
      ><input type="checkbox" bind:checked={includeTrash} /> Include Recently Deleted</label
    >
    <Button disabled={busy} onclick={() => void exportZip()}>{busy ? 'Building ZIP…' : 'Export ZIP'}</Button>
    {#if message}<p role="status">{message}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 16px 0;
  }
  .toggle input {
    width: 20px;
    height: 20px;
  }
</style>
