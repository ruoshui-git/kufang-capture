<script lang="ts">
  import { onMount } from 'svelte'
  import type { SyncConflict } from '$lib/sync/api'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  let { open = $bindable(false) }: { open?: boolean } = $props()
  let conflicts = $state<SyncConflict[]>([])
  let engine: typeof import('$lib/sync').syncEngine | null = null
  let busy = $state(false)
  onMount(() => {
    let stop: (() => void) | undefined
    void import('$lib/sync').then(({ syncEngine }) => {
      engine = syncEngine
      const sub = syncEngine.conflicts.subscribe((rows) => (conflicts = rows))
      stop = typeof sub === 'function' ? sub : sub?.unsubscribe ? () => sub.unsubscribe() : undefined
    })
    return () => stop?.()
  })
  async function resolve(id: string, choice: 'mine' | 'server') {
    busy = true
    try {
      const resolvedEngine = engine ?? (await import('$lib/sync')).syncEngine
      await resolvedEngine.resolveConflict(id, choice)
    } finally {
      busy = false
    }
  }
</script>

<Sheet bind:open title="Resolve conflicts">
  {#snippet children()}
    {#if conflicts.length === 0}<p>No conflicts need a decision.</p>{/if}
    {#each conflicts as conflict (conflict.id)}
      <section class="conflict">
        <h3>{conflict.entity} — {conflict.entity_id}</h3>
        {#each conflict.fields as field (field)}
          <div class="field">
            <strong>{field}</strong>
            <div><span>On this device</span><code>{String(conflict.local_values[field] ?? '—')}</code></div>
            <div><span>On server</span><code>{String(conflict.server_values[field] ?? '—')}</code></div>
          </div>
        {/each}
        <div class="actions">
          <Button variant="quiet" disabled={busy} onclick={() => void resolve(conflict.id, 'server')}
            >Use server</Button
          ><Button disabled={busy} onclick={() => void resolve(conflict.id, 'mine')}>Keep mine</Button>
        </div>
      </section>
    {/each}
  {/snippet}
</Sheet>

<style>
  .conflict {
    padding: var(--space-4) 0;
    border-top: 1px solid var(--color-line);
  }
  h3 {
    margin: 0 0 var(--space-3);
    text-transform: capitalize;
  }
  .field {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    padding: var(--space-3) 0;
  }
  .field > strong {
    grid-column: 1/-1;
  }
  .field div {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  .field span {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  code {
    overflow-wrap: anywhere;
    font: inherit;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
</style>
