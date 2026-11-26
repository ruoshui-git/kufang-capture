<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { tick } from 'svelte'
  import { router } from '../../app/router.svelte'
  import { showToast } from '../../app/toasts.svelte'
  import { fetchShared, fetchSharedPhoto, ShareError } from '$lib/share/api'
  import { parseShareLocation, sharePath } from '$lib/share/location'
  import { matchesShareSearch, sharedPhotoOrder, summarizeQuantities } from '$lib/share/entries'
  import type { SharedCollection, SharedEntry } from '$lib/share/contract'
  import { relativeTime } from '../collections/relativeTime'
  import LanguagePicker from '../../components/i18n/LanguagePicker.svelte'
  import Chip from '../../components/ui/Chip.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ToastHost from '../../components/ui/ToastHost.svelte'
  import SharedEntryRow from '../../components/share/SharedEntryRow.svelte'
  import SharedEntryPanel from '../../components/share/SharedEntryPanel.svelte'
  import PhotoViewer from '../../components/viewer/PhotoViewer.svelte'

  const entryHistoryKey = 'captureSharedEntry'
  let fragment = $state(window.location.hash)
  const link = $derived(parseShareLocation(fragment))
  const token = $derived(link?.token)
  const sequence = $derived(link?.sequence)
  let retry = $state(0)
  let snapshot = $state.raw<SharedCollection>()
  let error = $state<'invalid' | 'expired' | 'rate' | 'network'>()
  let search = $state('')
  let reviewOnly = $state(false)
  let searchInput = $state<HTMLInputElement>()
  let entryTrigger: HTMLButtonElement | undefined
  let fallbackUrl = $state<string | null>(null)

  const selected = $derived(snapshot?.entries.find((entry) => entry.sequence_number === sequence))
  const visible = $derived(
    snapshot?.entries.filter(
      (entry) => (!reviewOnly || entry.review_status === 'needs_review') && matchesShareSearch(entry, search),
    ) ?? [],
  )
  const reviewCount = $derived(
    snapshot?.entries.filter((entry) => entry.review_status === 'needs_review').length ?? 0,
  )
  const quantities = $derived(snapshot ? summarizeQuantities(snapshot.entries) : [])
  const entryMissing = $derived(!!snapshot && sequence != null && !selected)
  let viewerOpen = $state(false)
  let viewerEntry = $state.raw<SharedEntry>()
  let viewerStartPhoto = $state<string | null>(null)
  const viewerSource = $derived(
    token && viewerEntry
      ? {
          photos: [...viewerEntry.photos].sort(sharedPhotoOrder),
          loadOriginal: (id: string, signal: AbortSignal) => fetchSharedPhoto(token, id, 'original', signal),
          onError: onPhotoError,
        }
      : undefined,
  )

  $effect(() => {
    retry
    const requestedToken = token
    snapshot = undefined
    error = undefined
    search = ''
    reviewOnly = false
    if (!requestedToken) {
      error = 'invalid'
      return
    }
    const controller = new AbortController()
    void fetchShared(requestedToken, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) snapshot = value
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          error = linkError(cause) ?? 'network'
        }
      },
    )
    return () => controller.abort()
  })

  function linkError(cause: unknown) {
    if (!(cause instanceof ShareError)) return
    if (cause.code === 'share_not_found' || cause.code === 'share_required') return 'invalid'
    if (cause.code === 'share_expired') return 'expired'
    if (cause.code === 'too_many_attempts') return 'rate'
  }

  function onPhotoError(cause: unknown) {
    const denied = linkError(cause)
    if (!denied) return
    viewerOpen = false
    viewerEntry = undefined
    snapshot = undefined
    error = denied
  }

  function updateFragment() {
    const next = window.location.hash
    if (next === fragment) return
    const previous = sequence
    fragment = next
    fallbackUrl = null
    viewerOpen = false
    viewerEntry = undefined
    if (previous != null && sequence == null) {
      void tick().then(() => {
        const target = entryTrigger?.isConnected ? entryTrigger : searchInput
        target?.focus({ preventScroll: true })
        entryTrigger = undefined
      })
    }
  }

  function openEntry(entry: SharedEntry, trigger: HTMLButtonElement) {
    if (!token || entry.sequence_number === sequence) return
    const path = sharePath(token, entry.sequence_number)
    if (sequence == null) {
      entryTrigger = trigger
      history.pushState({ [entryHistoryKey]: true }, '', path)
    } else {
      history.replaceState(history.state, '', path)
    }
    updateFragment()
  }

  function closeEntry() {
    if (!token) return
    if (history.state?.[entryHistoryKey]) history.back()
    else {
      history.replaceState(null, '', sharePath(token))
      updateFragment()
    }
  }

  async function copyEntry() {
    if (!token || sequence == null) return
    const url = location.origin + sharePath(token, sequence)
    try {
      await navigator.clipboard.writeText(url)
      fallbackUrl = null
      showToast({ message: m.share_copied() })
    } catch {
      if (token && sequence != null && url === location.origin + sharePath(token, sequence)) {
        fallbackUrl = url
      }
    }
  }

  function openPhoto(entry: SharedEntry, photoId: string, trigger: HTMLButtonElement) {
    trigger.focus({ preventScroll: true })
    viewerEntry = entry
    viewerStartPhoto = photoId
    viewerOpen = true
  }
</script>

<svelte:head>
  <title>{m.shell_page_title({ title: snapshot?.collection.name ?? m.share_page_title() })}</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
</svelte:head>
<svelte:window onpopstate={updateFragment} onhashchange={updateFragment} />

<main class="page share-page" aria-busy={!snapshot && !error}>
  <div class="share-content" class:entry-shown={!!selected} inert={viewerOpen}>
    <div class="list" inert={!!selected && !router.isDesktop}>
      <header class="share-header">
        <div class="header-copy">
          <h1>{snapshot?.collection.name ?? m.share_page_title()}</h1>
          {#if snapshot?.collection.folder}<p>{snapshot.collection.folder}</p>{/if}
          {#if snapshot?.collection.description}<p class="description">
              {snapshot.collection.description}
            </p>{/if}
          <div class="header-meta">
            <span class="read-only">{m.share_read_only()}</span>
            {#if snapshot}
              <time datetime={snapshot.updated_at}>
                {m.share_updated({ time: relativeTime(snapshot.updated_at) })}
              </time>
            {/if}
          </div>
        </div>
        <LanguagePicker inline />
      </header>
      {#if error}
        <section class="card message">
          <p role="alert">
            {error === 'invalid'
              ? m.share_invalid()
              : error === 'expired'
                ? m.share_expired()
                : error === 'rate'
                  ? m.share_rate_limited()
                  : m.share_connection()}
          </p>
          {#if error === 'network' || error === 'rate'}
            <Button variant="quiet" onclick={() => retry++}>{m.account_try_again()}</Button>
          {/if}
        </section>
      {:else}
        <div class="quantities" aria-label={m.shell_quantities_by_unit()}>
          {#each quantities as quantity (quantity.unit)}
            <Chip variant="quantity"
              >{quantity.unit
                ? `${quantity.total} ${quantity.unit}`
                : m.shell_quantity_without_unit({ total: quantity.total })}</Chip
            >
          {/each}
        </div>
        <div class="controls">
          <label class="field">
            <input
              bind:this={searchInput}
              bind:value={search}
              type="search"
              aria-label={m.share_search()}
              placeholder={m.share_search()}
              disabled={!snapshot}
            />
          </label>
          <div class="filters" role="group" aria-label={m.share_filters()}>
            <button
              type="button"
              class="button"
              class:quiet={reviewOnly}
              class:ink={!reviewOnly}
              aria-pressed={!reviewOnly}
              disabled={!snapshot}
              onclick={() => (reviewOnly = false)}>{m.shell_all()}</button
            >
            <button
              type="button"
              class="button"
              class:quiet={!reviewOnly}
              class:ink={reviewOnly}
              aria-pressed={reviewOnly}
              disabled={!snapshot}
              onclick={() => (reviewOnly = true)}>{m.share_needs_review({ count: reviewCount })}</button
            >
          </div>
        </div>
        {#if snapshot && token}
          {#if entryMissing}
            <section class="card message">
              <p role="alert">{m.share_entry_missing()}</p>
              <Button variant="quiet" onclick={closeEntry}>{m.share_back_to_collection()}</Button>
            </section>
          {/if}
          {#each visible as entry (entry.id)}
            <SharedEntryRow {entry} {token} {openEntry} {openPhoto} {onPhotoError} />
          {:else}
            <p class="card message">
              {snapshot.entries.length ? m.share_no_matches() : m.share_no_entries()}
            </p>
          {/each}
        {:else}
          <p class="card message" role="status">{m.share_loading()}</p>
        {/if}
      {/if}
    </div>
    {#if selected && token}
      {#key selected.id}
        <SharedEntryPanel
          entry={selected}
          {token}
          phone={!router.isDesktop}
          close={closeEntry}
          onCopy={copyEntry}
          {fallbackUrl}
          {openPhoto}
          {onPhotoError}
        />
      {/key}
    {/if}
  </div>
  {#if viewerSource}
    <PhotoViewer bind:open={viewerOpen} startPhotoId={viewerStartPhoto} photoSource={viewerSource} />
  {/if}
  <ToastHost />
</main>

<style>
  .share-page {
    padding-top: calc(var(--space-6) + env(safe-area-inset-top));
  }
  .list {
    display: grid;
    min-width: 0;
    gap: var(--space-3);
    align-content: start;
  }
  .share-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--space-4);
    min-height: var(--size-thumb-lg);
  }
  .header-copy {
    display: grid;
    gap: var(--space-2);
    overflow-wrap: anywhere;
  }
  h1,
  p {
    margin: 0;
  }
  h1 {
    font-size: var(--text-2xl);
  }
  .description {
    white-space: pre-wrap;
  }
  .header-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .read-only {
    padding: var(--space-1) var(--space-3);
    border: var(--border);
    border-radius: var(--radius-pill);
    background: var(--color-sunken);
  }
  .quantities {
    display: flex;
    min-height: var(--size-touch);
    gap: var(--space-3);
    overflow-x: auto;
    white-space: nowrap;
  }
  .controls,
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
  .controls .field {
    flex: 1 1 var(--size-rail);
    min-width: 0;
  }
  .message {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
  }
  @media (min-width: 900px) {
    .share-content.entry-shown {
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--size-panel);
      align-items: start;
      gap: var(--space-5);
    }
    h1 {
      font-size: var(--text-3xl);
    }
  }
</style>
