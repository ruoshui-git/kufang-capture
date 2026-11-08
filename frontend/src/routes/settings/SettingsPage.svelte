<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import { SETTING_KEYS } from '$lib/types'
  import type { CaptureMode } from '$lib/camera'
  import type { StorageEstimate } from '$lib/repo'
  import Button from '../../components/ui/Button.svelte'
  import ExportSheet from '../../components/sync/ExportSheet.svelte'
  import { authClient } from '$lib/sync'
  import type { CollectionSummary } from '$lib/types'
  import { navigate } from '../../app/router.svelte'

  let captureMode = $state<CaptureMode>('native')
  let storage = $state<StorageEstimate | null>(null)
  let storageMessage = $state('')
  let signedIn = $state<boolean | null>(null)
  let summaries = $state<CollectionSummary[]>([])
  let exportOpen = $state(false)
  let accountMessage = $state('')

  const localDataNeedsExport = $derived(
    summaries.some(
      (item) =>
        item.collection.storage_mode === 'local_only' &&
        (!item.collection.last_exported_at ||
          Date.now() - Date.parse(item.collection.last_exported_at) > 7 * 86400000),
    ),
  )

  onMount(() => {
    void (async () => {
      captureMode = await repo.getSetting<CaptureMode>(SETTING_KEYS.captureMode, 'native')
      storage = await repo.estimateStorage()
    })()
    const sub = repo
      .watchCollectionSummaries({ includeArchived: true })
      .subscribe((items) => (summaries = items))
    void authClient
      .session()
      .then((session) => (signedIn = session.authenticated))
      .catch(() => (signedIn = false))
    return () => (typeof sub === 'function' ? sub() : sub.unsubscribe())
  })

  async function chooseMode(mode: CaptureMode) {
    captureMode = mode
    await repo.setSetting(SETTING_KEYS.captureMode, mode)
  }

  async function keepData() {
    const granted = await repo.requestPersistentStorage()
    storageMessage = granted
      ? 'The browser will keep this storage until you clear site data.'
      : 'The browser did not grant persistent storage.'
    storage = await repo.estimateStorage()
  }
  async function signOut() {
    try {
      await authClient.logout()
      signedIn = false
      accountMessage = 'Signed out.'
    } catch (cause) {
      accountMessage = cause instanceof Error ? cause.message : 'Could not sign out.'
    }
  }

  function formatBytes(value: number | null | undefined) {
    if (value == null) return 'Unavailable'
    if (value < 1024) return `${value} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let size = value
    let unit = -1
    do {
      size /= 1024
      unit++
    } while (size >= 1024 && unit < units.length - 1)
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
  }
</script>

<svelte:head><title>Settings · Kufang Capture</title></svelte:head>
<section class="page settings-page">
  <div class="page-heading"><h1>Settings</h1></div>
  <section class="settings-card" aria-labelledby="account-heading">
    <h2 id="account-heading">Account &amp; sync</h2>
    {#if signedIn === null}<p>Checking sign-in…</p>{:else if signedIn}<p>
        Signed in. Synced collections upload in the background.
      </p>
      <div class="settings-actions">
        <Button variant="quiet" onclick={() => navigate('/server')}>Server exports</Button><Button
          variant="quiet"
          onclick={() => void signOut()}>Sign out</Button
        >
      </div>{:else}<p>Not signed in. Local Only collections work without an account.</p>
      <Button onclick={() => navigate(`/login?return=${encodeURIComponent('/settings')}`)}>Sign in</Button
      >{/if}
    {#if accountMessage}<p role="status">{accountMessage}</p>{/if}
  </section>
  <section class="settings-card" aria-labelledby="export-heading">
    <h2 id="export-heading">Device export</h2>
    {#if localDataNeedsExport}<p class="export-reminder">
        Local Only data lives only on this iPhone. Export a ZIP to Files regularly.
      </p>{:else}<p>Export a ZIP of this device's collections. This works offline.</p>{/if}
    <Button variant="quiet" onclick={() => (exportOpen = true)}>Export all data</Button>
  </section>
  <section class="settings-card" aria-labelledby="capture-heading">
    <h2 id="capture-heading">Capture mode</h2>
    <fieldset>
      <label class="choice"
        ><input
          type="radio"
          name="capture-mode"
          checked={captureMode === 'native'}
          onchange={() => chooseMode('native')}
        /><span
          ><strong>System camera</strong><small>Best quality, opens iOS Camera for each photo</small></span
        ></label
      >
      <label class="choice"
        ><input
          type="radio"
          name="capture-mode"
          checked={captureMode === 'fast'}
          onchange={() => chooseMode('fast')}
        /><span
          ><strong>Fast camera</strong><small>Stays open for rapid shots; video-frame quality</small></span
        ></label
      >
    </fieldset>
  </section>
  <section class="settings-card" aria-labelledby="storage-heading">
    <h2 id="storage-heading">Storage on this device</h2>
    <dl>
      <div>
        <dt>Used</dt>
        <dd>{formatBytes(storage?.usage)}</dd>
      </div>
      <div>
        <dt>Available quota</dt>
        <dd>{formatBytes(storage?.quota)}</dd>
      </div>
      <div>
        <dt>Persistent storage</dt>
        <dd>{storage?.persisted == null ? 'Unavailable' : storage.persisted ? 'Enabled' : 'Not enabled'}</dd>
      </div>
    </dl>
    <Button variant="quiet" onclick={keepData}>Keep data on this device</Button>
    {#if storageMessage}<p class="storage-message" role="status">{storageMessage}</p>{/if}
  </section>
  <section class="settings-card app-info">
    <h2>About</h2>
    <p>Version {import.meta.env.VITE_APP_VERSION ?? 'dev'}</p>
    <a href="/diagnostics">Open Diagnostics</a>
  </section>
</section>
<ExportSheet bind:open={exportOpen} scope="all" title="Export all data" />

<style>
  .settings-page {
    max-width: 760px;
  }
  .settings-page > .page-heading {
    margin-bottom: 16px;
  }
  .settings-card {
    padding: 18px;
    margin-bottom: 12px;
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: 8px;
  }
  .settings-card h2 {
    margin-bottom: 12px;
  }
  .settings-card fieldset {
    padding: 0;
    margin: 0;
    border: 0;
  }
  .choice {
    display: flex;
    gap: 12px;
    align-items: center;
    min-height: 64px;
    padding: 10px 4px;
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
    gap: 2px;
  }
  .choice small {
    color: var(--color-muted);
  }
  dl {
    margin: 0 0 14px;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    padding: 7px 0;
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
    margin: 0 0 8px;
    color: var(--color-muted);
  }
  .settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .export-reminder {
    padding: 12px;
    border-left: 3px solid var(--color-warn);
    background: color-mix(in srgb, var(--color-warn) 9%, var(--color-card));
  }
</style>
