<script lang="ts">
  import type { Snippet } from 'svelte'
  import { router } from './router.svelte'
  import { repo } from '$lib/db'
  import { onMount } from 'svelte'
  import ToastHost from '../components/ui/ToastHost.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import type { CollectionSummary } from '$lib/types'
  import { authClient, syncEngine } from '$lib/sync'
  import type { SyncStatus } from '$lib/sync/api'
  import SyncNowButton from '../components/sync/SyncNowButton.svelte'
  let { children, header, bottomBar }: { children: Snippet; header?: Snippet; bottomBar?: Snippet } = $props()
  let collections = $state<CollectionSummary[]>([])
  let signedIn = $state(false)
  let syncStatus = $state<SyncStatus | null>(null)
  const pending = $derived((syncStatus?.pending_uploads ?? 0) + (syncStatus?.pending_mutations ?? 0))
  // Only actionable sync states get a bar; Local Only work needs no banner.
  const syncMessage = $derived.by(() => {
    if (!syncStatus || pending === 0) return ''
    if (!signedIn) return 'Sign in to sync your Sync to Server collections'
    if (syncStatus.phase === 'error') return syncStatus.last_error ?? 'Sync error'
    if (syncStatus.pending_uploads)
      return `${syncStatus.pending_uploads} ${syncStatus.pending_uploads === 1 ? 'photo' : 'photos'} pending (${(syncStatus.pending_upload_bytes / 1048576).toFixed(1)} MB)`
    return syncStatus.phase === 'syncing' ? 'Syncing' : 'Changes waiting to sync'
  })
  const syncTone = $derived(syncStatus?.phase === 'error' && pending > 0 ? 'danger' : 'info')
  onMount(() => {
    const subscription = repo
      .watchCollectionSummaries({ includeArchived: false })
      .subscribe((items) => (collections = items))
    const statusSub = syncEngine.status.subscribe((value) => (syncStatus = value))
    void authClient
      .session()
      .then((value) => (signedIn = value.authenticated))
      .catch(() => (signedIn = false))
    return () => {
      typeof subscription === 'function' ? subscription() : subscription.unsubscribe()
      typeof statusSub === 'function' ? statusSub() : statusSub.unsubscribe()
    }
  })
</script>

<div class="app-layout">
  {#if router.isDesktop}
    <aside class="rail" aria-label="Collections">
      <a class="rail-title" href="/">Collections</a>
      {#each collections as item (item.collection.id)}
        <a class="rail-row" href="/c/{item.collection.id}"
          ><span class="rail-row-copy"
            ><span>{item.collection.name}</span><Badge mode={item.collection.storage_mode} /></span
          ><span>{item.entry_count}</span></a
        >
      {/each}
      <a class="rail-new" href="/?new=1">+ New collection</a>
      <nav class="rail-account" aria-label="Account">
        {#if signedIn}<a href="/server">Server exports</a>{:else}<a href="/login?return=%2Fserver">Sign in</a
          >{/if}
        <a href="/settings">Settings</a>
      </nav>
    </aside>
  {/if}
  <div class="app-main">
    {#if header}<header class="app-header">{@render header()}</header>{/if}
    {#if syncMessage}
      <div class="global-sync" class:danger={syncTone === 'danger'} role="status" aria-label="Sync status">
        <span class="global-sync-dot" aria-hidden="true"></span><span>{syncMessage}</span>
        {#if !signedIn}<a href="/login">Sign in</a>{:else}<SyncNowButton />{/if}
      </div>
    {/if}
    <main>{@render children()}</main>
    {#if bottomBar}<div class="bottom-action">{@render bottomBar()}</div>{/if}
  </div>
  <ToastHost />
</div>
