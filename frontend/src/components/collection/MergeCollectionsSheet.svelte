<script lang="ts">
  import { repo } from '$lib/db'
  import type { CollectionSummary, Id } from '$lib/types'
  import { showToast } from '../../app/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import Sheet from '../ui/Sheet.svelte'

  let { selected, open = $bindable(false) }: { selected: CollectionSummary[]; open?: boolean } = $props()
  let targetId = $state('')
  let busy = $state(false)
  let error = $state('')
  const modesMatch = $derived(new Set(selected.map((item) => item.collection.storage_mode)).size <= 1)
  const target = $derived(selected.find((item) => item.collection.id === targetId))
  const sources = $derived(selected.filter((item) => item.collection.id !== targetId))

  $effect(() => {
    if (!open || selected.length < 2) return
    const oldest = [...selected].sort((a, b) =>
      a.collection.created_at.localeCompare(b.collection.created_at),
    )[0]
    targetId = oldest?.collection.id ?? ''
    error = ''
  })

  async function merge() {
    if (!target || !modesMatch || busy) return
    busy = true
    error = ''
    try {
      await repo.mergeCollections(
        target.collection.id,
        sources.map((item) => item.collection.id),
      )
      open = false
      showToast({
        message: `Merged ${selected.length} collections into "${target.collection.name}". The others are archived.`,
      })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }
</script>

<Sheet bind:open title="Merge collections">
  {#snippet children()}
    <fieldset class="target-list">
      <legend>Keep this collection</legend>
      {#each selected as item (item.collection.id)}
        <label class="target-row">
          <input type="radio" name="merge-target" value={item.collection.id} bind:group={targetId} />
          <span
            ><strong>{item.collection.name}</strong><small
              >{item.entry_count} {item.entry_count === 1 ? 'entry' : 'entries'}</small
            ></span
          >
        </label>
      {/each}
    </fieldset>
    {#each sources as source (source.collection.id)}
      <p class="summary">
        {source.entry_count}
        {source.entry_count === 1 ? 'entry' : 'entries'} from {source.collection.name}
        {source.entry_count === 1 ? 'moves' : 'move'} into {target?.collection.name ?? 'the target'}.
      </p>
    {/each}
    {#if !modesMatch}<p class="blocked" role="alert">Collections must use the same storage mode.</p>{/if}
    {#if error}<p class="blocked" role="alert">{error}</p>{/if}
    <div class="actions">
      <Button disabled={!modesMatch || !target || busy} onclick={() => void merge()}
        >{busy ? 'Merging…' : 'Merge collections'}</Button
      >
    </div>
  {/snippet}
</Sheet>

<style>
  .target-list {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--space-3);
    font-weight: var(--weight-medium);
  }
  .target-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--size-touch);
    padding: var(--space-3);
    border: var(--border);
    border-radius: var(--radius-md);
  }
  .target-row span {
    display: grid;
  }
  .target-row small,
  .summary {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .summary {
    margin: var(--space-3) 0;
  }
  .blocked {
    color: var(--color-danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-4);
  }
</style>
