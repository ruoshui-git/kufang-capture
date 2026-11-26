<script lang="ts">
  import { formatBytes } from '$lib/i18n/format'
  import { m } from '$lib/paraglide/messages.js'
  import LanguagePicker from '../../components/i18n/LanguagePicker.svelte'
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import { SETTING_KEYS } from '$lib/types'
  import type { CaptureMode } from '$lib/camera'
  import type { StorageEstimate } from '$lib/repo'
  import Button from '../../components/ui/Button.svelte'
  import ExportSheet from '../../components/sync/ExportSheet.svelte'
  import type { CollectionSummary } from '$lib/types'
  import { navigate } from '../../app/router.svelte'
  import { accountAccess, accountMismatch } from '$lib/sync/binding'
  import type { SessionUser } from '$lib/sync/api'
  import { accountAuthenticated, startAccountState } from '$lib/sync/account'

  let captureMode = $state<CaptureMode>('native')
  let storage = $state<StorageEstimate | null>(null)
  let storageMessage = $state('')
  let summaries = $state<CollectionSummary[]>([])
  let exportOpen = $state(false)
  let accountMessage = $state('')
  let peopleOpen = $state(false)
  let switching = $state(false)

  const localDataNeedsExport = $derived(
    summaries.some(
      (item) =>
        item.collection.storage_mode === 'local_only' &&
        (!item.collection.last_exported_at ||
          Date.now() - Date.parse(item.collection.last_exported_at) > 7 * 86400000),
    ),
  )

  $effect(() => {
    if ($accountAccess.kind !== 'ready' || !$accountAccess.user.is_owner) peopleOpen = false
  })

  onMount(() => {
    startAccountState()
    void (async () => {
      captureMode = await repo.getSetting<CaptureMode>(SETTING_KEYS.captureMode, 'native')
      storage = await repo.estimateStorage()
    })()
    const sub = repo
      .watchCollectionSummaries({ includeArchived: true })
      .subscribe((items) => (summaries = items))
    return () => (typeof sub === 'function' ? sub() : sub.unsubscribe())
  })

  function displayAccountName(user: SessionUser) {
    return user.is_owner && user.name === 'Owner' ? m.core_account_owner() : user.name
  }

  async function chooseMode(mode: CaptureMode) {
    captureMode = mode
    await repo.setSetting(SETTING_KEYS.captureMode, mode)
  }

  async function keepData() {
    const granted = await repo.requestPersistentStorage()
    storageMessage = granted ? m.account_storage_granted() : m.account_storage_denied()
    storage = await repo.estimateStorage()
  }
  async function signOut() {
    try {
      const { authClient } = await import('$lib/sync')
      await authClient.logout()
      accountMessage = m.account_signed_out()
    } catch (cause) {
      accountMessage = m.account_sign_out_failed()
    }
  }

  async function switchAccount() {
    switching = true
    accountMessage = ''
    try {
      const { authClient } = await import('$lib/sync')
      await authClient.switchAccount()
    } catch (cause) {
      accountMessage = cause instanceof Error ? cause.message : m.account_switch_failed()
    } finally {
      switching = false
    }
  }
</script>

<svelte:head><title>{m.account_settings_title()}</title></svelte:head>
<section class="page settings-page">
  <div class="page-heading"><h1>{m.account_settings()}</h1></div>
  <section class="settings-card"><LanguagePicker inline /></section>
  <section class="settings-card" aria-labelledby="account-heading">
    <h2 id="account-heading">{m.account_account_and_sync()}</h2>
    {#if $accountAccess.kind === 'blocked'}
      <p class="auth-error" role="alert">{accountMismatch($accountAccess.name)}</p>
      <div class="settings-actions">
        <Button variant="quiet" onclick={() => void signOut()}>{m.account_sign_out()}</Button>
        {#if $accountAccess.canSwitch && $accountAccess.user}
          <Button disabled={switching} onclick={switchAccount}
            >{m.account_switch_to({ name: displayAccountName($accountAccess.user) })}</Button
          >
        {/if}
      </div>
    {:else if $accountAccess.kind === 'unavailable'}
      <p class="auth-error" role="alert">{m.core_account_unavailable()}</p>
      <Button variant="quiet" onclick={() => void signOut()}>{m.account_sign_out()}</Button>
    {:else if $accountAccess.kind === 'ready'}
      {@const name = displayAccountName($accountAccess.user)}
      {@const [beforeName, afterName] = m.account_signed_in_as({ name: '\0' }).split('\0')}
      <p>{beforeName}<strong>{name}</strong>{afterName}</p>
      <div class="settings-actions">
        {#if $accountAccess.user.is_owner}
          <Button variant="quiet" onclick={() => (peopleOpen = true)}>{m.account_people()}</Button>
        {/if}
        <Button variant="quiet" onclick={() => navigate('/server')}>{m.account_server_exports()}</Button>
        <Button variant="quiet" onclick={() => void signOut()}>{m.account_sign_out()}</Button>
      </div>
    {:else if $accountAuthenticated === null && $accountAccess.kind !== 'signed_out'}
      <p>{m.account_checking_sign_in()}</p>
    {:else}
      <p>{m.account_signed_out_hint()}</p>
      <Button onclick={() => navigate(`/login?return=${encodeURIComponent('/settings')}`)}
        >{m.account_sign_in()}</Button
      >
    {/if}
    {#if accountMessage}<p role="status">{accountMessage}</p>{/if}
  </section>
  <section class="settings-card" aria-labelledby="export-heading">
    <h2 id="export-heading">{m.account_device_export()}</h2>
    {#if localDataNeedsExport}<p class="export-reminder">
        {m.account_export_reminder()}
      </p>{:else}<p>{m.account_device_export_hint()}</p>{/if}
    <Button variant="quiet" onclick={() => (exportOpen = true)}>{m.account_export_all()}</Button>
  </section>
  <section class="settings-card" aria-labelledby="capture-heading">
    <h2 id="capture-heading">{m.account_capture_mode()}</h2>
    <fieldset>
      <label class="choice"
        ><input
          type="radio"
          name="capture-mode"
          checked={captureMode === 'native'}
          onchange={() => chooseMode('native')}
        /><span
          ><strong>{m.account_system_camera()}</strong><small>{m.account_system_camera_hint()}</small></span
        ></label
      >
      <label class="choice"
        ><input
          type="radio"
          name="capture-mode"
          checked={captureMode === 'fast'}
          onchange={() => chooseMode('fast')}
        /><span><strong>{m.account_fast_camera()}</strong><small>{m.account_fast_camera_hint()}</small></span
        ></label
      >
    </fieldset>
  </section>
  <section class="settings-card" aria-labelledby="storage-heading">
    <h2 id="storage-heading">{m.account_storage_on_device()}</h2>
    <dl>
      <div>
        <dt>{m.account_storage_used()}</dt>
        <dd>{formatBytes(storage?.usage)}</dd>
      </div>
      <div>
        <dt>{m.account_storage_quota()}</dt>
        <dd>{formatBytes(storage?.quota)}</dd>
      </div>
      <div>
        <dt>{m.account_persistent_storage()}</dt>
        <dd>
          {storage?.persisted == null
            ? m.core_unavailable()
            : storage.persisted
              ? m.account_storage_enabled()
              : m.account_storage_disabled()}
        </dd>
      </div>
    </dl>
    <Button variant="quiet" onclick={keepData}>{m.account_keep_data()}</Button>
    {#if storageMessage}<p class="storage-message" role="status">{storageMessage}</p>{/if}
  </section>
  <section class="settings-card app-info">
    <h2>{m.account_about()}</h2>
    <p>{m.account_version({ version: import.meta.env.VITE_APP_VERSION ?? m.account_development() })}</p>
    <a href="/diagnostics">{m.account_diagnostics_open()}</a>
  </section>
</section>
{#if peopleOpen && $accountAccess.kind === 'ready' && $accountAccess.user.is_owner}
  {#await import('../../components/sync/PeopleSheet.svelte') then { default: PeopleSheet }}
    <PeopleSheet bind:open={peopleOpen} />
  {/await}
{/if}
<ExportSheet bind:open={exportOpen} scope="all" title={m.account_export_all()} />

<style>
  .settings-page {
    max-width: 760px;
  }
  .settings-page > .page-heading {
    margin-bottom: var(--space-5);
  }
  .settings-card {
    padding: var(--space-5);
    margin-bottom: var(--space-4);
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
  }
  .settings-card h2 {
    margin-bottom: var(--space-4);
  }
  .settings-card fieldset {
    padding: 0;
    margin: 0;
    border: 0;
  }
  .choice {
    display: flex;
    gap: var(--space-4);
    align-items: center;
    min-height: 64px;
    padding: var(--space-3) var(--space-2);
    border-top: 1px solid var(--color-line);
    cursor: pointer;
  }
  .choice input {
    width: 20px;
    height: 20px;
    accent-color: var(--color-ballpoint);
  }
  .choice span {
    display: grid;
    gap: var(--space-1);
  }
  .choice small {
    color: var(--color-muted);
  }
  dl {
    margin: 0 0 var(--space-4);
  }
  dl div {
    display: flex;
    justify-content: space-between;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-line);
  }
  dt {
    color: var(--color-muted);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .storage-message {
    color: var(--color-muted);
    margin-bottom: 0;
  }
  .app-info p {
    margin: 0 0 var(--space-3);
    color: var(--color-muted);
  }
  .settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .export-reminder {
    padding: var(--space-4);
    border-left: 3px solid var(--color-warn);
    background: color-mix(in srgb, var(--color-warn) 9%, var(--color-card));
  }
</style>
