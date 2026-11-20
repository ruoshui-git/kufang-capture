<script lang="ts">
  import { repo } from '$lib/db'
  import type { CollectionSummary, EntryView } from '$lib/types'
  import { SETTING_KEYS, formatSequence } from '$lib/types'
  import { normalizeQuantityInput } from '$lib/entries/autosave'
  import { addDecimals } from '$lib/summary'
  import { navigate } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import Sheet from '../ui/Sheet.svelte'
  let {
    open = $bindable(false),
    entryId,
    onmoved,
    beforemove,
  }: {
    open?: boolean
    entryId: string
    onmoved?: (result: { partial: boolean }) => void
    /** Saves pending edits first, so they land on the entry before it moves. */
    beforemove?: () => Promise<void>
  } = $props()
  let collections = $state<CollectionSummary[]>([])
  let entry = $state<EntryView | undefined>()
  let query = $state('')
  let amountInput = $state('')
  let recent = $state<string[]>([])
  // Subscribe only while open: every entry row mounts this sheet, and a live summary query per row
  // re-ran on every write, which made long lists slow.
  $effect(() => {
    if (!open) return
    const sub = repo
      .watchCollectionSummaries({ includeArchived: false })
      .subscribe((items) => (collections = items))
    return () => (typeof sub === 'function' ? sub() : sub.unsubscribe())
  })
  $effect(() => {
    if (open) {
      void repo.getEntry(entryId).then((value) => {
        entry = value
        amountInput = value?.quantity ?? ''
      })
      void repo.getSetting<string[]>(SETTING_KEYS.recentMoveTargets, []).then((value) => (recent = value))
    }
  })
  const eligible = $derived(
    collections.filter(
      (item) =>
        item.collection.id !== entry?.collection_id &&
        item.collection.storage_mode ===
          collections.find((c) => c.collection.id === entry?.collection_id)?.collection.storage_mode &&
        item.collection.status === 'active' &&
        item.collection.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  )
  const totalAmount = $derived(entry ? normalizeQuantityInput(entry.quantity ?? '') : null)
  const amount = $derived(normalizeQuantityInput(amountInput))
  const remainder = $derived(
    totalAmount !== null && totalAmount !== undefined && amount !== null && amount !== undefined
      ? addDecimals(totalAmount, `-${amount}`)
      : null,
  )
  const hasRecordedAmount = $derived(
    totalAmount !== null &&
      totalAmount !== undefined &&
      /^\d+(?:\.\d+)?$/.test(totalAmount) &&
      /[1-9]/.test(totalAmount),
  )
  const amountValid = $derived(
    !hasRecordedAmount ||
      (amount !== null &&
        amount !== undefined &&
        /[1-9]/.test(amount) &&
        !!remainder &&
        !remainder.startsWith('-')),
  )
  const amountError = $derived(
    amountValid
      ? ''
      : amount === null || amountInput.trim() === ''
        ? 'Enter an amount greater than zero.'
        : amount === undefined
          ? 'Enter a valid decimal amount.'
          : !/[1-9]/.test(amount)
            ? 'Amount must be greater than zero.'
            : 'Amount cannot exceed the recorded quantity.',
  )
  const recentItems = $derived(
    recent
      .map((id) => eligible.find((item) => item.collection.id === id))
      .filter((item): item is CollectionSummary => !!item),
  )
  const others = $derived(
    eligible.filter(
      (item) => !recentItems.some((recentItem) => recentItem.collection.id === item.collection.id),
    ),
  )
  async function move(target: CollectionSummary['collection']) {
    if (!entry) return
    try {
      await beforemove?.()
      if (!amountValid) return
      const partial = hasRecordedAmount && remainder !== '0'
      const result = partial
        ? await repo.moveEntryPart(target.id, entry.id, amount!)
        : await repo.moveEntries(target.id, [entry.id])
      const placed = [...result.created, ...result.restored, ...result.merged_into_existing][0]
      if (!placed) return
      recent = [target.id, ...recent.filter((id) => id !== target.id)].slice(0, 5)
      await repo.setSetting(SETTING_KEYS.recentMoveTargets, [...recent])
      open = false
      onmoved?.({ partial })
      const amountText = `${amount ?? ''}${entry.unit ? ` ${entry.unit}` : ''}`
      showToast({
        message: `${partial ? `Moved ${amountText} to "${target.name}"` : `Moved to "${target.name}"`} as ${formatSequence(placed.sequence_number)}${result.merged_into_existing.length ? ' (added to the entry already there)' : ''}`,
        actions: [
          {
            label: 'Undo',
            action: async () => {
              try {
                await repo.undoMove(result.undo)
                showToast({ message: 'Move undone' })
              } catch (error) {
                showToast({ message: error instanceof Error ? error.message : 'Could not undo move' })
              }
            },
          },
          { label: 'Open', action: () => navigate(`/c/${target.id}/e/${placed.id}`) },
        ],
      })
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : 'Could not move entry' })
    }
  }
</script>

<Sheet bind:open title={entry ? `Move ${formatSequence(entry.sequence_number)} to…` : 'Move to…'}>
  <div class="picker">
    {#if totalAmount !== null && totalAmount !== undefined && /^\d+(?:\.\d+)?$/.test(totalAmount) && /[1-9]/.test(totalAmount)}
      <div class="amount-field">
        <label for="move-amount">Amount to move</label>
        <div class="amount-control">
          <input
            id="move-amount"
            aria-label="Amount to move"
            inputmode="decimal"
            enterkeyhint="done"
            bind:value={amountInput}
          />
          {#if entry?.unit}<span>{entry.unit}</span>{/if}
        </div>
        <small>of {totalAmount}{entry?.unit ? ` ${entry.unit}` : ''}</small>
        {#if !amountValid}<small class="amount-error" role="alert">{amountError}</small>{/if}
      </div>
    {/if}
    <input class="search" aria-label="Search collections" placeholder="Search rooms" bind:value={query} />
    {#if recentItems.length}<h3>Recent</h3>
      {#each recentItems as item (item.collection.id)}<button
          class="destination"
          disabled={!amountValid}
          onclick={() => void move(item.collection)}
          ><span>{item.collection.name}</span><small>{item.entry_count} entries</small></button
        >{/each}{/if}
    {#each [...new Set(others.map((item) => item.collection.folder || 'Unfiled'))] as folder (folder)}<h3>
        {folder}
      </h3>
      {#each others.filter((item) => (item.collection.folder || 'Unfiled') === folder) as item (item.collection.id)}<button
          class="destination"
          disabled={!amountValid}
          onclick={() => void move(item.collection)}
          ><span>{item.collection.name}</span><small>{item.entry_count} entries</small></button
        >{/each}{/each}
    {#if eligible.length === 0}<p>
        No eligible collections. Collections must use the same storage mode.
      </p>{/if}
  </div>
</Sheet>

<style>
  .picker {
    display: grid;
    gap: var(--space-2);
    max-height: 70vh;
    overflow: auto;
    padding: var(--space-4);
  }
  .search {
    min-height: var(--size-touch);
    border: var(--border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-4);
    font: inherit;
  }
  .amount-field {
    display: grid;
    gap: var(--space-2);
  }
  .amount-field label {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }
  .amount-control {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-3);
  }
  .amount-control input {
    width: 100%;
    min-width: 0;
    min-height: var(--size-touch);
    border: var(--border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-4);
    background: var(--color-card);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--text-lg);
  }
  .amount-control span,
  .amount-field small {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .amount-field .amount-error {
    color: var(--color-danger);
  }
  h3 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-md);
  }
  .destination {
    min-height: var(--size-touch);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: var(--border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-4);
    background: var(--color-card);
    color: var(--color-ink);
    text-align: left;
  }
  .destination:disabled {
    opacity: 0.55;
  }
  small {
    color: var(--color-muted);
  }
</style>
