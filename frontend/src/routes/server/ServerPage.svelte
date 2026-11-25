<script lang="ts">
  import { onMount } from 'svelte'
  import type { ServerCollection } from '$lib/sync/api'
  import { accountAccess, accountGate, accountMismatch, accountUnavailable } from '$lib/sync/binding'
  import { deliverExport } from '$lib/export/deliver'
  import { navigate } from '../../app/router.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { accountAuthenticated, startAccountState } from '$lib/sync/account'

  let collections = $state<ServerCollection[]>([])
  let includeTrash = $state(false)
  let loading = $state(true)
  let downloading = $state(false)
  let error = $state('')
  let downloadError = $state('')
  const userId = $derived($accountAccess.kind === 'ready' ? $accountAccess.user.id : null)

  onMount(startAccountState)

  $effect(() => {
    if (userId) void load(userId)
    else {
      collections = []
      if ($accountAccess.kind === 'signed_out' || $accountAuthenticated === false)
        navigate(`/login?return=${encodeURIComponent('/server')}`)
    }
  })

  async function load(account: string) {
    loading = true
    error = ''
    try {
      const { serverClient } = await import('$lib/sync')
      const listed = await serverClient.listCollections()
      if (userId === account) collections = listed
    } catch (cause) {
      error =
        cause instanceof TypeError
          ? 'Could not load server collections. Check your connection and try again.'
          : cause instanceof Error
            ? cause.message
            : 'Could not load server collections.'
    } finally {
      loading = false
    }
  }

  async function download(scope: { collectionId: string } | 'all') {
    if (!userId || downloading) return
    const account = userId
    downloading = true
    downloadError = ''
    try {
      const { serverClient } = await import('$lib/sync')
      const response = await serverClient.exportZip(scope, { includeTrash })
      const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
      const zip = await response.blob()
      if (accountGate.requireReady(await accountGate.check(fetch)).id === account)
        await deliverExport(zip, filename ?? 'capture-export.zip', { forceDownload: true })
    } catch (cause) {
      downloadError =
        cause instanceof TypeError
          ? "Couldn't download the ZIP. Check your connection and try again."
          : cause instanceof Error
            ? cause.message
            : 'Could not download the ZIP.'
    } finally {
      downloading = false
    }
  }

  function bytes(value: number) {
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
    return `${(value / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

<svelte:head><title>Server exports — Kufang Capture</title></svelte:head>
<section class="page server-page">
  <div class="page-heading">
    <h1>Server exports</h1>
    <a href="/settings">Settings</a>
  </div>
  {#if $accountAccess.kind === 'blocked'}
    <p class="error" role="alert">{accountMismatch($accountAccess.name)}</p>
  {:else if $accountAccess.kind === 'unavailable'}
    <p class="error" role="alert">{accountUnavailable}</p>
  {:else}
    <p>Only collections set to Sync to Server appear here. Local Only collections never leave this device.</p>
    <label class="toggle"
      ><input type="checkbox" bind:checked={includeTrash} /> Include Recently Deleted</label
    >
    <Button
      disabled={!userId || loading || downloading || !!error || collections.length === 0}
      onclick={() => download('all')}>Download everything</Button
    >
    {#if downloading}<p role="status">Downloading ZIP…</p>{/if}
    {#if downloadError}<p class="error" role="alert">{downloadError}</p>{/if}
    {#if !userId}<p>Checking sign-in…</p>{:else if loading}<p>
        Loading server collections…
      </p>{:else if error}<p class="error" role="alert">{error}</p>
      <Button variant="quiet" onclick={() => userId && void load(userId)}>Try again</Button
      >{:else if collections.length === 0}<p>No synced collections on the server.</p>{:else}
      <div class="collection-list">
        {#each collections as item (item.id)}<article>
            <div>
              <h2>{item.name}</h2>
              <p>{item.entry_count} entries, {item.photo_count} photos, {bytes(item.stored_photo_bytes)}</p>
              {#if item.missing_originals}<p class="error">
                  {item.missing_originals} original photos are missing from server storage.
                </p>{/if}
            </div>
            <Button variant="ink" disabled={downloading} onclick={() => download({ collectionId: item.id })}
              >Download ZIP</Button
            >
          </article>{/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .server-page {
    max-width: 920px;
  }
  .server-page > p {
    max-width: 680px;
    line-height: 1.5;
    color: var(--color-muted);
  }
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
  .collection-list {
    display: grid;
    gap: var(--space-3);
    margin-top: var(--space-5);
  }
  .collection-list article {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    padding: var(--space-5);
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
  }
  .collection-list h2 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xl);
  }
  .collection-list p {
    margin: 0;
    color: var(--color-muted);
  }
  .error {
    color: var(--color-danger) !important;
  }
  @media (max-width: 560px) {
    .collection-list article {
      align-items: flex-start;
      flex-direction: column;
      width: 100%;
    }
  }
</style>
