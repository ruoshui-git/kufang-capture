<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import type { StorageMode } from '$lib/types'
  import type { SyncStatus } from '$lib/sync/api'
  let {
    collectionId,
    mode,
    pendingCount = 0,
    pendingBytes = 0,
  }: { collectionId: string; mode: StorageMode; pendingCount?: number; pendingBytes?: number } = $props()
  let syncStatus = $state<SyncStatus | null>(null)
  onMount(() => {
    // Keep repository-only component tests isolated; production repo always has this method.
    if (typeof repo.readForExport !== 'function') return
    let unsubscribe: (() => void) | undefined
    void import('$lib/sync').then(({ syncEngine }) => {
      const sub = syncEngine.status.subscribe((value) => (syncStatus = value))
      unsubscribe = typeof sub === 'function' ? sub : sub?.unsubscribe ? () => sub.unsubscribe() : undefined
    })
    return () => unsubscribe?.()
  })
  const chipState = $derived.by(() => {
    if (mode === 'local_only') return { text: m.account_local_only(), kind: 'neutral' }
    if (syncStatus?.phase === 'blocked') return { text: m.account_sync_blocked(), kind: 'error' }
    const item = syncStatus?.per_collection[collectionId]
    if (item?.conflicts)
      return { text: m.account_sync_conflict_count({ count: item.conflicts }), kind: 'error' }
    if (item?.errors || syncStatus?.phase === 'error')
      return { text: m.account_sync_error_retry(), kind: 'error' }
    if (syncStatus?.authenticated === false || syncStatus?.phase === 'signed_out')
      return { text: m.account_sign_in_to_sync(), kind: 'warn' }
    const uploads = item?.pending_uploads ?? pendingCount
    const bytes = item?.pending_upload_bytes ?? pendingBytes
    const progress = syncStatus?.upload_progress
    if (syncStatus?.phase === 'syncing') {
      const ordinal = progress?.per_collection[collectionId]
      if (progress && ordinal)
        return {
          text: m.account_sync_uploading_photo({ ...ordinal, percent: progress.percent }),
          kind: 'syncing',
        }
      if (!progress || uploads === 0) return { text: m.account_syncing(), kind: 'syncing' }
    }
    if (uploads > 0 || item?.pending_mutations) {
      const mb = bytes / (1024 * 1024)
      return {
        text: uploads
          ? m.account_sync_pending_photos({
              photos: m.account_photos({ count: uploads }),
              size: m.account_size_megabytes({ amount: mb < 10 ? mb.toFixed(1) : Math.round(mb) }),
            })
          : m.account_sync_pending(),
        kind: 'warn',
      }
    }
    return { text: m.account_backed_up(), kind: 'ok' }
  })
</script>

<span class="status-chip {chipState.kind}" role="status" aria-label={chipState.text} title={chipState.text}
  >{chipState.text}</span
>

<style>
  .status-chip {
    box-sizing: border-box;
    display: inline-flex;
    width: 100%;
    min-width: 0;
    max-width: var(--size-sync-chip);
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-pill);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    line-height: 1.3;
  }
  .neutral {
    color: var(--color-muted);
    background: var(--color-sunken);
  }
  .ok {
    color: var(--color-ok);
  }
  .warn {
    color: var(--color-warn);
  }
  .error {
    color: var(--color-danger);
  }
  .syncing {
    color: var(--color-ballpoint);
  }
  .ok {
    background: var(--color-ok-soft);
  }
  .warn {
    background: var(--color-warn-soft);
  }
  .error {
    background: var(--color-danger-soft);
  }
</style>
