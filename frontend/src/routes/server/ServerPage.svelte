<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { onMount } from 'svelte'
  import type { ServerCollection } from '$lib/sync/api'
  import { accountAccess, accountGate, accountMismatch } from '$lib/sync/binding'
  import { deliverExport } from '$lib/export/deliver'
  import { navigate } from '../../app/router.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { accountAuthenticated, startAccountState } from '$lib/sync/account'

  let collections = $state<ServerCollection[]>([])
  // Live (unrevoked, unexpired) read-only link ids per server collection. This only reads and revokes
  // records the server already holds, so it also works for collections that are now Local Only.
  let shareLinks = $state<Record<string, string[]>>({})
  let stopping = $state('')
  let stopError = $state('')
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
      void loadShares(account)
    } catch (cause) {
      error =
        cause instanceof TypeError
          ? m.account_server_load_connection()
          : cause instanceof Error
            ? cause.message
            : m.account_server_load_failed()
    } finally {
      loading = false
    }
  }

  async function loadShares(account: string) {
    try {
      const { listServerShares } = await import('$lib/share/api')
      const grouped: Record<string, string[]> = {}
      for (const link of await listServerShares())
        if (!link.expired) (grouped[link.collection_id] ??= []).push(link.id)
      if (userId === account) shareLinks = grouped
    } catch {
      // Link counts are optional on this page; exports keep working without them.
    }
  }

  async function stopLinks(collectionId: string) {
    if (!userId || stopping) return
    const account = userId
    stopping = collectionId
    stopError = ''
    try {
      const { revokeShare } = await import('$lib/share/api')
      const results = await Promise.allSettled((shareLinks[collectionId] ?? []).map((id) => revokeShare(id)))
      if (results.some((result) => result.status === 'rejected')) stopError = collectionId
    } finally {
      await loadShares(account)
      stopping = ''
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
          ? m.account_server_download_connection()
          : cause instanceof Error
            ? cause.message
            : m.account_server_download_failed()
    } finally {
      downloading = false
    }
  }

  function bytes(value: number) {
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
    return `${(value / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

<svelte:head><title>{m.account_server_title()}</title></svelte:head>
<section class="page server-page">
  <div class="page-heading">
    <h1>{m.account_server_exports()}</h1>
    <a href="/settings">{m.account_settings()}</a>
  </div>
  {#if $accountAccess.kind === 'blocked'}
    <p class="error" role="alert">{accountMismatch($accountAccess.name)}</p>
  {:else if $accountAccess.kind === 'unavailable'}
    <p class="error" role="alert">{m.core_account_unavailable()}</p>
  {:else}
    <p>{m.account_server_exports_hint()}</p>
    <label class="toggle"
      ><input type="checkbox" bind:checked={includeTrash} /> {m.account_include_deleted()}</label
    >
    <Button
      disabled={!userId || loading || downloading || !!error || collections.length === 0}
      onclick={() => download('all')}>{m.account_download_everything()}</Button
    >
    {#if downloading}<p role="status">{m.account_downloading_zip()}</p>{/if}
    {#if downloadError}<p class="error" role="alert">{downloadError}</p>{/if}
    {#if !userId}<p>{m.account_checking_sign_in()}</p>{:else if loading}<p>
        {m.account_server_loading()}
      </p>{:else if error}<p class="error" role="alert">{error}</p>
      <Button variant="quiet" onclick={() => userId && void load(userId)}>{m.account_try_again()}</Button
      >{:else if collections.length === 0}<p>{m.account_server_empty()}</p>{:else}
      <div class="collection-list">
        {#each collections as item (item.id)}<article>
            <div>
              <h2>{item.name}</h2>
              <p>
                {m.account_server_collection_counts({
                  entries: m.account_entries({ count: item.entry_count }),
                  photos: m.account_photos({ count: item.photo_count }),
                  size: bytes(item.stored_photo_bytes),
                })}
              </p>
              {#if item.missing_originals}<p class="error">
                  {m.account_server_missing_originals({ count: item.missing_originals })}
                </p>{/if}
              {#if shareLinks[item.id]?.length}<p class="share-links">
                  {m.account_server_share_links({ count: shareLinks[item.id]!.length })}
                  <Button variant="quiet" disabled={!!stopping} onclick={() => stopLinks(item.id)}
                    >{m.account_server_stop_links()}</Button
                  >
                </p>{/if}
              {#if stopError === item.id}<p class="error" role="alert">
                  {m.account_server_stop_links_failed()}
                </p>{/if}
            </div>
            <Button variant="ink" disabled={downloading} onclick={() => download({ collectionId: item.id })}
              >{m.account_download_zip()}</Button
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
  .share-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-2) !important;
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
