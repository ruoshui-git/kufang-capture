<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { CollectionSummary } from '$lib/types'
  import type { ClearCheck } from '$lib/repo'
  import { repo } from '$lib/db'
  import { exportFromDevice } from '$lib/export/device'
  import type { ExportDelivery } from '$lib/export/deliver'
  import { showToast } from '../../app/toasts.svelte'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  let { item, open = $bindable(false) }: { item: CollectionSummary; open?: boolean } = $props()
  let check = $state<ClearCheck | null>(null)
  let name = $state('')
  let busy = $state(false)
  let exporting = $state(false)
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
      showToast({ message: m.account_cleared() })
    } catch (cause) {
      error = m.account_clear_failed()
      await refresh()
    } finally {
      busy = false
    }
  }
  // The ZIP built by Export ZIP now, kept when the share sheet needs a fresh tap (large exports).
  let shareAgain = $state<{
    deliver: () => Promise<ExportDelivery>
    download: () => Promise<ExportDelivery>
    filename: string
  } | null>(null)
  async function delivered(delivery: ExportDelivery, filename: string) {
    shareAgain = null
    if (delivery === 'shared' || delivery === 'download') {
      showToast({ message: m.account_exported({ filename }) })
      await refresh()
    }
  }
  async function exportNow() {
    if (exporting) return
    exporting = true
    error = ''
    shareAgain = null
    try {
      const result = await exportFromDevice([item.collection.id])
      if (result.delivery === 'needs_tap' && result.deliverAgain && result.downloadAgain)
        shareAgain = {
          deliver: result.deliverAgain,
          download: result.downloadAgain,
          filename: result.filename,
        }
      else await delivered(result.delivery, result.filename)
    } catch (cause) {
      error =
        cause instanceof Error && cause.message
          ? m.account_clear_export_failed_reason({ reason: cause.message })
          : m.account_clear_export_failed()
    } finally {
      exporting = false
    }
  }
  async function shareNow() {
    const again = shareAgain
    if (exporting || !again) return
    exporting = true
    try {
      await delivered(await again.deliver(), again.filename)
    } catch (cause) {
      error =
        cause instanceof Error && cause.message
          ? m.account_clear_export_failed_reason({ reason: cause.message })
          : m.account_clear_export_failed()
    } finally {
      exporting = false
    }
  }
  async function downloadNow() {
    const again = shareAgain
    if (exporting || !again) return
    exporting = true
    try {
      await delivered(await again.download(), again.filename)
    } catch (cause) {
      error =
        cause instanceof Error && cause.message
          ? m.account_clear_export_failed_reason({ reason: cause.message })
          : m.account_clear_export_failed()
    } finally {
      exporting = false
    }
  }
</script>

<Sheet bind:open title={m.account_clear_device()}>
  {#snippet children()}
    <p>
      <strong>{m.account_archive_instead()}</strong>
      {m.account_clear_permanent()}
    </p>
    <p>{m.account_clear_verify_export()}</p>
    <p>{m.account_clear_zip_platforms()}</p>
    {#if check}
      {#if check.shared_items > 0}<p>
          {m.account_clear_shared_items({ count: check.shared_items })}
        </p>{/if}
      {#if !check.allowed}<p>{m.account_clear_blocked()}</p>
        <ul>
          {#each check.reasons as reason}<li>{reason}</li>{/each}
        </ul>{/if}
      {#if shareAgain}
        <p role="status">{m.account_zip_ready()}</p>
        <Button disabled={exporting} onclick={() => void shareNow()}>{m.account_share_zip()}</Button>
        <Button variant="quiet" disabled={exporting} onclick={() => void downloadNow()}
          >{m.account_download_zip()}</Button
        >
      {:else}
        <Button variant="quiet" disabled={exporting} onclick={() => void exportNow()}
          >{exporting ? m.account_building_zip() : m.account_export_zip_now()}</Button
        >
      {/if}
      {@const [beforeName, afterName] = m.account_confirm_clear_name({ name: '\0' }).split('\0')}
      <label class="confirm"
        ><span>{beforeName}<strong>{item.collection.name}</strong>{afterName}</span><input
          aria-label={m.account_type_collection_name()}
          bind:value={name}
          autocomplete="off"
        /></label
      >
      <Button
        variant="danger"
        disabled={!check.allowed || name !== item.collection.name || busy}
        onclick={() => void clear()}>{busy ? m.account_clearing() : m.account_clear_collection()}</Button
      >
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
  .confirm {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-5) 0;
  }
  .confirm input {
    min-height: 44px;
    padding: var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
  }
  ul {
    padding-left: var(--space-6);
    color: var(--color-danger);
  }
</style>
