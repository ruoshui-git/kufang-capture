<script lang="ts">
  import type { Id, Movement } from '$lib/types'
  import { formatSequence } from '$lib/types'
  import Button from '../../components/ui/Button.svelte'

  let { entryId, movements }: { entryId: Id; movements: Movement[] } = $props()
  let showUndone = $state(false)
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  const hasUndone = $derived(movements.some((movement) => movement.undone_at !== null))
  const visible = $derived(movements.filter((movement) => showUndone || !movement.undone_at))

  function description(movement: Movement) {
    const from = movement.from_name + ' ' + formatSequence(movement.from_sequence)
    const to = movement.to_name + ' ' + formatSequence(movement.to_sequence)
    const count = [movement.quantity, movement.unit].filter(Boolean).join(' ')
    if (movement.from_entry_id === entryId) return '→ ' + (count ? count + ' to ' : 'To ') + to
    if (movement.to_entry_id === entryId) return (count ? count + ' from ' : 'From ') + from
    return (count ? count + ' from ' : 'From ') + from + ' → ' + to
  }
</script>

<section class="history" aria-label="History">
  <h2>History</h2>
  {#if visible.length > 0}
    <ol>
      {#each visible as movement (movement.id)}
        <li class:undone={movement.undone_at !== null}>
          <time datetime={movement.moved_at}>{dateFormat.format(new Date(movement.moved_at))}</time>
          · {description(movement)}{#if movement.count_detail}
            · {movement.count_detail}{/if}
          {#if movement.to_entry_id === entryId && movement.target_before_quantity !== null}
            <span class="previous"> · Already here: {movement.target_before_quantity}</span>
          {/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p>No moves yet</p>
  {/if}
  {#if hasUndone}
    <Button variant="quiet" onclick={() => (showUndone = !showUndone)}>
      {showUndone ? 'Hide undone' : 'Show undone'}
    </Button>
  {/if}
</section>

<style>
  .history {
    margin-top: var(--space-6);
    padding: var(--space-4);
    border: var(--border);
    border-radius: var(--radius-lg);
    background: var(--color-card);
    font-size: var(--text-md);
  }
  h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-xl);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li + li {
    border-top: var(--border);
  }
  li {
    overflow-wrap: anywhere;
    padding: var(--space-2) 0;
  }
  time,
  p,
  .previous {
    color: var(--color-muted);
  }
  p {
    margin: 0;
  }
  .undone {
    color: var(--color-muted);
    text-decoration: line-through;
  }
</style>
