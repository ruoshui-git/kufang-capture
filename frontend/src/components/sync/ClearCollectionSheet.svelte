<script lang="ts">
  import type { CollectionSummary } from '$lib/types'
  import type { ClearCheck } from '$lib/repo'
  import { repo } from '$lib/db'
  import { exportFromDevice } from '$lib/export/device'
  import { showToast } from '../../app/toasts.svelte'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  let { item, open = $bindable(false) }: { item: CollectionSummary; open?: boolean } = $props()
  let check = $state<ClearCheck | null>(null)
  let name = $state('')
  let busy = $state(false)
  let error = $state('')
  $effect(() => {
    if (open) {
      name = ''
      error = ''
      void refresh()
    }
  })
  async function refresh() {
    check = await repo.checkClearCollection(item.collection.id)
  }
  async function clear() {
    if (!check?.allowed || name !== item.collection.name) return
    busy = true
    error = ''
    try {
      await repo.clearCollection(item.collection.id, name)
      open = false
      showToast({ message: 'Collection cleared from this device' })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not clear collection.'
      await refresh()
    } finally {
      busy = false
    }
  }
  async function exportNow() {
    try {
      const result = await exportFromDevice([item.collection.id])
      if (result.delivery !== 'cancelled') {
        showToast({ message: `Exported ${result.filename}` })
        await refresh()
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Export failed.'
    }
  }
</script>

<Sheet bind:open title="Clear from this device">
  {#snippet children()}
    <p>
      <strong>Archive instead keeps everything.</strong> Clearing permanently removes this collection and its photos
      from this device.
    </p>
    <p>Unsynced photos will be lost. Export a verified ZIP before clearing.</p>
    {#if check}
      {#if !check.allowed}<p>This collection is blocked from clearing:</p>
        <ul>
          {#each check.reasons as reason}<li>{reason}</li>{/each}
        </ul>{/if}
      <Button variant="quiet" onclick={() => void exportNow()}>Export ZIP now</Button>
      <label class="confirm"
        ><span>Type <strong>{item.collection.name}</strong> to confirm</span><input
          aria-label="Type collection name"
          bind:value={name}
          autocomplete="off"
        /></label
      >
      <Button
        variant="danger"
        disabled={!check.allowed || name !== item.collection.name || busy}
        onclick={() => void clear()}>{busy ? 'Clearing…' : 'Clear collection'}</Button
      >
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
  .confirm {
    display: grid;
    gap: 6px;
    margin: 18px 0;
  }
  .confirm input {
    min-height: 44px;
    padding: 8px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-card);
    color: var(--color-ink);
  }
  ul {
    padding-left: 22px;
    color: var(--color-danger);
  }
</style>
