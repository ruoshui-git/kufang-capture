<script lang="ts">
  import type { Snippet } from 'svelte'
  import { navigate, router } from './router.svelte'
  import { repo } from '$lib/db'
  import { onMount } from 'svelte'
  import ToastHost from '../components/ui/ToastHost.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import type { CollectionSummary } from '$lib/types'
  import type { SyncStatus } from '$lib/sync/api'
  import SyncNowButton from '../components/sync/SyncNowButton.svelte'
  import { accountAccess, accountMismatch, accountUnavailable } from '$lib/sync/binding'
  import { accountAuthenticated, startAccountState } from '$lib/sync/account'
  import StarredPage from '../routes/starred/StarredPage.svelte'
  import { collectionMatches } from '../routes/collections/collectionSearch'
  let { children, header, bottomBar }: { children: Snippet; header?: Snippet; bottomBar?: Snippet } = $props()
  let collections = $state<CollectionSummary[]>([])
  let search = $state('')
  let syncStatus = $state<SyncStatus | null>(null)
  let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine)
  const authPage = $derived(router.route.name === 'join' || router.route.name === 'login')
  const pending = $derived((syncStatus?.pending_uploads ?? 0) + (syncStatus?.pending_mutations ?? 0))
  const syncMessage = $derived.by(() => {
    if (authPage) return ''
    if ($accountAccess.kind === 'blocked')
      return router.route.name === 'settings' ? 'Sync blocked' : accountMismatch($accountAccess.name)
    if ($accountAccess.kind === 'unavailable') return accountUnavailable
    if (!syncStatus) return ''
    if (!online || syncStatus.phase === 'offline')
      return pending ? 'Saved on this device. Will sync when online.' : ''
    if (syncStatus.phase === 'error')
      return syncStatus.last_error
        ? `Sync error. ${syncStatus.last_error}`
        : 'Sync error. Check your connection, then retry.'
    if ($accountAuthenticated === false && syncStatus.phase === 'signed_out')
      return 'Sign in to sync your Sync to Server collections'
    if (pending === 0) return syncStatus.last_error ?? ''
    if ($accountAuthenticated === false) return 'Sign in to sync your Sync to Server collections'
    if (syncStatus.pending_uploads)
      return `${syncStatus.pending_uploads} ${syncStatus.pending_uploads === 1 ? 'photo' : 'photos'} pending (${(syncStatus.pending_upload_bytes / 1048576).toFixed(1)} MB)`
    return syncStatus.phase === 'syncing' ? 'Syncing' : 'Changes waiting to sync'
  })
  const syncTone = $derived(
    syncStatus?.phase === 'error' ||
      $accountAccess.kind === 'blocked' ||
      $accountAccess.kind === 'unavailable'
      ? 'danger'
      : 'info',
  )
  const filteredCollections = $derived(
    search.trim() ? collections.filter((item) => collectionMatches(item, search)) : collections,
  )
  const collectionGroups = $derived.by(() => {
    const folders = [
      ...new Set(filteredCollections.map((item) => (item.collection.folder ?? '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b))
    const groups = folders.map((folder) => ({
      folder,
      items: filteredCollections.filter((item) => (item.collection.folder ?? '').trim() === folder),
    }))
    const unfiled = filteredCollections.filter((item) => !(item.collection.folder ?? '').trim())
    if (unfiled.length) groups.push({ folder: '', items: unfiled })
    return groups
  })
  onMount(() => {
    startAccountState()
    const onOnline = () => (online = true)
    const onOffline = () => (online = false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    let stopStatus: (() => void) | undefined
    void import('$lib/sync')
      .then(({ syncEngine }) => {
        const statusSub = syncEngine.status.subscribe((value) => (syncStatus = value))
        stopStatus =
          typeof statusSub === 'function'
            ? statusSub
            : statusSub?.unsubscribe
              ? () => statusSub.unsubscribe()
              : undefined
      })
      .catch(() => {})
    return () => {
      stopStatus?.()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  })
  $effect(() => {
    if (!router.isDesktop) {
      collections = []
      return
    }
    const subscription = repo
      .watchCollectionSummaries({ includeArchived: false })
      .subscribe((items) => (collections = items))
    return () => (typeof subscription === 'function' ? subscription() : subscription.unsubscribe())
  })
</script>

<div class="app-layout">
  {#if router.isDesktop}
    <aside class="rail" aria-label="Collections">
      <a class="rail-title" href="/">Collections</a>
      <input
        class="rail-search"
        type="search"
        aria-label="Filter collections"
        placeholder="Filter collections"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="search"
        bind:value={search}
        onkeydown={(event) => {
          if (event.key === 'Escape' && search) {
            event.preventDefault()
            event.stopPropagation()
            search = ''
          }
          if (event.key === 'Enter' && filteredCollections.length === 1) {
            event.preventDefault()
            navigate(`/c/${filteredCollections[0]!.collection.id}`)
          }
        }}
      />
      <a href="/starred">★ Starred</a>
      {#if search.trim() && filteredCollections.length === 0}<div
          class="rail-empty"
          role="status"
          aria-live="polite"
        >
          No matches
        </div>{/if}
      {#each collectionGroups as group (group.folder)}
        {#if group.folder}<div class="rail-folder">{group.folder}</div>{/if}
        {#each group.items as item (item.collection.id)}
          <a class="rail-row" href="/c/{item.collection.id}"
            ><span class="rail-row-copy"
              ><span>{item.collection.name}</span><Badge mode={item.collection.storage_mode} /></span
            ><span>{item.entry_count}</span></a
          >
        {/each}
      {/each}
      <a class="rail-new" href="/?new=1">+ New collection</a>
      <nav class="rail-account" aria-label="Account">
        {#if !authPage && $accountAuthenticated === true && $accountAccess.kind !== 'blocked' && $accountAccess.kind !== 'unavailable'}<a
            href="/server">Server exports</a
          >{:else if !authPage && $accountAuthenticated === false}<a href="/login?return=%2Fserver">Sign in</a
          >{/if}
        <a href="/settings">Settings</a>
      </nav>
    </aside>
  {/if}
  <div class="app-main">
    {#if header}<header class="app-header">{@render header()}</header>{/if}
    <div
      class="global-sync"
      class:empty={!syncMessage}
      class:danger={!authPage && syncTone === 'danger'}
      aria-label="Sync status"
      aria-live="polite"
    >
      <span class="global-sync-dot" aria-hidden="true"></span><span>{syncMessage}</span>
      {#if authPage || ($accountAccess.kind === 'blocked' && router.route.name === 'settings')}
        <span class="sync-action-placeholder" aria-hidden="true"></span>
      {:else if $accountAccess.kind === 'blocked'}<a href="/settings">Account</a>
      {:else if $accountAuthenticated === false && (pending > 0 || syncStatus?.phase === 'signed_out')}<a
          href="/login">Sign in</a
        >{:else if pending > 0 || syncStatus?.phase === 'error' || syncStatus?.phase === 'offline'}<SyncNowButton
        />{:else}<span class="sync-action-placeholder" aria-hidden="true"></span>{/if}
    </div>
    <main>
      {#if router.route.name === 'starred'}<StarredPage />{:else}{@render children()}{/if}
    </main>
    {#if bottomBar}<div class="bottom-action">{@render bottomBar()}</div>{/if}
  </div>
  <ToastHost />
</div>

<style>
  .rail-folder {
    padding: var(--space-4) var(--space-3) var(--space-2);
    color: var(--color-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .rail-search {
    width: 100%;
    min-height: var(--size-touch);
    margin-bottom: var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    padding: 0 var(--space-3);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-md);
  }
  .rail-empty {
    padding: var(--space-3);
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
</style>
