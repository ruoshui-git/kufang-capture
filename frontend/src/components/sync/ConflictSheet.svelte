<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { formatBytes, formatDate, formatDateTime } from '$lib/i18n/format'
  import { onMount } from 'svelte'
  import type { SyncConflict } from '$lib/sync/api'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  const entityLabels: Record<Exclude<SyncConflict['entity'], 'item'>, () => string> = {
    collection: m.account_conflict_entity_collection,
    entry: m.account_conflict_entity_entry,
    photo: m.account_conflict_entity_photo,
    movement: m.account_conflict_entity_movement,
  }
  const fieldLabels: Record<string, (() => string) | undefined> = {
    name: m.account_conflict_field_name,
    folder: m.account_conflict_field_folder,
    description: m.account_conflict_field_description,
    status: m.account_conflict_field_status,
    storage_mode: m.account_conflict_field_storage_mode,
    next_sequence_number: m.account_conflict_field_next_sequence_number,
    sort_order: m.account_conflict_field_sort_order,
    sync_consented_at: m.account_conflict_field_sync_consented_at,
    last_exported_at: m.account_conflict_field_last_exported_at,
    archived_at: m.account_conflict_field_archived_at,
    quantity: m.account_conflict_field_quantity,
    unit: m.account_conflict_field_unit,
    count_detail: m.account_conflict_field_count_detail,
    entry_notes: m.account_conflict_field_entry_notes,
    starred_at: m.account_conflict_field_starred_at,
    deleted_at: m.account_conflict_field_deleted_at,
    title: m.account_conflict_field_title,
    notes: m.account_conflict_field_notes,
    expiration_date: m.account_conflict_field_expiration_date,
    dimensions: m.account_conflict_field_dimensions,
    review_status: m.account_conflict_field_review_status,
    original_filename: m.account_conflict_field_original_filename,
    mime_type: m.account_conflict_field_mime_type,
    byte_size: m.account_conflict_field_byte_size,
    width: m.account_conflict_field_width,
    height: m.account_conflict_field_height,
    sha256: m.account_conflict_field_sha256,
    crc32: m.account_conflict_field_crc32,
    captured_at: m.account_conflict_field_captured_at,
    capture_source: m.account_conflict_field_capture_source,
    caption: m.account_conflict_field_caption,
    is_cover: m.account_conflict_field_is_cover,
    undone_at: m.account_conflict_field_undone_at,
  }
  const enumLabels: Record<string, Record<string, (() => string) | undefined> | undefined> = {
    status: { active: m.account_conflict_value_active, archived: m.account_conflict_value_archived },
    storage_mode: { local_only: m.account_local_only, synced: m.account_synced },
    review_status: {
      draft: m.account_conflict_value_draft,
      complete: m.account_conflict_value_complete,
      needs_review: m.account_conflict_value_needs_review,
    },
    capture_source: {
      native_camera: m.account_system_camera,
      photo_library: m.account_conflict_value_photo_library,
      camera_frame: m.account_conflict_value_camera_frame,
    },
  }
  const timestamps = new Set([
    'sync_consented_at',
    'last_exported_at',
    'archived_at',
    'starred_at',
    'deleted_at',
    'captured_at',
    'undone_at',
  ])

  function displayValue(field: string, value: unknown): string {
    if (getLocale() === 'en' || value == null) return String(value ?? '—')
    if (field === 'is_cover' && typeof value === 'boolean') return value ? m.account_yes() : m.account_no()
    if (field === 'byte_size' && typeof value === 'number') return formatBytes(value)
    if (typeof value === 'string') {
      if (field === 'expiration_date' && /^\d{4}-\d{2}-\d{2}$/.test(value))
        return formatDate(`${value}T00:00:00`)
      if (timestamps.has(field) && Number.isFinite(Date.parse(value))) return formatDateTime(value)
      const options = Object.hasOwn(enumLabels, field) ? enumLabels[field] : undefined
      if (options && Object.hasOwn(options, value)) return options[value]!()
    }
    return String(value)
  }
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

<Sheet bind:open title={m.account_resolve_conflicts()}>
  {#snippet children()}
    {#if conflicts.length === 0}<p>{m.account_conflicts_empty()}</p>{/if}
    {#each conflicts as conflict (conflict.id)}
      <section class="conflict">
        <h3>
          {conflict.entity === 'item'
            ? m.account_conflict_item_fields()
            : m.account_conflict_record({ entity: entityLabels[conflict.entity](), id: conflict.entity_id })}
        </h3>
        {#each conflict.fields as field (field)}
          <div class="field">
            <strong
              >{(Object.hasOwn(fieldLabels, field) ? fieldLabels[field]?.() : undefined) ??
                m.account_conflict_field_unknown()}</strong
            >
            <div>
              <span>{m.account_on_device()}</span><code
                >{displayValue(field, conflict.local_values[field])}</code
              >
            </div>
            <div>
              <span>{m.account_on_server()}</span><code
                >{displayValue(field, conflict.server_values[field])}</code
              >
            </div>
          </div>
        {/each}
        <div class="actions">
          <Button variant="quiet" disabled={busy} onclick={() => void resolve(conflict.id, 'server')}
            >{m.account_use_server()}</Button
          ><Button disabled={busy} onclick={() => void resolve(conflict.id, 'mine')}
            >{m.account_keep_mine()}</Button
          >
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
