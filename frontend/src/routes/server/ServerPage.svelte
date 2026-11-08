<script lang="ts">
  import { onMount } from 'svelte'
  import { authClient, serverClient } from '$lib/sync'
  import type { ServerCollection } from '$lib/sync/api'
  import { navigate } from '../../app/router.svelte'
  import Button from '../../components/ui/Button.svelte'
  let collections = $state<ServerCollection[]>([])
  let includeTrash = $state(false)
  let loading = $state(true)
  let error = $state('')
  onMount(() => {
    void load()
  })
  async function load() {
    loading = true
    error = ''
    try {
      const session = await authClient.session()
      if (!session.authenticated) {
        navigate(`/login?return=${encodeURIComponent('/server')}`)
        return
      }
      collections = await serverClient.listCollections()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load server collections.'
    } finally {
      loading = false
    }
  }
  function url(scope: { collectionId: string } | 'all') {
    return serverClient.exportUrl(scope, { includeTrash })
  }
  function bytes(value: number) {
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
</script>

<svelte:head><title>Server exports · Kufang Capture</title></svelte:head>
<section class="page server-page">
  <div class="page-heading">
    <h1>Server exports</h1>
    <a href="/settings">Settings</a>
  </div>
  <p>Only collections set to Sync to Server appear here. Local Only collections never leave this device.</p>
  <label class="toggle"><input type="checkbox" bind:checked={includeTrash} /> Include Recently Deleted</label>
  <Button
    disabled={loading || !!error || collections.length === 0}
    onclick={() => window.location.assign(url('all'))}>Download everything</Button
  >
  {#if loading}<p>Loading server collections…</p>{:else if error}<p class="error" role="alert">{error}</p>
    <Button variant="quiet" onclick={() => void load()}>Try again</Button
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
          <a class="download" href={url({ collectionId: item.id })}>Download ZIP</a>
        </article>{/each}
    </div>
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
    gap: 10px;
    margin: 16px 0;
  }
  .toggle input {
    width: 20px;
    height: 20px;
  }
  .collection-list {
    display: grid;
    gap: 10px;
    margin-top: 20px;
  }
  .collection-list article {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: 8px;
  }
  .collection-list h2 {
    margin: 0 0 4px;
    font-size: 20px;
  }
  .collection-list p {
    margin: 0;
    color: var(--color-muted);
  }
  .download {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 14px;
    border-radius: 6px;
    background: var(--color-ink);
    color: var(--color-floor);
    text-decoration: none;
    white-space: nowrap;
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
