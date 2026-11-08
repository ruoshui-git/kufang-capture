<script lang="ts">
  import { syncEngine } from '$lib/sync'
  import Button from '../ui/Button.svelte'
  let { label = 'Sync now' }: { label?: string } = $props()
  let busy = $state(false)
  async function sync() {
    busy = true
    try {
      await syncEngine.syncNow()
    } finally {
      busy = false
    }
  }
</script>

<Button variant="quiet" disabled={busy} onclick={() => void sync()}>{busy ? 'Syncing…' : label}</Button>
