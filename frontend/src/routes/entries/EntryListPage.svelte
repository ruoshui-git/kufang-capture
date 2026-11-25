<script module lang="ts">
  const PAGE_SIZE = 40
  /** Rows revealed when a list was left, so coming back can restore the scroll position. */
  const revealedRows = new Map<string, number>()
</script>

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
  import ImportEntriesSheet from '../../components/entry/ImportEntriesSheet.svelte'
  import MoveEntriesSheet from '../../components/entry/MoveEntriesSheet.svelte'

  let { collectionId, detailEntryId }: { collectionId: string; detailEntryId?: string } = $props()
  let summary = $state<CollectionSummary | undefined>()
  let rows = $state<EntryRow[]>([])
  let unitRows = $state<EntryRow[]>([])
  let unitRowsLoaded = $state(false)
  let filter = $state<EntryFilter>('all')
  let sort = $state<EntrySort>('newest')
  let search = $state('')
  let appliedSearch = $state('')
  let limit = $state(PAGE_SIZE)
  let loaded = $state(false)
  let viewerOpen = $state(false)
  let viewerEntryId = $state('')
  let viewerPhotoId = $state<string | null>(null)
  let restoredScroll = false
  let previousDetailEntryId: string | undefined
  let sentinel = $state<HTMLDivElement>()
  let listElement = $state<HTMLDivElement>()
  let exportOpen = $state(false)
  let importOpen = $state(false)
  let moveOpen = $state(false)
  let conflictOpen = $state(false)
  let ConflictSheetView: typeof import('../../components/sync/ConflictSheet.svelte').default | null =
    $state(null)
  let frozenRowIds = $state<string[] | null>(null)
  let frozenRowSnapshot = $state<EntryRow[]>([])
  let initialAllRowIds = $state<string[]>([])
  let lastQueryKey = ''

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
        loaded = true
        freezeVisibleOrder()
        if (!restoredScroll) {
          restoredScroll = true
          limit = Math.max(limit, revealedRows.get(collectionId) ?? 0)
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
    const key = `${collectionId}\u0000${filter}\u0000${sort}\u0000${appliedSearch}`
    if (lastQueryKey && lastQueryKey !== key) unfreezeVisibleOrder()
    lastQueryKey = key
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
      .subscribe((items) => {
        unitRows = items
        unitRowsLoaded = true
        if (frozenRowIds) {
          const newCount = items.filter((row) => !initialAllRowIds.includes(row.entry.id)).length
          if (newCount) limit = Math.max(limit, frozenRowIds.length + newCount)
        }
      })
    return () => {
      if (typeof subscription === 'function') subscription()
      else subscription.unsubscribe()
    }
  })

  onMount(() => {
    void repo.getSetting<EntrySort>(SETTING_KEYS.entrySort, 'newest').then((value) => (sort = value))
    const onNew = () => void createEntry()
    const onHide = () => savePosition()
    window.addEventListener('capture: new-entry', onNew)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      if (typeof activeSubscription === 'function') activeSubscription()
      else activeSubscription?.unsubscribe()
      window.removeEventListener('capture: new-entry', onNew)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  })

  // The sentinel exists only once rows have rendered, and an observer reports changes only, so observe
  // afresh after every reveal. Otherwise the list can stop short of entries that are in the collection.
  $effect(() => {
    if (!sentinel || limit >= rows.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) limit += PAGE_SIZE
      },
      { rootMargin: '600px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  })

  function savePosition() {
    saveScroll(`entries: ${collectionId}`)
    revealedRows.set(collectionId, limit)
  }

  let searchTimer: ReturnType<typeof setTimeout>
  function searchChanged(value: string) {
    search = value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => (appliedSearch = search.trim()), 150)
  }
  function showAllEntries() {
    clearTimeout(searchTimer)
    filter = 'all'
    appliedSearch = ''
    search = ''
  }
  // The order and membership of the list stay put from its first load until the filter, sort, search or
  // collection changes, so an edit or a sync never moves the row under the finger. New rows still show
  // at once and deleted rows still disappear; contents update live.
  function freezeVisibleOrder() {
    if (!frozenRowIds) {
      frozenRowSnapshot = rows
      frozenRowIds = rows.map((row) => row.entry.id)
      initialAllRowIds = [...new Set([...rows, ...unitRows].map((row) => row.entry.id))]
    }
  }
  function unfreezeVisibleOrder() {
    frozenRowIds = null
    frozenRowSnapshot = []
    initialAllRowIds = []
  }
  async function createEntry() {
    const focusOrigin = document.activeElement
    if (filter === 'deleted') filter = 'all'
    const entry = await repo.createEntry(collectionId)
    if (sort === 'oldest') limit = Math.max(limit, rows.length + 1)
    showAllEntries()
    await tick()
    void focusNewEntry(entry.id, focusOrigin)
  }

  async function focusNewEntry(entryId: string, focusOrigin: Element | null, attempts = 0) {
    await tick()
    const shouldTakeFocus =
      document.activeElement === focusOrigin ||
      (focusOrigin instanceof HTMLButtonElement && focusOrigin.textContent?.includes('New Entry'))
    // Oldest first puts the new entry last, possibly beyond the rows revealed so far.
    const index = rows.findIndex((row) => row.entry.id === entryId)
    if (index >= limit) {
      limit = index + 1
      await tick()
    } else if (index < 0 && sort === 'oldest') {
      limit = Math.max(limit, rows.length + 1)
    }
    const row = listElement?.querySelector(`[data-entry-id="${entryId}"]`)
    if (!row && attempts < 30) {
      setTimeout(() => void focusNewEntry(entryId, focusOrigin, attempts + 1), 20)
      return
    }
    if (!row) return
    if (!shouldTakeFocus) return
    const titleInput = row?.querySelector('[aria-label="Entry title"]') as HTMLInputElement | null
    titleInput?.focus()
    row?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }
  async function deleteRow(row: EntryRow) {
    await repo.deleteEntry(row.entry.id)
    const shared = row.entry.shared_with
    const message = shared.length
      ? `Removed from ${summary?.collection.name ?? 'this collection'}. Still in ${shared[0]!.collection_name}${shared.length > 1 ? ` (+${shared.length - 1})` : ''}.`
      : `Deleted ${format(row.entry.sequence_number)}`
    showToast({
      message,
      actionLabel: 'Undo',
      action: () => void repo.restoreEntry(row.entry.id),
    })
  }
  function format(value: number) {
    return `#${String(value).padStart(4, '0')}`
  }
  function openDetails(entry: EntryRow['entry']) {
    savePosition()
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
  const stableRows = $derived.by(() => {
    if (!frozenRowIds) return rows
    const byId = new Map(unitRows.map((row) => [row.entry.id, row]))
    const matching = new Map(rows.map((row) => [row.entry.id, row]))
    const snapshot = new Map(frozenRowSnapshot.map((row) => [row.entry.id, row]))
    const frozen = frozenRowIds.flatMap((id) => {
      const row = byId.get(id) ?? (unitRowsLoaded ? undefined : snapshot.get(id))
      return row ? [matching.get(id) ?? row] : []
    })
    const seen = new Set(initialAllRowIds)
    const frozenIds = new Set(frozenRowIds)
    const additions = unitRows.filter(
      (row) =>
        !seen.has(row.entry.id) && !frozenIds.has(row.entry.id) && (!narrowed || matching.has(row.entry.id)),
    )
    // Rows that started matching the filter later join at the end, above nothing.
    const joined = rows.filter((row) => seen.has(row.entry.id) && !frozenIds.has(row.entry.id))
    if (sort === 'oldest') return [...frozen, ...joined, ...additions]
    return [...additions, ...frozen, ...joined]
  })
  const visibleRows = $derived(stableRows.slice(0, limit))
  const narrowed = $derived(filter !== 'all' || appliedSearch !== '')
  const incompleteLabel = $derived(
    filter === 'missing_quantity'
      ? 'No quantity'
      : filter === 'missing_title'
        ? 'No title'
        : filter === 'missing_photos'
          ? 'No photos'
          : filter === 'needs_review'
            ? 'Needs review'
            : 'Incomplete',
  )
  const incompleteFilterActive = $derived(
    ['incomplete', 'missing_quantity', 'missing_title', 'missing_photos', 'needs_review'].includes(filter),
  )
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
        {#if summary.incomplete_count > 0}<button
            class="summary-filter"
            onclick={() => (filter = 'incomplete')}><Chip>{summary.incomplete_count} incomplete</Chip></button
          >{/if}
        {#if summary.needs_review_count > 0}<button
            class="summary-filter"
            onclick={() => (filter = 'needs_review')}
            ><Chip>{summary.needs_review_count} needs review</Chip></button
          >{/if}
        <div class="quantity-chips" aria-label="Quantities by unit">
          {#each summary.quantity_by_unit as quantity (quantity.unit)}<Chip variant="quantity"
              >{quantity.total} {quantity.unit || 'no unit'}</Chip
            >{/each}
        </div>
      </div>
    {/if}
    <div class="toolbar">
      <div class="filter-row">
        <div class="filters" role="group" aria-label="Entry filters">
          <button class:active={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
          <Menu
            label={incompleteLabel}
            triggerText={`${incompleteLabel} ▾`}
            variant="filter"
            active={incompleteFilterActive}
          >
            <button
              role="menuitemradio"
              aria-checked={filter === 'incomplete'}
              onclick={() => (filter = 'incomplete')}
            >
              {filter === 'incomplete' ? '✓ ' : ''}Any incomplete
            </button>
            <button
              role="menuitemradio"
              aria-checked={filter === 'missing_quantity'}
              onclick={() => (filter = 'missing_quantity')}
            >
              {filter === 'missing_quantity' ? '✓ ' : ''}No quantity
            </button>
            <button
              role="menuitemradio"
              aria-checked={filter === 'missing_title'}
              onclick={() => (filter = 'missing_title')}
            >
              {filter === 'missing_title' ? '✓ ' : ''}No title
            </button>
            <button
              role="menuitemradio"
              aria-checked={filter === 'missing_photos'}
              onclick={() => (filter = 'missing_photos')}
            >
              {filter === 'missing_photos' ? '✓ ' : ''}No photos
            </button>
            <button
              role="menuitemradio"
              aria-checked={filter === 'needs_review'}
              onclick={() => (filter = 'needs_review')}
            >
              {filter === 'needs_review' ? '✓ ' : ''}Needs review
            </button>
          </Menu>
          <button class:active={filter === 'starred'} onclick={() => (filter = 'starred')}>Starred</button>
          <button class:active={filter === 'pending_sync'} onclick={() => (filter = 'pending_sync')}
            >Pending sync</button
          >
          <button class:active={filter === 'deleted'} onclick={() => (filter = 'deleted')}
            >Recently Deleted</button
          >
        </div>
        <Menu label="Collection actions">
          <button
            role="menuitemradio"
            aria-checked={sort === 'newest'}
            onclick={() => {
              sort = 'newest'
              void repo.setSetting(SETTING_KEYS.entrySort, sort)
            }}>{sort === 'newest' ? '✓ ' : ''}Newest first</button
          >
          <button
            role="menuitemradio"
            aria-checked={sort === 'oldest'}
            onclick={() => {
              sort = 'oldest'
              void repo.setSetting(SETTING_KEYS.entrySort, sort)
            }}>{sort === 'oldest' ? '✓ ' : ''}Oldest first</button
          >
          <button
            role="menuitemradio"
            aria-checked={sort === 'last_edited'}
            onclick={() => {
              sort = 'last_edited'
              void repo.setSetting(SETTING_KEYS.entrySort, sort)
            }}>{sort === 'last_edited' ? '✓ ' : ''}Last edited</button
          >
          <button role="menuitem" onclick={() => (exportOpen = true)}>Export ZIP</button>
          <button role="menuitem" onclick={() => (importOpen = true)}>Import from another collection</button>
          <button role="menuitem" onclick={() => (moveOpen = true)}>Move entries…</button>
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
    {:else if rows.length === 0 && !loaded}
      <!-- Rows are still being read: an empty state here would claim the room has nothing in it. -->
    {:else if rows.length === 0 && narrowed}
      <EmptyState title="No matching entries"
        >Entries in this collection are hidden by the current search or filter.</EmptyState
      >
      <div class="list-status">
        <Button variant="quiet" onclick={showAllEntries}>Show all entries</Button>
      </div>
    {:else if rows.length === 0}
      <EmptyState title="No entries yet"
        >Tap New Entry, then Add Photo to start counting this room.</EmptyState
      >
    {:else}
      {#if narrowed}
        <div class="list-status">
          <span>{rows.length} of {unitRows.length} entries match</span>
          <Button variant="quiet" onclick={showAllEntries}>Show all entries</Button>
        </div>
      {/if}
      <div class="entry-list" bind:this={listElement}>
        {#each visibleRows as row (row.entry.id)}
          <div data-entry-id={row.entry.id} class="row-wrapper">
            <EntryRowView {row} {units} ondetails={openDetails} onviewer={openViewer} ondelete={deleteRow} />
          </div>
        {/each}
        <div class="sentinel" bind:this={sentinel}></div>
      </div>
      {#if visibleRows.length < rows.length}
        <div class="list-status">
          <span>Showing {visibleRows.length} of {rows.length} entries</span>
          <Button variant="quiet" onclick={() => (limit = rows.length)}>Show the rest</Button>
        </div>
      {/if}
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
{#if summary}<ImportEntriesSheet
    bind:open={importOpen}
    targetCollectionId={collectionId}
    storageMode={summary.collection.storage_mode}
  />{/if}
{#if summary}<MoveEntriesSheet
    bind:open={moveOpen}
    {collectionId}
    sourceName={summary.collection.name}
    folder={summary.collection.folder}
    storageMode={summary.collection.storage_mode}
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
  .status-trigger {
    flex: none;
    width: min(var(--size-sync-chip), 42vw);
    min-width: 0;
    min-height: var(--size-touch);
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
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
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    align-items: center;
    margin: var(--space-4) 0 var(--space-2);
    min-height: var(--size-touch);
    min-width: 0;
  }
  .summary-chips::-webkit-scrollbar {
    display: none;
  }
  .summary-chips :global(.chip),
  .quantity-chips :global(.chip),
  .summary-filter {
    flex: none;
  }
  .quantity-chips {
    display: flex;
    flex: none;
    gap: var(--space-2);
  }
  .quantity-chips:global(.chip) {
    background: color-mix(in srgb, var(--color-tag) 28%, var(--color-card));
    border-color: color-mix(in srgb, var(--color-tag) 65%, var(--color-line));
    color: var(--color-ink);
  }
  .summary-filter {
    flex: none;
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
  .filters > button {
    border: 1px solid var(--color-line);
    background: var(--color-card);
    color: var(--color-ink);
    border-radius: var(--radius-pill);
    padding: var(--space-3) var(--space-4);
    white-space: nowrap;
    min-height: var(--size-touch);
  }
  .filters > button.active {
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
  .list-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin: var(--space-3) 0;
    color: var(--color-muted);
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
