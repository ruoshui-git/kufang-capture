<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { StorageMode } from '$lib/types'
  let { mode }: { mode: StorageMode } = $props()
</script>

<span class="badge {mode}">{mode === 'local_only' ? m.account_local_only() : m.account_synced()}</span>
