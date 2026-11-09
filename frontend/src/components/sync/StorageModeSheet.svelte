<script lang="ts">
  import { onMount } from 'svelte'
  import type { CollectionSummary } from '$lib/types'
  import { repo } from '$lib/db'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  import { navigate } from '../../app/router.svelte'
  let {
    item,
    open = $bindable(false),
    onchanged,
  }: { item: CollectionSummary; open?: boolean; onchanged?: () => void } = $props()
  let consent = $state(false)
  let signedIn = $state(false)
  let confirming = $state('')
  let busy = $state(false)
  let error = $state('')
  let uploadEntryCount = $state(0)
  let uploadPhotoCount = $state(0)
  let uploadBytes = $state(0)
  let blockers = $state<import('$lib/repo').SharedModeBlocker[]>([])
  let checking = $state(false)
  onMount(() => {
    void repo
      .readForExport([item.collection.id])
      .then((data) => {
        uploadEntryCount = data.entries.length
        uploadPhotoCount = data.photos.length
        uploadBytes = data.photos.reduce((sum, photo) => sum + photo.byte_size, 0)
      })
      .catch(() => {})
    void import('$lib/sync')
      .then(({ authClient }) => authClient.session())
      .then((session) => (signedIn = session.authenticated))
      .catch(() => (signedIn = false))
  })
  const mb = $derived((uploadBytes / (1024 * 1024)).toFixed(1))
  $effect(() => {
    if (!open) return
    const mode = item.collection.storage_mode === 'local_only' ? 'synced' : 'local_only'
    checking = true
    error = ''
    blockers = []
    void repo
      .checkStorageMode(item.collection.id, mode)
      .then((check) => (blockers = check.blockers))
      .catch((cause) => (error = cause instanceof Error ? cause.message : String(cause)))
      .finally(() => (checking = false))
  })
  function blockerMessage(blocker: import('$lib/repo').SharedModeBlocker) {
    const modeName = blocker.storage_mode === 'local_only' ? 'Local Only' : 'Synced'
    const noun = blocker.shared_items === 1 ? 'item is' : 'items are'
    return `${blocker.shared_items} ${noun} shared with ${modeName} collection '${blocker.collection_name}'. Remove them from one side, or switch both.`
  }
  async function enableSync() {
    if (!signedIn) {
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
    busy = true
    error = ''
    try {
      await repo.setStorageMode(item.collection.id, 'local_only', { consentToUploadExisting: false })
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
      error = 'Could not remove the server copy. Check your connection and try again.'
    } finally {
      busy = false
    }
  }
</script>

<Sheet bind:open title="Change storage mode">
  {#snippet children()}
    {#if item.collection.storage_mode === 'local_only'}
      {#if !signedIn}<p>Sign in first. This collection can stay Local Only while you sign in.</p>
        <Button onclick={() => navigate(`/login?return=${encodeURIComponent(location.pathname)}`)}
          >Sign in</Button
        >{:else}
        <p>
          Upload this collection's {uploadEntryCount} entries and {uploadPhotoCount} photos ({mb} MB) to capture.kufang.org?
        </p>
        {#if checking}<p>Checking shared items…</p>{/if}
        {#each blockers as blocker}<p class="blocker">{blockerMessage(blocker)}</p>{/each}
        <label class="consent"
          ><input type="checkbox" bind:checked={consent} /> I understand this uploads existing collection data and
          photos to the server.</label
        >
        <Button
          disabled={!consent || busy || checking || blockers.length > 0}
          onclick={() => void enableSync()}>{busy ? 'Saving…' : 'Sync to Server'}</Button
        >
      {/if}
    {:else}
      <p>Future changes stay on this device. The server copy remains until you remove it.</p>
      {#if checking}<p>Checking shared items…</p>{/if}
      {#each blockers as blocker}<p class="blocker">{blockerMessage(blocker)}</p>{/each}
      <Button
        variant="quiet"
        disabled={busy || checking || blockers.length > 0}
        onclick={() => void disableSync()}>Switch to Local Only</Button
      >
      <hr />
      <p>Remove the server copy and its uploaded files permanently. Type the collection name to confirm.</p>
      <input aria-label="Type collection name" bind:value={confirming} placeholder={item.collection.name} />
      <Button
        variant="danger"
        disabled={busy || confirming !== item.collection.name}
        onclick={() => void removeCopy()}>Remove server copy</Button
      >
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/snippet}
</Sheet>

<style>
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
