<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import { SETTING_KEYS, type CollectionSummary, type StorageMode } from '$lib/types'
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
  import { exportFromDevice } from '$lib/export/device'

  let summaries = $state<CollectionSummary[]>([])
  let includeArchived = $state(false)
  let sheetOpen = $state(false)
  let editing = $state<CollectionSummary | null>(null)
  let name = $state('')
  let description = $state('')
  let storageMode = $state<StorageMode>('local_only')
  let saving = $state(false)
  let error = $state('')
  let exporting = $state<string | null>(null)

  async function exportCollection(item: CollectionSummary) {
    if (exporting) return
    exporting = item.collection.id
    showToast({ message: `Preparing ZIP for ${item.collection.name}…` })
    try {
      const result = await exportFromDevice([item.collection.id])
      if (result.delivery !== 'cancelled') showToast({ message: `Exported ${result.filename}` })
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Export failed.', duration: 12000 })
    } finally {
      exporting = null
    }
  }

  onMount(() => {
    let subscription: Unsubscriber | { unsubscribe(): void } | undefined
    const observe = () => {
      if (typeof subscription === 'function') subscription()
      else subscription?.unsubscribe()
      subscription = repo
        .watchCollectionSummaries({ includeArchived })
        .subscribe((items) => (summaries = items))
    }
    observe()
    if (new URLSearchParams(window.location.search).get('new') === '1') void openNew()
    return () => {
      if (typeof subscription === 'function') subscription()
      else subscription?.unsubscribe()
    }
  })

  const totalEntries = $derived(summaries.reduce((sum, item) => sum + item.entry_count, 0))

  async function openNew() {
    editing = null
    name = ''
    description = ''
    storageMode = await repo.getSetting<StorageMode>(SETTING_KEYS.lastStorageMode, 'local_only')
    error = ''
    sheetOpen = true
  }
  function openEdit(item: CollectionSummary) {
    editing = item
    name = item.collection.name
    description = item.collection.description
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
        })
        showToast({ message: 'Collection updated' })
      } else {
        const created = await repo.createCollection({
          name: name.trim(),
          description: description.trim(),
          storage_mode: storageMode,
        })
        await repo.setSetting(SETTING_KEYS.lastStorageMode, storageMode)
        void repo.requestPersistentStorage()
        sheetOpen = false
        navigate(`/c/${created.id}`)
        return
      }
      sheetOpen = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this collection.'
    } finally {
      saving = false
    }
  }
  async function toggleArchive(item: CollectionSummary) {
    if (item.collection.status === 'archived') await repo.unarchiveCollection(item.collection.id)
    else await repo.archiveCollection(item.collection.id)
  }
</script>

<svelte:head><title>Collections · Kufang Capture</title></svelte:head>
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
    <button
      class="button ink new-collection-action"
      type="button"
      aria-label="New collection"
      onclick={openNew}
    >
      <span aria-hidden="true">+ New</span>
    </button>
  </div>
  <label class="toggle-row"><input type="checkbox" bind:checked={includeArchived} /> Show archived</label>
  {#if summaries.length === 0}
    <EmptyState title={includeArchived ? 'No archived collections' : 'No collections yet'}
      >Create a collection for a room or counting session. Add photos and counts as you work, even when you
      are offline.</EmptyState
    >
  {:else}
    <div class="collection-grid">
      {#each summaries as item (item.collection.id)}
        <article class="collection-card">
          <a class="collection-open" href="/c/{item.collection.id}" aria-label="Open {item.collection.name}">
            <span class="collection-title-row">
              <span class="collection-title">{item.collection.name}</span>
              <Badge mode={item.collection.storage_mode} />
            </span>
            <span class="collection-meta">
              <span class="stat-chip">{item.entry_count} {item.entry_count === 1 ? 'entry' : 'entries'}</span>
              <span class="stat-chip">{item.photo_count} {item.photo_count === 1 ? 'photo' : 'photos'}</span>
              <span class="stat-chip" class:incomplete={item.incomplete_count > 0}>
                {item.incomplete_count} incomplete
              </span>
            </span>
            <span class="collection-updated">Updated {relativeTime(item.last_activity_at)}</span>
          </a>
          <div class="collection-card-menu">
            <Menu label={`Actions for ${item.collection.name}`}>
              <button role="menuitem" onclick={() => openEdit(item)}>Rename / Edit</button>
              <button role="menuitem" onclick={() => toggleArchive(item)}>
                {item.collection.status === 'archived' ? 'Unarchive' : 'Archive'}
              </button>
              <button role="menuitem" disabled={!!exporting} onclick={() => exportCollection(item)}
                >Export ZIP</button
              >
              <button role="menuitem" disabled title="Coming soon"
                >Clear from this device… · Coming soon</button
              >
            </Menu>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>
<Sheet bind:open={sheetOpen} title={editing ? 'Edit collection' : 'New collection'}>
  {#snippet children()}
    <form class="collection-form" onsubmit={save}>
      <TextField label="Name" bind:value={name} required placeholder="e.g. Temple 2 / A04" />
      <label class="field"
        >Description <textarea bind:value={description} rows="3" placeholder="Optional details"
        ></textarea></label
      >
      {#if !editing}
        <fieldset class="storage-choice">
          <legend>Storage</legend>
          <label class="choice"
            ><input type="radio" name="storage-mode" value="local_only" bind:group={storageMode} /><span
              ><strong>Local Only</strong><small>Stays on this iPhone; export ZIPs to back up</small></span
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
