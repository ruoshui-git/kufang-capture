<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { onMount } from 'svelte'
  import type { CollectionSummary } from '$lib/types'
  import { repo } from '$lib/db'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  import { navigate } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import { revokeCollectionShares } from '$lib/share/api'
  import { accountAuthenticated, startAccountState } from '$lib/sync/account'
  let {
    item,
    open = $bindable(false),
    onchanged,
  }: { item: CollectionSummary; open?: boolean; onchanged?: () => void } = $props()
  let consent = $state(false)
  let confirming = $state('')
  let busy = $state(false)
  let error = $state('')
  let uploadEntryCount = $state(0)
  let uploadPhotoCount = $state(0)
  let uploadBytes = $state(0)
  let blockers = $state<import('$lib/repo').SharedModeBlocker[]>([])
  let checking = $state(false)
  onMount(() => {
    startAccountState()
    void repo
      .readForExport([item.collection.id])
      .then((data) => {
        uploadEntryCount = data.entries.length
        uploadPhotoCount = data.photos.length
        uploadBytes = data.photos.reduce((sum, photo) => sum + photo.byte_size, 0)
      })
      .catch(() => {})
  })
  const mb = $derived((uploadBytes / (1024 * 1024)).toFixed(1))
  // Primitives, so live summary updates (counts, sync status) do not re-run the check: a re-check
  // briefly disables the confirm button and would swallow a tap.
  const collectionId = $derived(item.collection.id)
  const targetMode = $derived(item.collection.storage_mode === 'local_only' ? 'synced' : 'local_only')
  $effect(() => {
    if (!open) return
    const id = collectionId
    const mode = targetMode
    checking = true
    error = ''
    blockers = []
    void repo
      .checkStorageMode(id, mode)
      .then((check) => (blockers = check.blockers))
      .catch((cause) => (error = cause instanceof Error ? cause.message : String(cause)))
      .finally(() => (checking = false))
  })
  function blockerMessage(blocker: import('$lib/repo').SharedModeBlocker) {
    const modeName = blocker.storage_mode === 'local_only' ? m.account_local_only() : m.account_synced()
    return m.account_storage_blocker({
      count: blocker.shared_items,
      mode: modeName,
      name: blocker.collection_name,
    })
  }
  async function enableSync() {
    if ($accountAuthenticated !== true) {
      navigate(`/login?return=${encodeURIComponent(location.pathname)}`)
      return
    }
    if (!consent) return
    busy = true
    error = ''
    try {
      await repo.setStorageMode(item.collection.id, 'synced', { consentToUploadExisting: true })
      open = false
      onchanged?.()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
  async function disableSync() {
    if (busy || item.collection.storage_mode !== 'synced') return
    const id = item.collection.id
    busy = true
    error = ''
    try {
      await revokeCollectionShares(id).catch(() => {
        showToast({ message: m.account_storage_share_revoke_failed(), persistent: true })
      })
      await repo.setStorageMode(id, 'local_only', { consentToUploadExisting: false })
      open = false
      onchanged?.()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
  async function removeCopy() {
    if (confirming !== item.collection.name) return
    busy = true
    error = ''
    try {
      const { serverClient } = await import('$lib/sync')
      await serverClient.removeServerCopy(item.collection.id, confirming)
      confirming = ''
      open = false
      onchanged?.()
    } catch (cause) {
      error = m.account_remove_server_failed()
    } finally {
      busy = false
    }
  }
</script>

<Sheet bind:open title={m.account_storage_mode_change()}>
  {#snippet children()}
    {#if item.collection.storage_mode === 'local_only'}
      {#if $accountAuthenticated === false}<p>
          {m.account_storage_sign_in()}
        </p>
        <Button onclick={() => navigate(`/login?return=${encodeURIComponent(location.pathname)}`)}
          >{m.account_sign_in()}</Button
        >{:else}
        {#if $accountAuthenticated === null}<p>{m.account_checking_account()}</p>{/if}
        <p class="upload-summary">
          {m.account_storage_upload_confirm({
            entries: m.account_entries({ count: uploadEntryCount }),
            photos: m.account_photos({ count: uploadPhotoCount }),
            size: m.account_size_megabytes({ amount: mb }),
            host: 'capture.kufang.org',
          })}
        </p>
        {#if checking}<p>{m.account_checking_shared()}</p>{/if}
        {#each blockers as blocker}<p class="blocker">{blockerMessage(blocker)}</p>{/each}
        <label class="consent"
          ><input type="checkbox" bind:checked={consent} /> {m.account_storage_consent()}</label
        >
        <Button
          disabled={$accountAuthenticated !== true || !consent || busy || checking || blockers.length > 0}
          onclick={() => void enableSync()}>{busy ? m.account_saving() : m.account_sync_to_server()}</Button
        >
      {/if}
    {:else}
      <p>{m.account_storage_local_future()}</p>
      <p>{m.account_storage_share_links_stop()}</p>
      {#if checking}<p>{m.account_checking_shared()}</p>{/if}
      {#each blockers as blocker}<p class="blocker">{blockerMessage(blocker)}</p>{/each}
      <Button
        variant="quiet"
        disabled={busy || checking || blockers.length > 0}
        onclick={() => void disableSync()}>{m.account_switch_local_only()}</Button
      >
      <hr />
      <p>{m.account_remove_server_confirm()}</p>
      <input
        aria-label={m.account_type_collection_name()}
        bind:value={confirming}
        placeholder={item.collection.name}
      />
      <Button
        variant="danger"
        disabled={busy || confirming !== item.collection.name}
        onclick={() => void removeCopy()}>{m.account_remove_server_copy()}</Button
      >
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
  .upload-summary:lang(zh-CN) {
    text-wrap: balance;
  }
  .consent {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    margin: var(--space-5) 0;
  }
  .blocker {
    color: var(--color-danger);
  }
  .consent input {
    width: 20px;
    height: 20px;
    flex: none;
  }
  input:not([type='checkbox']) {
    width: 100%;
    min-height: 44px;
    margin: var(--space-3) 0;
    padding: var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--color-line);
    margin: var(--space-5) 0;
  }
</style>
