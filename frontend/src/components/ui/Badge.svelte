<script lang="ts">
  import type { StorageMode } from '$lib/types'
  let { mode }: { mode: StorageMode } = $props()
</script>

<span class="badge {mode}">{mode === 'local_only' ? 'Local Only' : 'Synced'}</span>
