<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
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
  import { accountAuthenticated } from '$lib/sync/account'

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
      ? m.shell_collection_search_count({ shown: displayedItems.length, total: summaries.length })
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
        showToast({ message: m.shell_collection_updated() })
      } else {
        const created = await repo.createCollection({
          name: name.trim(),
          description: description.trim(),
          folder: folder.trim(),
          storage_mode: storageMode,
        })
        await repo.setSetting(SETTING_KEYS.lastStorageMode, storageMode)
        if (storageMode === 'synced') {
          if ($accountAuthenticated === false) {
            showToast({
              message: m.shell_collection_created_signed_out(),
              actionLabel: m.shell_sign_in(),
              action: () => navigate(`/login?return=${encodeURIComponent(`/c/${created.id}`)}`),
            })
          } else {
            showToast({
              message:
                $accountAuthenticated === true
                  ? m.shell_collection_created_online()
                  : m.shell_collection_created_offline(),
            })
          }
        }
        void repo.requestPersistentStorage()
        sheetOpen = false
        navigate(`/c/${created.id}`)
        return
      }
      sheetOpen = false
    } catch (cause) {
      error = m.shell_collection_save_failed()
    } finally {
      saving = false
    }
  }
  async function toggleArchive(item: CollectionSummary) {
    if (item.collection.status === 'archived') {
      await repo.unarchiveCollection(item.collection.id)
      showToast({ message: m.shell_collection_restored() })
    } else {
      await repo.archiveCollection(item.collection.id)
      showToast({
        message: m.shell_collection_archived(),
        actionLabel: m.shell_undo(),
        action: () => void repo.unarchiveCollection(item.collection.id),
      })
    }
  }
</script>

<svelte:head><title>{m.shell_page_title({ title: m.shell_collections() })}</title></svelte:head>
<svelte:window onkeydown={selectionKeydown} />
<section class="page collections-page">
  <div class="page-heading">
    <div>
      <h1>{m.shell_collections()}</h1>
      <div class="summary-copy" aria-label={m.shell_collection_summary()}>
        <span class="summary-chip">{m.shell_collection_count({ count: summaries.length })}</span>
        <span class="summary-chip">{m.shell_entry_count({ count: totalEntries })}</span>
      </div>
    </div>
    <div class="page-heading-actions">
      {#if selectionMode}
        <button class="button quiet" type="button" onclick={leaveSelection}
          >{m.shell_cancel_selection()}</button
        >
      {:else}
        <button
          bind:this={selectButton}
          class="button quiet select-action"
          type="button"
          onclick={enterSelection}>{m.shell_select()}</button
        >
      {/if}
      <a class="button quiet" href="/starred">{m.shell_starred_link()}</a>
      <a
        class="button quiet icon-link"
        href="/settings"
        aria-label={m.shell_settings()}
        title={m.shell_settings()}><SettingsIcon size={20} aria-hidden="true" /></a
      >
      <button
        class="button ink new-collection-action"
        type="button"
        aria-label={m.shell_new_collection()}
        onclick={openNew}
      >
        <span aria-hidden="true">{m.shell_new_short()}</span>
      </button>
    </div>
  </div>
  <div class="search-controls">
    <div class="search-row">
      <input
        bind:this={searchInput}
        type="search"
        aria-label={m.shell_search_collections()}
        placeholder={m.shell_search_collections()}
        enterkeyhint="search"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={search}
        onkeydown={searchKeydown}
      />
    </div>
    <label class="toggle-row"
      ><input type="checkbox" bind:checked={includeArchived} /> {m.shell_show_archived()}</label
    >
  </div>
  <p class="search-status" aria-live="polite">{searchStatus}</p>
  {#if summaries.length === 0}
    <EmptyState title={includeArchived ? m.shell_no_archived_collections() : m.shell_no_collections_yet()}
      >{m.shell_collections_empty_hint()}</EmptyState
    >
  {:else}
    {#if searching && displayedItems.length === 0}
      <EmptyState title={m.shell_collections_no_match({ query: search.trim() })}>
        <button class="button quiet" type="button" onclick={clearSearch}>{m.shell_clear_search()}</button>
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
                {group.items.every((item) => selectedIds.includes(item.collection.id))
                  ? m.shell_clear_folder_selection()
                  : m.shell_select_all()}
              </button>
            {/if}
          </div>{:else if groups.length > 1}<div class="folder-heading-row">
            <h2 class="unfiled-heading">
              {m.shell_not_in_folder()} <span class="chip folder-count">{group.items.length}</span>
            </h2>
            {#if selectionMode}
              <button
                class="button quiet folder-select"
                type="button"
                onclick={() => toggleFolderSelection(group.items)}
              >
                {group.items.every((item) => selectedIds.includes(item.collection.id))
                  ? m.shell_clear_folder_selection()
                  : m.shell_select_all()}
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
                      <span class="stat-chip">{m.shell_entry_count({ count: item.entry_count })}</span>
                      <span class="stat-chip">{m.shell_photo_count({ count: item.photo_count })}</span>
                      <span class="stat-chip" class:incomplete={item.incomplete_count > 0}
                        >{m.shell_incomplete_count({ count: item.incomplete_count })}</span
                      >
                    </span>
                    <span class="collection-updated"
                      >{m.shell_updated_at({ time: relativeTime(item.last_activity_at) })}</span
                    >
                  </div>{:else}<a
                    class="collection-open"
                    href="/c/{item.collection.id}"
                    aria-label={m.shell_open_collection({ name: item.collection.name })}
                  >
                    <span class="collection-title-row">
                      <span class="collection-title">{item.collection.name}</span>
                    </span>
                    <span class="collection-meta">
                      <span class="stat-chip">{m.shell_entry_count({ count: item.entry_count })}</span>
                      <span class="stat-chip">{m.shell_photo_count({ count: item.photo_count })}</span>
                      <span class="stat-chip" class:incomplete={item.incomplete_count > 0}>
                        {m.shell_incomplete_count({ count: item.incomplete_count })}
                      </span>
                    </span>
                    <span class="collection-updated"
                      >{m.shell_updated_at({ time: relativeTime(item.last_activity_at) })}</span
                    >
                  </a>{/if}
                {#if !selectionMode}
                  <button
                    class="status-trigger"
                    type="button"
                    aria-label={m.shell_show_sync_conflicts()}
                    onclick={() => void openConflicts()}
                    ><SyncStatusChip
                      collectionId={item.collection.id}
                      mode={item.collection.storage_mode}
                      pendingCount={item.pending_sync_count}
                      pendingBytes={item.pending_upload_bytes}
                    /></button
                  >
                  <div class="collection-card-menu">
                    <Menu label={m.shell_collection_actions_for({ name: item.collection.name })}>
                      <button role="menuitem" onclick={() => openEdit(item)}>{m.shell_rename_edit()}</button>
                      <button role="menuitem" onclick={() => toggleArchive(item)}>
                        {item.collection.status === 'archived' ? m.shell_unarchive() : m.shell_archive()}
                      </button>
                      <button
                        role="menuitem"
                        onclick={() => {
                          selected = item
                          exportOpen = true
                        }}>{m.shell_export_zip()}</button
                      >
                      <button
                        role="menuitem"
                        onclick={() => {
                          selected = item
                          storageOpen = true
                        }}>{m.shell_change_storage_mode()}</button
                      >
                      <button
                        role="menuitem"
                        onclick={() => {
                          selected = item
                          clearOpen = true
                        }}>{m.shell_clear_from_device()}</button
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
  <div class="selection-bar" role="region" aria-label={m.shell_export_selected()}>
    <span aria-live="polite">{m.shell_selected_count({ count: selectedIds.length })}</span>
    <div class="selection-actions">
      <Button variant="quiet" disabled={selectedIds.length < 2} onclick={() => (mergeOpen = true)}
        >{m.shell_merge_action()}</Button
      >
      <Button disabled={selectedIds.length === 0} onclick={openSelectedExport}>{m.shell_export_zip()}</Button>
      <Button variant="quiet" onclick={leaveSelection}>{m.shell_cancel()}</Button>
    </div>
  </div>
{/if}
{#if mergeOpen && selectedInDisplayOrder.length >= 2}
  <MergeCollectionsSheet bind:open={mergeOpen} selected={selectedInDisplayOrder} />
{/if}
<Sheet bind:open={sheetOpen} title={editing ? m.shell_edit_collection() : m.shell_new_collection()}>
  {#snippet children()}
    <form class="collection-form" onsubmit={save}>
      <TextField
        label={m.shell_name()}
        bind:value={name}
        required
        placeholder={m.shell_collection_name_example()}
      />
      <label class="field"
        >{m.shell_folder()}
        <input
          aria-label={m.shell_folder()}
          bind:value={folder}
          list="collection-folders"
          placeholder={m.shell_unfiled()}
        /></label
      >
      <datalist id="collection-folders"
        >{#each [...new Set(summaries
              .map((item) => item.collection.folder ?? '')
              .filter(Boolean))] as existing}<option value={existing}></option>{/each}</datalist
      >
      <label class="field"
        >{m.shell_description()}
        <textarea bind:value={description} rows="3" placeholder={m.shell_optional_details()}
        ></textarea></label
      >
      {#if !editing}
        <fieldset class="storage-choice">
          <legend>{m.shell_storage()}</legend>
          <label class="choice"
            ><input type="radio" name="storage-mode" value="local_only" bind:group={storageMode} /><span
              ><strong>{m.shell_local_only()}</strong><small>{m.shell_local_only_description()}</small></span
            ></label
          >
          <label class="choice"
            ><input type="radio" name="storage-mode" value="synced" bind:group={storageMode} /><span
              ><strong>{m.shell_sync_to_server()}</strong><small>{m.shell_sync_to_server_description()}</small
              ></span
            ></label
          >
        </fieldset>
      {/if}
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
      {#if !editing && !name.trim()}
        <p class="form-hint">{m.shell_enter_collection_name()}</p>
      {/if}
      <div class="form-actions">
        <Button variant="quiet" onclick={() => (sheetOpen = false)}>{m.shell_cancel()}</Button><Button
          type="submit"
          disabled={!name.trim() || saving}
          >{saving
            ? m.shell_saving()
            : editing
              ? m.shell_save_changes()
              : m.shell_create_collection()}</Button
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
      ? m.shell_export_selected_title({ count: selectedIds.length })
      : selected
        ? m.shell_export_named({ name: selected.collection.name })
        : m.shell_export_zip()}
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
    :global([lang='zh-CN']) .page-heading-actions .button:not(.icon-link) {
      padding-inline: var(--space-3);
    }
    :global([lang='zh-CN']) .collection-form {
      gap: var(--space-3);
    }
    :global([lang='zh-CN'] dialog.sheet):has(.collection-form) {
      max-height: calc(100dvh - var(--space-5));
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
