<script lang="ts">
  import { onMount } from 'svelte'
  import { onDestroy } from 'svelte'
  import SettingsIcon from '@lucide/svelte/icons/settings'
  import { repo } from '$lib/db'
  import { SETTING_KEYS, type CollectionSummary, type Id, type StorageMode } from '$lib/types'
  import { navigate } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Badge from '../../components/ui/Badge.svelte'
  import EmptyState from '../../components/ui/EmptyState.svelte'
  import Menu from '../../components/ui/Menu.svelte'
  import Sheet from '../../components/ui/Sheet.svelte'
  import TextField from '../../components/ui/TextField.svelte'
  import type { Unsubscriber } from 'svelte/store'
  import { relativeTime } from './relativeTime'
  import SyncStatusChip from '../../components/sync/SyncStatusChip.svelte'
  import StorageModeSheet from '../../components/sync/StorageModeSheet.svelte'
  import ClearCollectionSheet from '../../components/sync/ClearCollectionSheet.svelte'
  import ExportSheet from '../../components/sync/ExportSheet.svelte'
  import MergeCollectionsSheet from '../../components/collection/MergeCollectionsSheet.svelte'
  import { collectionMatches } from './collectionSearch'

  let summaries = $state<CollectionSummary[]>([])
  let includeArchived = $state(false)
  let search = $state('')
  let searchInput = $state<HTMLInputElement>()
  let sheetOpen = $state(false)
  let editing = $state<CollectionSummary | null>(null)
  let name = $state('')
  let description = $state('')
  let folder = $state('')
  let collapsedFolders = $state<string[]>([])
  let folderSettingsLoaded = false
  let storageMode = $state<StorageMode>('local_only')
  let saving = $state(false)
  let error = $state('')
  let selected = $state<CollectionSummary | null>(null)
  let storageOpen = $state(false)
  let clearOpen = $state(false)
  let exportOpen = $state(false)
  let mergeOpen = $state(false)
  let selectionMode = $state(false)
  let selectedIds = $state<Id[]>([])
  let selectButton = $state<HTMLButtonElement>()
  let conflictOpen = $state(false)
  let ConflictSheetView: typeof import('../../components/sync/ConflictSheet.svelte').default | null =
    $state(null)

  async function openConflicts() {
    ConflictSheetView = (await import('../../components/sync/ConflictSheet.svelte')).default
    conflictOpen = true
  }

  let subscription: Unsubscriber | { unsubscribe(): void } | undefined
  $effect(() => {
    if (typeof subscription === 'function') subscription()
    else subscription?.unsubscribe()
    subscription = repo
      .watchCollectionSummaries({ includeArchived })
      .subscribe((items) => (summaries = items))
    return () => {
      if (typeof subscription === 'function') subscription()
      else subscription?.unsubscribe()
      subscription = undefined
    }
  })

  onMount(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') void openNew()
  })

  const totalEntries = $derived(summaries.reduce((sum, item) => sum + item.entry_count, 0))
  const filteredSummaries = $derived(
    search.trim() ? summaries.filter((item) => collectionMatches(item, search)) : summaries,
  )
  const searching = $derived(search.trim().length > 0)
  const groups = $derived.by(() => {
    const names = [
      ...new Set(filteredSummaries.map((item) => (item.collection.folder ?? '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b))
    const result = names.map((name) => ({
      name,
      items: filteredSummaries.filter((item) => (item.collection.folder ?? '').trim() === name),
    }))
    const unfiled = filteredSummaries.filter((item) => !(item.collection.folder ?? '').trim())
    if (unfiled.length) result.push({ name: '', items: unfiled })
    return result
  })
  const displayedItems = $derived(groups.flatMap((group) => group.items))
  const searchStatus = $derived(
    searching && summaries.length > 0
      ? `${displayedItems.length} of ${summaries.length} ${summaries.length === 1 ? 'collection' : 'collections'}`
      : '',
  )
  const allItemsInDisplayOrder = $derived.by(() => {
    const names = [
      ...new Set(summaries.map((item) => (item.collection.folder ?? '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b))
    const ordered = names.flatMap((name) =>
      summaries.filter((item) => (item.collection.folder ?? '').trim() === name),
    )
    return [...ordered, ...summaries.filter((item) => !(item.collection.folder ?? '').trim())]
  })
  const selectedInDisplayOrder = $derived(
    allItemsInDisplayOrder.filter((item) => selectedIds.includes(item.collection.id)),
  )
  onMount(() => {
    void repo.getSetting<string[]>(SETTING_KEYS.collapsedFolders, []).then((value) => {
      if (!folderSettingsLoaded) collapsedFolders = value
      folderSettingsLoaded = true
    })
  })
  async function toggleFolder(name: string) {
    folderSettingsLoaded = true
    collapsedFolders = collapsedFolders.includes(name)
      ? collapsedFolders.filter((item) => item !== name)
      : [...collapsedFolders, name]
    await repo.setSetting(SETTING_KEYS.collapsedFolders, [...collapsedFolders])
  }
  function leaveSelection() {
    selectionMode = false
    selectedIds = []
    requestAnimationFrame(() => selectButton?.focus())
  }
  function enterSelection() {
    selectionMode = true
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.collection-card[role="checkbox"]')?.focus(),
    )
  }
  function toggleSelected(id: string) {
    selectedIds = selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]
  }
  function toggleFolderSelection(items: CollectionSummary[]) {
    const ids = items.map((item) => item.collection.id)
    const allSelected = ids.every((id) => selectedIds.includes(id))
    selectedIds = allSelected
      ? selectedIds.filter((id) => !ids.includes(id))
      : [...selectedIds, ...ids.filter((id) => !selectedIds.includes(id))]
  }
  function clearSearch() {
    search = ''
    requestAnimationFrame(() => searchInput?.focus())
  }
  function searchKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && search) {
      event.preventDefault()
      event.stopPropagation()
      clearSearch()
      return
    }
    if (event.key === 'Enter' && !selectionMode && displayedItems.length === 1) {
      event.preventDefault()
      navigate(`/c/${displayedItems[0]!.collection.id}`)
    }
  }
  function openSelectedExport() {
    if (!selectedInDisplayOrder.length) return
    exportOpen = true
  }
  function selectionKeydown(event: KeyboardEvent) {
    if (selectionMode && event.key === 'Escape' && !exportOpen) {
      event.preventDefault()
      leaveSelection()
    }
  }
  onDestroy(() => {
    selectedIds = []
    selectionMode = false
  })

  async function openNew() {
    editing = null
    name = ''
    description = ''
    folder = ''
    storageMode = await repo.getSetting<StorageMode>(SETTING_KEYS.lastStorageMode, 'local_only')
    error = ''
    sheetOpen = true
  }
  function openEdit(item: CollectionSummary) {
    editing = item
    name = item.collection.name
    description = item.collection.description
    folder = item.collection.folder
    storageMode = item.collection.storage_mode
    error = ''
    sheetOpen = true
  }
  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (!name.trim() || saving) return
    saving = true
    error = ''
    try {
      if (editing) {
        await repo.updateCollection(editing.collection.id, {
          name: name.trim(),
          description: description.trim(),
          folder: folder.trim(),
        })
        showToast({ message: 'Collection updated' })
      } else {
        const created = await repo.createCollection({
          name: name.trim(),
          description: description.trim(),
          folder: folder.trim(),
          storage_mode: storageMode,
        })
        await repo.setSetting(SETTING_KEYS.lastStorageMode, storageMode)
        if (storageMode === 'synced')
          showToast({
            message: 'Created locally. Sign in to start syncing.',
            actionLabel: 'Sign in',
            action: () => navigate(`/login?return=${encodeURIComponent(`/c/${created.id}`)}`),
          })
        void repo.requestPersistentStorage()
        sheetOpen = false
        navigate(`/c/${created.id}`)
        return
      }
      sheetOpen = false
    } catch (cause) {
      error = 'Could not save this collection. Check the details and try again.'
    } finally {
      saving = false
    }
  }
  async function toggleArchive(item: CollectionSummary) {
    if (item.collection.status === 'archived') {
      await repo.unarchiveCollection(item.collection.id)
      showToast({ message: 'Collection restored' })
    } else {
      await repo.archiveCollection(item.collection.id)
      showToast({
        message: 'Collection archived',
        actionLabel: 'Undo',
        action: () => void repo.unarchiveCollection(item.collection.id),
      })
    }
  }
</script>

<svelte:head><title>Collections — Kufang Capture</title></svelte:head>
<svelte:window onkeydown={selectionKeydown} />
<section class="page collections-page">
  <div class="page-heading">
    <div>
      <h1>Collections</h1>
      <div class="summary-copy" aria-label="Collection summary">
        <span class="summary-chip"
          >{summaries.length} {summaries.length === 1 ? 'collection' : 'collections'}</span
        >
        <span class="summary-chip">{totalEntries} {totalEntries === 1 ? 'entry' : 'entries'}</span>
      </div>
    </div>
    <div class="page-heading-actions">
      {#if selectionMode}
        <button class="button quiet" type="button" onclick={leaveSelection}>Cancel selection</button>
      {:else}
        <button
          bind:this={selectButton}
          class="button quiet select-action"
          type="button"
          onclick={enterSelection}>Select</button
        >
      {/if}
      <a class="button quiet" href="/starred">★ Starred</a>
      <a class="button quiet icon-link" href="/settings" aria-label="Settings" title="Settings"
        ><SettingsIcon size={20} aria-hidden="true" /></a
      >
      <button
        class="button ink new-collection-action"
        type="button"
        aria-label="New collection"
        onclick={openNew}
      >
        <span aria-hidden="true">+ New</span>
      </button>
    </div>
  </div>
  <div class="search-controls">
    <div class="search-row">
      <input
        bind:this={searchInput}
        type="search"
        aria-label="Search collections"
        placeholder="Search collections"
        enterkeyhint="search"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={search}
        onkeydown={searchKeydown}
      />
    </div>
    <label class="toggle-row"><input type="checkbox" bind:checked={includeArchived} /> Show archived</label>
  </div>
  <p class="search-status" aria-live="polite">{searchStatus}</p>
  {#if summaries.length === 0}
    <EmptyState title={includeArchived ? 'No archived collections' : 'No collections yet'}
      >Create a collection for a room or counting session. Add photos and counts as you work, even when you
      are offline.</EmptyState
    >
  {:else}
    {#if searching && displayedItems.length === 0}
      <EmptyState title={`No collections match “${search.trim()}”`}>
        <button class="button quiet" type="button" onclick={clearSearch}>Clear search</button>
      </EmptyState>
    {:else}{#each groups as group (group.name)}
        {#if group.name}<div class="folder-heading-row">
            <button
              class="folder-heading"
              aria-expanded={searching || !collapsedFolders.includes(group.name)}
              onclick={() => {
                if (!searching) void toggleFolder(group.name)
              }}
            >
              <span class="folder-chevron" aria-hidden="true">⌄</span>
              <span class="folder-name">{group.name}</span>
              <span class="chip folder-count">{group.items.length}</span>
            </button>
            {#if selectionMode}
              <button
                class="button quiet folder-select"
                type="button"
                onclick={() => toggleFolderSelection(group.items)}
              >
                {#if group.items.every((item) => selectedIds.includes(item.collection.id))}Clear{:else}Select
                  all{/if}
              </button>
            {/if}
          </div>{:else if groups.length > 1}<div class="folder-heading-row">
            <h2 class="unfiled-heading">
              Not in a folder <span class="chip folder-count">{group.items.length}</span>
            </h2>
            {#if selectionMode}
              <button
                class="button quiet folder-select"
                type="button"
                onclick={() => toggleFolderSelection(group.items)}
              >
                {#if group.items.every((item) => selectedIds.includes(item.collection.id))}Clear{:else}Select
                  all{/if}
              </button>
            {/if}
          </div>{/if}
        {#if !group.name || searching || !collapsedFolders.includes(group.name)}<div class="collection-grid">
            {#each group.items as item (item.collection.id)}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <article
                class="collection-card"
                class:selectable={selectionMode}
                class:is-selected={selectedIds.includes(item.collection.id)}
                role={selectionMode ? 'checkbox' : undefined}
                aria-label={selectionMode ? item.collection.name : undefined}
                aria-checked={selectionMode ? selectedIds.includes(item.collection.id) : undefined}
                onclick={selectionMode ? () => toggleSelected(item.collection.id) : undefined}
                onkeydown={(event) => {
                  if (selectionMode && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault()
                    toggleSelected(item.collection.id)
                  }
                }}
                tabindex={selectionMode ? 0 : undefined}
              >
                {#if selectionMode}
                  <span class="selection-checkbox" aria-hidden="true">
                    {#if selectedIds.includes(item.collection.id)}✓{/if}
                  </span>
                {/if}
                {#if selectionMode}<div class="collection-open selection-copy">
                    <span class="collection-title-row">
                      <span class="collection-title">{item.collection.name}</span>
                    </span>
                    <span class="collection-meta">
                      <span class="stat-chip"
                        >{item.entry_count} {item.entry_count === 1 ? 'entry' : 'entries'}</span
                      >
                      <span class="stat-chip"
                        >{item.photo_count} {item.photo_count === 1 ? 'photo' : 'photos'}</span
                      >
                      <span class="stat-chip" class:incomplete={item.incomplete_count > 0}
                        >{item.incomplete_count} incomplete</span
                      >
                    </span>
                    <span class="collection-updated">Updated {relativeTime(item.last_activity_at)}</span>
                  </div>{:else}<a
                    class="collection-open"
                    href="/c/{item.collection.id}"
                    aria-label="Open {item.collection.name}"
                  >
                    <span class="collection-title-row">
                      <span class="collection-title">{item.collection.name}</span>
                    </span>
                    <span class="collection-meta">
                      <span class="stat-chip"
                        >{item.entry_count} {item.entry_count === 1 ? 'entry' : 'entries'}</span
                      >
                      <span class="stat-chip"
                        >{item.photo_count} {item.photo_count === 1 ? 'photo' : 'photos'}</span
                      >
                      <span class="stat-chip" class:incomplete={item.incomplete_count > 0}>
                        {item.incomplete_count} incomplete
                      </span>
                    </span>
                    <span class="collection-updated">Updated {relativeTime(item.last_activity_at)}</span>
                  </a>{/if}
                {#if !selectionMode}
                  <button
                    class="status-trigger"
                    type="button"
                    aria-label="Show sync conflicts"
                    onclick={() => void openConflicts()}
                    ><SyncStatusChip
                      collectionId={item.collection.id}
                      mode={item.collection.storage_mode}
                      pendingCount={item.pending_sync_count}
                      pendingBytes={item.pending_upload_bytes}
                    /></button
                  >
                  <div class="collection-card-menu">
                    <Menu label={`Actions for ${item.collection.name}`}>
                      <button role="menuitem" onclick={() => openEdit(item)}>Rename / Edit</button>
                      <button role="menuitem" onclick={() => toggleArchive(item)}>
                        {item.collection.status === 'archived' ? 'Unarchive' : 'Archive'}
                      </button>
                      <button
                        role="menuitem"
                        onclick={() => {
                          selected = item
                          exportOpen = true
                        }}>Export ZIP</button
                      >
                      <button
                        role="menuitem"
                        onclick={() => {
                          selected = item
                          storageOpen = true
                        }}>Change storage mode…</button
                      >
                      <button
                        role="menuitem"
                        onclick={() => {
                          selected = item
                          clearOpen = true
                        }}>Clear from this device…</button
                      >
                    </Menu>
                  </div>
                {/if}
              </article>
            {/each}
          </div>{/if}
      {/each}{/if}
  {/if}
</section>
{#if selectionMode}
  <div class="selection-bar" role="region" aria-label="Export selected collections">
    <span aria-live="polite">{selectedIds.length} selected</span>
    <div class="selection-actions">
      <Button variant="quiet" disabled={selectedIds.length < 2} onclick={() => (mergeOpen = true)}
        >Merge…</Button
      >
      <Button disabled={selectedIds.length === 0} onclick={openSelectedExport}>Export ZIP</Button>
      <Button variant="quiet" onclick={leaveSelection}>Cancel</Button>
    </div>
  </div>
{/if}
{#if mergeOpen && selectedInDisplayOrder.length >= 2}
  <MergeCollectionsSheet bind:open={mergeOpen} selected={selectedInDisplayOrder} />
{/if}
<Sheet bind:open={sheetOpen} title={editing ? 'Edit collection' : 'New collection'}>
  {#snippet children()}
    <form class="collection-form" onsubmit={save}>
      <TextField label="Name" bind:value={name} required placeholder="e.g. Temple 2 / A04" />
      <label class="field"
        >Folder <input
          aria-label="Folder"
          bind:value={folder}
          list="collection-folders"
          placeholder="Unfiled"
        /></label
      >
      <datalist id="collection-folders"
        >{#each [...new Set(summaries
              .map((item) => item.collection.folder ?? '')
              .filter(Boolean))] as existing}<option value={existing}></option>{/each}</datalist
      >
      <label class="field"
        >Description <textarea bind:value={description} rows="3" placeholder="Optional details"
        ></textarea></label
      >
      {#if !editing}
        <fieldset class="storage-choice">
          <legend>Storage</legend>
          <label class="choice"
            ><input type="radio" name="storage-mode" value="local_only" bind:group={storageMode} /><span
              ><strong>Local Only</strong><small>Stays on this device; export ZIPs to back up</small></span
            ></label
          >
          <label class="choice"
            ><input type="radio" name="storage-mode" value="synced" bind:group={storageMode} /><span
              ><strong>Sync to Server</strong><small>Uploads to capture.kufang.org after you sign in</small
              ></span
            ></label
          >
        </fieldset>
      {/if}
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
      {#if !editing && !name.trim()}
        <p class="form-hint">Enter a name to continue.</p>
      {/if}
      <div class="form-actions">
        <Button variant="quiet" onclick={() => (sheetOpen = false)}>Cancel</Button><Button
          type="submit"
          disabled={!name.trim() || saving}
          >{saving ? 'Saving…' : editing ? 'Save changes' : 'Create collection'}</Button
        >
      </div>
    </form>
  {/snippet}
</Sheet>
{#if selected}
  <StorageModeSheet bind:open={storageOpen} item={selected} />
  <ClearCollectionSheet bind:open={clearOpen} item={selected} />
{/if}
{#if exportOpen && (selected || selectedIds.length > 0)}
  <ExportSheet
    bind:open={exportOpen}
    scope={selectedIds.length > 0
      ? selectedInDisplayOrder.map((item) => item.collection.id)
      : selected
        ? [selected.collection.id]
        : []}
    title={selectedIds.length > 0
      ? `Export ${selectedIds.length} ${selectedIds.length === 1 ? 'collection' : 'collections'}`
      : `Export ${selected?.collection.name ?? 'ZIP'}`}
  />
{/if}
{#if conflictOpen && ConflictSheetView}<ConflictSheetView bind:open={conflictOpen} />{/if}

<style>
  .search-controls {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .search-row {
    flex: 1;
    min-width: 0;
  }
  .search-row input {
    width: 100%;
    min-width: 0;
    min-height: var(--size-touch);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .search-status:empty {
    display: none;
  }
  .search-status {
    margin: var(--space-3) 0 0;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .search-controls .toggle-row {
    flex: none;
  }
  .folder-heading {
    width: 100%;
    min-height: var(--size-touch);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-sunken);
    color: var(--color-ink);
    text-align: left;
    font-size: var(--text-xl);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }
  .folder-heading-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-4) 0 var(--space-3);
  }
  .folder-heading-row .folder-heading,
  .unfiled-heading {
    flex: 1;
  }
  .unfiled-heading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
    padding: var(--space-3) var(--space-4);
    color: var(--color-muted);
    font-size: var(--text-xl);
    font-weight: var(--weight-medium);
  }
  .folder-chevron {
    display: inline-block;
    transition: transform var(--duration-fast) var(--easing-standard);
  }
  .folder-heading[aria-expanded='true'] .folder-chevron {
    transform: rotate(180deg);
  }
  .folder-count {
    margin-left: auto;
    color: var(--color-muted);
  }
  .folder-select {
    flex: none;
    padding-inline: var(--space-3);
  }
  .collection-card.selectable {
    cursor: pointer;
    padding-left: calc(var(--space-5) + var(--size-touch));
  }
  .collection-card.is-selected {
    border-color: var(--color-ballpoint);
  }
  .selection-checkbox {
    position: absolute;
    top: var(--space-5);
    left: var(--space-4);
    display: grid;
    place-items: center;
    width: var(--size-touch);
    height: var(--size-touch);
    border: var(--border);
    border-radius: var(--radius-round);
    background: var(--color-card);
    color: var(--color-ballpoint);
    font-weight: var(--weight-bold);
    cursor: pointer;
    pointer-events: none;
  }
  .selection-bar {
    position: fixed;
    z-index: var(--z-bottom-bar);
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: var(--size-bottom-bar);
    padding: var(--space-3) max(var(--space-5), env(safe-area-inset-left))
      calc(var(--space-3) + env(safe-area-inset-bottom)) max(var(--space-5), env(safe-area-inset-right));
    border-top: var(--border);
    background: var(--color-card);
  }
  .selection-actions {
    display: flex;
    gap: var(--space-2);
  }
  @media (max-width: 430px) {
    .search-controls {
      flex-wrap: wrap;
    }
    .search-row {
      flex-basis: auto;
    }
    .page-heading {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .page-heading-actions {
      width: 100%;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .select-action {
      min-width: 0;
    }
    .selection-bar {
      padding-inline: var(--space-3);
    }
    .selection-actions {
      gap: var(--space-2);
    }
    .selection-actions :global(.button) {
      padding-inline: var(--space-3);
    }
    .folder-select {
      padding-inline: var(--space-3);
    }
  }
  .status-trigger {
    position: absolute;
    top: var(--space-5);
    right: var(--space-8);
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  @media (max-width: 430px) {
    .status-trigger {
      right: var(--space-8);
    }
  }
</style>
