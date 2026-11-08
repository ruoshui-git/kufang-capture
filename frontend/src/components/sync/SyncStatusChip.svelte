<script lang="ts">
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
      unsubscribe = typeof sub === 'function' ? sub : () => sub.unsubscribe()
    })
    return () => unsubscribe?.()
  })
  const chipState = $derived.by(() => {
    if (mode === 'local_only') return { text: 'Local Only', kind: 'local' }
    const item = syncStatus?.per_collection[collectionId]
    if (item?.conflicts) return { text: `Conflict (${item.conflicts})`, kind: 'error' }
    if (item?.errors || syncStatus?.phase === 'error')
      return { text: 'Sync error — tap to retry', kind: 'error' }
    if (syncStatus?.authenticated === false || syncStatus?.phase === 'signed_out')
      return { text: 'Sign in to sync', kind: 'warn' }
    if (syncStatus?.phase === 'syncing') return { text: 'Syncing', kind: 'syncing' }
    const uploads = item?.pending_uploads ?? pendingCount
    const bytes = item?.pending_upload_bytes ?? pendingBytes
    if (uploads > 0 || item?.pending_mutations) {
      const mb = bytes / (1024 * 1024)
      return {
        text: uploads
          ? `${uploads} photos pending (${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB)`
          : 'Sync pending',
        kind: 'warn',
      }
    }
    return { text: 'Backed up', kind: 'ok' }
  })
</script>

<span class="status-chip {chipState.kind}" role="status">{chipState.text}</span>

<style>
  .status-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 4px 9px;
    font-size: 13px;
    line-height: 1.3;
  }
  .local {
    color: var(--color-local);
    border-color: color-mix(in srgb, var(--color-local) 35%, var(--color-line));
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
</style>
