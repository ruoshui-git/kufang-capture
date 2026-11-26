<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { repo } from '$lib/db'
  import { entryDisplayTitle, formatSequence, type StarredRow } from '$lib/types'
  import ThumbnailStrip from '../../components/entry/ThumbnailStrip.svelte'
  import { navigate } from '../../app/router.svelte'
  let rows = $state<StarredRow[]>([])
  $effect(() => {
    const subscription = repo.watchStarredRows().subscribe((value) => (rows = value))
    return () => (typeof subscription === 'function' ? subscription() : subscription.unsubscribe())
  })
  const groups = $derived.by(() => {
    const grouped = new Map<string, { collection: StarredRow['collection']; rows: StarredRow[] }>()
    for (const row of rows) {
      const group = grouped.get(row.collection.id) ?? { collection: row.collection, rows: [] }
      group.rows.push(row)
      grouped.set(row.collection.id, group)
    }
    return [...grouped.values()]
  })
  const notesFor = (row: StarredRow) =>
    [row.entry.notes, row.entry.entry_notes]
      .map((note) => note?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .join(' · ')
</script>

<svelte:head><title>{m.shell_page_title({ title: m.shell_starred() })}</title></svelte:head>
<section class="page">
  <a class="starred-back" href="/">{m.shell_starred_back()}</a>
  <h1>{m.shell_starred()}</h1>
  {#if !rows.length}
    <p>{m.shell_starred_empty()}</p>
  {:else}
    {#each groups as group (group.collection.id)}
      <section class="starred-group">
        <h2>
          {group.collection.name}{#if group.collection.folder}<small>{group.collection.folder}</small>{/if}
          {#if group.collection.status === 'archived'}<small class="archived-note">{m.shell_archived()}</small
            >{/if}
        </h2>
        {#each group.rows as row (row.entry.id)}
          <div class="starred-row">
            <ThumbnailStrip
              photos={row.recent_photos.slice(0, 1)}
              total={row.photo_count}
              onopen={() => navigate(`/c/${row.entry.collection_id}/e/${row.entry.id}`)}
              onmore={() => navigate(`/c/${row.entry.collection_id}/e/${row.entry.id}`)}
            />
            <a href="/c/{row.entry.collection_id}/e/{row.entry.id}">
              <span class="starred-title-row">
                <span class="sequence-label">{formatSequence(row.entry.sequence_number)}</span>
                <span class="entry-title">{entryDisplayTitle(row.entry)}</span>
                {#if row.entry.review_status === 'needs_review'}<span class="review-badge"
                    >{m.shell_needs_review()}</span
                  >{/if}
              </span>
              {#if notesFor(row)}<span class="entry-notes">{notesFor(row)}</span>{/if}
            </a><button
              aria-label={m.shell_unstar_entry()}
              aria-pressed="true"
              onclick={() => void repo.setEntryStarred(row.entry.id, false)}>★</button
            >
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</section>

<style>
  .starred-group {
    margin-top: var(--space-5);
  }
  .starred-back {
    display: inline-block;
    min-height: var(--size-touch);
    padding: var(--space-2) 0;
    color: var(--color-ballpoint);
    text-decoration: none;
  }
  .starred-group h2 {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .starred-group small {
    color: var(--color-muted);
    font: var(--weight-regular) var(--text-sm) var(--font-body);
  }
  .starred-group .archived-note {
    border-radius: var(--radius-pill);
    background: var(--color-sunken);
    padding: var(--space-1) var(--space-3);
  }
  .starred-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--size-touch);
    border-bottom: var(--border);
  }
  .starred-row :global(.thumb-strip) {
    flex: 0 0 var(--size-thumb);
  }
  .starred-row a {
    display: grid;
    flex: 1;
    gap: var(--space-1);
    min-width: 0;
    color: var(--color-ink);
    text-decoration: none;
  }
  .starred-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .entry-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-notes {
    display: -webkit-box;
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--text-sm);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .sequence-label {
    flex: none;
    border-radius: var(--radius-md);
    background: var(--color-tag);
    color: var(--color-tag-ink);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
  .review-badge {
    border-radius: var(--radius-pill);
    background: var(--color-warn-soft);
    color: var(--color-warn);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }
  :global([lang='zh-CN']) .review-badge,
  :global([lang='zh-CN']) .archived-note {
    white-space: nowrap;
  }
  .starred-row button {
    min-width: var(--size-touch);
    min-height: var(--size-touch);
    border: 0;
    background: transparent;
    color: var(--color-warn);
  }
</style>
