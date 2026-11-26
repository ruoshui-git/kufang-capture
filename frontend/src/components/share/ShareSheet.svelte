<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { StorageMode } from '$lib/types'
  import { accountAccess, accountGate, AccountRequestError } from '$lib/sync/binding'
  import { formatDateTime } from '$lib/i18n/format'
  import { relativeTime } from '../../routes/collections/relativeTime'
  import { createShare, listShares, revokeShare, ShareError } from '$lib/share/api'
  import {
    DEFAULT_SHARE_EXPIRY_DAYS,
    SHARE_EXPIRY_CHOICES,
    type ShareExpiryChoice,
    type ShareLink,
  } from '$lib/share/contract'
  import { joinQr } from '../sync/joinQr'
  import Sheet from '../ui/Sheet.svelte'
  import Button from '../ui/Button.svelte'
  import SelectableLink from './SelectableLink.svelte'

  let {
    open = $bindable(false),
    collectionId,
    storageMode,
  }: { open?: boolean; collectionId: string; storageMode: StorageMode } = $props()

  type Result = 'loading' | 'ready' | 'sign-in' | 'error'
  let result = $state<Result>('loading')
  let links = $state.raw<ShareLink[]>([])
  let owner = $state<string>()
  let ownerGeneration: number | undefined
  const activeAccount = $derived($accountAccess.kind === 'ready' ? $accountAccess.user.id : undefined)
  let label = $state('')
  let expiry = $state<ShareExpiryChoice>(DEFAULT_SHARE_EXPIRY_DAYS)
  let busy = $state(false)
  let error = $state('')
  let retry = $state(0)
  let confirm = $state<string>()
  let qrId = $state<string>()
  let fallbackId = $state<string>()
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined

  $effect(() => {
    retry
    const id = collectionId
    if (!open || storageMode !== 'synced') return
    const controller = new AbortController()
    request = controller
    const generation = accountGate.sessionGeneration
    result = 'loading'
    error = ''
    links = []
    owner = undefined
    void listShares(id, controller.signal).then(
      (items) => {
        if (controller.signal.aborted) return
        if (accountGate.sessionGeneration !== generation) {
          retry++
          return
        }
        links = items
        ownerGeneration = generation
        owner = activeAccount
        result = 'ready'
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return
        result = 'error'
        handleError(cause)
      },
    )
    return () => {
      controller.abort()
      request = undefined
      clearTimeout(copyTimer)
      copied = false
      confirm = undefined
      qrId = undefined
      fallbackId = undefined
      busy = false
    }
  })

  // Discard capability URLs after switching or signing out in another tab.
  $effect(() => {
    if (
      result === 'ready' &&
      (activeAccount !== owner || accountGate.sessionGeneration !== ownerGeneration)
    ) {
      links = []
      qrId = undefined
      fallbackId = undefined
      confirm = undefined
      result = $accountAccess.kind === 'signed_out' ? 'sign-in' : 'loading'
      if (result === 'loading') retry++
    }
  })

  function handleError(cause: unknown) {
    if (cause instanceof ShareError) {
      switch (cause.code) {
        case 'local_only':
          return
        case 'sign_in':
          links = []
          result = 'sign-in'
          return
        case 'collection_not_found':
          links = []
          result = 'error'
          error = m.share_sync_first()
          return
        case 'too_many_shares':
          error = m.share_limit()
          return
        case 'invalid_label':
          error = m.share_invalid_label()
          return
        case 'network':
          error = m.share_connection()
          return
      }
    }
    error = cause instanceof AccountRequestError ? cause.message : m.share_manage_failed()
  }

  function expiryLabel(link: ShareLink) {
    if (!link.expires_at) return m.share_no_expiry()
    const remaining = Date.parse(link.expires_at) - Date.now()
    if (link.expired || remaining <= 0) return m.share_has_expired()
    return m.share_expires_in({ duration: m.share_days({ count: Math.ceil(remaining / 86_400_000) }) })
  }

  function lastViewedLabel(viewed: string | null) {
    if (!viewed) return m.share_not_viewed()
    const hours = Math.floor((Date.now() - Date.parse(viewed)) / 3_600_000)
    return hours >= 1 && hours < 24
      ? m.share_viewed_hours({ count: hours })
      : m.share_viewed({ time: relativeTime(viewed) })
  }

  function canManage(signal?: AbortSignal) {
    return (
      open &&
      storageMode === 'synced' &&
      !signal?.aborted &&
      !!owner &&
      owner === activeAccount &&
      accountGate.sessionGeneration === ownerGeneration
    )
  }

  async function copy(link: ShareLink, signal?: AbortSignal) {
    if (!canManage(signal)) return
    try {
      await navigator.clipboard.writeText(link.url)
      if (!canManage(signal)) return
      fallbackId = undefined
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 8000)
    } catch {
      if (canManage(signal)) fallbackId = link.id
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault()
    const signal = request?.signal
    if (!canManage(signal) || busy) return
    busy = true
    error = ''
    try {
      const link = await createShare({ collection_id: collectionId, label, expires_in_days: expiry }, signal)
      if (!canManage(signal)) return
      links = [link, ...links]
      label = ''
      await copy(link, signal)
    } catch (cause) {
      if (!signal?.aborted) handleError(cause)
    } finally {
      if (!signal?.aborted) busy = false
    }
  }

  async function revoke(link: ShareLink) {
    const signal = request?.signal
    if (!canManage(signal) || busy) return
    busy = true
    error = ''
    try {
      await revokeShare(link.id, signal, collectionId)
      if (!canManage(signal)) return
      removeLink(link.id)
    } catch (cause) {
      if (!signal?.aborted) {
        if (cause instanceof ShareError && cause.code === 'share_not_found') removeLink(link.id)
        else handleError(cause)
      }
    } finally {
      if (!signal?.aborted) busy = false
    }
  }

  function removeLink(id: string) {
    links = links.filter((link) => link.id !== id)
    if (qrId === id) qrId = undefined
    if (fallbackId === id) fallbackId = undefined
    confirm = undefined
  }
</script>

<Sheet bind:open title={m.share_sheet_title()}>
  <div class="share-sheet">
    {#if storageMode === 'local_only'}
      <p>{m.share_local_only()}</p>
    {:else}
      <p>{m.share_owner_description()}</p>
      {#if result === 'loading'}
        <p role="status">{m.share_links_loading()}</p>
      {:else if result === 'sign-in'}
        <p>{m.share_sign_in()}</p>
        <a class="button primary" href="/login?return={encodeURIComponent(`/c/${collectionId}`)}">
          {m.account_sign_in()}
        </a>
      {:else if result === 'error'}
        <p role="alert">{error}</p>
        <Button variant="quiet" onclick={() => retry++}>{m.account_try_again()}</Button>
      {:else if owner && owner === activeAccount}
        <form onsubmit={create}>
          <label class="field">
            {m.share_label()}
            <input bind:value={label} maxlength="40" autocomplete="off" />
          </label>
          <fieldset>
            <legend>{m.share_expiry()}</legend>
            <div class="expiry">
              {#each SHARE_EXPIRY_CHOICES as days (days)}
                <label>
                  <input type="radio" bind:group={expiry} value={days} />
                  <span>{days === null ? m.share_never() : m.share_days({ count: days })}</span>
                </label>
              {/each}
            </div>
          </fieldset>
          <Button type="submit" disabled={busy}>{m.share_create()}</Button>
        </form>
        {#if error}<p role="alert">{error}</p>{/if}
        {#if links.length}
          <ul class="links">
            {#each links as link (link.id)}
              {@const name = link.label || m.share_link()}
              <li>
                <h3>{name}</h3>
                <p class="link-meta">
                  <span>{m.share_created({ date: formatDateTime(link.created_at) })}</span>
                  <span>{expiryLabel(link)}</span>
                  <span>{lastViewedLabel(link.last_viewed_at)}</span>
                </p>
                <div class="link-actions">
                  <Button variant="quiet" onclick={() => copy(link, request?.signal)}>{m.share_copy()}</Button
                  >
                  <button
                    class="button quiet"
                    type="button"
                    aria-expanded={qrId === link.id}
                    onclick={() => (qrId = qrId === link.id ? undefined : link.id)}>{m.share_qr()}</button
                  >
                  <Button variant="quiet" disabled={busy} onclick={() => (confirm = link.id)}>
                    {m.share_revoke()}
                  </Button>
                </div>
                {#if fallbackId === link.id}<SelectableLink url={link.url} />{/if}
                {#if qrId === link.id}
                  {@const qr = joinQr(link.url)}
                  <svg
                    class="qr-code"
                    viewBox="0 0 {qr.size} {qr.size}"
                    shape-rendering="crispEdges"
                    role="img"
                    aria-label={m.share_qr_accessible({ name })}
                  >
                    <rect width={qr.size} height={qr.size} class="qr-background" />
                    <path d={qr.path} class="qr-modules" />
                  </svg>
                {/if}
                {#if confirm === link.id}
                  <p role="alert">{m.share_revoke_confirm({ name })}</p>
                  <div class="link-actions">
                    <Button variant="danger" disabled={busy} onclick={() => revoke(link)}>
                      {m.share_revoke()}
                    </Button>
                    <Button variant="quiet" disabled={busy} onclick={() => (confirm = undefined)}>
                      {m.shell_cancel()}
                    </Button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if copied}
          <div class="toast-host" aria-live="polite">
            <p class="toast" role="status">{m.share_copied()}</p>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</Sheet>

<style>
  .share-sheet,
  form,
  li {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }
  .share-sheet > :global(.button),
  form > :global(.button) {
    justify-self: start;
  }
  p,
  h3 {
    margin: 0;
    overflow-wrap: anywhere;
  }
  fieldset,
  .links {
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  legend {
    margin-bottom: var(--space-2);
    font-weight: var(--weight-bold);
  }
  .expiry {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: var(--border);
    border-radius: var(--radius-md);
  }
  .expiry label {
    position: relative;
    cursor: pointer;
    text-align: center;
  }
  .expiry label + label {
    border-inline-start: var(--border);
  }
  .expiry input {
    position: absolute;
    opacity: 0;
  }
  .expiry span {
    display: grid;
    place-items: center;
    min-height: var(--size-touch);
    font-size: var(--text-md);
  }
  .expiry input:checked + span {
    background: var(--color-ink);
    color: var(--color-on-ink);
  }
  .expiry input:focus-visible + span {
    position: relative;
    box-shadow: var(--focus-ring);
  }
  .links {
    display: grid;
    gap: var(--space-4);
    list-style: none;
  }
  li {
    gap: var(--space-3);
    border-top: var(--border);
    padding-top: var(--space-4);
  }
  .link-meta,
  .link-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }
  .link-meta {
    color: var(--color-muted);
    font-size: var(--text-sm);
  }
  .qr-code {
    display: block;
    width: min(var(--size-join-qr), 100%);
    aspect-ratio: 1;
  }
  .qr-background {
    fill: var(--color-qr-background);
  }
  .qr-modules {
    fill: var(--color-qr-modules);
  }
</style>
