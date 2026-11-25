<script lang="ts">
  import Button from '../ui/Button.svelte'
  let { label = 'Sync now' }: { label?: string } = $props()
  let busy = $state(false)
  async function sync() {
    busy = true
    try {
      const { syncEngine } = await import('$lib/sync')
      await syncEngine.syncNow()
    } finally {
      busy = false
    }
  }
</script>

<span class="sync-now-button"
  ><Button variant="quiet" disabled={busy} onclick={() => void sync()}>{busy ? 'Syncing…' : label}</Button
  ></span
>

<style>
  .sync-now-button :global(.button) {
    min-width: var(--size-sync-action);
    white-space: nowrap;
  }
</style>
