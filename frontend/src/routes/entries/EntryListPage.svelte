<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { repo } from '$lib/db'
  import { SETTING_KEYS, type CollectionSummary, type EntryRow } from '$lib/types'
  import type { EntryFilter, EntrySort, Watchable } from '$lib/repo'
  import { navigate, saveScroll, restoreScroll } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import EntryRowView from '../../components/entry/EntryRow.svelte'
  import RecentlyDeleted from '../../components/entry/RecentlyDeleted.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Badge from '../../components/ui/Badge.svelte'
  import Chip from '../../components/ui/Chip.svelte'
  import EmptyState from '../../components/ui/EmptyState.svelte'
  import Menu from '../../components/ui/Menu.svelte'
  import DetailPage from '../detail/DetailPage.svelte'
  import PhotoViewer from '../../components/viewer/PhotoViewer.svelte'
  import SyncStatusChip from '../../components/sync/SyncStatusChip.svelte'
  import SyncNowButton from '../../components/sync/SyncNowButton.svelte'
  import ExportSheet from '../../components/sync/ExportSheet.svelte'

  let { collectionId, detailEntryId }: { collectionId: string; detailEntryId?: string } = $props()
  let summary = $state<CollectionSummary | undefined>()
  let rows = $state<EntryRow[]>([])
  let unitRows = $state<EntryRow[]>([])
  let filter = $state<EntryFilter>('all')
  let sort = $state<EntrySort>('newest')
  let search = $state('')
  let appliedSearch = $state('')
  let limit = $state(40)
  let viewerOpen = $state(false)
  let viewerEntryId = $state('')
  let viewerPhotoId = $state<string | null>(null)
  let restoredScroll = false
  let previousDetailEntryId: string | undefined
  let sentinel = $state<HTMLDivElement>()
  let listElement = $state<HTMLDivElement>()
  let exportOpen = $state(false)
  let conflictOpen = $state(false)
  let ConflictSheetView: typeof import('../../components/sync/ConflictSheet.svelte').default | null =
    $state(null)

  async function openConflicts() {
    ConflictSheetView = (await import('../../components/sync/ConflictSheet.svelte')).default
    conflictOpen = true
  }

  let activeSubscription: ReturnType<Watchable<EntryRow[]>['subscribe']> | undefined
  function subscribeRows() {
    if (typeof activeSubscription === 'function') activeSubscription()
    else activeSubscription?.unsubscribe()
    activeSubscription = repo
      .watchEntryRows(collectionId, { search: appliedSearch, filter, sort })
      .subscribe((items) => {
        rows = items
        limit = Math.max(limit, 40)
        if (!restoredScroll) {
          restoredScroll = true
          requestAnimationFrame(() => restoreScroll(`entries: ${collectionId}`))
        }
      })
  }
  $effect(() => {
    appliedSearch
    filter
    sort
    collectionId
    subscribeRows()
  })

  $effect(() => {
    const currentDetailEntryId = detailEntryId
    if (previousDetailEntryId && !currentDetailEntryId) {
      requestAnimationFrame(() => restoreScroll(`entries: ${collectionId}`))
    }
    previousDetailEntryId = currentDetailEntryId
  })

  $effect(() => {
    const subscription = repo.watchCollectionSummary(collectionId).subscribe((item) => (summary = item))
    return () => {
      if (typeof subscription === 'function') subscription()
      else subscription.unsubscribe()
    }
  })

  $effect(() => {
    const subscription = repo
      .watchEntryRows(collectionId, { search: '', filter: 'all', sort: 'newest' })
      .subscribe((items) => (unitRows = items))
    return () => {
      if (typeof subscription === 'function') subscription()
      else subscription.unsubscribe()
    }
  })

  onMount(() => {
    void repo.getSetting<EntrySort>(SETTING_KEYS.entrySort, 'newest').then((value) => (sort = value))
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) limit = Math.min(rows.length, limit + 40)
      },
      { rootMargin: '600px' },
    )
    if (sentinel) observer.observe(sentinel)
    const onNew = () => void createEntry()
    const onHide = () => {
      saveScroll(`entries: ${collectionId}`)
    }
    window.addEventListener('capture: new-entry', onNew)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      if (typeof activeSubscription === 'function') activeSubscription()
      else activeSubscription?.unsubscribe()
      observer.disconnect()
      window.removeEventListener('capture: new-entry', onNew)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  })

  let searchTimer: ReturnType<typeof setTimeout>
  function searchChanged(value: string) {
    search = value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => (appliedSearch = search.trim()), 150)
  }
  async function createEntry() {
    const focusOrigin = document.activeElement
    if (filter === 'deleted') filter = 'all'
    const entry = await repo.createEntry(collectionId)
    filter = 'all'
    appliedSearch = ''
    search = ''
    limit = Math.max(limit, rows.length + 1)
    await tick()
    void focusNewEntry(entry.id, focusOrigin)
  }

  async function focusNewEntry(entryId: string, focusOrigin: Element | null, attempts = 0) {
    await tick()
    if (document.activeElement !== focusOrigin) return
    const row = listElement?.querySelector(`[data-entry-id="${entryId}"]`)
    if (!row && attempts < 30) {
      setTimeout(() => void focusNewEntry(entryId, focusOrigin, attempts + 1), 20)
      return
    }
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const titleInput = row?.querySelector('[aria-label="Entry title"]') as HTMLInputElement | null
    titleInput?.focus()
  }
  async function deleteRow(row: EntryRow) {
    await repo.deleteEntry(row.entry.id)
    showToast({
      message: `Deleted ${format(row.entry.sequence_number)}`,
      actionLabel: 'Undo',
      action: () => void repo.restoreEntry(row.entry.id),
    })
  }
  function format(value: number) {
    return `#${String(value).padStart(4, '0')}`
  }
  function openDetails(entry: EntryRow['entry']) {
    saveScroll(`entries: ${collectionId}`)
    navigate(`/c/${collectionId}/e/${entry.id}`)
  }
  function openViewer(entryId: string, photoId: string) {
    viewerEntryId = entryId
    viewerPhotoId = photoId || null
    viewerOpen = true
  }
  const units = $derived(
    [...new Set(unitRows.map(({ entry }) => entry.unit.trim()).filter(Boolean))].slice(0, 12),
  )
  const visibleRows = $derived(rows.slice(0, limit))
</script>

<svelte:head><title>{summary?.collection.name ?? 'Entries'} — Kufang Capture</title></svelte:head>
<div class="list-with-detail" class:has-detail={!!detailEntryId}>
  <section class="page entries-page">
    <div class="collection-heading">
      <div class="heading-title">
        {#if !detailEntryId && !matchMedia('(min-width: 900px)').matches}<a class="back" href="/"
            >‹ Collections</a
          >{/if}
        <h1>{summary?.collection.name ?? 'Collection'}</h1>
        {#if summary}<button class="status-trigger" type="button" onclick={() => void openConflicts()}
            ><SyncStatusChip
              collectionId={summary.collection.id}
              mode={summary.collection.storage_mode}
              pendingCount={summary.pending_sync_count}
              pendingBytes={summary.pending_upload_bytes}
            /></button
          >{/if}
      </div>
    </div>
    {#if summary}
      <div class="summary-chips">
        <Chip>{summary.entry_count} {summary.entry_count === 1 ? 'entry' : 'entries'}</Chip>
        <Chip>{summary.photo_count} {summary.photo_count === 1 ? 'photo' : 'photos'}</Chip>
        {#if summary.incomplete_count > 0}
          <button class="summary-filter" onclick={() => (filter = 'incomplete')}
            ><Chip>{summary.incomplete_count} incomplete</Chip></button
          >
        {/if}
        {#if summary.needs_review_count > 0}<Chip>{summary.needs_review_count} needs review</Chip>{/if}
      </div>
      {#if summary.quantity_by_unit.length > 0}
        <div class="quantity-chips" aria-label="Quantities by unit">
          {#each summary.quantity_by_unit as quantity (quantity.unit)}<Chip variant="quantity"
              >{quantity.total} {quantity.unit || 'no unit'}</Chip
            >{/each}
        </div>
      {/if}
    {/if}
    <div class="toolbar">
      <div class="filter-row">
        <div class="filters" role="group" aria-label="Entry filters">
          {#each [['all', 'All'], ['incomplete', 'Incomplete'], ['pending_sync', 'Pending sync'], ['deleted', 'Recently Deleted']] as item}
            <button class:active={filter === item[0]} onclick={() => (filter = item[0] as EntryFilter)}
              >{item[1]}</button
            >
          {/each}
        </div>
        <Menu label="Collection actions">
          <button
            role="menuitem"
            onclick={() => {
              sort = 'newest'
              void repo.setSetting(SETTING_KEYS.entrySort, sort)
            }}>Newest first</button
          >
          <button
            role="menuitem"
            onclick={() => {
              sort = 'oldest'
              void repo.setSetting(SETTING_KEYS.entrySort, sort)
            }}>Oldest first</button
          >
          <button role="menuitem" onclick={() => (exportOpen = true)}>Export ZIP</button>
        </Menu>
      </div>
      <div class="search-row">
        <input
          aria-label="Search entries"
          placeholder="Search entries"
          value={search}
          oninput={(event) => searchChanged(event.currentTarget.value)}
        />
      </div>
      <div class="new-entry-toolbar">
        {#if summary?.collection.storage_mode === 'synced'}<SyncNowButton />{/if}
        <Button variant="ink" onclick={() => void createEntry()}>＋ New Entry</Button>
      </div>
    </div>
    {#if filter === 'deleted'}
      <RecentlyDeleted {collectionId} />
    {:else if rows.length === 0}
      <EmptyState title="No entries yet"
        >Tap New Entry, then Add Photo to start counting this room.</EmptyState
      >
    {:else}
      <div class="entry-list" bind:this={listElement}>
        {#each visibleRows as row (row.entry.id)}
          <div data-entry-id={row.entry.id} class="row-wrapper">
            <EntryRowView {row} {units} ondetails={openDetails} onviewer={openViewer} ondelete={deleteRow} />
          </div>
        {/each}
        <div class="sentinel" bind:this={sentinel}></div>
      </div>
    {/if}
  </section>
  {#if detailEntryId && matchMedia('(min-width: 900px)').matches}
    <aside class="detail-panel"><DetailPage {collectionId} entryId={detailEntryId} variant="panel" /></aside>
  {/if}
</div>
{#if !matchMedia('(min-width: 900px)').matches}<div class="new-entry-bar">
    <Button variant="ink" onclick={() => void createEntry()}>＋ New Entry</Button>
  </div>{/if}
{#if viewerEntryId}<PhotoViewer
    bind:open={viewerOpen}
    entryId={viewerEntryId}
    startPhotoId={viewerPhotoId}
  />{/if}
{#if summary}<ExportSheet
    bind:open={exportOpen}
    scope={[summary.collection.id]}
    title={`Export ${summary.collection.name}`}
  />{/if}
{#if conflictOpen && ConflictSheetView}<ConflictSheetView bind:open={conflictOpen} />{/if}

<style>
  .list-with-detail {
    display: block;
    min-width: 0;
  }
  .entries-page {
    min-width: 0;
    width: 100%;
    padding: var(--space-6) var(--space-4) calc(var(--size-bottom-bar) + var(--space-4));
    container: entry-list / inline-size;
  }
  .collection-heading {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
  }
  .heading-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-4);
    min-width: 0;
  }
  .heading-title h1 {
    overflow-wrap: anywhere;
  }
  .back {
    display: inline-block;
    flex-basis: 100%;
    margin-bottom: var(--space-2);
    text-decoration: none;
  }
  .summary-chips {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin: var(--space-4) 0 var(--space-2);
    min-width: 0;
  }
  .quantity-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
  .quantity-chips:global(.chip) {
    background: color-mix(in srgb, var(--color-tag) 28%, var(--color-card));
    border-color: color-mix(in srgb, var(--color-tag) 65%, var(--color-line));
    color: var(--color-ink);
  }
  .summary-filter {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    cursor: pointer;
  }
  .toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-3);
    margin: var(--space-4) 0;
    min-width: 0;
  }
  .filter-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    overflow: visible;
    flex: 1 1 auto;
    min-width: 0;
    scrollbar-width: none;
  }
  .filters::-webkit-scrollbar {
    display: none;
  }
  .filters button {
    border: 1px solid var(--color-line);
    background: var(--color-card);
    color: var(--color-ink);
    border-radius: var(--radius-pill);
    padding: var(--space-3) var(--space-4);
    white-space: nowrap;
    min-height: var(--size-touch);
  }
  .filters button.active {
    background: var(--color-ink);
    color: var(--color-floor);
  }
  .search-row {
    width: 100%;
    min-width: 0;
  }
  .search-row input {
    min-height: var(--size-touch);
    width: 100%;
    min-width: 0;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-3);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .new-entry-toolbar {
    display: none;
  }
  .entry-list {
    display: grid;
    gap: var(--space-3);
  }
  .row-wrapper {
    min-width: 0;
  }
  .sentinel {
    height: 1px;
  }
  .new-entry-bar {
    position: fixed;
    z-index: var(--z-bottom-bar);
    bottom: 0;
    left: 0;
    right: 0;
    padding: var(--space-3) var(--space-5) calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--color-ink);
    display: flex;
    justify-content: center;
  }
  .new-entry-bar:global(.button) {
    width: min(100%, 600px);
    background: transparent;
    color: var(--color-floor);
    border: 0;
    font-size: var(--text-lg);
  }
  .detail-panel {
    display: none;
  }
  .summary-chips:global(.chip),
  .quantity-chips :global(.chip) {
    white-space: nowrap;
  }
  @media (min-width: 600px) {
    .entries-page {
      padding-right: var(--space-5);
      padding-left: var(--space-5);
    }
  }
  @media (min-width: 900px) {
    .list-with-detail.has-detail {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(380px, var(--size-panel));
      align-items: start;
    }
    .entries-page {
      /* Both names: rows query entry-list, the toolbar queries entry-toolbar. */
      container: entry-list entry-toolbar / inline-size;
      margin: 0;
      padding-bottom: calc(var(--space-7) + env(safe-area-inset-bottom));
      max-width: none;
    }
    .toolbar {
      grid-template-columns: minmax(0, 1fr) minmax(160px, 240px) auto;
      align-items: center;
      gap: var(--space-3);
    }
    .new-entry-toolbar {
      display: flex;
    }
    .detail-panel {
      display: block;
      min-width: 0;
      overflow-x: clip;
      border-left: 1px solid var(--color-line);
      min-height: calc(100dvh - 24px);
      background: var(--color-card);
    }
    .detail-panel:global(.page) {
      width: 100%;
      min-width: 0;
      padding: var(--space-5);
      max-width: none;
    }
    .new-entry-bar {
      display: none;
    }
  }
  @media (min-width: 900px) {
    @container entry-toolbar (max-width: 820px) {
      .toolbar {
        grid-template-columns: minmax(0, 1fr);
      }
      .new-entry-toolbar {
        justify-content: flex-start;
      }
    }
  }
</style>
