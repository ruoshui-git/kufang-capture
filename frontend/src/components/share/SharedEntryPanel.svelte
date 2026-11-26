<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { entryDisplayTitle } from '$lib/types'
  import { sharedPhotoOrder } from '$lib/share/entries'
  import type { SharedEntry } from '$lib/share/contract'
  import { onMount } from 'svelte'
  import Button from '../ui/Button.svelte'
  import Tag from '../ui/Tag.svelte'
  import SharedThumbnail from './SharedThumbnail.svelte'
  import SelectableLink from './SelectableLink.svelte'

  let {
    entry,
    token,
    close,
    onCopy,
    fallbackUrl,
    phone,
    openPhoto,
    onPhotoError,
  }: {
    entry: SharedEntry
    token: string
    close: () => void
    onCopy: () => void
    fallbackUrl: string | null
    phone: boolean
    openPhoto: (entry: SharedEntry, photoId: string, button: HTMLButtonElement) => void
    onPhotoError: (error: unknown) => void
  } = $props()
  let closeButton: HTMLButtonElement
  const photos = $derived([...entry.photos].sort(sharedPhotoOrder))
  const fields = $derived([
    { label: m.entry_quantity(), value: entry.quantity, pair: true },
    { label: m.entry_unit(), value: entry.unit, pair: true },
    { label: m.entry_count_detail(), value: entry.count_detail },
    { label: m.entry_notes(), value: entry.notes },
    { label: m.entry_notes_this_collection(), value: entry.entry_notes },
    { label: m.entry_expiration(), value: entry.expiration_date, pair: true },
    { label: m.entry_dimensions(), value: entry.dimensions, pair: true },
    {
      label: m.entry_review_status(),
      value:
        entry.review_status === 'needs_review'
          ? m.entry_needs_review()
          : entry.review_status === 'complete'
            ? m.entry_complete()
            : m.entry_draft(),
    },
  ])

  onMount(() => closeButton.focus())

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
    if (phone && event.key === 'Tab') {
      const focusables =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.querySelectorAll<HTMLElement>('button, input')
          : null
      const last = focusables?.[focusables.length - 1]
      if (last && event.shiftKey && document.activeElement === closeButton) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        closeButton.focus()
      }
    }
  }
</script>

<section
  class="entry-panel"
  role={phone ? 'dialog' : 'region'}
  aria-modal={phone || undefined}
  aria-label={entryDisplayTitle(entry)}
  onkeydown={keyboard}
>
  <div class="panel-top">
    <Tag sequence={entry.sequence_number} size="lg" />
    <button bind:this={closeButton} class="button quiet" type="button" onclick={close}>
      {m.entry_close()}
    </button>
  </div>
  <h2>{entryDisplayTitle(entry)}</h2>
  <Button variant="quiet" onclick={onCopy}>{m.share_copy_entry()}</Button>
  {#if fallbackUrl}<SelectableLink url={fallbackUrl} />{/if}
  <dl>
    {#each fields as field (field.label)}
      <div class:wide={!field.pair}>
        <dt>{field.label}</dt>
        <dd>{field.value?.trim() ? field.value : '—'}</dd>
      </div>
    {/each}
  </dl>
  <h3>{m.entry_entry_photos()}</h3>
  {#if photos.length}
    <div class="photo-grid">
      {#each photos as photo, index (photo.id)}
        <SharedThumbnail
          {photo}
          {token}
          number={index + 1}
          open={(button) => openPhoto(entry, photo.id, button)}
          onError={onPhotoError}
        />
      {/each}
    </div>
  {:else}<p>{m.entry_no_photos()}</p>{/if}
</section>

<style>
  .entry-panel {
    position: fixed;
    inset: 0;
    z-index: var(--z-panel);
    display: grid;
    align-content: start;
    gap: var(--space-4);
    padding: calc(var(--space-5) + env(safe-area-inset-top)) var(--space-5)
      calc(var(--space-6) + env(safe-area-inset-bottom));
    background: var(--color-card);
    overflow-y: auto;
    overscroll-behavior: contain;
    overflow-wrap: anywhere;
  }
  .entry-panel > :global(.button) {
    justify-self: start;
  }
  .panel-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
    margin: 0;
  }
  .wide {
    grid-column: 1 / -1;
  }
  dt {
    font-size: var(--text-sm);
    color: var(--color-muted);
  }
  dd {
    margin: 0;
    white-space: pre-wrap;
  }
  h2,
  h3,
  p {
    margin: 0;
  }
  .photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(var(--size-thumb-lg), 100%), 1fr));
    gap: var(--space-3);
  }
  @media (min-width: 900px) {
    .entry-panel {
      position: sticky;
      inset: auto;
      top: var(--space-5);
      max-height: calc(100dvh - var(--space-7));
      padding: var(--space-5);
      border: var(--border);
      border-radius: var(--radius-lg);
    }
  }
</style>
